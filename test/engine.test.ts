import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, ModelConfig } from "../src/model";
import { computeStats, initialRunState, RunState, stepOnce } from "../src/engine";
import { ApiError } from "../src/errors";

function model(input: Record<string, unknown>): ModelConfig {
  return buildModel(input, "m1", "2026-01-01T00:00:00.000Z");
}

test("p=0 永不尝试，全部空闲，消息保留", () => {
  const m = model({
    seed: 1,
    stations: [{ id: "A", probability: 0 }],
    arrivals: [{ stationId: "A", messageId: "x", arrivalSlot: 0 }],
  });
  let s: RunState = initialRunState("r1", m);
  for (let i = 0; i < 3; i++) {
    const r = stepOnce(m, s);
    s = r.state;
    assert.equal(r.event.result, "idle");
    assert.equal(r.event.contenders.length, 0);
  }
  assert.equal(s.queues["A"].length, 1);
  assert.equal(s.stats.succeeded.length, 0);
});

test("p=1 单站逐条成功，延迟=成功时隙-到达时隙+1", () => {
  const m = model({
    seed: 1,
    stations: [{ id: "A", probability: 1 }],
    arrivals: [
      { stationId: "A", messageId: "m1", arrivalSlot: 0 },
      { stationId: "A", messageId: "m2", arrivalSlot: 0 },
      { stationId: "A", messageId: "m3", arrivalSlot: 2 },
    ],
  });
  let s: RunState = initialRunState("r1", m);
  const r0 = stepOnce(m, s); s = r0.state;
  assert.equal(r0.event.result, "success");
  assert.equal(r0.event.successMessage?.messageId, "m1");
  assert.equal(r0.event.successMessage?.latency, 1);
  const r1 = stepOnce(m, s); s = r1.state;
  assert.equal(r1.event.successMessage?.messageId, "m2");
  assert.equal(r1.event.successMessage?.latency, 2); // 时隙1成功，到达0
  const r2 = stepOnce(m, s); s = r2.state;
  assert.equal(r2.event.successMessage?.messageId, "m3");
  assert.equal(r2.event.successMessage?.latency, 1); // 到达2成功2
  assert.equal(s.queues["A"].length, 0);
});

test("p=1 两站连续碰撞，消息不移除", () => {
  const m = model({
    seed: 7,
    stations: [
      { id: "A", probability: 1 },
      { id: "B", probability: 1 },
    ],
    arrivals: [
      { stationId: "A", messageId: "a", arrivalSlot: 0 },
      { stationId: "B", messageId: "b", arrivalSlot: 0 },
    ],
  });
  let s: RunState = initialRunState("r1", m);
  for (let i = 0; i < 4; i++) {
    const r = stepOnce(m, s);
    s = r.state;
    assert.equal(r.event.result, "collision");
    assert.deepEqual(r.event.contenders, ["A", "B"]);
  }
  assert.equal(s.queues["A"].length, 1);
  assert.equal(s.queues["B"].length, 1);
  assert.equal(s.stats.collisionSlots, 4);
});

test("空站不消耗随机数", () => {
  const m = model({
    seed: 123,
    stations: [
      { id: "A", probability: 0.5 },
      { id: "B", probability: 0.5 },
    ],
    arrivals: [{ stationId: "B", messageId: "b", arrivalSlot: 0 }],
  });
  let s: RunState = initialRunState("r1", m);
  const r = stepOnce(m, s);
  assert.equal(r.event.draws.length, 1);
  assert.equal(r.event.draws[0].stationId, "B");
  assert.equal(r.event.rng.draws, 1);
});

test("到达在时隙开始纳入，当站即可竞争", () => {
  const m = model({
    seed: 1,
    stations: [{ id: "A", probability: 1 }],
    arrivals: [{ stationId: "A", messageId: "late", arrivalSlot: 3 }],
  });
  let s: RunState = initialRunState("r1", m);
  for (let i = 0; i < 3; i++) {
    const r = stepOnce(m, s);
    s = r.state;
    assert.equal(r.event.result, "idle");
    assert.equal(r.event.draws.length, 0);
  }
  const r3 = stepOnce(m, s);
  assert.equal(r3.event.result, "success");
  assert.equal(r3.event.arrivals.length, 1);
});

test("统一裁决：前一站的成功不影响后一站本时隙的决定", () => {
  // 两站 p=1 同时到达 -> 碰撞而非 A 成功后 B 独占
  const m = model({
    seed: 9,
    stations: [
      { id: "A", probability: 1 },
      { id: "B", probability: 1 },
    ],
    arrivals: [
      { stationId: "A", messageId: "a", arrivalSlot: 0 },
      { stationId: "B", messageId: "b", arrivalSlot: 0 },
    ],
  });
  const r = stepOnce(m, initialRunState("r1", m));
  assert.equal(r.event.result, "collision");
  assert.equal(r.event.draws.length, 2);
});

test("校验：重复站点/消息、负时间、非整数时隙、非法概率", () => {
  assert.throws(
    () => model({ seed: 1, stations: [{ id: "A", probability: 0.5 }, { id: "A", probability: 0.5 }] }),
    (e: unknown) => e instanceof ApiError && e.code === "E_DUP_STATION"
  );
  assert.throws(
    () =>
      model({
        seed: 1,
        stations: [{ id: "A", probability: 0.5 }],
        arrivals: [
          { stationId: "A", messageId: "x", arrivalSlot: 0 },
          { stationId: "A", messageId: "x", arrivalSlot: 1 },
        ],
      }),
    (e: unknown) => e instanceof ApiError && e.code === "E_DUP_MESSAGE"
  );
  assert.throws(
    () =>
      model({
        seed: 1,
        stations: [{ id: "A", probability: 0.5 }],
        arrivals: [{ stationId: "A", messageId: "x", arrivalSlot: -1 }],
      }),
    (e: unknown) => e instanceof ApiError && e.code === "E_NEGATIVE_TIME"
  );
  assert.throws(
    () =>
      model({
        seed: 1,
        stations: [{ id: "A", probability: 0.5 }],
        arrivals: [{ stationId: "A", messageId: "x", arrivalSlot: 1.5 }],
      }),
    (e: unknown) => e instanceof ApiError && e.code === "E_NON_INTEGER_SLOT"
  );
  assert.throws(
    () => model({ seed: 1, stations: [{ id: "A", probability: 1.5 }] }),
    (e: unknown) => e instanceof ApiError && e.code === "E_BAD_PROBABILITY"
  );
});

test("规范化：输入列表顺序不影响规范模型", () => {
  const a = model({
    seed: 5,
    stations: [
      { id: "B", probability: 0.2 },
      { id: "A", probability: 0.9 },
    ],
    arrivals: [
      { stationId: "B", messageId: "b1", arrivalSlot: 2 },
      { stationId: "A", messageId: "a1", arrivalSlot: 0 },
    ],
  });
  const b = model({
    seed: 5,
    stations: [
      { id: "A", probability: 0.9 },
      { id: "B", probability: 0.2 },
    ],
    arrivals: [
      { stationId: "A", messageId: "a1", arrivalSlot: 0 },
      { stationId: "B", messageId: "b1", arrivalSlot: 2 },
    ],
  });
  assert.deepEqual(a.stations, b.stations);
  assert.deepEqual(a.arrivals, b.arrivals);
});

test("统计守恒：到达=成功+待发，三类时隙之和=推进步数，延迟来自真实事件", () => {
  const m = model({
    seed: 20241001,
    stations: [
      { id: "A", probability: 0.3 },
      { id: "B", probability: 0.3 },
    ],
    arrivals: [
      { stationId: "A", messageId: "a1", arrivalSlot: 0 },
      { stationId: "B", messageId: "b1", arrivalSlot: 0 },
      { stationId: "A", messageId: "a2", arrivalSlot: 5 },
    ],
  });
  let s: RunState = initialRunState("r1", m);
  const events: import("../src/engine").SlotEvent[] = [];
  for (let i = 0; i < 30; i++) {
    const r = stepOnce(m, s);
    s = r.state;
    events.push(r.event);
  }
  const st = computeStats(m, s);
  assert.equal(st.totalArrivals, st.successCount + st.waitingCount);
  assert.equal(st.idleSlots + st.collisionSlots + st.successSlots, st.totalSlots);
  for (const succ of st.successes) {
    const ev = events[succ.successSlot];
    assert.equal(ev.result, "success");
    assert.equal(ev.successMessage?.messageId, succ.messageId);
    assert.equal(succ.latency, succ.successSlot - succ.arrivalSlot + 1);
  }
});

test("队列上限：超限终止并保留可解释状态", () => {
  const m = model({
    seed: 1,
    stations: [{ id: "A", probability: 0 }],
    arrivals: [
      { stationId: "A", messageId: "m1", arrivalSlot: 0 },
      { stationId: "A", messageId: "m2", arrivalSlot: 1 },
      { stationId: "A", messageId: "m3", arrivalSlot: 2 },
    ],
    maxQueuePerStation: 2,
  });
  let s: RunState = initialRunState("r1", m);
  s = stepOnce(m, s).state;
  s = stepOnce(m, s).state;
  assert.throws(
    () => stepOnce(m, s),
    (e: unknown) => {
      const err = e as ApiError & { overflowState?: RunState };
      assert.ok(err instanceof ApiError && err.code === "E_QUEUE_OVERFLOW");
      assert.equal(err.overflowState?.status, "queue_overflow");
      assert.ok(err.overflowState?.statusReason?.includes("超过上限"));
      return true;
    }
  );
});

test("时隙预算：达到 maxSlots 抛 E_BUDGET_EXHAUSTED", () => {
  const m = model({
    seed: 1,
    stations: [{ id: "A", probability: 1 }],
    arrivals: [],
    maxSlots: 2,
  });
  let s: RunState = initialRunState("r1", m);
  s = stepOnce(m, s).state;
  s = stepOnce(m, s).state;
  assert.throws(
    () => stepOnce(m, s),
    (e: unknown) => e instanceof ApiError && e.code === "E_BUDGET_EXHAUSTED"
  );
});

