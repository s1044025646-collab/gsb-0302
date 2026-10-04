import type { DatabaseSync } from 'node:sqlite';
import { MODEL_VERSION } from './db.js';
import { advance, createRunState } from './engine.js';
import type { RunState } from './engine.js';
import { ErrorCode, fail } from './errors.js';
import { RNG_ALGORITHM } from './rng.js';
import type { Arrival, RunStats, SlotEvent, Station } from './types.js';

interface ModelRow {
  model_id: string;
  name: string;
  stations_json: string;
  seed: number;
  per_station_queue_limit: number;
  total_slot_budget: number;
  created_at: string;
}

export interface ModelConfig {
  modelId: string;
  name: string;
  stations: Station[];
  seed: number;
  perStationQueueLimit: number;
  totalSlotBudget: number;
  arrivals: Arrival[];
  createdAt: string;
}

/* ---------------- 状态序列化 ---------------- */

interface SerializedState {
  v: typeof MODEL_VERSION;
  runId: string;
  modelId: string;
  currentSlot: number;
  rng: { algorithm: string; state: number; draws: number };
  idleSlots: number;
  collisionSlots: number;
  successSlots: number;
  queues: Array<[string, Array<{ messageId: string; arrivalSlot: number }>]>;
  delays: RunState['delays'];
  perStationQueueLimit: number;
  totalSlotBudget: number;
  finished: boolean;
}

export function serializeState(s: RunState): string {
  const payload: SerializedState = {
    v: MODEL_VERSION,
    runId: s.runId,
    modelId: s.modelId,
    currentSlot: s.currentSlot,
    rng: s.rng,
    idleSlots: s.idleSlots,
    collisionSlots: s.collisionSlots,
    successSlots: s.successSlots,
    queues: [...s.queues.entries()],
    delays: s.delays,
    perStationQueueLimit: s.perStationQueueLimit,
    totalSlotBudget: s.totalSlotBudget,
    finished: s.finished,
  };
  return JSON.stringify(payload);
}

export function deserializeState(json: string, model: ModelConfig): RunState {
  const p = JSON.parse(json) as SerializedState;
  if (p.v !== MODEL_VERSION) {
    fail(ErrorCode.INVALID_JSON, `状态版本不匹配: ${p.v} != ${MODEL_VERSION}`);
  }
  if (p.rng.algorithm !== RNG_ALGORITHM) {
    fail(ErrorCode.INVALID_JSON, `随机算法版本不匹配: ${p.rng.algorithm}`);
  }
  const arrivalsBySlot = new Map<number, Arrival[]>();
  for (const a of model.arrivals) {
    const list = arrivalsBySlot.get(a.arrivalSlot);
    if (list) list.push(a);
    else arrivalsBySlot.set(a.arrivalSlot, [a]);
  }
  return {
    runId: p.runId,
    modelId: p.modelId,
    stations: model.stations,
    arrivalsBySlot,
    totalArrivals: model.arrivals.length,
    queues: new Map(p.queues),
    probabilities: new Map(model.stations.map((x) => [x.stationId, x.probability])),
    currentSlot: p.currentSlot,
    rng: p.rng,
    idleSlots: p.idleSlots,
    collisionSlots: p.collisionSlots,
    successSlots: p.successSlots,
    delays: p.delays,
    perStationQueueLimit: p.perStationQueueLimit,
    totalSlotBudget: p.totalSlotBudget,
    finished: p.finished,
  };
}

/* ---------------- 仓储 ---------------- */

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  createModel(cfg: ModelConfig): void {
    const stmt = this.db.prepare(
      `INSERT INTO models(model_id,name,stations_json,seed,per_station_queue_limit,total_slot_budget,created_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    stmt.run(
      cfg.modelId,
      cfg.name,
      JSON.stringify(cfg.stations),
      cfg.seed,
      cfg.perStationQueueLimit,
      cfg.totalSlotBudget,
      cfg.createdAt,
    );
    if (cfg.arrivals.length) this.replaceArrivals(cfg.modelId, cfg.arrivals);
  }

  listModels(): Array<Omit<ModelConfig, 'stations' | 'arrivals'> & { stationCount: number; arrivalCount: number; locked: boolean }> {
    const rows = this.db
      .prepare('SELECT * FROM models ORDER BY created_at, model_id')
      .all() as unknown as ModelRow[];
    return rows.map((r) => {
      const arrivalCount = (
        this.db.prepare('SELECT COUNT(*) c FROM arrivals WHERE model_id=?').get(r.model_id) as {
          c: number;
        }
      ).c;
      const locked = (
        this.db.prepare('SELECT COUNT(*) c FROM runs WHERE model_id=?').get(r.model_id) as {
          c: number;
        }
      ).c > 0;
      return {
        modelId: r.model_id,
        name: r.name,
        seed: r.seed,
        perStationQueueLimit: r.per_station_queue_limit,
        totalSlotBudget: r.total_slot_budget,
        createdAt: r.created_at,
        stationCount: (JSON.parse(r.stations_json) as Station[]).length,
        arrivalCount,
        locked,
      };
    });
  }

  getModelConfig(modelId: string): ModelConfig {
    const row = this.db.prepare('SELECT * FROM models WHERE model_id=?').get(modelId) as
      | ModelRow
      | undefined;
    if (!row) fail(ErrorCode.NOT_FOUND, `模型不存在: ${modelId}`, { modelId });
    const arrivals = (
      this.db
        .prepare(
          'SELECT message_id, station_id, arrival_slot FROM arrivals WHERE model_id=? ORDER BY arrival_slot, station_id, message_id',
        )
        .all(modelId) as Array<{ message_id: string; station_id: string; arrival_slot: number }>
    ).map((x) => ({ messageId: x.message_id, stationId: x.station_id, arrivalSlot: x.arrival_slot }));
    return {
      modelId: row.model_id,
      name: row.name,
      stations: JSON.parse(row.stations_json) as Station[],
      seed: row.seed,
      perStationQueueLimit: row.per_station_queue_limit,
      totalSlotBudget: row.total_slot_budget,
      arrivals,
      createdAt: row.created_at,
    };
  }

  /** 仅在该模型尚无任何运行时允许替换到达表（运行一旦创建即锁定历史）。 */
  replaceArrivals(modelId: string, arrivals: Arrival[]): number {
    this.getModelConfig(modelId); // 存在性
    const runCount = (
      this.db.prepare('SELECT COUNT(*) c FROM runs WHERE model_id=?').get(modelId) as { c: number }
    ).c;
    if (runCount > 0) {
      fail(ErrorCode.RUN_LOCKED, '该模型已有运行，到达表已锁定；修改参数请新建模型/运行', {
        modelId,
      });
    }
    this.db.prepare('DELETE FROM arrivals WHERE model_id=?').run(modelId);
    const ins = this.db.prepare(
      'INSERT INTO arrivals(model_id,seq,message_id,station_id,arrival_slot) VALUES (?,?,?,?,?)',
    );
    arrivals.forEach((a, i) => ins.run(modelId, i, a.messageId, a.stationId, a.arrivalSlot));
    return arrivals.length;
  }

  createRun(runId: string, modelId: string, createdAt: string): RunState {
    const model = this.getModelConfig(modelId);
    const state = createRunState({
      runId,
      modelId,
      stations: model.stations,
      arrivals: model.arrivals,
      seed: model.seed,
      perStationQueueLimit: model.perStationQueueLimit,
      totalSlotBudget: model.totalSlotBudget,
    });
    this.db
      .prepare('INSERT INTO runs(run_id,model_id,created_at,locked,state_json) VALUES (?,?,?,1,?)')
      .run(runId, modelId, createdAt, serializeState(state));
    return state;
  }

  listRuns(modelId?: string): Array<{ runId: string; modelId: string; createdAt: string; slotsAdvanced: number; finished: boolean }> {
    const rows = (modelId
      ? this.db.prepare('SELECT * FROM runs WHERE model_id=? ORDER BY created_at, run_id').all(modelId)
      : this.db.prepare('SELECT * FROM runs ORDER BY created_at, run_id').all()) as Array<{
      run_id: string;
      model_id: string;
      created_at: string;
      state_json: string;
    }>;
    return rows.map((r) => {
      const s = JSON.parse(r.state_json) as SerializedState;
      return {
        runId: r.run_id,
        modelId: r.model_id,
        createdAt: r.created_at,
        slotsAdvanced: s.currentSlot,
        finished: s.finished,
      };
    });
  }

  getRunState(runId: string): { state: RunState; model: ModelConfig } {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId) as
      | { model_id: string; state_json: string }
      | undefined;
    if (!row) fail(ErrorCode.NOT_FOUND, `运行不存在: ${runId}`, { runId });
    const model = this.getModelConfig(row.model_id);
    return { state: deserializeState(row.state_json, model), model };
  }

  /** 在单个 SQLite 事务中推进若干时隙，保证状态与事件原子一致。 */
  advanceRun(runId: string, steps: number): SlotEvent[] {
    const { state, model } = this.getRunState(runId);
    const events: SlotEvent[] = [];
    const saveState = this.db.prepare('UPDATE runs SET state_json=? WHERE run_id=?');
    const saveEvent = this.db.prepare(
      'INSERT INTO events(run_id,slot,event_json) VALUES (?,?,?)',
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const produced = advance(state, steps);
      for (const e of produced) {
        events.push(e);
        saveEvent.run(runId, e.slot, JSON.stringify(e));
      }
      saveState.run(serializeState(state), runId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      void model;
      throw err;
    }
    return events;
  }

  getEvent(runId: string, slot: number): SlotEvent {
    const row = this.db
      .prepare('SELECT event_json FROM events WHERE run_id=? AND slot=?')
      .get(runId, slot) as { event_json: string } | undefined;
    if (!row) fail(ErrorCode.NOT_FOUND, `时隙 ${slot} 尚未推进或不存在`, { runId, slot });
    return JSON.parse(row.event_json) as SlotEvent;
  }

  getHistory(runId: string): SlotEvent[] {
    const rows = this.db
      .prepare('SELECT event_json FROM events WHERE run_id=? ORDER BY slot')
      .all(runId) as Array<{ event_json: string }>;
    return rows.map((r) => JSON.parse(r.event_json) as SlotEvent);
  }

  stats(runId: string): RunStats {
    const { state } = this.getRunState(runId);
    const succeededIds = new Set(state.delays.map((d) => d.messageId));
    const pending: RunStats['pending'] = [];
    for (const station of state.stations) {
      for (const item of state.queues.get(station.stationId)!) {
        pending.push({
          messageId: item.messageId,
          stationId: station.stationId,
          arrivalSlot: item.arrivalSlot,
        });
      }
    }
    const meanDelay =
      state.delays.length === 0
        ? null
        : state.delays.reduce((sum, d) => sum + d.delay, 0) / state.delays.length;
    return {
      runId,
      slotsAdvanced: state.currentSlot,
      idleSlots: state.idleSlots,
      collisionSlots: state.collisionSlots,
      successSlots: state.successSlots,
      totalArrivals: state.totalArrivals,
      succeededCount: succeededIds.size,
      pendingCount: pending.length,
      meanDelay,
      delays: [...state.delays].sort((a, b) => a.successSlot - b.successSlot),
      pending,
      finished: state.finished,
    };
  }

  exportRun(runId: string): unknown {
    const { state, model } = this.getRunState(runId);
    return {
      modelVersion: MODEL_VERSION,
      rngAlgorithm: RNG_ALGORITHM,
      model: {
        modelId: model.modelId,
        name: model.name,
        stations: model.stations,
        arrivals: model.arrivals,
        seed: model.seed,
        perStationQueueLimit: model.perStationQueueLimit,
        totalSlotBudget: model.totalSlotBudget,
      },
      state: JSON.parse(serializeState(state)),
      events: this.getHistory(runId),
      stats: this.stats(runId),
    };
  }
}
