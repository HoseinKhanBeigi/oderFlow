import type { MarketState, MarketType, WindowId } from '../models/trade.js';
import type {
  AggressionSide,
  EffortVsResultState,
  EntryContext,
  IntensityLabel,
  MicroShift,
  MicrostructureState,
  StructureBias,
} from '../models/liquidity-response.js';
import type {
  LiquidityStructureState,
  PassiveLiquidityMarketState,
  PassiveSide,
  WallLifecycle,
} from '../models/passive-liquidity.js';
import type {
  DownsideBattleState,
  MarketBattleSummaryState,
  UpsideBattleState,
} from '../models/market-battle.js';
import type { PathOfLeastResistance, TargetDifficulty } from '../models/movement.js';
import type { DailyBias, DailySetup } from '../models/daily-signal.js';

export const BRIEFING_SCHEMA = 'orderflow.briefing.v1';

/**
 * Deterministic pre-filter. When `usable` is false the caller must not spend an
 * LLM call — the feed cannot support any entry decision, and a model given bad
 * data will still answer confidently.
 */
export interface BriefingGate {
  usable: boolean;
  /** Window snapshot confidence, 0–1. */
  confidence: number;
  /** Passive liquidity data quality, 0–100. */
  dataQuality: number;
  bookReliable: boolean;
  tradesFresh: boolean;
  tradeAgeMs: number;
  /** Empty when usable. Otherwise every reason the read is untrustworthy. */
  blockers: string[];
}

/**
 * Conclusions the deterministic engines already reached. The model's job is to
 * combine these, not to re-derive them from raw numbers.
 */
export interface BriefingRead {
  state: MarketState;
  microstructure: MicrostructureState;
  passiveState: PassiveLiquidityMarketState;
  /** Already computed by `classifyEntry` — treat as the engine's own opinion. */
  entryContext: EntryContext;
  effort: EffortVsResultState;
  aggression: AggressionSide;
  absorption: {
    type: 'BUYER_ABSORPTION' | 'SELLER_ABSORPTION';
    absorbingSide: 'PASSIVE_BUYER' | 'PASSIVE_SELLER';
    strength: number;
  } | null;
  reversal: { kind: 'BULLISH' | 'BEARISH'; reasons: string[] } | null;
  pathOfLeastResistance: PathOfLeastResistance;
  /** -100 (sell) … +100 (buy). */
  directionalScore: number;
  priceImpactEfficiency: IntensityLabel;
  /** True when later horizons give back the immediate move. */
  impactFaded: boolean;
}

export interface BriefingWindowFlow {
  window: WindowId;
  buy: number;
  sell: number;
  delta: number;
  /** (buy − sell) / (buy + sell), −1 … +1. */
  imbalance: number;
  /** How unusual |net| is for this symbol, 0–100. */
  netPercentile: number;
  largestBuy: number;
  largestSell: number;
  priceChangePercent: number;
  state: MarketState;
}

export interface BriefingBattleSide {
  state: UpsideBattleState | DownsideBattleState;
  /** 0–100 intensity of this interaction, independent of the other side. */
  score: number;
  aggressivePower: number;
  defensePower: number;
  survival: 'STRONG' | 'MODERATE' | 'WEAK';
  consumption: IntensityLabel;
  replenishment: IntensityLabel;
  why: string[];
}

export interface BriefingBattle {
  window: WindowId;
  summary: MarketBattleSummaryState;
  summaryWhy: string;
  upside: BriefingBattleSide;
  downside: BriefingBattleSide;
}

export interface BriefingWall {
  side: PassiveSide;
  price: number;
  distanceBps: number;
  notional: number;
  /** 0–100. Size alone never earns a high score. */
  strength: number;
  /** 0–100 chance the displayed size is still there on contact. */
  reliability: number;
  lifecycle: WallLifecycle;
  attacks: number;
  defended: number;
  /** Non-empty means the level is suspect (pulled on approach, spoof-like, …). */
  labels: string[];
}

export interface BriefingVacuum {
  direction: 'UP' | 'DOWN';
  detected: boolean;
  score: number;
  distanceToNextWallBps: number;
}

export interface BriefingZone {
  side: PassiveSide;
  priceMin: number;
  priceMax: number;
  state: LiquidityStructureState;
  tests: number;
  defended: number;
  strength: number;
}

export interface BriefingLiquidity {
  spreadBps: number;
  bidDepth: number;
  askDepth: number;
  nearBidDepth: number;
  nearAskDepth: number;
  passiveBuyerStrength: number;
  passiveSellerStrength: number;
  bidWalls: BriefingWall[];
  askWalls: BriefingWall[];
  upsideVacuum: BriefingVacuum;
  downsideVacuum: BriefingVacuum;
  floor: BriefingZone | null;
  ceiling: BriefingZone | null;
}

export interface BriefingTarget {
  price: number;
  distancePercent: number;
  /** 0–100 likelihood this level is reached given current flow vs liquidity. */
  reachability: number;
  difficulty: TargetDifficulty;
}

export interface BriefingTargets {
  atr: number;
  upside: BriefingTarget[];
  downside: BriefingTarget[];
}

export interface BriefingStructure {
  bias: StructureBias;
  shift: MicroShift;
  swingHigh: number | null;
  swingLow: number | null;
}

/** One footprint bar reduced to what a decision actually needs. */
export interface BriefingBar {
  /** Bar open, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  buy: number;
  sell: number;
  delta: number;
  /** Price bucket with the most total volume in the bar. */
  poc: number;
  /** Strongest buy- and sell-dominant levels: [price, buy, sell]. */
  topBuyLevels: [number, number, number][];
  topSellLevels: [number, number, number][];
}

export type FootprintStructureKind = 'absorption' | 'breakout' | 'distribution' | 'indeterminate';
export type ClusterDefense = 'defended' | 'collapsed' | 'unobserved';
export type MomentumState = 'building' | 'flat' | 'diverging';

export interface BriefingAskCluster {
  price: number;
  /** Cluster candle open, unix seconds. */
  t: number;
  ask: number;
  bid: number;
}

export interface BriefingThreeCandleBar {
  t: number;
  delta: number;
  /** `[price, bid_vol, ask_vol]`, high to low. */
  levels: [number, number, number][];
}

/**
 * Last 3 footprint candles plus the one question they can answer:
 * did bids defend the largest ask cluster, or did that cluster collapse?
 */
export interface BriefingThreeCandle {
  candles: BriefingThreeCandleBar[];
  askCluster: BriefingAskCluster | null;
  subsequentBid: number;
  subsequentAsk: number;
  defense: ClusterDefense;
  structure: FootprintStructureKind;
  why: string;
  momentum: BriefingAttackMomentum;
}

export interface BriefingAttackMomentum {
  /** Attack score 3 candles ago, 2 ago, current. Signed −100…+100, buy positive. */
  scores: [number | null, number | null, number | null];
  priceFrom: number | null;
  priceTo: number | null;
  priceChangePercent: number;
  state: MomentumState;
  implies: string;
}

export interface BriefingFootprint {
  /** Bar size in minutes. */
  timeframeMinutes: number;
  bars: BriefingBar[];
  last3: BriefingThreeCandle | null;
}

export interface BriefingDaily {
  timeframe: string;
  bias: DailyBias;
  setup: DailySetup;
  location: string;
  confidence: number;
  support: number | null;
  resistance: number | null;
  poc: number | null;
  /** The engine's own deterministic plan — the model should argue with it, not ignore it. */
  plan: {
    entry: number | null;
    sl: number | null;
    tp1: number | null;
    tp2: number | null;
    entryMode: 'NOW' | 'WAIT_FOR_LEVEL' | 'NONE';
    why: string;
  };
  reason: string;
}

/**
 * The complete payload handed to an LLM. Every field is either a number the
 * engine measured or a label it assigned; nothing here is model output.
 */
export interface AgentBriefing {
  schema: typeof BRIEFING_SCHEMA;
  symbol: string;
  market: MarketType | 'combined';
  at: string;
  price: number;
  gate: BriefingGate;
  read: BriefingRead;
  flow: BriefingWindowFlow[];
  battle: BriefingBattle;
  liquidity: BriefingLiquidity;
  targets: BriefingTargets;
  structure: BriefingStructure;
  footprint: BriefingFootprint | null;
  daily: BriefingDaily | null;
  /** Percentile-backed facts the engines emitted, already phrased for a reader. */
  notes: string[];
}

export interface BriefingOptions {
  /** Windows to include, shortest first. Default: 10s, 1m, 5m, 15m. */
  windows?: WindowId[];
  /** Window whose battle and liquidity view anchors the briefing. Default: 1m. */
  primaryWindow?: WindowId;
  /** Walls per side. Default 3. */
  maxWalls?: number;
  /** Liquidity targets per direction. Default 3. */
  maxTargets?: number;
  /** Footprint bars, most recent last. Default 12. */
  maxBars?: number;
  /** Imbalanced levels reported per bar per side. Default 2. */
  maxLevelsPerBar?: number;
  /** Price levels kept on each of the last 3 candles. Default 32. */
  maxLast3Levels?: number;
  /** Trade age past which the read is gated as stale. Default 15000. */
  staleTradeMs?: number;
  /** Minimum window confidence (0–1) to consider the read usable. Default 0.35. */
  minConfidence?: number;
  /** Minimum passive liquidity data quality (0–100). Default 40. */
  minDataQuality?: number;
}
