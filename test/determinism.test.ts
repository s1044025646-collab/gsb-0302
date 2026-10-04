import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store";
import { ApiError } from "../src/errors";

function tmpStore(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aloha-test-"));
  return { store: new Store({ dataDir: dir }), dir };
}

const MODEL_INPUT = {
  name: "det",
  seed: 7,
  stations: [
    { id: "A", probability: 0.3 },
    { id: "B", probability: 0.3 },
  ],
  arrivals: [
    { stationId: "A", messageId: "a1", arrivalSlot: 0 },
    { stationId: "B", messageId: "b1", arrivalSlot: 0 },
    { stationId: "A", messageId: "a2", arrivalSlot: 4 },
    { stationId: "B", messageId: "b2", arrivalSlot: 7 },
  ],
  maxSlots: 50,
};

test("固定种子夹具：一段推进 vs 分段推进+重启，完整日志一致", () => {
  // 一次性推进 20 步
  const { store: s1 } = tmpStore();
  const m1 = s1.createModel(MODEL_INPUT);
  const r1 = s1.createRun(m1.id);
  s1.step(r1.runId, 20);
  const log1 = s1.history(r1.runId);
  const state1 = s1.getRun(r1.runId);
  s1.close();

  // 分段推进，且每段之间关闭并重开数据库（模拟重启）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aloha-test-"));
  let runId = "";
  for (const seg of [3, 7, 4, 6]) {
    const store = new Store({ dataDir: dir });
    if (!runId) {
      const m = store.createModel(MODEL_INPUT);
      runId = store.createRun(m.id).runId;
    }
    store.step(runId, seg);
    store.close();
  }
  const s2 = new Store({ dataDir: dir });
  const log2 = s2.history(runId);
  const state2 = s2.getRun(runId);
  s2.close();

  assert.deepEqual(log2, log1);
  const strip = (s: typeof state1) => { const { runId, modelId, ...rest } = s; return rest; };
  assert.deepEqual(strip(state2), strip(state1));
  assert.equal(log1.length, 20);
});

test("固定种子夹具：两站 p=0.3 出现成功与碰撞，随机序列可复现", () => {
  const { store } = tmpStore();
  const m = store.createModel(MODEL_INPUT);
  const run = store.createRun(m.id);
  store.step(run.runId, 20);
  const events = store.history(run.runId);
  const results = events.map((e) => e.result);
  assert.ok(results.includes("success"), "应至少有一次成功");
  assert.ok(results.includes("collision"), "应至少有一次碰撞");
  // 再次同种子运行，结果序列一致
  const m2 = store.createModel(MODEL_INPUT);
  const run2 = store.createRun(m2.id);
  store.step(run2.runId, 20);
  assert.deepEqual(
    store.history(run2.runId).map((e) => [e.result, e.contenders, e.rng.draws]),
    events.map((e) => [e.result, e.contenders, e.rng.draws])
  );
  store.close();
});

test("模型冻结：存在运行后导入到达表被拒绝", () => {
  const { store } = tmpStore();
  const m = store.createModel(MODEL_INPUT);
  store.importArrivals(m.id, [{ stationId: "A", messageId: "a9", arrivalSlot: 9 }]);
  store.createRun(m.id);
  assert.throws(
    () => store.importArrivals(m.id, [{ stationId: "A", messageId: "a10", arrivalSlot: 10 }]),
    (e: unknown) => e instanceof ApiError && e.code === "E_MODEL_FROZEN"
  );
  store.close();
});

test("事件与状态原子落盘：推进后事件数与 currentSlot 一致", () => {
  const { store } = tmpStore();
  const m = store.createModel(MODEL_INPUT);
  const run = store.createRun(m.id);
  store.step(run.runId, 15);
  assert.equal(store.history(run.runId).length, 15);
  assert.equal(store.getRun(run.runId).currentSlot, 15);
  assert.equal(store.getSlot(run.runId, 14).slot, 14);
  assert.throws(() => store.getSlot(run.runId, 15), (e: unknown) => e instanceof ApiError && e.code === "E_NOT_FOUND");
  store.close();
});


