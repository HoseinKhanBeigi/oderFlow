import type { WindowId } from './trade.js';

/** Contribution row for AggressiveBuyPower / AggressiveSellPower explainability. */
export interface AggressivePowerContribution {
  label: string;
  /** Points added to the 0–100 power score after weighting. */
  points: number;
  /** Normalized feature 0–100 before weight. */
  normalized: number;
  weight: number;
}

export interface FootprintAggressionLevel {
  price: number;
  buyExecuted: number;
  sellExecuted: number;
  /** Dominant-side / opposing ratio when imbalanced; else 0. */
  imbalanceRatio: number;
  side: 'BUY' | 'SELL' | 'BALANCED';
}

export interface AggressiveSideFlow {
  /** ASK-executed volume (aggressive buys) or BID-executed (aggressive sells). */
  executedVolume: number;
  tradeCount: number;
  velocityPerSec: number;
  averageTradeSize: number;
  largeVolume: number;
  imbalanceCount: number;
  stackedImbalanceCount: number;
  imbalanceNotional: number;
  imbalanceStrength: number;
  /** Signed delta contribution from this side (+buy / −sell). */
  deltaContribution: number;
  cvdContribution: number;
  consecutiveImbalances: number;
  activityPercentile: number;
  /** 0–100 footprint aggression power. */
  power: number;
  contributions: AggressivePowerContribution[];
  /** Top footprint levels that drove this side (price-level detail). */
  topLevels: FootprintAggressionLevel[];
  hasData: boolean;
  lowConfidence: boolean;
}

export interface AggressiveFlowSnapshot {
  window: WindowId;
  windowMs: number;
  buy: AggressiveSideFlow;
  sell: AggressiveSideFlow;
  /** Alias of buy.power */
  aggressiveBuyPower: number;
  /** Alias of sell.power */
  aggressiveSellPower: number;
  source: 'FOOTPRINT_EXECUTED';
}

export function emptyAggressiveSideFlow(): AggressiveSideFlow {
  return {
    executedVolume: 0,
    tradeCount: 0,
    velocityPerSec: 0,
    averageTradeSize: 0,
    largeVolume: 0,
    imbalanceCount: 0,
    stackedImbalanceCount: 0,
    imbalanceNotional: 0,
    imbalanceStrength: 0,
    deltaContribution: 0,
    cvdContribution: 0,
    consecutiveImbalances: 0,
    activityPercentile: 0,
    power: 0,
    contributions: [],
    topLevels: [],
    hasData: false,
    lowConfidence: false,
  };
}

export function emptyAggressiveFlow(window: WindowId = '10s', windowMs = 10_000): AggressiveFlowSnapshot {
  const buy = emptyAggressiveSideFlow();
  const sell = emptyAggressiveSideFlow();
  return {
    window,
    windowMs,
    buy,
    sell,
    aggressiveBuyPower: 0,
    aggressiveSellPower: 0,
    source: 'FOOTPRINT_EXECUTED',
  };
}
