import type { PathOfLeastResistance } from './movement.js';
import type { LiquidityWall, LiquidityVacuum } from './liquidity.js';

export type DailyBias = 'LONG' | 'SHORT' | 'WAIT';

export type DailySetup =
  | 'SUPPORT_HOLD'
  | 'RESISTANCE_REJECT'
  | 'BREAKOUT_UP'
  | 'BREAKDOWN'
  | 'FLOW_CONTINUATION'
  | 'MID_RANGE'
  | 'INSUFFICIENT';

export type DailyLocation =
  | 'AT_SUPPORT'
  | 'AT_RESISTANCE'
  | 'ABOVE_RESISTANCE'
  | 'BELOW_SUPPORT'
  | 'MID_RANGE'
  | 'UNKNOWN';

export interface DailyLevel {
  price: number;
  kind: 'SUPPORT' | 'RESISTANCE' | 'POC' | 'HVN';
  source: string;
  volume: number;
}

export interface DailyLiquidityContext {
  price: number;
  pathOfLeastResistance: PathOfLeastResistance;
  nearbyAsk: number;
  nearbyBid: number;
  askConsumption: number;
  bidConsumption: number;
  walls: Pick<LiquidityWall, 'kind' | 'price' | 'status' | 'quoteValue'>[];
  vacuums: Pick<LiquidityVacuum, 'kind' | 'fromPrice' | 'toPrice'>[];
  absorptionType: 'BUYER_ABSORPTION' | 'SELLER_ABSORPTION' | null;
}

export interface DailyFlowSnapshot {
  todayBuy: number;
  todaySell: number;
  todayDelta: number;
  todayDeltaPercent: number;
  todayChangePercent: number;
  recentDelta: number;
  recentDeltaPercent: number;
  efficient: boolean;
  absorbed: 'BUYERS' | 'SELLERS' | null;
}

export interface DailySignal {
  timeframe: '1D';
  symbol: string;
  market: 'spot' | 'perp' | 'stock';
  price: number;
  bias: DailyBias;
  setup: DailySetup;
  location: DailyLocation;
  score: number;
  confidence: number;
  reason: string;
  evidence: string[];
  levels: {
    support: number | null;
    resistance: number | null;
    poc: number | null;
    hvns: number[];
    all: DailyLevel[];
  };
  flow: DailyFlowSnapshot;
  structureBias: string;
  structureShift: string;
  pathOfLeastResistance: PathOfLeastResistance;
  footprintComplete: boolean;
}
