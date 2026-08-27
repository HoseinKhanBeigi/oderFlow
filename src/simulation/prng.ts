/**
 * Seeded PRNG. Synthetic mode may be random; replay mode must not use this.
 * Same seed + same call sequence → identical stream.
 */
export class SeededRng {
  private state: number;

  constructor(seed = 1) {
    this.state = seed >>> 0 || 1;
  }

  /** Mulberry32 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min));
  }

  /** Inclusive range. */
  nextFloat(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Box–Muller using this generator only. */
  nextGaussian(mean = 0, std = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const mag = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return mean + mag * std;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('SeededRng.pick on empty list');
    return items[this.nextInt(0, items.length)] as T;
  }

  get seedState(): number {
    return this.state;
  }
}
