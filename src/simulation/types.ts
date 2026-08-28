/**
 * Market microstructure simulation types.
 *
 * Physics words (impulse, particle, wall) are visualization metaphors only.
 * The engine uses event-driven order-book rules, never Newtonian equations.
 *
 * This module does not predict future price. It models how aggressive flow
 * interacts with passive liquidity: consumption, replenishment, withdrawal,
 * absorption, and the price displacement that interaction produces.
 */

export type SimulationMarketType = 'spot' | 'perp';
export type SimulationMode = 'realtime' | 'replay' | 'synthetic';
export type SimulationChannel = 'spot' | 'futures' | 'combined';
export type PlaybackSpeed = 0.25 | 0.5 | 1 | 2 | 5 | 10;
export type TrailWindowId = '1s' | '5s' | '30s' | '1m' | '5m';
export type IntensityLabel = 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';

export const TRAIL_WINDOW_MS: Record<TrailWindowId, number> = {
  '1s': 1_000,
  '5s': 5_000,
  '30s': 30_000,
  '1m': 60_000,
  '5m': 300_000,
};

export type SimulationMarketState =
  | 'NO_SIGNAL'
  | 'BUYERS_IN_CONTROL'
  | 'SELLERS_IN_CONTROL'
  | 'PASSIVE_SELLERS_DEFENDING'
  | 'PASSIVE_BUYERS_DEFENDING'
  | 'BUYERS_BEING_ABSORBED'
  | 'SELLERS_BEING_ABSORBED'
  | 'UPSIDE_LIQUIDITY_VACUUM'
  | 'DOWNSIDE_LIQUIDITY_VACUUM'
  | 'SHORT_SQUEEZE_DOMINATED'
  | 'LONG_SQUEEZE_DOMINATED'
  | 'SHORT_COVERING_DOMINATED'
  | 'LONG_UNWIND_DOMINATED'
  | 'BALANCED'
  | 'TRANSITION';

export type EffortVsResult =
  | 'EFFICIENT_BUYING'
  | 'INEFFICIENT_BUYING'
  | 'BUYER_ABSORPTION'
  | 'EFFICIENT_SELLING'
  | 'INEFFICIENT_SELLING'
  | 'SELLER_ABSORPTION'
  | 'BALANCED'
  | 'INSUFFICIENT';

export type OiClassification =
  | 'NEW_LEVERAGED_LONGS'
  | 'NEW_LEVERAGED_SHORTS'
  | 'SHORT_COVERING'
  | 'LONG_UNWIND'
  | 'EXPANDING'
  | 'CONTRACTING'
  | 'NEUTRAL';

export type FundingClassification = 'LONG_CROWDING' | 'SHORT_CROWDING' | 'NEUTRAL';

export type CrossMarketState =
  | 'BROAD_BUYING'
  | 'BROAD_SELLING'
  | 'SPOT_LED_BUYING'
  | 'SPOT_LED_SELLING'
  | 'FUTURES_LED_BUYING'
  | 'FUTURES_LED_SELLING'
  | 'SHORT_COVERING_DOMINATED'
  | 'LONG_LIQUIDATION_DOMINATED'
  | 'SPOT_FUTURES_DIVERGENCE'
  | 'BALANCED'
  | 'INSUFFICIENT';

export type LiquidityRegime = 'thin' | 'normal' | 'deep';

export interface LiquidityLevel {
  price: number;
  restingLiquidity: number;
  addedLiquidity: number;
  cancelledLiquidity: number;
  executedLiquidity: number;
  replenishedLiquidity: number;
}

export interface LevelFill {
  price: number;
  consumed: number;
  remainingAtLevel: number;
  cleared: boolean;
}

export interface BookWalkResult {
  filled: number;
  leftover: number;
  lastFillPrice: number | null;
  levelsCleared: number;
  fills: LevelFill[];
}

export interface LiquidationZone {
  id: string;
  price: number;
  side: 'short' | 'long';
  quoteValue: number;
  triggered: boolean;
  triggeredAt?: number;
}

export interface PricePoint {
  timestamp: number;
  price: number;
}

export interface VisualImpulse {
  side: 'BUY' | 'SELL';
  magnitude: number;
  forced: boolean;
  timestamp: number;
}

export interface VisualWallHit {
  side: 'bid' | 'ask';
  price: number;
  magnitude: number;
}

export interface VisualFade {
  side: 'bid' | 'ask';
  price: number;
  cancelled: number;
}

/**
 * Renderer-facing hints. These are observations already computed by the
 * engine — the UI must not derive market quantities from them.
 */
export interface VisualHints {
  buyImpulse: number;
  sellImpulse: number;
  forcedBuyImpulse: number;
  forcedSellImpulse: number;
  wallHits: VisualWallHit[];
  fades: VisualFade[];
  impulses: VisualImpulse[];
  absorptionAsk: boolean;
  absorptionBid: boolean;
  upsideVacuum: boolean;
  downsideVacuum: boolean;
}

export interface PressureGauge {
  /** -1 = full sell pressure, +1 = full buy pressure */
  net: number;
  buy: number;
  sell: number;
}

export interface WhyFact {
  text: string;
  weight: number;
}

export interface MarketSimulationState {
  timestamp: number;
  symbol: string;
  marketType: SimulationMarketType;

  price: number;
  previousPrice: number;
  priceChange: number;
  priceChangeBps: number;
  spread: number;
  spreadBps: number;

  aggressiveBuy: number;
  aggressiveSell: number;
  delta: number;
  cvd: number;

  bids: LiquidityLevel[];
  asks: LiquidityLevel[];
  bidDepth: number;
  askDepth: number;
  nearbyBidDepth: number;
  nearbyAskDepth: number;

  bidConsumption: number;
  askConsumption: number;
  bidReplenishment: number;
  askReplenishment: number;
  bidWithdrawal: number;
  askWithdrawal: number;

  buyerAbsorption: number;
  sellerAbsorption: number;

  openInterest?: number;
  oiChange?: number;
  oiChangePercent?: number;
  oiClassification?: OiClassification;

  fundingRate?: number;
  fundingClassification?: FundingClassification;

  longLiquidations?: number;
  shortLiquidations?: number;

  volatility: number;
  priceEfficiency: IntensityLabel;
  effortVsResult: EffortVsResult;
  marketState: SimulationMarketState;
  mechanics: string;

  levelsConsumedUp: number;
  levelsConsumedDown: number;

  upsidePressure: number;
  downsidePressure: number;
  netPressure: number;
  pressure: PressureGauge;

  why: WhyFact[];
  whyHeadline: string;

  trail: PricePoint[];
  visual: VisualHints;

  disclaimer: 'MARKET_MICROSTRUCTURE_SIMULATION';
}

export interface CrossMarketSimulationState {
  timestamp: number;
  symbol: string;
  spot: MarketSimulationState | null;
  futures: MarketSimulationState | null;
  combined: CrossMarketState;
  why: WhyFact[];
}

export interface CalibrationParams {
  symbol: string;
  marketType: SimulationMarketType;
  exchange: string;
  timeframeMs: number;
  liquidityRegime: LiquidityRegime;
  sampleCount: number;
  nearbyDepthWeight: number;
  replenishmentDamp: number;
  withdrawalAmplify: number;
  absorptionDamp: number;
  vacuumGapCoeff: number;
  volatilityScale: number;
  imbalanceMemory: number;
  impactDecay: number;
  leftoverPressureCoeff: number;
  updatedAt: number;
}

export interface ValidationMetrics {
  n: number;
  mae: number;
  rmse: number;
  directionAccuracy: number;
  impactCorrelation: number;
}

export interface ScenarioIntensity {
  aggressiveBuy: number;
  aggressiveSell: number;
  askDepth: number;
  bidDepth: number;
  askReplenishment: number;
  bidReplenishment: number;
  askWithdrawal: number;
  bidWithdrawal: number;
  volatility: number;
  oiChange: number;
  funding: number;
  longLiquidations: number;
  shortLiquidations: number;
}

export type ScenarioPresetId =
  | 'STRONG_BUY_BREAKOUT'
  | 'SELLER_ABSORPTION'
  | 'BUYER_ABSORPTION'
  | 'UPSIDE_LIQUIDITY_VACUUM'
  | 'DOWNSIDE_LIQUIDITY_VACUUM'
  | 'SHORT_SQUEEZE'
  | 'LONG_SQUEEZE'
  | 'FAKE_BREAKOUT'
  | 'BALANCED_MARKET'
  | 'SPOT_LED_RALLY'
  | 'FUTURES_LED_RALLY';

export interface ScenarioSpec {
  id?: ScenarioPresetId | string;
  label: string;
  symbol: string;
  marketType: SimulationMarketType;
  seed: number;
  durationMs: number;
  startPrice: number;
  tickSize: number;
  levelStep: number;
  intensity: ScenarioIntensity;
  liquidationZones?: Array<Omit<LiquidationZone, 'triggered' | 'triggeredAt'>>;
  channel?: SimulationChannel;
}

export const DISCLAIMER = 'MARKET_MICROSTRUCTURE_SIMULATION' as const;

export const EPSILON = 1e-9;
export const DEFAULT_NEARBY_LEVELS = 4;
export const DEFAULT_TICK_MS = 50;
export const DEFAULT_VISIBLE_LEVELS = 8;
