import { ErrorCode, fail } from './errors.js';
import { createRngState, digest, next, type RngState } from './rng.js';
import type { Arrival, SlotEvent, Station } from './types.js';

export interface QueueItem {
  messageId: string;
  arrivalSlot: number;
}

export interface DelayRecord {
  messageId: string;
  stationId: string;
  arrivalSlot: number;
  successSlot: number;
  delay: number;
}

export interface RunState {
  runId: string;
  modelId: string;
  stations: Station[];
  /** 按到达时隙分组并规范化排序后的全部到达。 */
  arrivalsBySlot: Map<number, Arrival[]>;
  totalArrivals: number;
  queues: Map<string, QueueItem[]>;
  probabilities: Map<string, number>;
  /** 即将推进的时隙编号（从 0 开始）。 */
  currentSlot: number;
  rng: RngState;
  idleSlots: number;
  collisionSlots: number;
  successSlots: number;
  delays: DelayRecord[];
  perStationQueueLimit: number;
  totalSlotBudget: number;
  finished: boolean;
}

export interface CreateRunOptions {
  runId: string;
  modelId: string;
  stations: Station[];
  arrivals: Arrival[];
  seed: number;
  perStationQueueLimit: number;
  totalSlotBudget: number;
}

export function createRunState(opts: CreateRunOptions): RunState {
  const queues = new Map<string, QueueItem[]>();
  const probabilities = new Map<string, number>();
  const arrivalsBySlot = new Map<number, Arrival[]>();
  for (const s of opts.stations) {
    queues.set(s.stationId, []);
    probabilities.set(s.stationId, s.probability);
  }
  for (const a of opts.arrivals) {
    const list = arrivalsBySlot.get(a.arrivalSlot);
    if (list) list.push(a);
    else arrivalsBySlot.set(a.arrivalSlot, [a]);
  }
  return {
    runId: opts.runId,
    modelId: opts.modelId,
    stations: opts.stations,
    arrivalsBySlot,
    totalArrivals: opts.arrivals.length,
    queues,
    probabilities,
    currentSlot: 0,
    rng: createRngState(opts.seed),
    idleSlots: 0,
    collisionSlots: 0,
    successSlots: 0,
    delays: [],
    perStationQueueLimit: opts.perStationQueueLimit,
    totalSlotBudget: opts.totalSlotBudget,
    finished: false,
  };
}

/**
 * 推进一个时隙。返回事件与新状态（就地修改 state，由调用方在事务中持久化）。
 *
 * 顺序：
 * 1) 纳入本时隙到达（先检查队列预算，溢出则整体拒绝、不丢消息）。
 * 2) 站点编号升序：仅对非空站抽一次随机数；random < probability 才尝试。
 *    概率 0 永不尝试，概率 1 恒尝试；空站不抽样。
 * 3) 全部决定形成后统一裁决：0 个尝试=空闲，1 个=成功，>=2 个=碰撞。
 * 4) 仅成功移除队首；碰撞/未尝试保留。
 */
export function advanceOne(state: RunState): SlotEvent {
  if (state.finished) {
    fail(ErrorCode.RUN_FINISHED, '运行已达到总时隙预算，不能继续推进；如需新参数请新建运行', {
      runId: state.runId,
      slotsAdvanced: state.currentSlot,
      budget: state.totalSlotBudget,
    });
  }

  const slot = state.currentSlot;
  const arrivals = state.arrivalsBySlot.get(slot) ?? [];

  // 预算预检：任何一个站会溢出则整体拒绝，保持状态可解释且不静默丢消息。
  if (state.perStationQueueLimit > 0) {
    const incoming = new Map<string, number>();
    for (const a of arrivals) {
      incoming.set(a.stationId, (incoming.get(a.stationId) ?? 0) + 1);
    }
    for (const [stationId, count] of incoming) {
      const used = state.queues.get(stationId)!.length;
      if (used + count > state.perStationQueueLimit) {
        fail(
          ErrorCode.QUEUE_OVERFLOW,
          `站点 ${stationId} 将超过单站队列预算（现有 ${used} + 到达 ${count} > ${state.perStationQueueLimit}）`,
          { slot, stationId, used, incoming: count, limit: state.perStationQueueLimit },
        );
      }
    }
  }

  const arrivalIds: string[] = [];
  for (const a of arrivals) {
    state.queues.get(a.stationId)!.push({ messageId: a.messageId, arrivalSlot: a.arrivalSlot });
    arrivalIds.push(a.messageId);
  }

  const rngBefore = digest(state.rng);
  const sampledStations: string[] = [];
  const samples: number[] = [];
  const contenders: string[] = [];
  const sampleByStation = new Map<string, number>();

  // 先形成所有站的独立决定，不提前裁决。
  for (const station of state.stations) {
    const queue = state.queues.get(station.stationId)!;
    if (queue.length === 0) continue; // 空站不抽样
    const r = next(state.rng);
    state.rng = r.state;
    sampledStations.push(station.stationId);
    samples.push(r.value);
    sampleByStation.set(station.stationId, r.value);
    const probability = state.probabilities.get(station.stationId)!;
    if (r.value < probability) contenders.push(station.stationId);
  }

  let result: SlotEvent['result'];
  let winnerStation: string | null = null;
  let transmittedMessage: string | null = null;

  if (contenders.length === 0) {
    result = 'idle';
    state.idleSlots += 1;
  } else if (contenders.length === 1) {
    result = 'success';
    state.successSlots += 1;
    winnerStation = contenders[0]!;
    const head = state.queues.get(winnerStation)!.shift()!;
    transmittedMessage = head.messageId;
    state.delays.push({
      messageId: head.messageId,
      stationId: winnerStation,
      arrivalSlot: head.arrivalSlot,
      successSlot: slot,
      delay: slot - head.arrivalSlot + 1,
    });
  } else {
    result = 'collision';
    state.collisionSlots += 1;
  }

  state.currentSlot += 1;
  if (state.totalSlotBudget > 0 && state.currentSlot >= state.totalSlotBudget) {
    state.finished = true;
  }

  const queueLengths: Record<string, number> = {};
  for (const station of state.stations) {
    queueLengths[station.stationId] = state.queues.get(station.stationId)!.length;
  }

  return {
    runId: state.runId,
    slot,
    arrivals: arrivalIds,
    sampledStations,
    samples,
    contenders,
    result,
    transmittedMessage,
    winnerStation,
    queueLengths,
    rngBefore,
    rngAfter: digest(state.rng),
  };
}

export function advance(state: RunState, steps: number): SlotEvent[] {
  if (!Number.isInteger(steps) || steps <= 0) {
    fail(ErrorCode.INVALID_ARGUMENT, '推进步数必须是正整数', { steps });
  }
  const events: SlotEvent[] = [];
  for (let i = 0; i < steps; i++) events.push(advanceOne(state));
  return events;
}
