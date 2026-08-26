import type { PriceImpactEfficiency } from './trade.js';

/** Chart timeframes used for effort vs result and price efficiency. */
export const LIQUIDITY_TF_MINUTES = [1, 5, 15, 30, 45, 60, 120, 240] as const;
export type LiquidityTf = (typeof LIQUIDITY_TF_MINUTES)[number];

export type IntensityLabel = PriceImpactEfficiency;

export type AggressionSide = 'BUYERS' | 'SELLERS' | 'BALANCED';

export type LiquiditySideResponse =
  | 'CONSUMPTION'
  | 'REPLENISHMENT'
  | 'WITHDRAWAL'
  | 'REPRICING'
  | 'MIXED'
  | 'QUIET';

export type EffortVsResultState =
  | 'EFFICIENT_BUYING'
  | 'INEFFICIENT_BUYING'
  | 'BUY_ABSORPTION'
  | 'EFFICIENT_SELLING'
  | 'INEFFICIENT_SELLING'
  | 'SELL_ABSORPTION'
  | 'BALANCED'
  | 'INSUFFICIENT';

export type MicrostructureState =
  | 'BUYERS_IN_CONTROL'
  | 'SELLERS_IN_CONTROL'
  | 'PASSIVE_BUYERS_DEFENDING'
  | 'PASSIVE_SELLERS_DEFENDING'
  | 'BUYERS_BEING_ABSORBED'
  | 'SELLERS_BEING_ABSORBED'
  | 'UPSIDE_LIQUIDITY_VACUUM'
  | 'DOWNSIDE_LIQUIDITY_VACUUM'
  | 'BALANCED'
  | 'TRANSITION';

export type ConfidenceLabel = 'LOW' | 'MEDIUM' | 'HIGH';

export type VacuumKind = 'UPSIDE_LIQUIDITY_VACUUM' | 'DOWNSIDE_LIQUIDITY_VACUUM' | null;

export type AbsorptionKind = 'SELL_ABSORPTION' | 'BUY_ABSORPTION' | null;

export type ReversalKind = 'BULLISH' | 'BEARISH' | null;

export type LiquidityLevelEvent =
  | 'NONE'
  | 'REPLENISH_BID'
  | 'REPLENISH_ASK'
  | 'WITHDRAW_BID'
  | 'WITHDRAW_ASK'
  | 'CONSUME_BID'
  | 'CONSUME_ASK'
  | 'ABSORPTION_BID'
  | 'ABSORPTION_ASK';

export interface NormStats {
  value: number;
  percentile: number;
  zScore: number;
  median: number;
  std: number;
  window: number;
}

export interface LiquidityBandAccounting {
  bandPct: number;
  side: 'bid' | 'ask';
  initial: number;
  added: number;
  cancelled: number;
  consumed: number;
  remaining: number;
  response: LiquiditySideResponse;
}

export interface FootprintLiquidityMark {
  price: number;
  restingBid: number;
  restingAsk: number;
  event: LiquidityLevelEvent;
}

export interface WhyFact {
  label: string;
  value: string;
  percentile?: number;
}

export interface LiquidityAbsorption {
  detected: boolean;
  kind: AbsorptionKind;
  /** Passive side that is absorbing. */
  absorbingSide: 'PASSIVE_SELLER' | 'PASSIVE_BUYER' | null;
  strength: number;
  usedBookEvidence: boolean;
  usedPriceEvidence: boolean;
}

export interface PriceImpactHorizons {
  immediateBps: number;
  bps5s: number;
  bps30s: number;
  bps1m: number;
  vwapBps: number;
  classification: IntensityLabel;
}

export interface EfficiencyMetrics {
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
  totalExecutedVolume: number;
  delta: number;
  priceChange: number;
  priceChangePercent: number;
  priceRange: number;
  atrNormalized: number;
  absoluteEfficiency: number;
  directionalEfficiency: number;
  bpsPer100m: number;
  classification: IntensityLabel;
}

export interface LiquidityTfView {
  tfMinutes: LiquidityTf;
  aggression: AggressionSide;
  executed: number;
  delta: number;
  priceMovePercent: number;
  priceMoveAbs: number;
  efficiency: IntensityLabel;
  effort: EffortVsResultState;
  absorption: LiquidityAbsorption;
  metrics: EfficiencyMetrics;
}

export interface LiquidityMarketLeg {
  market: 'spot' | 'perp';
  aggression: AggressionSide;
  delta: number;
  bookResponse: LiquiditySideResponse;
  absorption: AbsorptionKind;
  withdrawal: IntensityLabel;
  efficiency: IntensityLabel;
  oiChangePercent: number | null;
  liquidations: number;
}

export type LiquidityMarketRelation =
  | 'BROAD_BUYING_CONFIRMATION'
  | 'BROAD_SELLING_CONFIRMATION'
  | 'SHORT_SQUEEZE_DOMINATED_MOVE'
  | 'LONG_LIQUIDATION_DOMINATED_MOVE'
  | 'SPOT_FUTURES_DIVERGENCE'
  | 'NEUTRAL';

export interface LiquidityMarketCompare {
  spot: LiquidityMarketLeg;
  futures: LiquidityMarketLeg;
  relation: LiquidityMarketRelation;
  confirmed: boolean;
}

export interface ReversalSetup {
  detected: boolean;
  kind: ReversalKind;
  /** Informational only — never a buy/sell instruction. */
  label: 'POTENTIAL_REVERSAL_CONDITIONS_DETECTED';
  reasons: string[];
}

export interface LiquidityResponseSnapshot {
  aggression: AggressionSide;
  executed: number;
  delta: number;
  priceMovePercent: number;
  priceMoveAbs: number;
  efficiency: IntensityLabel;
  askConsumption: IntensityLabel;
  askReplenishment: IntensityLabel;
  askWithdrawal: IntensityLabel;
  bidConsumption: IntensityLabel;
  bidReplenishment: IntensityLabel;
  bidWithdrawal: IntensityLabel;
  askResponse: LiquiditySideResponse;
  bidResponse: LiquiditySideResponse;
  state: MicrostructureState;
  confidence: ConfidenceLabel;
  why: WhyFact[];
  effort: EffortVsResultState;
  absorption: LiquidityAbsorption;
  vacuum: VacuumKind;
  impact: PriceImpactHorizons;
  bands: LiquidityBandAccounting[];
  levels: FootprintLiquidityMark[];
  reversal: ReversalSetup | null;
  byTf: Partial<Record<LiquidityTf, LiquidityTfView>>;
  norms: {
    aggressiveBuy: NormStats;
    aggressiveSell: NormStats;
    delta: NormStats;
    priceDisplacement: NormStats;
    askDepthChange: NormStats;
  };
  compare: LiquidityMarketCompare | null;
  repeatedAskReplenishment: boolean;
  repeatedBidReplenishment: boolean;
}
