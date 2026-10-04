import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { RNG_ALGORITHM } from './rng.js';

export const MODEL_VERSION = 'slotted-aloha-1.0.0';

export function openDatabase(dbPath: string): DatabaseSync {
  const full = isAbsolute(dbPath) ? dbPath : resolve(process.cwd(), dbPath);
  mkdirSync(dirname(full), { recursive: true });
  const db = new DatabaseSync(full);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS models (
    model_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    stations_json TEXT NOT NULL,
    seed INTEGER NOT NULL,
    per_station_queue_limit INTEGER NOT NULL,
    total_slot_budget INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS arrivals (
    model_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    station_id TEXT NOT NULL,
    arrival_slot INTEGER NOT NULL,
    PRIMARY KEY (model_id, message_id),
    FOREIGN KEY (model_id) REFERENCES models(model_id)
  );
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0,
    state_json TEXT NOT NULL,
    FOREIGN KEY (model_id) REFERENCES models(model_id)
  );
  CREATE TABLE IF NOT EXISTS events (
    run_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    PRIMARY KEY (run_id, slot),
    FOREIGN KEY (run_id) REFERENCES runs(run_id)
  );
  `);
  db.prepare(
    'INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)',
  ).run('model_version', MODEL_VERSION);
  db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run(
    'rng_algorithm',
    RNG_ALGORITHM,
  );
}
