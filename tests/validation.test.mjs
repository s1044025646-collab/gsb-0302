import test from 'node:test';
import assert from 'node:assert/strict';
import { freshService } from './helpers.mjs';
import { AppError } from '../dist/src/errors.js';

function expectError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof AppError, '应为 AppError');
    assert.equal(err.code, code);
    return true;
  });
}

test('重复站点报错', () => {
  const { svc } = freshService();
  expectError(
    () => svc.createModel({ stations: [{ stationId: 'A' }, { stationId: 'A' }], probability: 0.5 }),
    'DUPLICATE_STATION',
  );
});

test('重复消息报错', () => {
  const { svc } = freshService();
  expectError(
    () =>
      svc.createModel({
        stations: [{ stationId: 'A' }],
        probability: 0.5,
        arrivals: [
          { messageId: 'm1', stationId: 'A', arrivalSlot: 0 },
          { messageId: 'm1', stationId: 'A', arrivalSlot: 1 },
        ],
      }),
    'DUPLICATE_MESSAGE',
  );
});

test('负时间与非整数时隙报错', () => {
  const { svc } = freshService();
  const base = { stations: [{ stationId: 'A' }], probability: 0.5 };
  expectError(
    () => svc.createModel({ ...base, arrivals: [{ messageId: 'm', stationId: 'A', arrivalSlot: -1 }] }),
    'INVALID_SLOT',
  );
  expectError(
    () => svc.createModel({ ...base, arrivals: [{ messageId: 'm', stationId: 'A', arrivalSlot: 1.5 }] }),
    'INVALID_SLOT',
  );
});

test('非法概率报错（0/1 边界合法）', () => {
  const { svc } = freshService();
  expectError(() => svc.createModel({ stations: [{ stationId: 'A' }], probability: 1.2 }), 'INVALID_PROBABILITY');
  expectError(() => svc.createModel({ stations: [{ stationId: 'A' }], probability: -0.1 }), 'INVALID_PROBABILITY');
  const m = svc.createModel({
    stations: [{ stationId: 'A', probability: 0 }, { stationId: 'B', probability: 1 }],
  });
  assert.equal(m.stations.length, 2);
});

test('引用未知站点报错', () => {
  const { svc } = freshService();
  expectError(
    () =>
      svc.createModel({
        stations: [{ stationId: 'A' }],
        probability: 0.5,
        arrivals: [{ messageId: 'm', stationId: 'Z', arrivalSlot: 0 }],
      }),
    'UNKNOWN_STATION',
  );
});

test('队列预算超限：整体拒绝、不丢消息', () => {
  const { svc } = freshService();
  const model = svc.createModel({
    stations: [{ stationId: 'A' }],
    probability: 1,
    seed: 1,
    perStationQueueLimit: 1,
  });
  // m1 概率1在时隙0成功，时隙1空闲；时隙2两条同时到达超过单站队列 1 -> 溢出
  svc.importArrivals(model.modelId, [
    { messageId: 'm1', stationId: 'A', arrivalSlot: 0 },
    { messageId: 'm2', stationId: 'A', arrivalSlot: 2 },
    { messageId: 'm3', stationId: 'A', arrivalSlot: 2 },
  ]);
  const run = svc.createRun(model.modelId);
  svc.store.advanceRun(run.runId, 2);
  assert.throws(() => svc.store.advanceRun(run.runId, 1), (err) => err.code === 'QUEUE_OVERFLOW');
  const stats = svc.store.stats(run.runId);
  // 溢出时隙被事务回滚：m1 已成功，m2/m3 未纳入，状态停在时隙 2
  assert.equal(stats.succeededCount, 1);
  assert.equal(stats.pendingCount, 0);
  assert.equal(stats.slotsAdvanced, 2);
});

test('运行创建后到达表锁定', () => {
  const { svc } = freshService();
  const model = svc.createModel({ stations: [{ stationId: 'A' }], probability: 0.5 });
  svc.createRun(model.modelId);
  expectError(
    () => svc.importArrivals(model.modelId, [{ messageId: 'm', stationId: 'A', arrivalSlot: 0 }]),
    'RUN_LOCKED',
  );
});

test('空站点集合报错', () => {
  const { svc } = freshService();
  expectError(() => svc.createModel({ stations: [] }), 'EMPTY_STATIONS');
});
