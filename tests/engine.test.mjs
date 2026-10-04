import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, makeState } from './helpers.mjs';

test('概率 0：有消息也永不发送，时隙全空闲，消息仍等待', () => {
  const state = makeState({
    seed: 42,
    stations: [{ stationId: 'A', probability: 0 }],
    arrivals: [{ messageId: 'm1', stationId: 'A', arrivalSlot: 0 }],
  });
  const events = advance(state, 3);
  assert.deepEqual(events.map((e) => e.result), ['idle', 'idle', 'idle']);
  assert.deepEqual(events.map((e) => e.contenders), [[], [], []]);
  assert.equal(state.queues.get('A').length, 1);
});

test('概率 1：单站逐条成功，延迟=成功时隙-到达时隙+1', () => {
  const state = makeState({
    seed: 7,
    stations: [{ stationId: 'A', probability: 1 }],
    arrivals: [
      { messageId: 'm1', stationId: 'A', arrivalSlot: 0 },
      { messageId: 'm2', stationId: 'A', arrivalSlot: 1 },
    ],
  });
  const events = advance(state, 2);
  assert.deepEqual(events.map((e) => e.result), ['success', 'success']);
  assert.deepEqual(state.delays.map((d) => d.delay), [1, 1]);
  assert.equal(events[1].transmittedMessage, 'm2');
});

test('概率 1：两站每时隙同时尝试 -> 连续碰撞，队列都保留', () => {
  const state = makeState({
    seed: 1,
    stations: [{ stationId: 'A', probability: 1 }, { stationId: 'B', probability: 1 }],
    arrivals: [
      { messageId: 'a1', stationId: 'A', arrivalSlot: 0 },
      { messageId: 'b1', stationId: 'B', arrivalSlot: 0 },
    ],
  });
  const events = advance(state, 2);
  assert.deepEqual(events.map((e) => e.result), ['collision', 'collision']);
  assert.equal(state.queues.get('A').length, 1);
  assert.equal(state.queues.get('B').length, 1);
});

test('到达在时隙开始先纳入，再裁决：时隙 0 到达即可竞争', () => {
  const state = makeState({
    seed: 1,
    stations: [{ stationId: 'A', probability: 1 }],
    arrivals: [{ messageId: 'm1', stationId: 'A', arrivalSlot: 0 }],
  });
  const [e0] = advance(state, 1);
  assert.deepEqual(e0.arrivals, ['m1']);
  assert.equal(e0.result, 'success');
});

test('统一裁决：前站不影响后站本时隙决定（按编号顺序各抽一次）', () => {
  // 概率 0.5 固定种子，检查两个非空站都被抽样，且决定在裁决前同时形成。
  const state = makeState({
    seed: 123,
    stations: [{ stationId: 'A', probability: 0.5 }, { stationId: 'B', probability: 0.5 }],
    arrivals: [
      { messageId: 'a1', stationId: 'A', arrivalSlot: 0 },
      { messageId: 'b1', stationId: 'B', arrivalSlot: 0 },
    ],
  });
  const [e] = advance(state, 1);
  assert.deepEqual(e.sampledStations, ['A', 'B']);
  assert.equal(e.samples.length, 2);
  // contenders 与 samples<p 的逻辑一致
  const expected = ['A', 'B'].filter((id, i) => e.samples[i] < 0.5);
  assert.deepEqual(e.contenders, expected);
  assert.ok(['success', 'collision', 'idle'].includes(e.result));
});

test('空站不消耗随机数', () => {
  const empty = makeState({
    seed: 99,
    stations: [{ stationId: 'A', probability: 0.5 }, { stationId: 'B', probability: 0.5 }],
    arrivals: [{ messageId: 'a1', stationId: 'A', arrivalSlot: 0 }],
  });
  const [e] = advance(empty, 1);
  assert.deepEqual(e.sampledStations, ['A']); // B 为空，不抽样
  assert.equal(e.samples.length, 1);
  assert.equal(empty.rng.draws, 1);

  // 与“单站模型”同种子同序列对齐：B 不参与时 A 抽到的值必须一致
  const onlyA = makeState({
    seed: 99,
    stations: [{ stationId: 'A', probability: 0.5 }],
    arrivals: [{ messageId: 'a1', stationId: 'A', arrivalSlot: 0 }],
  });
  const [e2] = advance(onlyA, 1);
  assert.equal(e.samples[0], e2.samples[0]);
});

test('列表顺序规范化不改变随机序列', () => {
  const s1 = makeState({
    seed: 5,
    stations: [{ stationId: 'B', probability: 0.5 }, { stationId: 'A', probability: 0.5 }],
    arrivals: [
      { messageId: 'b1', stationId: 'B', arrivalSlot: 0 },
      { messageId: 'a1', stationId: 'A', arrivalSlot: 0 },
    ],
  });
  const s2 = makeState({
    seed: 5,
    stations: [{ stationId: 'A', probability: 0.5 }, { stationId: 'B', probability: 0.5 }],
    arrivals: [
      { messageId: 'a1', stationId: 'A', arrivalSlot: 0 },
      { messageId: 'b1', stationId: 'B', arrivalSlot: 0 },
    ],
  });
  const ev1 = advance(s1, 3);
  const ev2 = advance(s2, 3);
  assert.deepEqual(ev1, ev2);
});

test('失败消息用相同固定概率重试，无退避（连续碰撞后仍概率 1 立即成功的对照）', () => {
  // 站 A 概率 1，时隙 0 碰撞（与 B），B 时隙 1 为空场景不成立，故构造 B 仅时隙 0 有队首但成功后清空。
  const state = makeState({
    seed: 3,
    stations: [{ stationId: 'A', probability: 1 }, { stationId: 'B', probability: 1 }],
    arrivals: [
      { messageId: 'a1', stationId: 'A', arrivalSlot: 0 },
      { messageId: 'b1', stationId: 'B', arrivalSlot: 0 },
    ],
  });
  advance(state, 1); // collision
  // 两队列都在，无退避：依旧都尝试
  const [e2] = advance(state, 1);
  assert.equal(e2.result, 'collision');
});
