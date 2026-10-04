import { ApiError } from "./errors";

export const MODEL_VERSION = "slotted-aloha-model-v1";

export interface StationConfig {
  id: string;
  probability: number;
}

export interface Arrival {
  stationId: string;
  messageId: string;
  arrivalSlot: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  version: string;
  seed: number;
  stations: StationConfig[]; // 规范化后按 id 升序
  arrivals: Arrival[]; // 规范化后按 (arrivalSlot, stationId, messageId) 升序
  maxQueuePerStation: number;
  maxSlots: number;
  createdAt: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function validateSlot(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ApiError("E_NON_INTEGER_SLOT", `${field} 必须是有限数字`);
  }
  if (!Number.isInteger(v)) {
    throw new ApiError("E_NON_INTEGER_SLOT", `${field} 必须是整数时隙，收到 ${v}`);
  }
  if (v < 0) {
    throw new ApiError("E_NEGATIVE_TIME", `${field} 不能为负，收到 ${v}`);
  }
  return v;
}

export function validateProbability(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new ApiError("E_BAD_PROBABILITY", `${field} 必须是 [0,1] 内的数字，收到 ${String(v)}`);
  }
  return v;
}

/** 校验并规范化站点列表：按 id 升序排序，使输入顺序不影响规范模型。 */
export function normalizeStations(input: unknown): StationConfig[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ApiError("E_VALIDATION", "stations 必须是非空数组");
  }
  const seen = new Set<string>();
  const stations: StationConfig[] = input.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ApiError("E_VALIDATION", `stations[${i}] 必须是对象`);
    }
    const s = raw as Record<string, unknown>;
    if (!isNonEmptyString(s.id)) {
      throw new ApiError("E_VALIDATION", `stations[${i}].id 必须是非空字符串`);
    }
    if (seen.has(s.id)) {
      throw new ApiError("E_DUP_STATION", `重复站点 id: ${s.id}`);
    }
    seen.add(s.id);
    return { id: s.id, probability: validateProbability(s.probability, `stations[${i}].probability`) };
  });
  stations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return stations;
}

/** 校验并规范化到达表：按 (arrivalSlot, stationId, messageId) 排序。 */
export function normalizeArrivals(input: unknown, stationIds: Set<string>): Arrival[] {
  if (!Array.isArray(input)) {
    throw new ApiError("E_VALIDATION", "arrivals 必须是数组");
  }
  const seen = new Set<string>();
  const arrivals: Arrival[] = input.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ApiError("E_VALIDATION", `arrivals[${i}] 必须是对象`);
    }
    const a = raw as Record<string, unknown>;
    if (!isNonEmptyString(a.stationId)) {
      throw new ApiError("E_VALIDATION", `arrivals[${i}].stationId 必须是非空字符串`);
    }
    if (!stationIds.has(a.stationId)) {
      throw new ApiError("E_UNKNOWN_STATION", `arrivals[${i}] 引用了不存在的站点 ${a.stationId}`);
    }
    if (!isNonEmptyString(a.messageId)) {
      throw new ApiError("E_VALIDATION", `arrivals[${i}].messageId 必须是非空字符串`);
    }
    const key = a.stationId + "|" + a.messageId;
    if (seen.has(key)) {
      throw new ApiError("E_DUP_MESSAGE", `站点 ${a.stationId} 的消息 ${a.messageId} 重复`);
    }
    seen.add(key);
    const arrivalSlot = validateSlot(a.arrivalSlot, `arrivals[${i}].arrivalSlot`);
    return { stationId: a.stationId, messageId: a.messageId, arrivalSlot };
  });
  arrivals.sort((a, b) =>
    a.arrivalSlot !== b.arrivalSlot
      ? a.arrivalSlot - b.arrivalSlot
      : a.stationId !== b.stationId
        ? (a.stationId < b.stationId ? -1 : 1)
        : a.messageId !== b.messageId
          ? (a.messageId < b.messageId ? -1 : 1)
          : 0
  );
  return arrivals;
}

export function validateSeed(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new ApiError("E_BAD_SEED", "seed 必须是 [0, 2^32-1] 内的整数");
  }
  return v;
}

export function validatePositiveInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new ApiError("E_VALIDATION", `${field} 必须是正整数，收到 ${String(v)}`);
  }
  return v;
}

/** 从用户输入构建规范模型。 */
export function buildModel(input: Record<string, unknown>, id: string, createdAt: string): ModelConfig {
  const name = isNonEmptyString(input.name) ? input.name : id;
  const seed = validateSeed(input.seed);
  const stations = normalizeStations(input.stations);
  const stationIds = new Set(stations.map((s) => s.id));
  const arrivals = normalizeArrivals(input.arrivals ?? [], stationIds);
  const maxQueuePerStation = validatePositiveInt(input.maxQueuePerStation ?? 1024, "maxQueuePerStation");
  const maxSlots = validatePositiveInt(input.maxSlots ?? 100000, "maxSlots");
  return {
    id,
    name,
    version: MODEL_VERSION,
    seed,
    stations,
    arrivals,
    maxQueuePerStation,
    maxSlots,
    createdAt,
  };
}
