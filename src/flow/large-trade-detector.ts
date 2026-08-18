import type { EngineConfig } from '../config/types.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import type {
  LargeAggressiveTradeEvent,
  LargeTradeTier,
  RelativeTradeSize,
} from '../models/flow.js';
import type { MarketTrade, RelativeSizeClass } from '../models/trade.js';

export class LargeTradeDetector {
  readonly distribution: RollingDistribution;

  constructor(private readonly config: EngineConfig) {
    this.distribution = new RollingDistribution(config.relative.sampleSize);
  }

  observe(trade: MarketTrade): void {
    this.distribution.add(trade.quoteValue);
  }

  relativeSize(quoteValue: number): RelativeTradeSize {
    const { minStdDevQuote } = this.config.relative;
    const percentileRank = this.distribution.percentileRank(quoteValue);
    return {
      quoteValue,
      vsMedian: this.distribution.ratioToMedian(quoteValue),
      zScore: this.distribution.zScore(quoteValue, minStdDevQuote),
      percentileRank,
      classification: this.classifyPercentile(percentileRank),
    };
  }

  classifyPercentile(percentileRank: number): RelativeSizeClass {
    const { largePercentile, veryLargePercentile, extremePercentile } = this.config.relative;
    if (percentileRank >= extremePercentile) return 'EXTREME';
    if (percentileRank >= veryLargePercentile) return 'VERY_LARGE';
    if (percentileRank >= largePercentile) return 'LARGE';
    return 'NORMAL';
  }

  absoluteTier(quoteValue: number): LargeTradeTier | null {
    const { tier1, tier2, tier3, tier4 } = this.config.largeTradeThresholds;
    if (quoteValue >= tier4) return 4;
    if (quoteValue >= tier3) return 3;
    if (quoteValue >= tier2) return 2;
    if (quoteValue >= tier1) return 1;
    return null;
  }

  isLarge(trade: MarketTrade, relative: RelativeTradeSize): boolean {
    return relative.classification !== 'NORMAL' || this.absoluteTier(trade.quoteValue) !== null;
  }

  maybeEvent(trade: MarketTrade, relative: RelativeTradeSize): LargeAggressiveTradeEvent | null {
    const tier = this.absoluteTier(trade.quoteValue);
    if (tier === null && relative.classification === 'NORMAL') return null;
    const effectiveTier: LargeTradeTier = tier ?? 1;
    return {
      type: trade.isAggressiveBuy ? 'LARGE_AGGRESSIVE_BUY' : 'LARGE_AGGRESSIVE_SELL',
      symbol: trade.symbol,
      quoteValue: trade.quoteValue,
      price: trade.price,
      timestamp: trade.timestamp,
      tier: effectiveTier,
      relativeClass: relative.classification,
      relativeSize: relative.vsMedian,
      zScore: relative.zScore,
    };
  }
}
