import type { LargeTradeThresholds } from '../models/flow.js';
import type { WindowId } from '../models/trade.js';
import type { PercentileBandConfig } from '../models/liquidity-response.js';

export interface RelativeSizeConfig {
  /** Rolling sample of recent trade notionals used for percentiles / z-scores. */
  sampleSize: number;
  largePercentile: number;
  veryLargePercentile: number;
  extremePercentile: number;
  minStdDevQuote: number;
}

export interface BurstConfig {
  maxGapMs: number;
  minTradeCount: number;
  minTotalQuoteValue: number;
  minSameSideShare: number;
  strengthVolumeWeight: number;
  strengthCountWeight: number;
  strengthTightnessWeight: number;
  strengthRelativeWeight: number;
  strengthMoveWeight: number;
}

export interface ClusterConfig {
  maxGapMs: number;
  maxPriceRangeBps: number;
  minTradeCount: number;
  minTotalQuoteValue: number;
}

export interface PersistentFlowConfig {
  minSameSideDeltaPercent: number;
  minTradeCount: number;
  minFlowMultiple: number;
  minDurationMs: number;
}

export interface AbsorptionConfig {
  minAbsDeltaQuote: number;
  minDeltaPercent: number;
  maxPriceChangePercent: number;
  minFlowMultiple: number;
  minBurstOrPersistent: boolean;
  replenishmentBoost: number;
  samePriceBoost: number;
  minStrength: number;
  minConfidence: number;
}

export interface SamePriceConfig {
  maxPriceDeviationBps: number;
  minTradeCount: number;
  minTotalQuoteValue: number;
}

export interface IcebergConfig {
  minAggressiveOverVisible: number;
  minAggressiveQuote: number;
}

export interface PriceImpactConfig {
  sampleSize: number;
  lowRatioOfMedian: number;
  highRatioOfMedian: number;
  extremeRatioOfMedian: number;
  minAbsDeltaQuote: number;
}

export interface VacuumConfig {
  minPressure: number;
  minPriceChangePercent: number;
  maxFlowMultiple: number;
  minImpact: 'HIGH' | 'EXTREME';
}

export interface ExhaustionConfig {
  requiredPriorAcceleration: 'MODERATE' | 'STRONG';
  minDecelerationDrop: number;
}

export interface PressureConfig {
  nearBandPct: number;
  thinAskQuote: number;
  thinBidQuote: number;
}

export interface ScoreWeights {
  deltaPercent: number;
  largeFlowShare: number;
  burst: number;
  persistence: number;
  cvdSlope: number;
  consumption: number;
  priceResponse: number;
}

export interface ParticipantScoreWeights {
  largeTradeFrequency: number;
  largeTradeVolume: number;
  relativePercentile: number;
  burstPersistence: number;
  sameSideDominance: number;
  largeFlowShare: number;
  priceResponse: number;
  liquidityConsumption: number;
}

export interface ConfidencePenalties {
  lowVolume: number;
  staleBook: number;
  missingData: number;
  contradictoryPrice: number;
  rapidFlip: number;
  wideSpread: number;
  reconnect: number;
  sequenceGap: number;
}

export interface AlertThresholds {
  extremeBurstQuote: number;
  netFlow10sQuote: number;
}

export interface ReachabilityWeights {
  flowToLiquidity: number;
  flowAcceleration: number;
  liquidityConsumption: number;
  liquidityPulling: number;
  liquidationAcceleration: number;
  priceEfficiency: number;
  volatilityDistance: number;
  structuralAlignment: number;
}

export interface MovePotentialConfig {
  /** Percent distances from mid used to build the liquidity path (not BTC-specific dollars). */
  percentSteps: number[];
  /** Extra targets at these ATR multiples. */
  atrMultiples: number[];
  maxTargetsPerSide: number;
  nearbyBandPct: number;
  minAtrPctOfPrice: number;
  densityThinRatio: number;
  densityThickRatio: number;
  densityExtremeRatio: number;
  pressureModerate: number;
  pressureStrong: number;
  pressureVeryStrong: number;
  reachability: ReachabilityWeights;
  easyScore: number;
  moderateScore: number;
  difficultScore: number;
  veryDifficultScore: number;
  directionNeutralBand: number;
  wallMultiple: number;
  wallMinPercentile: number;
  wallLookaround: number;
  wallDropFraction: number;
  vacuumDensityRatio: number;
  pullUnexplainedFraction: number;
}

export interface FlowBattleConfig {
  minAttackQuote: number;
  consumeOverReplenish: number;
  replenishOverConsume: number;
  minDefenseScore: number;
  minFailureConfidence: number;
  zoneBps: number;
  minExecutionToVisible: number;
}

export interface IntegrityConfig {
  maxOutOfOrderMs: number;
  bookStaleMs: number;
  maxSpreadBps: number;
  duplicateWindow: number;
}

export interface LiquidityResponseConfig {
  /** Nearby % of mid used for primary bid/ask accounting. */
  bandPct: number;
  /** Extra % bands around mid (not BTC-specific dollars). */
  bands: number[];
  /** Rolling candle windows for percentile / z-score normalization. */
  normWindows: number[];
  defaultNormWindow: number;
  impactHorizonsMs: number[];
  replenishRepeatMin: number;
  largeAggressionPercentile: number;
  extremeAggressionPercentile: number;
  weakDisplacementPercentile: number;
  strongDisplacementPercentile: number;
  nearTouchShare: number;
  vacuumPullShare: number;
  vacuumSpreadExpandBps: number;
  minBookTicks: number;
  minuteCapacity: number;
  markTtlMs: number;
  minImpactQuote: number;
  atrPeriod: number;
  persistMs: number;
  persistMinStrength: number;
  defendEscalateCount: number;
  highConfidenceMinQuality: number;
  oiThresholdPercent: number;
  unexplainedDropPercent: number;
  minConsistencyForHigh: number;
  minConsistencyForKnown: number;
  percentileBands: PercentileBandConfig;
}

export interface PassiveLiquidityConfig {
  /** Band edges in bps from mid. Consecutive pairs form the bands. */
  bandEdgesBps: number[];
  /** Cuts used for band-scoped book imbalance. */
  imbalanceCutsBps: number[];
  /** "Near touch" distance that feeds the Price Engine most heavily. */
  nearTouchBps: number;
  /** Decay constant k in exp(-k * distanceBps). Calibrate per market. */
  distanceWeightK: number;
  /** Levels beyond this distance are ignored for level tracking. */
  maxTrackedBps: number;

  /** Book change to trade reconciliation window, both directions. */
  tradeMatchWindowMs: number;
  /** Ticks either side of a trade price that may absorb its quantity. */
  tradeMatchTicks: number;
  /** A drop unmatched for this long is committed as a cancellation. */
  unresolvedCommitMs: number;
  /** Additions this long after consumption count as replenishment. */
  replenishWindowMs: number;

  /** Rolling sample size for per-level notional percentiles. */
  levelSampleSize: number;
  /** Rolling sample size for side-level flow metrics. */
  metricSampleSize: number;
  /**
   * Trailing window all normalized metrics are measured over. Percentiles are
   * only comparable against samples of the same window length.
   */
  metricWindowMs: number;
  /** How often a metric-window sample is added to the distributions. */
  metricSampleMs: number;

  /** Percentile of local level sizes above which a level may be a wall. */
  wallMinPercentile: number;
  /** Multiple of nearby median size required alongside the percentile. */
  wallMinVsNearbyMedian: number;
  /** Below this age a large wall is treated as unproven, not strong. */
  wallYoungMs: number;
  /** Age at which persistence saturates. */
  wallMatureMs: number;
  /** Fractional size loss that counts as an attack survived vs broken. */
  wallBreakFraction: number;

  /** Mid must close by at least this much for approach tracking to arm. */
  approachArmBps: number;
  /** Fraction of size lost during an approach, unexplained by trades. */
  approachWithdrawalFraction: number;

  /** Percentiles used to gate absorption and vacuum classification. */
  highPercentile: number;
  extremePercentile: number;
  lowPercentile: number;

  minAbsorptionScore: number;
  minVacuumScore: number;
  /** Distinct defended tests before a zone may be called confirmed. */
  confirmedTestCount: number;
  buildingTestCount: number;
  /** Zone half-width in bps for grouping tests at "the same" level. */
  zoneBps: number;

  /** Weights for PassiveBuyerStrength / PassiveSellerStrength. */
  strengthWeights: PassiveStrengthWeights;

  /** Below this data-quality score the engine returns NO_DIRECTIONAL_EDGE. */
  minTrustedQuality: number;
  /** Book older than this is stale. */
  bookStaleMs: number;
  /** Acceptable exchange-vs-local clock drift. */
  maxTimestampDriftMs: number;

  /** Per-level timeline retention. */
  timelinePoints: number;
  /** Max levels reported in the profile, per side. */
  profileLevelsPerSide: number;
  /** Max lifecycle events retained between snapshots. */
  eventCapacity: number;
  /** Price-level memory capacity. */
  memoryCapacity: number;
}

export interface PassiveStrengthWeights {
  depth: number;
  nearDepth: number;
  persistence: number;
  replenishment: number;
  withdrawalInverse: number;
  absorbedAggression: number;
  priceInefficiency: number;
  defendedTests: number;
}

export interface EngineConfig {
  windows: WindowId[];
  bucketMs: number;
  maxBuckets: number;
  tapeCapacity: number;
  largeTradeThresholds: LargeTradeThresholds;
  relative: RelativeSizeConfig;
  burst: BurstConfig;
  cluster: ClusterConfig;
  persistent: PersistentFlowConfig;
  absorption: AbsorptionConfig;
  samePrice: SamePriceConfig;
  iceberg: IcebergConfig;
  priceImpact: PriceImpactConfig;
  vacuum: VacuumConfig;
  exhaustion: ExhaustionConfig;
  pressure: PressureConfig;
  directionalWeights: ScoreWeights;
  participantWeights: ParticipantScoreWeights;
  confidence: ConfidencePenalties;
  alerts: AlertThresholds;
  integrity: IntegrityConfig;
  movePotential: MovePotentialConfig;
  flowBattle: FlowBattleConfig;
  liquidityResponse: LiquidityResponseConfig;
  passiveLiquidity: PassiveLiquidityConfig;
  historicalBaselineSamples: number;
  accelerationLookbackBuckets: number;
  cvdSlopeMs: number;
}
