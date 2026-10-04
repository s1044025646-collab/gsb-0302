import { ErrorCode, fail } from './errors.js';

/**
 * 随机发生器：Mulberry32（公开的 32 位整数种子 PRNG）。
 *
 * 算法版本: RNG_ALGORITHM = 'mulberry32-v1'
 * 状态: state 为 32 位无符号整数（每次抽样按 (state + 0x6D2B79F5) mod 2^32 推进），
 *       draws 为累计抽样次数。
 * 抽样值: 返回 [0,1) 的双精度浮点。
 *
 * 抽样消耗顺序: 在每个时隙内，按规范化后的站点编号升序，对每个“非空队列”的站
 *               恰好抽取一次；空站不抽取。所有决定形成后才统一裁决。
 */
export const RNG_ALGORITHM = 'mulberry32-v1';

export interface RngState {
  algorithm: string;
  state: number;
  draws: number;
}

export function normalizeSeed(seed: unknown): number {
  if (typeof seed === 'boolean' || seed === null) {
    fail(ErrorCode.INVALID_SEED, '种子必须是 32 位无符号整数', { seed });
  }
  let n: number;
  if (typeof seed === 'number') {
    n = seed;
  } else if (typeof seed === 'string' && /^\d+$/.test(sTrim(seed))) {
    n = Number(sTrim(seed));
  } else {
    fail(ErrorCode.INVALID_SEED, '种子必须是 32 位无符号整数', { seed });
  }
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    fail(ErrorCode.INVALID_SEED, '种子必须位于 [0, 4294967295] 的整数', { seed });
  }
  return n >>> 0;
}

function sTrim(s: string): string {
  return s.trim();
}

/** 由种子创建初始状态。 */
export function createRngState(seed: number): RngState {
  return { algorithm: RNG_ALGORITHM, state: seed >>> 0, draws: 0 };
}

/**
 * 推进一次并返回 [0,1) 随机数。纯函数：不修改入参，返回新状态。
 * mulberry32: t = state + 0x6D2B79F5 (mod 2^32)
 */
export function next(state: RngState): { value: number; state: RngState } {
  let t = (state.state + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return {
    value,
    state: {
      algorithm: state.algorithm,
      // 注意：mulberry32 的状态推进是线性加法，保存推进前的“线性状态”。
      state: (state.state + 0x6d2b79f5) >>> 0,
      draws: state.draws + 1,
    },
  };
}

/** 状态摘要（写入事件，便于回放核对）。 */
export function digest(state: RngState): string {
  return `${state.algorithm}:${state.state >>> 0}:${state.draws}`;
}
