import type { EngineConfig } from './types.js';

/**
 * Example defaults only. Every value is overridable via `createEngine({ ... })`.
 * Dollar tiers are not universal — relative percentiles are preferred for classification.
 */
export const DEFAULT_CONFIG: EngineConfig = {
  windows: ['1s', '5s', '10s', '30s', '1m', '5m', '15m'],
  bucketMs: 100,
  maxBuckets: 12_000,
  tradeRingCapacity: 50_000,
  tapeCapacity: 2_000,

  largeTradeThresholds: {
    tier1: 100_000,
    tier2: 500_000,
    tier3: 1_000_000,
    tier4: 5_000_000,
  },

  relative: {
    sampleSize: 4_096,
    largePercentile: 95,
    veryLargePercentile: 99,
    extremePercentile: 99.9,
    minStdDevQuote: 1,
  },

  burst: {
    maxGapMs: 3_000,
    minTradeCount: 5,
    minTotalQuoteValue: 1_000_000,
    minSameSideShare: 0.8,
    strengthVolumeWeight: 0.35,
    strengthCountWeight: 0.2,
    strengthTightnessWeight: 0.2,
    strengthRelativeWeight: 0.15,
    strengthMoveWeight: 0.1,
  },

  cluster: {
    maxGapMs: 5_000,
    maxPriceRangeBps: 3,
    minTradeCount: 4,
    minTotalQuoteValue: 500_000,
  },

  persistent: {
    minSameSideDeltaPercent: 0.45,
    minTradeCount: 12,
    minFlowMultiple: 2,
    minDurationMs: 5_000,
  },

  absorption: {
    minAbsDeltaQuote: 5_000_000,
    minDeltaPercent: 0.35,
    maxPriceChangePercent: 0.08,
    minFlowMultiple: 3,
    minBurstOrPersistent: false,
    replenishmentBoost: 0.15,
    samePriceBoost: 0.1,
    minStrength: 0.55,
    minConfidence: 0.5,
  },

  samePrice: {
    maxPriceDeviationBps: 0.5,
    minTradeCount: 4,
    minTotalQuoteValue: 1_000_000,
  },

  iceberg: {
    minAggressiveOverVisible: 4,
    minAggressiveQuote: 250_000,
  },

  priceImpact: {
    sampleSize: 512,
    lowRatioOfMedian: 0.4,
    highRatioOfMedian: 2,
    extremeRatioOfMedian: 5,
    minAbsDeltaQuote: 50_000,
  },

  vacuum: {
    minPressure: 3,
    minPriceChangePercent: 0.4,
    maxFlowMultiple: 2.5,
    minImpact: 'HIGH',
  },

  exhaustion: {
    requiredPriorAcceleration: 'MODERATE',
    minDecelerationDrop: 0.5,
  },

  pressure: {
    nearBandPct: 0.25,
    thinAskQuote: 500_000,
    thinBidQuote: 500_000,
  },

  directionalWeights: {
    deltaPercent: 0.28,
    largeFlowShare: 0.16,
    burst: 0.12,
    persistence: 0.12,
    cvdSlope: 0.1,
    consumption: 0.1,
    priceResponse: 0.12,
  },

  participantWeights: {
    largeTradeFrequency: 0.12,
    largeTradeVolume: 0.16,
    relativePercentile: 0.14,
    burstPersistence: 0.14,
    sameSideDominance: 0.12,
    largeFlowShare: 0.12,
    priceResponse: 0.1,
    liquidityConsumption: 0.1,
  },

  confidence: {
    lowVolume: 0.25,
    staleBook: 0.3,
    missingData: 0.35,
    contradictoryPrice: 0.2,
    rapidFlip: 0.25,
    wideSpread: 0.2,
    reconnect: 0.4,
    sequenceGap: 0.35,
  },

  alerts: {
    extremeBurstQuote: 20_000_000,
    netFlow10sQuote: 100_000_000,
  },

  integrity: {
    maxOutOfOrderMs: 2_000,
    bookStaleMs: 3_000,
    maxSpreadBps: 50,
    duplicateWindow: 8_192,
  },

  historicalBaselineSamples: 1_024,
  accelerationLookbackBuckets: 5,
  cvdSlopeMs: 5_000,
};

export function mergeConfig(overrides: DeepPartial<EngineConfig> = {}): EngineConfig {
  return deepMerge(DEFAULT_CONFIG, overrides);
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  const out: T = Array.isArray(base) ? ([...base] as T) : { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const value = override[key];
    if (value === undefined) continue;
    const current = (out as Record<string, unknown>)[key as string];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      (out as Record<string, unknown>)[key as string] = deepMerge(
        current,
        value as DeepPartial<typeof current>,
      );
    } else {
      (out as Record<string, unknown>)[key as string] = value;
    }
  }
  return out;
}
