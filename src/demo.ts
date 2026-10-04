import { DatabaseSync } from 'node:sqlite';
import { migrate } from './db.js';
import { Service, type CreateModelInput } from './service.js';
import type { SlotEvent } from './types.js';

/**
 * 三个固定种子教学演示（全部使用内存数据库，互不影响持久数据）：
 * A. 单站、概率 1：消息逐条成功。
 * B. 两站、概率 1：连续碰撞。
 * C. 相同消息、较低概率：使用确定性挑选出的第一个能产生“成功”的种子，
 *    展示一次抽样让一站尝试、另一站按兵不动从而成功。
 */
export function runDemos(_db?: DatabaseSync): unknown {
  return runDemosSync();
}

function freshDb(): { db: DatabaseSync; svc: Service } {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return { db, svc: new Service(db) };
}

function build(svc: Service, seed: number, p: number, stations: string[], slots: number) {
  const input: CreateModelInput = {
    name: 'demo',
    stations: stations.map((stationId) => ({ stationId, probability: p })),
    arrivals: [
      { messageId: 'm1', stationId: stations[0], arrivalSlot: 0 },
      { messageId: 'm2', stationId: stations[1] ?? stations[0], arrivalSlot: 0 },
    ],
    seed,
    totalSlotBudget: slots,
  };
  const model = svc.createModel(input);
  const run = svc.createRun(model.modelId);
  const events = svc.store.advanceRun(run.runId, slots);
  return { model, run, stats: svc.store.stats(run.runId), events };
}

function runDemosSync() {
  // A. 单站概率 1
  const a = freshDb();
  const demoA = build(a.svc, 1, 1, ['S1'], 2);

  // B. 两站概率 1 连续碰撞
  const b = freshDb();
  const demoB = build(b.svc, 1, 1, ['S1', 'S2'], 2);

  // C. 相同消息，较低概率；确定性地找到首个在时隙 0 成功的种子。
  let chosenSeed = 0;
  let demoC: ReturnType<typeof build> | null = null;
  for (let seed = 0; seed < 100000; seed++) {
    const c = freshDb();
    const candidate = build(c.svc, seed, 0.5, ['S1', 'S2'], 1);
    if (candidate.events[0]!.result === 'success') {
      chosenSeed = seed;
      demoC = candidate;
      break;
    }
  }

  return {
    note: '理想时隙 ALOHA 教学模型；未成功消息仍在队列中等待，不等于丢失，也不保证有限步内发完。',
    demoA_singleStationProbability1: {
      expectation: '每个时隙唯一站尝试 -> success',
      seed: 1,
      results: demoA.events.map(simple),
    },
    demoB_twoStationsProbability1: {
      expectation: '两站每时隙同时尝试 -> collision',
      seed: 1,
      results: demoB.events.map(simple),
    },
    demoC_sameMessagesLowerProbability: {
      expectation: '概率 0.5 + 固定种子，首个时隙恰好一站尝试 -> success',
      seed: chosenSeed,
      results: (demoC as unknown as { events: SlotEvent[] }).events.map(simple),
    },
  };
}

function simple(e: SlotEvent) {
  return {
    slot: e.slot,
    sampledStations: e.sampledStations,
    samples: e.samples.map((x) => Number(x.toFixed(6))),
    contenders: e.contenders,
    result: e.result,
    transmittedMessage: e.transmittedMessage,
    queueLengths: e.queueLengths,
  };
}
