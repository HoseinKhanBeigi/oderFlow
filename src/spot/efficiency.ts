import { RollingDistribution } from '../core/rolling-stats.js';
import { pctChange, safeDiv } from '../core/integrity.js';
import type { PriceImpactEfficiency } from '../models/trade.js';
import type { EffortResultLabel, SpotEfficiencySnapshot } from './types.js';

export interface EffortInput {
  open: number;
  close: number;
  totalVolume: number;
  delta: number;
}

/**
 * Effort vs result: how much aggressive capital was required to move price.
 * Ranked against a rolling distribution for the same asset/timeframe — no fixed $ cutoffs.
 */
export class EffortVsResult {
  readonly volPerDollar: RollingDistribution;
  readonly volPerBps: RollingDistribution;
  readonly absDelta: RollingDistribution;
  readonly absMovePct: RollingDistribution;

  constructor(private readonly sampleSize = 256) {
    this.volPerDollar = new RollingDistribution(sampleSize);
    this.volPerBps = new RollingDistribution(sampleSize);
    this.absDelta = new RollingDistribution(sampleSize);
    this.absMovePct = new RollingDistribution(sampleSize);
  }

  measure(input: EffortInput, recordHistory = true): SpotEfficiencySnapshot {
    const priceChange = input.close - input.open;
    const priceChangePercent = pctChange(input.open, input.close);
    const absDelta = Math.abs(input.delta);
    const absMove = Math.abs(priceChange);
    const absMovePct = Math.abs(priceChangePercent);
    const absBps = absMovePct * 100;

    const volumePerDollar = absMove < 1e-12 ? (input.totalVolume > 0 ? Number.POSITIVE_INFINITY : 0) : safeDiv(input.totalVolume, absMove);
    const volumePerBps = absBps < 1e-9 ? (input.totalVolume > 0 ? Number.POSITIVE_INFINITY : 0) : safeDiv(input.totalVolume, absBps);

    if (recordHistory && Number.isFinite(volumePerDollar) && volumePerDollar > 0 && absMove > 0) {
      this.volPerDollar.add(volumePerDollar);
    }
    if (recordHistory && Number.isFinite(volumePerBps) && volumePerBps > 0 && absBps > 0) {
      this.volPerBps.add(volumePerBps);
    }
    if (recordHistory && absDelta > 0) this.absDelta.add(absDelta);
    if (recordHistory && absMovePct > 0) this.absMovePct.add(absMovePct);

    const rank = this.rankEfficiency(volumePerDollar);
    const effortVsResult = this.classify(input.delta, priceChange, volumePerDollar, absDelta);

    return {
      priceChange,
      priceChangePercent,
      totalVolume: input.totalVolume,
      delta: input.delta,
      absDelta,
      volumePerDollar: Number.isFinite(volumePerDollar) ? volumePerDollar : 0,
      volumePerBps: Number.isFinite(volumePerBps) ? volumePerBps : 0,
      rank,
      effortVsResult,
    };
  }

  private rankEfficiency(volumePerDollar: number): PriceImpactEfficiency {
    if (!Number.isFinite(volumePerDollar) || volumePerDollar <= 0) return 'LOW';
    if (this.volPerDollar.size < 8) return 'NORMAL';
    const rank = this.volPerDollar.percentileRank(volumePerDollar);
    // High volume-per-dollar-move = little displacement = LOW efficiency.
    if (rank >= 80) return 'LOW';
    if (rank <= 10) return 'EXTREME';
    if (rank <= 30) return 'HIGH';
    return 'NORMAL';
  }

  private classify(delta: number, priceChange: number, volumePerDollar: number, absDelta: number): EffortResultLabel {
    if (this.absDelta.size < 8) return 'INSUFFICIENT';
    const deltaRank = this.absDelta.percentileRank(absDelta);
    if (deltaRank < 35) return 'BALANCED';

    const buyers = delta > 0;
    const movedWith = buyers ? priceChange > 0 : priceChange < 0;
    const effortRank = Number.isFinite(volumePerDollar)
      ? this.volPerDollar.size >= 8
        ? this.volPerDollar.percentileRank(volumePerDollar)
        : 50
      : 90;

    const inefficient = effortRank >= 70 || !movedWith;
    const efficient = movedWith && effortRank <= 40;

    if (buyers && inefficient) return 'BUYERS_INEFFICIENT';
    if (buyers && efficient) return 'BUYERS_EFFICIENT';
    if (!buyers && inefficient) return 'SELLERS_INEFFICIENT';
    if (!buyers && efficient) return 'SELLERS_EFFICIENT';
    return 'BALANCED';
  }
}
