import { ApiError } from "./errors";
import { Arrival, ModelConfig } from "./model";
import { Rng, RngSnapshot } from "./rng";

export interface QueuedMessage {
  stationId: string;
  messageId: string;
  arrivalSlot: number;
}

export interface StationDraw {
  stationId: string;
  random: number;
  probability: number;
  attempted: boolean;
}

export type SlotResult = "idle" | "success" | "collision";

export interface SlotEvent {
  slot: number;
  arrivals: QueuedMessage[]; // 本时隙到达并入队的消息
  draws: StationDraw[]; // 本时隙抽样明细（仅非空站，按站点编号升序）
  contenders: string[]; // 实际尝试发送的站
  result: SlotResult;
  successMessage: (QueuedMessage & { latency: number }) | null;
  queueLengths: Record<string, number>; // 时隙结束后的各站队列长度
  rng: RngSnapshot; // 时隙结束后的随机状态摘要
}

export type RunStatus = "running" | "finished" | "budget_exhausted" | "queue_overflow";

export interface RunState {
  runId: string;
  modelId: string;
  status: RunStatus;
  statusReason: string | null;
  currentSlot: number; // 下一个要推进的时隙
  queues: Record<string, QueuedMessage[]>; // stationId -> FIFO 队列
  rng: RngSnapshot;
  stats: {
    slotsAdvanced: number;
    idleSlots: number;
    collisionSlots: number;
    successSlots: number;
    succeeded: { stationId: string; messageId: string; arrivalSlot: number; successSlot: number; latency: number }[];
  };
}

export function initialRunState(runId: string, model: ModelConfig): RunState {
  const queues: Record<string, QueuedMessage[]> = {};
  for (const s of model.stations) queues[s.id] = [];
  return {
    runId,
    modelId: model.id,
    status: "running",
    statusReason: null,
    currentSlot: 0,
    queues,
    rng: Rng.create(model.seed).snapshot(),
    stats: { slotsAdvanced: 0, idleSlots: 0, collisionSlots: 0, successSlots: 0, succeeded: [] },
  };
}

function rngFromSnapshot(s: RngSnapshot): Rng {
  return Rng.restore(s.seed, s.state, s.draws);
}

/**
 * 推进一个时隙。纯函数：给定模型与运行状态，返回新状态与本时隙事件。
 * 顺序：1) 纳入本时隙到达；2) 按站点编号升序对每个非空站抽一次随机数并各自独立决定；
 * 3) 全部决定形成后统一裁决；4) 成功才移除队首。
 */
export function stepOnce(
  model: ModelConfig,
  state: RunState
): { state: RunState; event: SlotEvent } {
  if (state.status !== "running") {
    throw new ApiError("E_RUN_FINISHED", `运行已结束（${state.status}: ${state.statusReason ?? ""}），不能继续推进`, 409);
  }
  const t = state.currentSlot;
  if (t >= model.maxSlots) {
    const next: RunState = { ...state, status: "budget_exhausted", statusReason: `已达到总时隙预算 ${model.maxSlots}` };
    throw new ApiError("E_BUDGET_EXHAUSTED", `已达到总时隙预算 ${model.maxSlots}，运行终止`, 409);
  }

  // 1) 纳入本时隙到达（到达表已规范化排序）
  const queues: Record<string, QueuedMessage[]> = {};
  for (const s of model.stations) queues[s.id] = [...state.queues[s.id]];
  const arrivalsNow: QueuedMessage[] = [];
  for (const a of model.arrivals) {
    if (a.arrivalSlot === t) {
      const msg: QueuedMessage = { stationId: a.stationId, messageId: a.messageId, arrivalSlot: a.arrivalSlot };
      queues[a.stationId].push(msg);
      arrivalsNow.push(msg);
    }
  }

  // 队列上限检查：超限则保留可解释状态并终止运行
  for (const s of model.stations) {
    if (queues[s.id].length > model.maxQueuePerStation) {
      const overflowState: RunState = {
        ...state,
        status: "queue_overflow",
        statusReason: `站点 ${s.id} 队列长度 ${queues[s.id].length} 超过上限 ${model.maxQueuePerStation}（时隙 ${t}）`,
        queues,
      };
      const err = new ApiError(
        "E_QUEUE_OVERFLOW",
        `站点 ${s.id} 队列超过上限 ${model.maxQueuePerStation}，运行终止，状态已保留`,
        409
      );
      (err as ApiError & { overflowState?: RunState }).overflowState = overflowState;
      throw err;
    }
  }

  // 2) 按站点编号升序，仅对非空站各抽一次随机数，独立决定是否尝试
  const rng = rngFromSnapshot(state.rng);
  const draws: StationDraw[] = [];
  const contenders: string[] = [];
  for (const s of model.stations) {
    if (queues[s.id].length === 0) continue; // 空站不抽样
    const r = rng.next();
    const attempted = r < s.probability; // p=0 永不尝试，p=1 必尝试
    draws.push({ stationId: s.id, random: r, probability: s.probability, attempted });
    if (attempted) contenders.push(s.id);
  }

  // 3) 统一裁决
  let result: SlotResult;
  let successMessage: SlotEvent["successMessage"] = null;
  if (contenders.length === 0) {
    result = "idle";
  } else if (contenders.length === 1) {
    result = "success";
    const winner = contenders[0];
    const msg = queues[winner].shift()!; // 4) 成功才移除队首
    successMessage = { ...msg, latency: t - msg.arrivalSlot + 1 };
  } else {
    result = "collision"; // 全部保留在队首
  }

  const queueLengths: Record<string, number> = {};
  for (const s of model.stations) queueLengths[s.id] = queues[s.id].length;

  const stats = {
    slotsAdvanced: state.stats.slotsAdvanced + 1,
    idleSlots: state.stats.idleSlots + (result === "idle" ? 1 : 0),
    collisionSlots: state.stats.collisionSlots + (result === "collision" ? 1 : 0),
    successSlots: state.stats.successSlots + (result === "success" ? 1 : 0),
    succeeded: successMessage
      ? [
          ...state.stats.succeeded,
          {
            stationId: successMessage.stationId,
            messageId: successMessage.messageId,
            arrivalSlot: successMessage.arrivalSlot,
            successSlot: t,
            latency: successMessage.latency,
          },
        ]
      : state.stats.succeeded,
  };

  const nextState: RunState = {
    ...state,
    currentSlot: t + 1,
    queues,
    rng: rng.snapshot(),
    stats,
  };

  const event: SlotEvent = {
    slot: t,
    arrivals: arrivalsNow,
    draws,
    contenders,
    result,
    successMessage,
    queueLengths,
    rng: rng.snapshot(),
  };
  return { state: nextState, event };
}

export interface RunStats {
  runId: string;
  modelId: string;
  status: RunStatus;
  statusReason: string | null;
  totalSlots: number;
  idleSlots: number;
  collisionSlots: number;
  successSlots: number;
  successCount: number;
  waitingCount: number;
  totalArrivals: number;
  meanLatency: number | null;
  successes: RunState["stats"]["succeeded"];
  waiting: (QueuedMessage & { stationId: string })[];
}

export function computeStats(model: ModelConfig, state: RunState): RunStats {
  const waiting: RunStats["waiting"] = [];
  for (const s of model.stations) {
    for (const m of state.queues[s.id]) waiting.push({ ...m, stationId: s.id });
  }
  const succ = state.stats.succeeded;
  const meanLatency = succ.length > 0 ? succ.reduce((a, b) => a + b.latency, 0) / succ.length : null;
  return {
    runId: state.runId,
    modelId: model.id,
    status: state.status,
    statusReason: state.statusReason,
    totalSlots: state.stats.slotsAdvanced,
    idleSlots: state.stats.idleSlots,
    collisionSlots: state.stats.collisionSlots,
    successSlots: state.stats.successSlots,
    successCount: succ.length,
    waitingCount: waiting.length,
    totalArrivals: model.arrivals.length,
    meanLatency,
    successes: succ,
    waiting,
  };
}
