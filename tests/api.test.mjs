import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../dist/src/db.js';
import { startServer } from '../dist/src/server.js';

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'aloha-api-'));
  void dir;
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const { server, port } = await startServer(db);
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, init) => {
    const res = await fetch(base + path, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
    const body = await res.json();
    return { status: res.status, body };
  };
  const close = () => new Promise((r) => server.close(r));
  return { call, close };
}

test('HTTP API 端到端：建模->运行->推进->时隙/统计/历史/导出', async () => {
  const { call, close } = await harness();
  try {
    const created = await call('/api/models', {
      method: 'POST',
      body: JSON.stringify({
        name: 'api',
        seed: 11,
        stations: [{ stationId: 'A', probability: 1 }, { stationId: 'B', probability: 0.5 }],
        arrivals: [
          { messageId: 'a1', stationId: 'A', arrivalSlot: 0 },
          { messageId: 'b1', stationId: 'B', arrivalSlot: 0 },
        ],
        totalSlotBudget: 4,
      }),
    });
    assert.equal(created.status, 200);
    const modelId = created.body.modelId;

    const listed = await call('/api/models');
    assert.equal(listed.body.length, 1);

    const run = await call(`/api/models/${modelId}/runs`, { method: 'POST' });
    const runId = run.body.runId;

    const adv = await call(`/api/runs/${runId}/advance`, {
      method: 'POST',
      body: JSON.stringify({ steps: 3 }),
    });
    assert.equal(adv.body.events.length, 3);

    const slot = await call(`/api/runs/${runId}/slots/0`);
    assert.equal(slot.body.slot, 0);
    assert.ok(['success', 'collision', 'idle'].includes(slot.body.result));

    const stats = await call(`/api/runs/${runId}/stats`);
    assert.equal(stats.body.slotsAdvanced, 3);
    assert.equal(
      stats.body.idleSlots + stats.body.collisionSlots + stats.body.successSlots,
      3,
    );

    const history = await call(`/api/runs/${runId}/history`);
    assert.equal(history.body.events.length, 3);

    const exported = await call(`/api/runs/${runId}/export`);
    assert.equal(exported.body.modelVersion, 'slotted-aloha-1.0.0');
    assert.equal(exported.body.rngAlgorithm, 'mulberry32-v1');
  } finally {
    await close();
  }
});

test('HTTP API 返回结构化错误码', async () => {
  const { call, close } = await harness();
  try {
    const bad = await call('/api/models', {
      method: 'POST',
      body: JSON.stringify({ stations: [{ stationId: 'X' }], probability: 2 }),
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_PROBABILITY');
  } finally {
    await close();
  }
});
