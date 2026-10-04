import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError } from "./errors";
import { buildModel, ModelConfig, normalizeArrivals, MODEL_VERSION } from "./model";
import {
  computeStats,
  initialRunState,
  RunState,
  SlotEvent,
  stepOnce,
} from "./engine";

export interface StoreOptions {
  dataDir: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(private opts: StoreOptions) {
    fs.mkdirSync(opts.dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(opts.dataDir, "aloha.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        frozen INTEGER NOT NULL DEFAULT 0,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        status TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, slot)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createModel(input: Record<string, unknown>): ModelConfig {
    const id = randomUUID();
    const model = buildModel(input, id, new Date().toISOString());
    this.db
      .prepare("INSERT INTO models (id, version, frozen, json) VALUES (?, ?, 0, ?)")
      .run(model.id, MODEL_VERSION, JSON.stringify(model));
    return model;
  }

  getModel(modelId: string): ModelConfig {
    const row = this.db.prepare("SELECT json FROM models WHERE id = ?").get(modelId) as
      | { json: string }
      | undefined;
    if (!row) throw new ApiError("E_NOT_FOUND", `模型不存在: ${modelId}`, 404);
    return JSON.parse(row.json) as ModelConfig;
  }

  listModels(): ModelConfig[] {
    const rows = this.db.prepare("SELECT json FROM models ORDER BY rowid").all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as ModelConfig);
  }

  /** 导入到达表：仅在模型尚未被任何运行使用时允许。 */
  importArrivals(modelId: string, arrivalsInput: unknown): ModelConfig {
    const model = this.getModel(modelId);
    const frozen = (this.db.prepare("SELECT frozen FROM models WHERE id = ?").get(modelId) as { frozen: number }).frozen;
    if (frozen) {
      throw new ApiError("E_MODEL_FROZEN", "模型已存在运行，到达表与概率不可再修改；请用新参数创建新模型/新运行", 409);
    }
    const stationIds = new Set(model.stations.map((s) => s.id));
    const merged = normalizeArrivals(
      [...model.arrivals, ...(Array.isArray(arrivalsInput) ? arrivalsInput : [])],
      stationIds
    );
    const next: ModelConfig = { ...model, arrivals: merged };
    this.db.prepare("UPDATE models SET json = ? WHERE id = ?").run(JSON.stringify(next), modelId);
    return next;
  }

  createRun(modelId: string): RunState {
    const model = this.getModel(modelId);
    const runId = randomUUID();
    const state = initialRunState(runId, model);
    const tx = this.db;
    tx.exec("BEGIN");
    try {
      tx.prepare("INSERT INTO runs (id, model_id, status, state_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
        runId,
        modelId,
        state.status,
        JSON.stringify(state),
        new Date().toISOString()
      );
      tx.prepare("UPDATE models SET frozen = 1 WHERE id = ?").run(modelId);
      tx.exec("COMMIT");
    } catch (e) {
      tx.exec("ROLLBACK");
      throw e;
    }
    return state;
  }

  getRun(runId: string): RunState {
    const row = this.db.prepare("SELECT state_json FROM runs WHERE id = ?").get(runId) as
      | { state_json: string }
      | undefined;
    if (!row) throw new ApiError("E_NOT_FOUND", `运行不存在: ${runId}`, 404);
    return JSON.parse(row.state_json) as RunState;
  }

  listRuns(): { id: string; modelId: string; status: string; createdAt: string }[] {
    const rows = this.db
      .prepare("SELECT id, model_id, status, created_at FROM runs ORDER BY rowid")
      .all() as { id: string; model_id: string; status: string; created_at: string }[];
    return rows.map((r) => ({ id: r.id, modelId: r.model_id, status: r.status, createdAt: r.created_at }));
  }

  /** 原子推进 n 个时隙：事件与运行状态在同一事务中落盘。 */
  step(runId: string, count: number): { state: RunState; events: SlotEvent[] } {
    if (!Number.isInteger(count) || count <= 0) {
      throw new ApiError("E_NON_INTEGER_SLOT", `推进步数必须是正整数，收到 ${count}`);
    }
    const model = this.getModel(this.getRun(runId).modelId);
    let state = this.getRun(runId);
    const events: SlotEvent[] = [];
    for (let i = 0; i < count; i++) {
      try {
        const r = stepOnce(model, state);
        state = r.state;
        events.push(r.event);
      } catch (e) {
        const overflow = (e as ApiError & { overflowState?: RunState }).overflowState;
        if (overflow) state = overflow;
        // 已推进的部分与最终状态一并原子落盘
        this.persist(runId, state, events);
        throw e;
      }
    }
    this.persist(runId, state, events);
    return { state, events };
  }

  private persist(runId: string, state: RunState, events: SlotEvent[]): void {
    this.db.exec("BEGIN");
    try {
      const ins = this.db.prepare("INSERT INTO events (run_id, slot, json) VALUES (?, ?, ?)");
      for (const ev of events) ins.run(runId, ev.slot, JSON.stringify(ev));
      this.db
        .prepare("UPDATE runs SET status = ?, state_json = ? WHERE id = ?")
        .run(state.status, JSON.stringify(state), runId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getSlot(runId: string, slot: number): SlotEvent {
    if (!Number.isInteger(slot) || slot < 0) {
      throw new ApiError("E_NON_INTEGER_SLOT", `时隙必须是非负整数，收到 ${slot}`);
    }
    const row = this.db
      .prepare("SELECT json FROM events WHERE run_id = ? AND slot = ?")
      .get(runId, slot) as { json: string } | undefined;
    if (!row) throw new ApiError("E_NOT_FOUND", `运行 ${runId} 尚无时隙 ${slot} 的事件`, 404);
    return JSON.parse(row.json) as SlotEvent;
  }

  history(runId: string): SlotEvent[] {
    this.getRun(runId);
    const rows = this.db
      .prepare("SELECT json FROM events WHERE run_id = ? ORDER BY slot")
      .all(runId) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as SlotEvent);
  }

  stats(runId: string) {
    const state = this.getRun(runId);
    const model = this.getModel(state.modelId);
    return computeStats(model, state);
  }

  exportRun(runId: string) {
    const state = this.getRun(runId);
    const model = this.getModel(state.modelId);
    return {
      model,
      run: state,
      events: this.history(runId),
      stats: computeStats(model, state),
    };
  }
}
