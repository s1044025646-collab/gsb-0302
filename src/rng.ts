/**
 * 固定种子随机数发生器：mulberry32（公开算法）。
 * 算法版本：mulberry32-v1。
 * 状态：32 位无符号整数 state；每抽一次数 state 前进一次，draws 计数加一。
 * 抽样消耗顺序由引擎保证：每个时隙内按站点编号升序、仅对非空队列的站各抽一次。
 */
export const RNG_ALGO_VERSION = "mulberry32-v1";

export interface RngSnapshot {
  algo: string;
  seed: number;
  state: number;
  draws: number;
}

export class Rng {
  private constructor(
    public readonly seed: number,
    private state: number,
    private draws: number
  ) {}

  static create(seed: number): Rng {
    return new Rng(seed >>> 0, seed >>> 0, 0);
  }

  static restore(seed: number, state: number, draws: number): Rng {
    return new Rng(seed >>> 0, state >>> 0, draws);
  }

  /** 返回 [0, 1) 均匀分布随机数 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    this.draws += 1;
    return r;
  }

  snapshot(): RngSnapshot {
    return {
      algo: RNG_ALGO_VERSION,
      seed: this.seed,
      state: this.state,
      draws: this.draws,
    };
  }
}
