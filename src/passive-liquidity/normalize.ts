import { RollingDistribution } from '../core/rolling-stats.js';
import { safeDiv } from '../core/integrity.js';
import type { NormalizedMeasure } from '../models/passive-liquidity.js';

export type PassiveMetricKey =
  | 'bidDepth'
  | 'askDepth'
  | 'nearBidDepth'
  | 'nearAskDepth'
  | 'bidConsumed'
  | 'askConsumed'
  | 'bidCancelled'
  | 'askCancelled'
  | 'bidReplenished'
  | 'askReplenished'
  | 'bidAdded'
  | 'askAdded'
  | 'aggressiveBuy'
  | 'aggressiveSell'
  | 'upsideDisplacement'
  | 'downsideDisplacement'
  | 'upsideEfficiency'
  | 'downsideEfficiency'
  | 'spreadBps';

/** Below this sample count percentiles are meaningless, so 50 is returned. */
const MIN_SAMPLES = 8;

export interface RelativeContext {
  nearbyDepth: number;
  recentExecutedVolume: number;
  dailyVolume: number;
}

/**
 * Per-symbol rolling distributions. Every classification threshold in this
 * module is a percentile of this market's own history, never a fixed dollar
 * amount that would mean different things on BTC and on a small-cap perp.
 */
export class PassiveMetricNormalizer {
  private readonly series = new Map<PassiveMetricKey, RollingDistribution>();

  constructor(private readonly sampleSize: number) {}

  observe(key: PassiveMetricKey, value: number): void {
    if (!Number.isFinite(value)) return;
    this.dist(key).add(value);
  }

  percentile(key: PassiveMetricKey, value: number): number {
    const dist = this.dist(key);
    if (dist.size < MIN_SAMPLES || !Number.isFinite(value)) return 50;
    return dist.midRank(value);
  }

  samples(key: PassiveMetricKey): number {
    return this.dist(key).size;
  }

  measure(key: PassiveMetricKey, value: number, context: RelativeContext): NormalizedMeasure {
    const dist = this.dist(key);
    const warm = dist.size >= MIN_SAMPLES;
    return {
      raw: value,
      percentile: warm ? dist.midRank(value) : 50,
      zScore: warm ? dist.zScore(value, 1e-9) : 0,
      vsNearbyDepth: safeDiv(value, context.nearbyDepth),
      vsRecentExecutedVolume: safeDiv(value, context.recentExecutedVolume),
      vsDailyVolume: safeDiv(value, context.dailyVolume),
      samples: dist.size,
    };
  }

  private dist(key: PassiveMetricKey): RollingDistribution {
    let d = this.series.get(key);
    if (!d) {
      d = new RollingDistribution(this.sampleSize);
      this.series.set(key, d);
    }
    return d;
  }
}

export function emptyMeasure(raw = 0): NormalizedMeasure {
  return {
    raw,
    percentile: 50,
    zScore: 0,
    vsNearbyDepth: 0,
    vsRecentExecutedVolume: 0,
    vsDailyVolume: 0,
    samples: 0,
  };
}
