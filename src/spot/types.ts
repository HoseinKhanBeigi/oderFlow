import type { ExchangeId } from '../exchange/venues.js';
import type { PriceImpactEfficiency } from '../models/trade.js';

/** Spot venues that are live today. Coinbase / Kraken are reserved for later adapters. */
export const SPOT_EXCHANGE_IDS = ['binance', 'bybit', 'okx', 'bitstamp'] as const;
export type SpotExchangeId = (typeof SPOT_EXCHANGE_IDS)[number];

/** Future spot venues — add an adapter + `venueInstrument` mapping, then append to SPOT_EXCHANGE_IDS. */
export const PLANNED_SPOT_EXCHANGES = ['coinbase', 'kraken'] as const;
export type PlannedSpotExchangeId = (typeof PLANNED_SPOT_EXCHANGES)[number];

export type SpotVenueId = SpotExchangeId | PlannedSpotExchangeId;

export const SPOT_CHART_TF_MINUTES = [1, 5, 15, 30, 45, 60, 120, 240] as const;
export type SpotChartTf = (typeof SPOT_CHART_TF_MINUTES)[number];

export type SpotFlowState =
  | 'STRONG_SPOT_BUYING'
  | 'SPOT_BUYING'
  | 'BALANCED'
  | 'SPOT_SELLING'
  | 'STRONG_SPOT_SELLING';

export type SpotFlowFlag =
  | 'BUY_ABSORPTION'
  | 'SELL_ABSORPTION'
  | 'BUYER_EXHAUSTION'
  | 'SELLER_EXHAUSTION'
  | 'BULLISH_CVD_DIVERGENCE'
  | 'BEARISH_CVD_DIVERGENCE';

export type EffortResultLabel =
  | 'BUYERS_EFFICIENT'
  | 'BUYERS_INEFFICIENT'
  | 'SELLERS_EFFICIENT'
  | 'SELLERS_INEFFICIENT'
  | 'BALANCED'
  | 'INSUFFICIENT';

export type SpotVsFuturesRelation =
  | 'BROAD_BUYING_CONFIRMATION'
  | 'BROAD_SELLING_CONFIRMATION'
  | 'SPOT_FUTURES_DIVERGENCE'
  | 'SPOT_LED_BUYING'
  | 'SPOT_LED_SELLING'
  | 'FUTURES_LED_BUYING'
  | 'FUTURES_LED_SELLING'
  | 'NEUTRAL';

export type FuturesContextLabel =
  | 'NEW_LEVERAGED_BUYING_SPOT_CONFIRMATION'
  | 'SHORT_COVERING_DOMINATED_RALLY'
  | 'NEW_SHORTS_SPOT_SELLING'
  | 'LONG_LIQUIDATION_DELEVERAGING'
  | 'SPOT_LED_BUYING'
  | 'FUTURES_LED_BUYING'
  | 'BROAD_BUYING'
  | 'BROAD_SELLING'
  | 'DIVERGENCE'
  | 'UNCLEAR';

export type FlowBias = 'BUY' | 'SELL' | 'NEUTRAL';

export interface SpotVenueStats {
  exchange: SpotExchangeId | 'all';
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
  delta: number;
  deltaPercent: number;
  cvd: number;
  tradeCount: number;
  buyTradeCount: number;
  sellTradeCount: number;
  averageBuySize: number;
  averageSellSize: number;
  largestBuy: number;
  largestSell: number;
}

export interface SpotEfficiencySnapshot {
  priceChange: number;
  priceChangePercent: number;
  totalVolume: number;
  delta: number;
  absDelta: number;
  volumePerDollar: number;
  volumePerBps: number;
  /** LOW = absorbed / little displacement; HIGH = price moved readily. */
  rank: PriceImpactEfficiency;
  effortVsResult: EffortResultLabel;
}

export interface SpotAbsorptionSnapshot {
  detected: boolean;
  type: 'PASSIVE_SELL_ABSORPTION' | 'PASSIVE_BUY_ABSORPTION' | null;
  confidence: number;
  /** False unless book and/or near-touch prints supported the call. */
  usedBookEvidence: boolean;
}

export interface SpotWindowStats extends SpotVenueStats {
  open: number;
  high: number;
  low: number;
  close: number;
  efficiency: SpotEfficiencySnapshot;
  absorption: SpotAbsorptionSnapshot;
  flow: SpotFlowState;
  flags: SpotFlowFlag[];
  cvdDirection: 'UP' | 'DOWN' | 'FLAT';
  cvdDivergence: 'BULLISH' | 'BEARISH' | 'NONE';
}

export interface SpotFuturesLeg {
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
  delta: number;
  cvd: number;
  efficiency: PriceImpactEfficiency;
  oiChangePercent: number | null;
  liquidationUsd: number;
  shortLiquidationUsd: number;
  longLiquidationUsd: number;
}

export interface SpotFuturesComparison {
  spot: SpotFuturesLeg;
  futures: SpotFuturesLeg;
  spotBias: FlowBias;
  futuresBias: FlowBias;
  relation: SpotVsFuturesRelation;
  interpretation: FuturesContextLabel;
}

export interface SpotFlowSnapshot {
  symbol: string;
  price: number;
  timestamp: number;
  exchange: SpotExchangeId | 'all';
  imbalanceRatio: number;
  windows: Partial<Record<SpotChartTf, SpotWindowStats>>;
  exchanges: Partial<Record<SpotExchangeId, SpotVenueStats>>;
  aggregated: SpotVenueStats;
  comparison: SpotFuturesComparison | null;
  liquidityResponse: import('../models/liquidity-response.js').LiquidityResponseSnapshot;
}

export interface NormalizedSpotTrade {
  exchange: ExchangeId;
  symbol: string;
  timestamp: number;
  price: number;
  quantity: number;
  quoteValue: number;
  side: 'BUY' | 'SELL';
  tradeId?: string | number;
}

export const DEFAULT_IMBALANCE_RATIO = 3;
export const DEFAULT_SPOT_DEDUP = 24_000;
export const DEFAULT_SPOT_HISTORY_BARS = 512;
