import { ErrorCode, fail } from './errors.js';
import type { Arrival, Station } from './types.js';

export interface RawStation {
  stationId?: unknown;
  id?: unknown;
  probability?: unknown;
}

export interface RawArrival {
  messageId?: unknown;
  id?: unknown;
  stationId?: unknown;
  station?: unknown;
  arrivalSlot?: unknown;
  slot?: unknown;
}

/**
 * 规范化站点：去重、编号字符串化、概率校验、按编号升序。
 * 输入列表顺序不影响规范化结果。
 */
export function normalizeStations(input: unknown, defaultProbability?: unknown): Station[] {
  if (!Array.isArray(input) || input.length === 0) {
    fail(ErrorCode.EMPTY_STATIONS, '至少需要配置一个站点');
  }
  const byId = new Map<string, number>();
  for (const raw of input as RawStation[]) {
    const obj = raw && typeof raw === 'object' ? raw : { stationId: raw };
    const id = str(obj.stationId ?? obj.id);
    if (id === '') fail(ErrorCode.INVALID_ARGUMENT, '站点编号不能为空', obj);
    if (byId.has(id)) {
      fail(ErrorCode.DUPLICATE_STATION, `站点编号重复: ${id}`, { stationId: id });
    }
    const prob =
      obj.probability === undefined ? defaultProbability : obj.probability;
    byId.set(id, normalizeProbability(prob));
  }
  return [...byId.entries()]
    .map(([stationId, probability]) => ({ stationId, probability }))
    .sort((a, b) => (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0));
}

export function normalizeProbability(p: unknown): number {
  if (typeof p === 'boolean' || p === null || p === undefined) {
    fail(ErrorCode.INVALID_PROBABILITY, '概率必须是 [0,1] 内的数字', { probability: p });
  }
  const n = typeof p === 'string' ? Number(p) : (p as number);
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) {
    fail(ErrorCode.INVALID_PROBABILITY, '概率必须位于 [0,1]', { probability: p });
  }
  return n;
}

export function normalizeSlot(slot: unknown, field = 'arrivalSlot'): number {
  if (typeof slot === 'boolean' || slot === null) {
    fail(ErrorCode.INVALID_SLOT, `${field} 必须是非负整数时隙`, { value: slot });
  }
  const n = typeof slot === 'string' && slot.trim() !== '' ? Number(slot) : (slot as number);
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    fail(ErrorCode.INVALID_SLOT, `${field} 必须是 >= 0 的整数时隙（不允许负时间/非整数）`, {
      value: slot,
    });
  }
  return n;
}

/**
 * 规范化到达表：校验消息唯一、站点存在、非负整数时隙，按 (时隙, 站点, 消息) 稳定排序。
 * 输入列表顺序不影响规范化结果，也不改变随机序列。
 */
export function normalizeArrivals(
  input: unknown,
  stations: Station[],
): Arrival[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    fail(ErrorCode.INVALID_ARGUMENT, '到达表必须是数组', input);
  }
  const known = new Set(stations.map((s) => s.stationId));
  const seen = new Set<string>();
  const rows: Arrival[] = [];
  for (const raw of input as RawArrival[]) {
    const obj = raw && typeof raw === 'object' ? raw : fail(ErrorCode.INVALID_ARGUMENT, '到达项必须是对象', raw);
    const messageId = str(obj.messageId ?? obj.id);
    const stationId = str(obj.stationId ?? obj.station);
    if (messageId === '') fail(ErrorCode.INVALID_ARGUMENT, '消息编号不能为空', obj);
    if (seen.has(messageId)) {
      fail(ErrorCode.DUPLICATE_MESSAGE, `消息编号重复: ${messageId}`, { messageId });
    }
    if (!known.has(stationId)) {
      fail(ErrorCode.UNKNOWN_STATION, `到达消息引用了未配置的站点: ${stationId}`, {
        messageId,
        stationId,
      });
    }
    seen.add(messageId);
    rows.push({
      messageId,
      stationId,
      arrivalSlot: normalizeSlot(obj.arrivalSlot ?? obj.slot),
    });
  }
  rows.sort((a, b) => {
    if (a.arrivalSlot !== b.arrivalSlot) return a.arrivalSlot - b.arrivalSlot;
    if (a.stationId !== b.stationId) return a.stationId < b.stationId ? -1 : 1;
    return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
  });
  return rows;
}

/** 规范化队列/时隙预算；0 表示不限。 */
export function normalizeLimit(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    fail(ErrorCode.INVALID_LIMIT, `${field} 必须是 >= 0 的整数（0 表示不限）`, { value });
  }
  return n;
}

function str(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  return '';
}
