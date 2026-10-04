import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../dist/src/db.js';
import { Service } from '../dist/src/service.js';
import { advance, createRunState } from '../dist/src/engine.js';
import {
  normalizeArrivals,
  normalizeStations,
} from '../dist/src/normalize.js';

export function freshService() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return { db, svc: new Service(db) };
}

export function makeState({ seed, stations, arrivals, queueLimit = 0, budget = 0 }) {
  const st = normalizeStations(stations);
  const ar = normalizeArrivals(arrivals, st);
  return createRunState({
    runId: 'r',
    modelId: 'm',
    stations: st,
    arrivals: ar,
    seed,
    perStationQueueLimit: queueLimit,
    totalSlotBudget: budget,
  });
}

export { advance };
