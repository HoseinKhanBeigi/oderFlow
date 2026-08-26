import { RollingDistribution } from '../core/rolling-stats.js';
import type { NormStats } from '../models/liquidity-response.js';

export type NormKey =
  | 'aggressiveBuy'
  | 'aggressiveSell'
  | 'deltaAbs'
  | 'priceDisplacement'
  | 'askDepthChange'
  | 'bidDepthChange'
  | 'absEfficiency'
  | 'dirEfficiency'
  | 'bpsPer100m'
  | 'impactBps'
  | 'askRemaining'
  | 'bidRemaining';

/**
 * Per-asset rolling distributions. Thresholds are percentiles of this
 * symbol's own history — never universal dollar cutoffs.
 */
export class MetricNormalizer {
  private readonly series = new Map<string, RollingDistribution>();

  constructor(private readonly windows: number[], private readonly defaultWindow: number) {}

  observe(key: NormKey, value: number, tf = 1): void {
    if (!Number.isFinite(value)) return;
    for (const n of this.windows) {
      this.dist(key, tf, n).add(value);
    }
  }

  stats(key: NormKey, value: number, tf = 1, window = this.defaultWindow): NormStats {
    const dist = this.dist(key, tf, window);
    if (dist.size < 4) {
      return { value, percentile: 50, zScore: 0, median: 0, std: 0, window };
    }
    return {
      value,
      percentile: dist.percentileRank(value),
      zScore: dist.zScore(value, 1e-12),
      median: dist.median(),
      std: dist.std(),
      window,
    };
  }

  percentile(key: NormKey, value: number, tf = 1, window = this.defaultWindow): number {
    return this.stats(key, value, tf, window).percentile;
  }

  sampleSize(key: NormKey, tf = 1, window = this.defaultWindow): number {
    return this.dist(key, tf, window).size;
  }

  private dist(key: NormKey, tf: number, window: number): RollingDistribution {
    const id = `${key}:${tf}:${window}`;
    let d = this.series.get(id);
    if (!d) {
      d = new RollingDistribution(window);
      this.series.set(id, d);
    }
    return d;
  }
}
