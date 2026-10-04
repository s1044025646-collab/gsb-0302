import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Store, type ModelConfig } from './store.js';
import {
  normalizeArrivals,
  normalizeLimit,
  normalizeProbability,
  normalizeStations,
} from './normalize.js';
import { normalizeSeed } from './rng.js';
import type { Arrival, Station } from './types.js';

export interface CreateModelInput {
  name?: unknown;
  stations?: unknown;
  /** 站点统一概率（当站点对象未单独给出时使用）。 */
  probability?: unknown;
  arrivals?: unknown;
  seed?: unknown;
  perStationQueueLimit?: unknown;
  totalSlotBudget?: unknown;
}

export class Service {
  readonly store: Store;
  constructor(db: DatabaseSync) {
    this.store = new Store(db);
  }

  createModel(input: CreateModelInput): ModelConfig {
    const stations = normalizeStations(input.stations, input.probability);
    const arrivals = normalizeArrivals(input.arrivals, stations);
    const seed = normalizeSeed(input.seed ?? 0);
    const cfg: ModelConfig = {
      modelId: randomUUID(),
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'model',
      stations,
      seed,
      perStationQueueLimit: normalizeLimit(input.perStationQueueLimit, 'perStationQueueLimit'),
      totalSlotBudget: normalizeLimit(input.totalSlotBudget, 'totalSlotBudget'),
      arrivals,
      createdAt: new Date().toISOString(),
    };
    this.store.createModel(cfg);
    return cfg;
  }

  importArrivals(modelId: string, arrivals: unknown): number {
    const model = this.store.getModelConfig(modelId);
    const normalized = normalizeArrivals(arrivals, model.stations);
    return this.store.replaceArrivals(modelId, normalized);
  }

  createRun(modelId: string): { runId: string; createdAt: string } {
    this.store.getModelConfig(modelId);
    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    this.store.createRun(runId, modelId, createdAt);
    return { runId, createdAt };
  }
}

export type { Arrival, Station };

/** 供 CLI / API 复用的概率规范化。 */
export function asProbability(p: unknown): number {
  return normalizeProbability(p);
}
