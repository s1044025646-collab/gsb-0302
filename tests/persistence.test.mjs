import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../dist/src/db.js';
import { Service } from '../dist/src/service.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aloha-'));
  const path = join(dir, 'aloha.sqlite');
  return { dir, path, svc: new Service(openDatabase(path)) };
}

const modelInput = {
  name: 'p',
  seed: 2024,
  stations: [
    { stationId: 'A', probability: 0.5 },
    { stationId: 'B', probability: 0.5 },
  ],
  arrivals: [
    { messageId: 'a1', stationId: 'A', arrivalSlot: 0 },
    { messageId: 'b1', stationId: 'B', arrivalSlot: 0 },
    { messageId: 'a2', stationId: 'A', arrivalSlot: 1 },
  ],
  totalSlotBudget: 8,
};

test('一次性推进 与 分段推进+重启 得到完全相同事件与统计', () => {
  // 一次性
  const one = setup();
  const m1 = one.svc.createModel(modelInput);
  const r1 = one.svc.createRun(m1.modelId);
  const allEvents = one.svc.store.advanceRun(r1.runId, 8);
  const allStats = one.svc.store.stats(r1.runId);

  // 分段 + 每次重新打开数据库（模拟重启继续）
  const seg = setup();
  const m2 = seg.svc.createModel(modelInput);
  const r2 = seg.svc.createRun(m2.modelId);
  let svc = seg.svc;
  svc.store.db?.close?.();
  const chunks = [1, 2, 1, 4];
  for (const n of chunks) {
    svc = new Service(openDatabase(seg.path));
    svc.store.advanceRun(r2.runId, n);
  }
  svc = new Service(openDatabase(seg.path));
  const segEvents = svc.store.getHistory(r2.runId);
  const segStats = svc.store.stats(r2.runId);

  assert.equal(segEvents.length, 8);
  const stripRunId = (e) => {
    const { runId, ...rest } = e;
    void runId;
    return rest;
  };
  assert.deepEqual(segEvents.map(stripRunId), allEvents.map(stripRunId));
  const stripRunIds = (s) => {
    const { runId, ...rest } = s;
    void runId;
    return rest;
  };
  assert.deepEqual(stripRunIds(segStats), stripRunIds(allStats));
  // 随机状态摘要链路一致
  for (let i = 1; i < segEvents.length; i++) {
    assert.equal(segEvents[i].rngBefore, segEvents[i - 1].rngAfter);
  }
});

test('不变量：到达总数 = 成功 + 待发；三类时隙之和 = 推进步数', () => {
  const { svc } = setup();
  const m = svc.createModel(modelInput);
  const r = svc.createRun(m.modelId);
  svc.store.advanceRun(r.runId, 8);
  const s = svc.store.stats(r.runId);
  assert.equal(s.totalArrivals, s.succeededCount + s.pendingCount);
  assert.equal(s.idleSlots + s.collisionSlots + s.successSlots, s.slotsAdvanced);
});

test('延迟来自真实事件：统计延迟与成功事件一致，等待消息不混入均值', () => {
  const { svc } = setup();
  const m = svc.createModel({
    seed: 0,
    stations: [{ stationId: 'A', probability: 0.3 }],
    arrivals: [
      { messageId: 'm1', stationId: 'A', arrivalSlot: 0 },
      { messageId: 'm2', stationId: 'A', arrivalSlot: 0 },
    ],
    totalSlotBudget: 6,
  });
  const r = svc.createRun(m.modelId);
  svc.store.advanceRun(r.runId, 6);
  const stats = svc.store.stats(r.runId);
  const events = svc.store.getHistory(r.runId);
  const successEvents = events.filter((e) => e.result === 'success');
  assert.equal(stats.delays.length, successEvents.length);
  for (const d of stats.delays) {
    const ev = successEvents.find((e) => e.transmittedMessage === d.messageId);
    assert.ok(ev);
    assert.equal(d.delay, d.successSlot - d.arrivalSlot + 1);
    assert.equal(ev.slot, d.successSlot);
  }
  const expectedMean =
    stats.delays.length === 0 ? null : stats.delays.reduce((x, d) => x + d.delay, 0) / stats.delays.length;
  assert.equal(stats.meanDelay, expectedMean);
});
