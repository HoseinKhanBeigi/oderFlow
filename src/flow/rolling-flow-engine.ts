import type { EngineConfig } from '../config/types.js';
import { BucketRing, type WindowAggregate } from '../core/bucket-ring.js';
import type { AccelerationLabel, WindowId } from '../models/trade.js';
import { WINDOW_MS } from '../models/trade.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import { computeDelta, flowShares } from './delta-engine.js';

export interface RollingWindowView {
  window: WindowId;
  windowMs: number;
  agg: WindowAggregate;
  delta: ReturnType<typeof computeDelta>;
  shares: ReturnType<typeof flowShares>;
  flowMultipleBuy: number;
  flowMultipleSell: number;
  buyFlowPercentile: number;
  sellFlowPercentile: number;
  largeBuyFlowAcceleration: AccelerationLabel;
  largeSellFlowAcceleration: AccelerationLabel;
}

/**
 * Incremental multi-window aggregator. Trades update the current 100ms bucket;
 * snapshots sum buckets for each configured window.
 */
export class RollingFlowEngine {
  readonly buckets: BucketRing;
  private readonly buyBaseline: RollingDistribution;
  private readonly sellBaseline: RollingDistribution;
  private lastBaselineSecond = -1;

  constructor(private readonly config: EngineConfig) {
    this.buckets = new BucketRing(config.bucketMs, config.maxBuckets);
    this.buyBaseline = new RollingDistribution(config.historicalBaselineSamples);
    this.sellBaseline = new RollingDistribution(config.historicalBaselineSamples);
  }

  onTrade(
    timestamp: number,
    side: 'BUY' | 'SELL',
    quoteValue: number,
    price: number,
    isLarge: boolean,
    isForced: boolean,
  ): void {
    this.buckets.add(timestamp, side, quoteValue, price, isLarge, isForced);
    this.maybeRecordBaseline(timestamp);
  }

  touchPrice(timestamp: number, price: number): void {
    this.buckets.touchPrice(timestamp, price);
  }

  view(window: WindowId, now: number): RollingWindowView {
    const windowMs = WINDOW_MS[window];
    const agg = this.buckets.aggregate(now - windowMs, now + 1);
    const multiples = this.scaledMultiples(window, agg);
    const seconds = windowMs / 1000;
    const buyRank = this.buyBaseline.percentileRank(seconds === 0 ? agg.buyVolume : agg.buyVolume / seconds);
    const sellRank = this.sellBaseline.percentileRank(seconds === 0 ? agg.sellVolume : agg.sellVolume / seconds);
    return {
      window,
      windowMs,
      agg,
      delta: computeDelta(agg),
      shares: flowShares(agg),
      flowMultipleBuy: multiples.buy,
      flowMultipleSell: multiples.sell,
      buyFlowPercentile: buyRank,
      sellFlowPercentile: sellRank,
      largeBuyFlowAcceleration: this.acceleration('BUY', now),
      largeSellFlowAcceleration: this.acceleration('SELL', now),
    };
  }

  seedBaseline(side: 'BUY' | 'SELL', volumes: number[]): void {
    const dist = side === 'BUY' ? this.buyBaseline : this.sellBaseline;
    for (const v of volumes) dist.add(v);
  }

  flowMultiple(window: WindowId, agg: WindowAggregate, side: 'BUY' | 'SELL'): number {
    const seconds = WINDOW_MS[window] / 1000;
    const dist = side === 'BUY' ? this.buyBaseline : this.sellBaseline;
    const current = side === 'BUY' ? agg.buyVolume : agg.sellVolume;
    const medianPerSecond = dist.median();
    const expected = medianPerSecond * seconds;
    if (expected === 0) return current === 0 ? 1 : 99;
    return current / expected;
  }

  scaledMultiples(window: WindowId, agg: WindowAggregate): { buy: number; sell: number } {
    return {
      buy: this.flowMultiple(window, agg, 'BUY'),
      sell: this.flowMultiple(window, agg, 'SELL'),
    };
  }

  private maybeRecordBaseline(timestamp: number): void {
    const second = Math.floor(timestamp / 1000);
    if (this.lastBaselineSecond < 0) {
      this.lastBaselineSecond = second;
      return;
    }
    if (second === this.lastBaselineSecond) return;
    const agg = this.buckets.aggregate(this.lastBaselineSecond * 1000, (this.lastBaselineSecond + 1) * 1000);
    this.buyBaseline.add(agg.buyVolume);
    this.sellBaseline.add(agg.sellVolume);
    this.lastBaselineSecond = second;
  }

  private acceleration(side: 'BUY' | 'SELL', now: number): AccelerationLabel {
    const n = this.config.accelerationLookbackBuckets;
    const series =
      side === 'BUY' ? this.buckets.buyVolumesForLastN(n, now) : this.buckets.sellVolumesForLastN(n, now);
    if (series.length < 3) return 'NONE';
    const recent = series.slice(-3);
    const diffs = [recent[1]! - recent[0]!, recent[2]! - recent[1]!];
    const accel = diffs[1]! - diffs[0]!;
    const last = recent[2]!;
    if (last <= 0 && diffs[1]! <= 0) return 'NONE';
    if (diffs[1]! < 0 && diffs[0]! > 0) return 'DECELERATING';
    const rel = last === 0 ? 0 : accel / Math.max(last, 1);
    if (rel > 0.25 || (diffs[1]! > 0 && diffs[1]! > diffs[0]! * 1.5 && diffs[1]! > 0)) return 'STRONG';
    if (rel > 0.08 || diffs[1]! > diffs[0]!) return 'MODERATE';
    if (diffs[1]! > 0) return 'WEAK';
    if (diffs[1]! < 0) return 'DECELERATING';
    return 'NONE';
  }
}
