import { Store } from "./store";
import { computeStats } from "./engine";

/**
 * 三个固定种子演示场景：
 * 1) 单站 p=1：逐条成功，延迟恒为 1
 * 2) 两站 p=1：连续碰撞，无成功
 * 3) 两站 p=0.3 固定种子：相同消息在较低概率下出现成功
 */
export function runDemo(store: Store): void {
  const out = (s: string) => process.stdout.write(s + "\n");

  out("=== 场景 1：单站 p=1，逐条成功 ===");
  const m1 = store.createModel({
    name: "demo-1-single-p1",
    seed: 42,
    stations: [{ id: "A", probability: 1 }],
    arrivals: [
      { stationId: "A", messageId: "m1", arrivalSlot: 0 },
      { stationId: "A", messageId: "m2", arrivalSlot: 1 },
      { stationId: "A", messageId: "m3", arrivalSlot: 2 },
    ],
    maxSlots: 10,
  });
  const r1 = store.createRun(m1.id);
  store.step(r1.runId, 5);
  printStats(store, m1.id, r1.runId, out);

  out("\n=== 场景 2：两站 p=1，连续碰撞 ===");
  const m2 = store.createModel({
    name: "demo-2-two-p1",
    seed: 42,
    stations: [
      { id: "A", probability: 1 },
      { id: "B", probability: 1 },
    ],
    arrivals: [
      { stationId: "A", messageId: "a1", arrivalSlot: 0 },
      { stationId: "B", messageId: "b1", arrivalSlot: 0 },
    ],
    maxSlots: 10,
  });
  const r2 = store.createRun(m2.id);
  store.step(r2.runId, 5);
  printStats(store, m2.id, r2.runId, out);

  out("\n=== 场景 3：两站 p=0.3，固定种子 7，相同消息最终成功 ===");
  const m3 = store.createModel({
    name: "demo-3-two-p03",
    seed: 7,
    stations: [
      { id: "A", probability: 0.3 },
      { id: "B", probability: 0.3 },
    ],
    arrivals: [
      { stationId: "A", messageId: "a1", arrivalSlot: 0 },
      { stationId: "B", messageId: "b1", arrivalSlot: 0 },
    ],
    maxSlots: 100,
  });
  const r3 = store.createRun(m3.id);
  store.step(r3.runId, 20);
  for (const ev of store.history(r3.runId)) {
    out(
      `  时隙 ${ev.slot}: 竞争=[${ev.contenders.join(",")}] 结果=${ev.result}` +
        (ev.successMessage ? ` 成功=${ev.successMessage.stationId}/${ev.successMessage.messageId} 延迟=${ev.successMessage.latency}` : "")
    );
  }
  printStats(store, m3.id, r3.runId, out);
}

function printStats(store: Store, modelId: string, runId: string, out: (s: string) => void): void {
  const state = store.getRun(runId);
  const model = store.getModel(modelId);
  const s = computeStats(model, state);
  out(
    `  推进 ${s.totalSlots} 时隙: 空闲=${s.idleSlots} 碰撞=${s.collisionSlots} 成功时隙=${s.successSlots}` +
      ` 成功消息=${s.successCount} 待发=${s.waitingCount} 平均延迟=${s.meanLatency ?? "无"}`
  );
}

