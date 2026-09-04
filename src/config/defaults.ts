import type { EngineConfig } from './types.js';

/**
 * Example defaults only. Every value is overridable via `createEngine({ ... })`.
 * Dollar tiers are not universal — relative percentiles are preferred for classification.
 */
export const DEFAULT_CONFIG: EngineConfig = {
  windows: ['1s', '5s', '10s', '30s', '1m', '5m', '15m'],
  bucketMs: 100,
  /** 100ms × 9_000 = 15m coverage for the longest configured window. */
  maxBuckets: 9_000,
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
    bookStaleMs: 5_000,
    maxSpreadBps: 50,
    duplicateWindow: 8_192,
  },

  movePotential: {
    percentSteps: [0.15, 0.35, 0.7, 1.4, 2.1, 2.8],
    atrMultiples: [0.25, 0.5, 1, 1.5, 2, 3],
    maxTargetsPerSide: 6,
    nearbyBandPct: 0.35,
    minAtrPctOfPrice: 0.15,
    densityThinRatio: 0.5,
    densityThickRatio: 2,
    densityExtremeRatio: 4,
    pressureModerate: 0.6,
    pressureStrong: 1,
    pressureVeryStrong: 1.5,
    reachability: {
      flowToLiquidity: 0.35,
      flowAcceleration: 0.1,
      liquidityConsumption: 0.1,
      liquidityPulling: 0.05,
      liquidationAcceleration: 0.05,
      priceEfficiency: 0.15,
      volatilityDistance: 0.15,
      structuralAlignment: 0.05,
    },
    easyScore: 75,
    moderateScore: 55,
    difficultScore: 35,
    veryDifficultScore: 20,
    directionNeutralBand: 0.12,
    wallMultiple: 4,
    wallMinPercentile: 80,
    wallLookaround: 4,
    wallDropFraction: 0.5,
    vacuumDensityRatio: 0.35,
    pullUnexplainedFraction: 0.55,
  },

  flowBattle: {
    minAttackQuote: 1_000_000,
    consumeOverReplenish: 1.5,
    replenishOverConsume: 1.1,
    minDefenseScore: 55,
    minFailureConfidence: 0.55,
    zoneBps: 5,
    minExecutionToVisible: 4,
  },

  marketBattle: {
    aggressiveWeights: {
      executedVolume: 0.25,
      executionVelocity: 0.2,
      imbalanceStrength: 0.2,
      largeTradeActivity: 0.15,
      tradeCountIntensity: 0.1,
      deltaCvdContribution: 0.1,
    },
    imbalanceRatio: 3,
    minImbalanceQuote: 800,
    tradeStaleMs: 15_000,
    tradeStaleGapMultiple: 15,
    maxTradeStaleMs: 180_000,
  },

  liquidityResponse: {
    bandPct: 0.25,
    bands: [0.05, 0.1, 0.25, 0.5, 1.0],
    normWindows: [20, 50, 100],
    defaultNormWindow: 50,
    impactHorizonsMs: [0, 5_000, 30_000, 60_000, 300_000],
    replenishRepeatMin: 2,
    largeAggressionPercentile: 80,
    extremeAggressionPercentile: 92,
    weakDisplacementPercentile: 40,
    strongDisplacementPercentile: 70,
    nearTouchShare: 0.5,
    vacuumPullShare: 0.45,
    vacuumSpreadExpandBps: 1.5,
    minBookTicks: 4,
    minuteCapacity: 400,
    markTtlMs: 8_000,
    minImpactQuote: 50_000,
    atrPeriod: 14,
    persistMs: 4_000,
    persistMinStrength: 0.62,
    defendEscalateCount: 2,
    highConfidenceMinQuality: 55,
    oiThresholdPercent: 0.05,
    unexplainedDropPercent: 80,
    minConsistencyForHigh: 60,
    minConsistencyForKnown: 40,
    percentileBands: {
      veryLow: 20,
      low: 40,
      normal: 60,
      elevated: 80,
      high: 95,
    },
  },

  passiveLiquidity: {
    bandEdgesBps: [0, 5, 10, 25, 50, 100, 250],
    imbalanceCutsBps: [5, 10, 25, 50, 100],
    nearTouchBps: 10,
    /** exp(-0.03 * bps): ~0.86 at 5bps, ~0.22 at 50bps, ~0.05 at 100bps. */
    distanceWeightK: 0.03,
    maxTrackedBps: 250,

    tradeMatchWindowMs: 100,
    tradeMatchTicks: 1,
    unresolvedCommitMs: 150,
    replenishWindowMs: 5_000,

    levelSampleSize: 4_096,
    metricSampleSize: 512,
    metricWindowMs: 10_000,
    metricSampleMs: 1_000,

    wallMinPercentile: 95,
    wallMinVsNearbyMedian: 3,
    wallYoungMs: 2_000,
    wallMatureMs: 300_000,
    wallBreakFraction: 0.8,

    approachArmBps: 2,
    approachWithdrawalFraction: 0.5,

    highPercentile: 85,
    extremePercentile: 92,
    lowPercentile: 30,

    minAbsorptionScore: 60,
    minVacuumScore: 60,
    confirmedTestCount: 4,
    buildingTestCount: 2,
    zoneBps: 5,

    strengthWeights: {
      depth: 0.1,
      nearDepth: 0.18,
      persistence: 0.14,
      replenishment: 0.18,
      withdrawalInverse: 0.14,
      absorbedAggression: 0.12,
      priceInefficiency: 0.08,
      defendedTests: 0.06,
    },

    minTrustedQuality: 45,
    bookStaleMs: 5_000,
    maxTimestampDriftMs: 5_000,

    timelinePoints: 64,
    profileLevelsPerSide: 24,
    eventCapacity: 256,
    memoryCapacity: 512,
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
