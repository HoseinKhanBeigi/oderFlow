import type { WhyFact } from './liquidity-response.js';

export type PassiveSide = 'BID' | 'ASK';

/**
 * Lifecycle of one resting price level. Ordered loosely from "nothing happening"
 * to "structurally meaningful", but the classifier picks by evidence, not by order.
 */
export type PassiveLiquidityState =
  | 'NEW'
  | 'PERSISTENT'
  | 'BUILDING'
  | 'WEAKENING'
  | 'WITHDRAWING'
  | 'BEING_CONSUMED'
  | 'REPLENISHING'
  | 'DEFENDING'
  | 'ABSORBING'
  | 'BROKEN'
  | 'VACUUM'
  | 'UNRELIABLE';

export type PassiveLiquidityEventType =
  | 'LIQUIDITY_ADDED'
  | 'LIQUIDITY_CONSUMED'
  | 'LIQUIDITY_CANCELLED'
  | 'LIQUIDITY_REPLENISHED'
  | 'LIQUIDITY_MOVED'
  | 'WALL_APPEARED'
  | 'WALL_DISAPPEARED'
  | 'WALL_ATTACKED'
  | 'WALL_DEFENDED'
  | 'WALL_BROKEN'
  | 'VACUUM_DETECTED'
  | 'ABSORPTION_DETECTED';

export interface PassiveLiquidityEvent {
  type: PassiveLiquidityEventType;
  side: PassiveSide;
  price: number;
  timestamp: number;
  quantity: number;
  notional: number;
  distanceBps: number;
  /** Short human-readable reason. Never a claim about intent. */
  note: string;
}

/**
 * Why a level's size dropped. `UNRESOLVED` is a real answer: within the
 * matching window we do not yet know, and we refuse to guess.
 */
export type LiquidityDropCause = 'EXECUTION' | 'CANCELLATION' | 'OUT_OF_VIEW' | 'UNRESOLVED';

export interface PassiveLiquidityLevel {
  side: PassiveSide;

  price: number;
  quantity: number;
  notionalValue: number;

  /** Always a positive distance *toward* the level from mid. */
  distanceFromMid: number;
  distanceBps: number;
  distancePercent: number;

  firstSeenAt: number;
  lastUpdatedAt: number;
  ageMs: number;
  /** Milliseconds the level has actually held size, excluding gaps. */
  presentMs: number;

  initialQuantity: number;
  initialNotional: number;

  addedQuantity: number;
  addedNotional: number;

  consumedQuantity: number;
  consumedNotional: number;

  cancelledQuantity: number;
  cancelledNotional: number;

  replenishedQuantity: number;
  replenishedNotional: number;

  /** Drops still inside the trade-matching window; not yet consumed or cancelled. */
  unresolvedQuantity: number;

  maxQuantity: number;
  maxNotional: number;

  executionCount: number;
  updateCount: number;
  replenishmentCount: number;
  attackCount: number;
  defendedCount: number;

  replenishmentRatio: number;

  persistenceScore: number;
  replenishmentScore: number;
  withdrawalScore: number;
  absorptionScore: number;

  /** Rolling percentile of this level's notional vs this book's own history. */
  sizePercentile: number;
  isWall: boolean;

  /** Closest the mid has come while this level held size. */
  closestApproachBps: number;
  notionalAtClosestApproach: number;
  /** Size shrank without matching executions while price closed in. */
  approachWithdrawal: boolean;

  visible: boolean;
  /** Outside the exchange's truncated depth window, so changes are unknowable. */
  outOfView: boolean;

  state: PassiveLiquidityState;
}

export interface LiquidityBandBucket {
  /** Inclusive lower edge in bps from mid. */
  fromBps: number;
  /** Exclusive upper edge in bps from mid. */
  toBps: number;
  label: string;
  bidQuantity: number;
  bidNotional: number;
  askQuantity: number;
  askNotional: number;
  bidLevels: number;
  askLevels: number;
  /** (bid - ask) / (bid + ask) inside this band alone. */
  imbalance: number;
}

export interface BookImbalanceCut {
  withinBps: number;
  bidNotional: number;
  askNotional: number;
  /** -1 ask dominance, 0 balanced, +1 bid dominance. */
  imbalance: number;
}

export type NetLiquidityState =
  | 'STRONGLY_GROWING'
  | 'GROWING'
  | 'STABLE'
  | 'SHRINKING'
  | 'STRONGLY_SHRINKING'
  | 'WITHDRAWAL_DOMINATED'
  | 'CONSUMPTION_DOMINATED'
  | 'REPLENISHMENT_DOMINATED'
  | 'MIXED'
  | 'LOW_CONFIDENCE';

export type NetLiquidityCause =
  | 'NEW_LIQUIDITY'
  | 'REPLENISHMENT'
  | 'WITHDRAWAL'
  | 'CONSUMPTION'
  | 'MIXED'
  | 'NONE';

export interface NetLiquiditySide {
  side: PassiveSide;
  startingQuantity: number;
  currentQuantity: number;
  newAddedQuantity: number;
  replenishedQuantity: number;
  cancelledQuantity: number;
  consumedQuantity: number;
  bookNetQuantity: number;
  behavioralNetQuantity: number;
  startingDepth: number;
  currentDepth: number;
  newAdded: number;
  replenished: number;
  totalAdded: number;
  cancelled: number;
  consumed: number;
  bookNetChange: number;
  behavioralNetChange: number;
  netChangePercent: number | null;
  percentageReliable: boolean;
  velocityPerSec: number;
  velocityPercentile: number;
  velocityZScore: number;
  percentile: number;
  zScore: number;
  withdrawalPressure: number;
  cancellationShare: number;
  consumptionShare: number;
  reconciliationError: number;
  reconciliationErrorPercent: number;
  dataConsistency: 'HIGH' | 'LOW';
  state: NetLiquidityState;
  primaryCause: NetLiquidityCause;
}

export interface NetLiquidityBand {
  fromBps: number;
  toBps: number;
  label: string;
  bid: NetLiquiditySide;
  ask: NetLiquiditySide;
  /** Book change not explained by order activity, normally levels crossing the moving band boundary. */
  rangeMigration: { bid: number; ask: number };
}

export interface NetLiquiditySnapshot {
  windowMs: number;
  bid: NetLiquiditySide;
  ask: NetLiquiditySide;
  near5Bps: { bid: NetLiquiditySide; ask: NetLiquiditySide };
  near10Bps: { bid: NetLiquiditySide; ask: NetLiquiditySide };
  bands: NetLiquidityBand[];
  liquidityChangeImbalance: number;
  liquidityChangeImbalancePercentile: number;
  liquidityChangeImbalanceZScore: number;
  interpretation: string;
  flags: Array<'LIQUIDITY_ACCOUNTING_MISMATCH' | 'SMALL_BASE_UNRELIABLE_PERCENTAGE'>;
}

/** Raw value plus every normalization the spec requires. Never a bare threshold. */
export interface NormalizedMeasure {
  raw: number;
  percentile: number;
  zScore: number;
  vsNearbyDepth: number;
  vsRecentExecutedVolume: number;
  vsDailyVolume: number;
  samples: number;
}

export type WallLifecycle =
  | 'FORMING'
  | 'HOLDING'
  | 'ATTACKED'
  | 'DEFENDED'
  | 'CONSUMED'
  | 'WITHDRAWN'
  | 'BROKEN';

export interface PassiveLiquidityWall {
  side: PassiveSide;
  price: number;
  quantity: number;
  notional: number;
  distanceBps: number;

  sizePercentile: number;
  persistencePercentile: number;
  replenishmentPercentile: number;
  vsNearbyMedian: number;

  ageMs: number;
  attackCount: number;
  defendedCount: number;
  consumedNotional: number;
  replenishedNotional: number;
  cancelledNotional: number;

  /** 0-100. Size alone never gets a level a high score. */
  strength: number;
  /** 0-100 confidence that displayed size will still be there on contact. */
  reliability: number;
  lifecycle: WallLifecycle;
  labels: UnreliableLiquidityLabel[];
  state: PassiveLiquidityState;
}

export type UnreliableLiquidityLabel =
  | 'LOW_PERSISTENCE_WALL'
  | 'APPROACH_WITHDRAWAL'
  | 'UNRELIABLE_LIQUIDITY'
  | 'REAPPEARS_FARTHER'
  | 'MULTI_EXCHANGE_LIQUIDITY_CLUSTER'
  | 'SINGLE_EXCHANGE_WALL';

export type LiquidityStructureState =
  | 'POTENTIAL_FLOOR'
  | 'BUILDING_FLOOR'
  | 'CONFIRMED_SUPPORT'
  | 'WEAKENING_SUPPORT'
  | 'BROKEN_SUPPORT'
  | 'POTENTIAL_CEILING'
  | 'BUILDING_CEILING'
  | 'CONFIRMED_RESISTANCE'
  | 'WEAKENING_RESISTANCE'
  | 'BROKEN_RESISTANCE';

export interface LiquidityZone {
  side: PassiveSide;
  priceMin: number;
  priceMax: number;
  state: LiquidityStructureState;
  /** Distinct aggressive tests of the zone. */
  testCount: number;
  defendedTests: number;
  aggressionAbsorbed: number;
  consumedNotional: number;
  replenishedNotional: number;
  cancelledNotional: number;
  replenishmentRatio: number;
  /** Mean absolute price displacement per test, in bps. */
  displacementBps: number;
  strength: number;
  confidence: number;
  firstSeenAt: number;
  lastTestAt: number;
}

export interface PassiveLiquidityVelocity {
  addedQuantityPerSec: number;
  addedNotionalPerSec: number;
  cancelledQuantityPerSec: number;
  cancelledNotionalPerSec: number;
  consumedQuantityPerSec: number;
  consumedNotionalPerSec: number;
  replenishedQuantityPerSec: number;
  replenishedNotionalPerSec: number;
}

export interface PassiveSideMetrics {
  side: PassiveSide;

  depthNotional: number;
  depthQuantity: number;
  nearDepthNotional: number;
  weightedDepthNotional: number;

  addedNotional: number;
  consumedNotional: number;
  cancelledNotional: number;
  replenishedNotional: number;
  replenishmentRatio: number;

  /** 0-100, mean level persistence weighted by notional. */
  persistenceScore: number;
  withdrawalScore: number;
  levelCount: number;

  velocity: PassiveLiquidityVelocity;

  consumedPercentile: number;
  cancelledPercentile: number;
  replenishedPercentile: number;
  nearDepthPercentile: number;
}

export interface AbsorptionAssessment {
  type: 'SELLER_ABSORPTION' | 'BUYER_ABSORPTION' | null;
  /** Passive side doing the absorbing. */
  absorbingSide: PassiveSide | null;
  score: number;
  confidence: number;
  aggressionPercentile: number;
  consumptionPercentile: number;
  replenishmentPercentile: number;
  displacementPercentile: number;
  detected: boolean;
}

export interface VacuumAssessment {
  direction: 'UP' | 'DOWN';
  score: number;
  detected: boolean;
  nearDepthPercentile: number;
  withdrawalPercentile: number;
  replenishmentPercentile: number;
  distanceToNextWallBps: number;
  priceEfficiencyPercentile: number;
  spreadExpansionBps: number;
}

export interface LiquidityLevelTimelinePoint {
  at: number;
  notional: number;
  quantity: number;
  event: PassiveLiquidityEventType | 'NONE';
}

/** Payload for a clicked price level in the UI. */
export interface LiquidityLevelDetail {
  level: PassiveLiquidityLevel;
  timeline: LiquidityLevelTimelinePoint[];
  wall: PassiveLiquidityWall | null;
  memory: PriceLevelMemory | null;
}

export interface PriceLevelMemory {
  price: number;
  side: PassiveSide;
  attacks: number;
  defendedTests: number;
  brokenTests: number;
  totalAggressionAbsorbed: number;
  totalConsumed: number;
  totalReplenished: number;
  totalCancelled: number;
  lastTestAt: number;
  firstSeenAt: number;
  /** 0-100. High means repeated aggression failed to move price through. */
  defenseScore: number;
  extendedThrough: boolean;
}

export interface AggressionVsLiquidityPanel {
  aggressiveSide: 'BUY' | 'SELL' | 'BALANCED';
  aggression: NormalizedMeasure;
  consumption: NormalizedMeasure;
  replenishment: NormalizedMeasure;
  withdrawal: NormalizedMeasure;
  displacementBps: NormalizedMeasure;
  interpretation: string;
}

export interface EffortVsPassiveResult {
  effortScore: number;
  resultScore: number;
  passiveDefenseScore: number;
  labels: string[];
}

export interface PassiveLiquidityDataQuality {
  /** 0-100. Below `minTrustedQuality` the engine refuses to classify. */
  score: number;
  trustworthy: boolean;
  snapshotAgeMs: number;
  sequenceContinuous: boolean;
  bookStreamContinuous: boolean;
  tradeStreamContinuous: boolean;
  reconnects: number;
  sequenceGaps: number;
  crossedBook: boolean;
  invalidLevels: number;
  timestampDriftMs: number;
  /** Exchange truncates depth, so beyond this distance changes are unknowable. */
  visibleDepthBps: number;
  observations: number;
  reasons: string[];
}

export type PassiveLiquidityMarketState =
  | 'BUYERS_EXPANDING'
  | 'SELLERS_EXPANDING'
  | 'PASSIVE_BUYERS_DEFENDING'
  | 'PASSIVE_SELLERS_DEFENDING'
  | 'BUYER_ABSORPTION'
  | 'SELLER_ABSORPTION'
  | 'UPSIDE_LIQUIDITY_VACUUM'
  | 'DOWNSIDE_LIQUIDITY_VACUUM'
  | 'BUILDING_FLOOR'
  | 'BUILDING_CEILING'
  | 'BALANCED'
  | 'NO_DIRECTIONAL_EDGE';

/** Feature bundle handed to the Price Engine. Features, not verdicts. */
export interface PassiveLiquidityContext {
  askDepth: number;
  bidDepth: number;

  nearAskDepth: number;
  nearBidDepth: number;

  weightedAskDepth: number;
  weightedBidDepth: number;

  askConsumption: number;
  bidConsumption: number;

  askReplenishment: number;
  bidReplenishment: number;

  askWithdrawal: number;
  bidWithdrawal: number;

  askPersistence: number;
  bidPersistence: number;

  passiveSellerStrength: number;
  passiveBuyerStrength: number;

  upsideVacuumScore: number;
  downsideVacuumScore: number;

  sellerAbsorptionScore: number;
  buyerAbsorptionScore: number;

  bookImbalance: number;
  nearBookImbalance: number;

  askNetLiquidityChange: number;
  bidNetLiquidityChange: number;
  nearAskNetLiquidityChange: number;
  nearBidNetLiquidityChange: number;
  askNetLiquidityVelocity: number;
  bidNetLiquidityVelocity: number;
  askWithdrawalPressure: number;
  bidWithdrawalPressure: number;
  askCancellationShare: number;
  bidCancellationShare: number;
  askConsumptionShare: number;
  bidConsumptionShare: number;
  liquidityChangeImbalance: number;

  nearestAskWall?: PassiveLiquidityWall;
  nearestBidWall?: PassiveLiquidityWall;

  potentialFloor?: LiquidityZone;
  potentialCeiling?: LiquidityZone;

  dataQuality: number;
}

/** Flat numeric row for the Backtest Lab and signal study. */
export interface PassiveLiquidityFeatures {
  bidDepth: number;
  askDepth: number;
  nearBidDepth: number;
  nearAskDepth: number;
  weightedBidDepth: number;
  weightedAskDepth: number;
  bookImbalance: number;
  nearBookImbalance: number;
  askNetLiquidityChange: number;
  bidNetLiquidityChange: number;
  nearAskNetLiquidityChange: number;
  nearBidNetLiquidityChange: number;
  askNetLiquidityVelocity: number;
  bidNetLiquidityVelocity: number;
  askWithdrawalPressure: number;
  bidWithdrawalPressure: number;
  askCancellationShare: number;
  bidCancellationShare: number;
  askConsumptionShare: number;
  bidConsumptionShare: number;
  liquidityChangeImbalance: number;
  bidConsumption: number;
  askConsumption: number;
  bidReplenishment: number;
  askReplenishment: number;
  bidWithdrawal: number;
  askWithdrawal: number;
  bidReplenishmentRatio: number;
  askReplenishmentRatio: number;
  bidPersistence: number;
  askPersistence: number;
  passiveBuyerStrength: number;
  passiveSellerStrength: number;
  buyerAbsorptionScore: number;
  sellerAbsorptionScore: number;
  upsideVacuumScore: number;
  downsideVacuumScore: number;
  bidWithdrawalPercentile: number;
  askWithdrawalPercentile: number;
  bidReplenishmentPercentile: number;
  askReplenishmentPercentile: number;
  aggressiveBuyPercentile: number;
  aggressiveSellPercentile: number;
  downsideEfficiencyPercentile: number;
  upsideEfficiencyPercentile: number;
  defendedBidTests: number;
  defendedAskTests: number;
  dataQuality: number;
}

export interface PassiveLiquiditySnapshot {
  symbol: string;
  timestamp: number;

  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;

  bid: PassiveSideMetrics;
  ask: PassiveSideMetrics;

  bands: LiquidityBandBucket[];
  imbalanceCuts: BookImbalanceCut[];
  netLiquidity: NetLiquiditySnapshot;

  /** Descending by price: asks above mid, then bids below. */
  profile: PassiveLiquidityLevel[];

  walls: PassiveLiquidityWall[];
  nearestBidWall: PassiveLiquidityWall | null;
  nearestAskWall: PassiveLiquidityWall | null;

  passiveBuyerStrength: number;
  passiveSellerStrength: number;

  sellerAbsorption: AbsorptionAssessment;
  buyerAbsorption: AbsorptionAssessment;

  upsideVacuum: VacuumAssessment;
  downsideVacuum: VacuumAssessment;

  zones: LiquidityZone[];
  potentialFloor: LiquidityZone | null;
  potentialCeiling: LiquidityZone | null;

  aggressionVsLiquidity: AggressionVsLiquidityPanel;
  effortVsResult: EffortVsPassiveResult;

  state: PassiveLiquidityMarketState;
  stateConfidence: number;
  why: WhyFact[];

  events: PassiveLiquidityEvent[];
  dataQuality: PassiveLiquidityDataQuality;
  context: PassiveLiquidityContext;
  features: PassiveLiquidityFeatures;
}
