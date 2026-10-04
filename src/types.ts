/** 规范化后的到达消息。 */
export interface Arrival {
  messageId: string;
  stationId: string;
  arrivalSlot: number;
}

/** 规范化后的站点配置。 */
export interface Station {
  stationId: string;
  probability: number;
}

export type SlotResult = 'idle' | 'success' | 'collision';

/** 单个时隙的完整事件记录。 */
export interface SlotEvent {
  runId: string;
  slot: number;
  arrivals: string[];
  /** 本时隙非空且参与抽样的站点（编号升序）。 */
  sampledStations: string[];
  /** 各站抽取的随机数（与 sampledStations 对应）。 */
  samples: number[];
  /** 尝试发送的站点（编号升序）。 */
  contenders: string[];
  result: SlotResult;
  /** 成功时传输的消息 id，否则为 null。 */
  transmittedMessage: string | null;
  /** 成功站，否则为 null。 */
  winnerStation: string | null;
  /** 时隙末各站队列长度。 */
  queueLengths: Record<string, number>;
  rngBefore: string;
  rngAfter: string;
}

export interface RunStats {
  runId: string;
  slotsAdvanced: number;
  idleSlots: number;
  collisionSlots: number;
  successSlots: number;
  totalArrivals: number;
  succeededCount: number;
  pendingCount: number;
  /** 仅基于已成功消息的平均系统延迟；无成功时为 null。 */
  meanDelay: number | null;
  /** 每条成功消息的系统延迟（成功时隙 - 到达时隙 + 1）。 */
  delays: Array<{
    messageId: string;
    stationId: string;
    arrivalSlot: number;
    successSlot: number;
    delay: number;
  }>;
  /** 仍在等待的消息（按站点队列顺序）。 */
  pending: Array<{ messageId: string; stationId: string; arrivalSlot: number }>;
  finished: boolean;
}

export interface BudgetStatus {
  perStationQueueLimit: number;
  totalSlotBudget: number;
  slotsAdvanced: number;
  finished: boolean;
}
