import type { WindowId } from './trade.js';

/** Dashboard net-aggression timeframe tabs; same set as net liquidity. */
export const NET_AGGRESSION_WINDOWS = ['10s', '30s', '1m', '5m', '15m'] as const;
export type NetAggressionWindowId = (typeof NET_AGGRESSION_WINDOWS)[number];

export type NetAggressionState =
  | 'STRONG_BUY_AGGRESSION'
  | 'BUY_AGGRESSION'
  | 'BALANCED'
  | 'SELL_AGGRESSION'
  | 'STRONG_SELL_AGGRESSION';

export interface NetAggressionSide {
  executed: number;
  tradeCount: number;
  velocityPerSec: number;
  averageTradeSize: number;
  largeVolume: number;
  percentile: number;
}

/**
 * Aggressive executed flow only — no cancel / replenish / book depth.
 * Net Aggression = AggressiveBuy − AggressiveSell.
 * Imbalance = Net / (Buy + Sell) ∈ [-1, +1].
 */
export interface NetAggressionSnapshot {
  window: WindowId;
  windowMs: number;
  buy: NetAggressionSide;
  sell: NetAggressionSide;
  /** Aggressive buy − aggressive sell (quote notional). */
  net: number;
  /** (buy − sell) / (buy + sell); −1 strong sell … +1 strong buy. */
  imbalance: number;
  netVelocityPerSec: number;
  buyPercentile: number;
  sellPercentile: number;
  /** How historically unusual |net| is (0–100). Sign comes from `net`. */
  netPercentile: number;
  state: NetAggressionState;
  interpretation: string;
}
