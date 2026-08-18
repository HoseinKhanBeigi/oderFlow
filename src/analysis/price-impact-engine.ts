import type { PriceImpactConfig } from '../config/types.js';
import { pctChange, safeDiv } from '../core/integrity.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import type { PriceImpactEfficiency } from '../models/trade.js';

export interface PriceResponse {
  priceStart: number;
  priceEnd: number;
  absolutePriceChange: number;
  percentagePriceChange: number;
  impactPerMillion: number;
  efficiency: PriceImpactEfficiency;
  effective: boolean;
}

export class PriceImpactEngine {
  private readonly history: RollingDistribution;

  constructor(private readonly config: PriceImpactConfig) {
    this.history = new RollingDistribution(config.sampleSize);
  }

  measure(priceStart: number, priceEnd: number, netDelta: number): PriceResponse {
    const absolutePriceChange = priceEnd - priceStart;
    const percentagePriceChange = pctChange(priceStart, priceEnd);
    const absDelta = Math.abs(netDelta);
    const impactPerMillion = absDelta < this.config.minAbsDeltaQuote
      ? 0
      : safeDiv(Math.abs(percentagePriceChange), absDelta / 1_000_000);

    if (impactPerMillion > 0) this.history.add(impactPerMillion);

    const efficiency = this.classify(impactPerMillion);
    const signedMove = netDelta >= 0 ? percentagePriceChange : -percentagePriceChange;
    const effective = signedMove > 0 && efficiency !== 'LOW';

    return {
      priceStart,
      priceEnd,
      absolutePriceChange,
      percentagePriceChange,
      impactPerMillion,
      efficiency,
      effective,
    };
  }

  seed(impactsPerMillion: number[]): void {
    for (const v of impactsPerMillion) this.history.add(v);
  }

  private classify(current: number): PriceImpactEfficiency {
    if (current === 0) return 'LOW';
    if (this.history.size < 8) {
      if (current < 0.01) return 'LOW';
      if (current > 0.5) return 'EXTREME';
      if (current > 0.15) return 'HIGH';
      return 'NORMAL';
    }
    const median = this.history.median();
    if (median <= 0) return 'NORMAL';
    const ratio = current / median;
    if (ratio < this.config.lowRatioOfMedian) return 'LOW';
    if (ratio >= this.config.extremeRatioOfMedian) return 'EXTREME';
    if (ratio >= this.config.highRatioOfMedian) return 'HIGH';
    return 'NORMAL';
  }
}
