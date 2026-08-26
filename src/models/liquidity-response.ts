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
  | 'TRANSITION'
  | 'NO_DIRECTIONAL_EDGE';

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

export type PercentileBand = 'VERY_LOW' | 'LOW' | 'NORMAL' | 'ELEVATED' | 'HIGH' | 'EXTREME';

export interface PercentileBandConfig {
  veryLow: number;
  low: number;
  normal: number;
  elevated: number;
  high: number;
}

export interface DeltaAnalysis {
  delta: number;
  direction: 'BUY' | 'SELL' | 'BALANCED';
  absoluteDeltaPercentile: number;
  directionalMagnitudePercentile: number;
}

export type LiquidityChangeState =
  | 'STABLE'
  | 'CONSUMPTION_DOMINATED'
  | 'WITHDRAWAL_DOMINATED'
  | 'REPLENISHMENT_DOMINATED'
  | 'MIXED'
  | 'UNKNOWN';

export type AskSideState =
  | 'ASK_STABLE'
  | 'ASKS_BEING_CONSUMED'
  | 'ASKS_BEING_REPLENISHED'
  | 'ASKS_BEING_WITHDRAWN'
  | 'PASSIVE_SELLERS_DEFENDING'
  | 'PASSIVE_SELLERS_FAILING'
  | 'UNKNOWN';

export type BidSideState =
  | 'BID_STABLE'
  | 'BIDS_BEING_CONSUMED'
  | 'BIDS_BEING_REPLENISHED'
  | 'BIDS_BEING_WITHDRAWN'
  | 'PASSIVE_BUYERS_DEFENDING'
  | 'PASSIVE_BUYERS_FAILING'
  | 'UNKNOWN';

export type MarketMechanics =
  | 'FLOW_DRIVEN_UP'
  | 'FLOW_DRIVEN_DOWN'
  | 'LIQUIDITY_DRIVEN_UP'
  | 'LIQUIDITY_DRIVEN_DOWN'
  | 'BUYER_ABSORPTION'
  | 'SELLER_ABSORPTION'
  | 'BALANCED'
  | 'UNKNOWN';

export interface LiquidityDepthView {
  current: number;
  currentPercentile: number;
  changePercent: number | null;
  changeReason: string | null;
  consumed: number;
  cancelled: number;
  replenished: number;
  removed: number;
  consumptionRatio: number;
  changeState: LiquidityChangeState;
  sideState: AskSideState | BidSideState;
}

export interface ConsistencyResult {
  valid: boolean;
  reason: string | null;
  score: number;
}

export interface WhyFact {
  label: string;
  value: string;
  percentile?: number;
  band?: PercentileBand;
  tooltip?: string;
  detail?: string;
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
  bps5m: number;
  vwapBps: number;
  classification: IntensityLabel;
  /** True when later horizons fade vs immediate — reduces bullish/bearish conviction. */
  faded: boolean;
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

export type CvdDirection = 'UP' | 'DOWN' | 'FLAT';

export type CrossMarketState =
  | 'BROAD_BUYING'
  | 'BROAD_SELLING'
  | 'SPOT_LED_BUYING'
  | 'SPOT_LED_SELLING'
  | 'FUTURES_LED_BUYING'
  | 'FUTURES_LED_SELLING'
  | 'SPOT_FUTURES_BULLISH_DIVERGENCE'
  | 'SPOT_FUTURES_BEARISH_DIVERGENCE'
  | 'SHORT_COVERING_DOMINATED'
  | 'LONG_LIQUIDATION_DOMINATED'
  | 'LEVERAGE_DRIVEN_LONGS'
  | 'LEVERAGE_DRIVEN_SHORTS'
  | 'BALANCED'
  | 'UNRESOLVED';

export type OiInterpretation =
  | 'LIKELY_NEW_LONGS'
  | 'LIKELY_SHORT_COVERING'
  | 'LIKELY_NEW_SHORTS'
  | 'LIKELY_LONG_UNWIND'
  | 'UNCLEAR';

export type EntryContext =
  | 'LONG_SETUP_FORMING'
  | 'SHORT_SETUP_FORMING'
  | 'LONG_CONFIRMATION'
  | 'SHORT_CONFIRMATION'
  | 'NO_ENTRY';

export type StructureBias = 'HH_HL' | 'LH_LL' | 'HH_LL' | 'LH_HL' | 'NONE';
export type MicroShift = 'BULLISH_CHOCH' | 'BEARISH_CHOCH' | 'BULLISH_BOS' | 'BEARISH_BOS' | 'NONE';

export interface StructureSnapshot {
  swingHigh: number | null;
  swingLow: number | null;
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
  higherHigh: boolean;
  higherLow: boolean;
  lowerHigh: boolean;
  lowerLow: boolean;
  bias: StructureBias;
  shift: MicroShift;
}

export interface LiquidityMarketLeg {
  market: 'spot' | 'perp';
  state: MicrostructureState;
  aggression: AggressionSide;
  delta: number;
  deltaPercent: number;
  cvdDirection: CvdDirection;
  bookResponse: LiquiditySideResponse;
  absorption: AbsorptionKind;
  withdrawal: IntensityLabel;
  efficiency: IntensityLabel;
  effort: EffortVsResultState;
  oiChangePercent: number | null;
  oiInterpretation: OiInterpretation | null;
  shortLiquidationUsd: number;
  longLiquidationUsd: number;
  liquidations: number;
}

/** @deprecated Use CrossMarketState. Kept so older compare payloads still type-check. */
export type LiquidityMarketRelation = CrossMarketState;

export interface LiquidityMarketCompare {
  spot: LiquidityMarketLeg;
  futures: LiquidityMarketLeg;
  relation: CrossMarketState;
  confirmed: boolean;
  inefficient: boolean;
  oiInterpretation: OiInterpretation | null;
  confidenceScore: number;
  note: string;
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
  confidenceScore: number;
  dataQuality: number;
  why: WhyFact[];
  effort: EffortVsResultState;
  absorption: LiquidityAbsorption;
  vacuum: VacuumKind;
  impact: PriceImpactHorizons;
  bands: LiquidityBandAccounting[];
  levels: FootprintLiquidityMark[];
  reversal: ReversalSetup | null;
  entryContext: EntryContext;
  structure: StructureSnapshot;
  cvdDirection: CvdDirection;
  oiChangePercent: number | null;
  oiInterpretation: OiInterpretation | null;
  shortLiquidationUsd: number;
  longLiquidationUsd: number;
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
  deltaAnalysis: DeltaAnalysis;
  askDepth: LiquidityDepthView;
  bidDepth: LiquidityDepthView;
  marketMechanics: MarketMechanics;
  dataConsistency: number;
  consistency: ConsistencyResult;
}
