import type { LargeTradeThresholds } from '../models/flow.js';
import type { WindowId } from '../models/trade.js';

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

export interface IntegrityConfig {
  maxOutOfOrderMs: number;
  bookStaleMs: number;
  maxSpreadBps: number;
  duplicateWindow: number;
}

export interface EngineConfig {
  windows: WindowId[];
  bucketMs: number;
  maxBuckets: number;
  tradeRingCapacity: number;
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
  historicalBaselineSamples: number;
  accelerationLookbackBuckets: number;
  cvdSlopeMs: number;
}
