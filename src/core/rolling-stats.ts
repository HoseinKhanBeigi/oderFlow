/**
 * Bounded rolling sample with mean, std, percentiles, and percentile rank.
 * Values are stored in a ring; quantiles sort a copy on demand and cache until dirty.
 */
export class RollingDistribution {
  private readonly values: Float64Array;
  private readonly sorted: Float64Array;
  private write = 0;
  private filled = 0;
  private dirty = true;
  private cachedMean = 0;
  private cachedStd = 0;

  constructor(readonly capacity: number) {
    this.values = new Float64Array(capacity);
    this.sorted = new Float64Array(capacity);
  }

  get size(): number {
    return this.filled;
  }

  add(value: number): void {
    this.values[this.write] = value;
    this.write = (this.write + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
    this.dirty = true;
  }

  mean(): number {
    this.refresh();
    return this.cachedMean;
  }

  std(): number {
    this.refresh();
    return this.cachedStd;
  }

  median(): number {
    return this.percentile(50);
  }

  percentile(p: number): number {
    if (this.filled === 0) return 0;
    this.refresh();
    const clamped = Math.min(100, Math.max(0, p));
    const idx = (clamped / 100) * (this.filled - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const a = this.sorted[lo] ?? 0;
    const b = this.sorted[hi] ?? a;
    const w = idx - lo;
    return a * (1 - w) + b * w;
  }

  percentileRank(value: number): number {
    if (this.filled === 0) return 50;
    this.refresh();
    let lo = 0;
    let hi = this.filled;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.sorted[mid] ?? 0) <= value) lo = mid + 1;
      else hi = mid;
    }
    return (lo / this.filled) * 100;
  }

  zScore(value: number, minStd: number): number {
    const std = Math.max(this.std(), minStd);
    if (std === 0) return 0;
    return (value - this.mean()) / std;
  }

  ratioToMedian(value: number): number {
    const med = this.median();
    if (med === 0) return value === 0 ? 1 : Number.POSITIVE_INFINITY;
    return value / med;
  }

  private refresh(): void {
    if (!this.dirty || this.filled === 0) return;
    this.sorted.set(this.values.subarray(0, this.filled));
    this.sorted.subarray(0, this.filled).sort();

    let sum = 0;
    for (let i = 0; i < this.filled; i++) sum += this.values[i] ?? 0;
    this.cachedMean = sum / this.filled;

    let varSum = 0;
    for (let i = 0; i < this.filled; i++) {
      const d = (this.values[i] ?? 0) - this.cachedMean;
      varSum += d * d;
    }
    this.cachedStd = Math.sqrt(varSum / this.filled);
    this.dirty = false;
  }
}
