import type { AggressorSide, RelativeSizeClass } from './trade.js';

export interface LargeTradeThresholds {
  tier1: number;
  tier2: number;
  tier3: number;
  tier4: number;
}

export type LargeTradeTier = 1 | 2 | 3 | 4;

export interface LargeAggressiveTradeEvent {
  type: 'LARGE_AGGRESSIVE_BUY' | 'LARGE_AGGRESSIVE_SELL';
  symbol: string;
  quoteValue: number;
  price: number;
  timestamp: number;
  tier: LargeTradeTier;
  relativeClass: RelativeSizeClass;
  relativeSize: number;
  zScore: number;
}

export interface RelativeTradeSize {
  quoteValue: number;
  vsMedian: number;
  zScore: number;
  percentileRank: number;
  classification: RelativeSizeClass;
}

export interface FlowBurst {
  side: AggressorSide;
  startTime: number;
  endTime: number;
  tradeCount: number;
  totalQuoteValue: number;
  largestTrade: number;
  averageTradeSize: number;
  priceStart: number;
  priceEnd: number;
  strength: number;
}

export interface LargeTradeCluster {
  side: AggressorSide;
  minPrice: number;
  maxPrice: number;
  startTime: number;
  endTime: number;
  tradeCount: number;
  totalVolume: number;
  relativeStrength: number;
}

export interface TapeEntry {
  timestamp: number;
  side: AggressorSide;
  price: number;
  quoteValue: number;
  relativeClass: RelativeSizeClass;
  symbol: string;
}

export interface TapeFilter {
  minQuoteValue?: number;
  side?: AggressorSide;
  symbol?: string;
  minRelativePercentile?: number;
  fromTimestamp?: number;
  toTimestamp?: number;
}
