import type {
  PassiveLiquidityContext,
  PassiveLiquidityFeatures,
  PassiveLiquiditySnapshot,
  PassiveSide,
  PassiveSideMetrics,
} from '../models/passive-liquidity.js';
import { NET_LIQUIDITY_WINDOWS_MS } from '../models/passive-liquidity.js';
import { emptyAbsorption } from './absorption.js';
import { emptyMeasure } from './normalize.js';
import { emptyVacuum } from './vacuum.js';
import { emptyNetLiquiditySnapshot } from './net-liquidity.js';

function emptyNetByWindow() {
  const out: PassiveLiquiditySnapshot['netByWindow'] = {};
  for (const ms of NET_LIQUIDITY_WINDOWS_MS) {
    out[String(ms)] = emptyNetLiquiditySnapshot(ms);
  }
  return out;
}

function emptySide(side: PassiveSide): PassiveSideMetrics {
  return {
    side,
    depthNotional: 0,
    depthQuantity: 0,
    nearDepthNotional: 0,
    weightedDepthNotional: 0,
    addedNotional: 0,
    consumedNotional: 0,
    cancelledNotional: 0,
    replenishedNotional: 0,
    replenishmentRatio: 0,
    persistenceScore: 0,
    withdrawalScore: 0,
    levelCount: 0,
    velocity: {
      addedQuantityPerSec: 0,
      addedNotionalPerSec: 0,
      cancelledQuantityPerSec: 0,
      cancelledNotionalPerSec: 0,
      consumedQuantityPerSec: 0,
      consumedNotionalPerSec: 0,
      replenishedQuantityPerSec: 0,
      replenishedNotionalPerSec: 0,
    },
    consumedPercentile: 50,
    cancelledPercentile: 50,
    replenishedPercentile: 50,
    nearDepthPercentile: 50,
  };
}

export function emptyPassiveLiquidityContext(): PassiveLiquidityContext {
  return {
    askDepth: 0,
    bidDepth: 0,
    nearAskDepth: 0,
    nearBidDepth: 0,
    weightedAskDepth: 0,
    weightedBidDepth: 0,
    askConsumption: 0,
    bidConsumption: 0,
    askReplenishment: 0,
    bidReplenishment: 0,
    askWithdrawal: 0,
    bidWithdrawal: 0,
    askPersistence: 0,
    bidPersistence: 0,
    passiveSellerStrength: 0,
    passiveBuyerStrength: 0,
    upsideVacuumScore: 0,
    downsideVacuumScore: 0,
    sellerAbsorptionScore: 0,
    buyerAbsorptionScore: 0,
    bookImbalance: 0,
    nearBookImbalance: 0,
    askNetLiquidityChange: 0,
    bidNetLiquidityChange: 0,
    nearAskNetLiquidityChange: 0,
    nearBidNetLiquidityChange: 0,
    askNetLiquidityVelocity: 0,
    bidNetLiquidityVelocity: 0,
    askWithdrawalPressure: 0,
    bidWithdrawalPressure: 0,
    askCancellationShare: 0,
    bidCancellationShare: 0,
    askConsumptionShare: 0,
    bidConsumptionShare: 0,
    liquidityChangeImbalance: 0,
    dataQuality: 0,
  };
}

export function emptyPassiveLiquidityFeatures(): PassiveLiquidityFeatures {
  return {
    bidDepth: 0,
    askDepth: 0,
    nearBidDepth: 0,
    nearAskDepth: 0,
    weightedBidDepth: 0,
    weightedAskDepth: 0,
    bookImbalance: 0,
    nearBookImbalance: 0,
    askNetLiquidityChange: 0,
    bidNetLiquidityChange: 0,
    nearAskNetLiquidityChange: 0,
    nearBidNetLiquidityChange: 0,
    askNetLiquidityVelocity: 0,
    bidNetLiquidityVelocity: 0,
    askWithdrawalPressure: 0,
    bidWithdrawalPressure: 0,
    askCancellationShare: 0,
    bidCancellationShare: 0,
    askConsumptionShare: 0,
    bidConsumptionShare: 0,
    liquidityChangeImbalance: 0,
    bidConsumption: 0,
    askConsumption: 0,
    bidReplenishment: 0,
    askReplenishment: 0,
    bidWithdrawal: 0,
    askWithdrawal: 0,
    bidReplenishmentRatio: 0,
    askReplenishmentRatio: 0,
    bidPersistence: 0,
    askPersistence: 0,
    passiveBuyerStrength: 0,
    passiveSellerStrength: 0,
    buyerAbsorptionScore: 0,
    sellerAbsorptionScore: 0,
    upsideVacuumScore: 0,
    downsideVacuumScore: 0,
    bidWithdrawalPercentile: 50,
    askWithdrawalPercentile: 50,
    bidReplenishmentPercentile: 50,
    askReplenishmentPercentile: 50,
    aggressiveBuyPercentile: 50,
    aggressiveSellPercentile: 50,
    downsideEfficiencyPercentile: 50,
    upsideEfficiencyPercentile: 50,
    defendedBidTests: 0,
    defendedAskTests: 0,
    dataQuality: 0,
  };
}

/**
 * Cold start or unusable book. Everything reads zero and the state is explicitly
 * NO_DIRECTIONAL_EDGE rather than a neutral-looking classification.
 */
export function emptyPassiveLiquiditySnapshot(
  symbol: string,
  timestamp = 0,
): PassiveLiquiditySnapshot {
  return {
    symbol,
    timestamp,
    mid: 0,
    bestBid: 0,
    bestAsk: 0,
    spreadBps: 0,
    bid: emptySide('BID'),
    ask: emptySide('ASK'),
    bands: [],
    imbalanceCuts: [],
    netLiquidity: emptyNetLiquiditySnapshot(),
    netByWindow: emptyNetByWindow(),
    profile: [],
    walls: [],
    nearestBidWall: null,
    nearestAskWall: null,
    passiveBuyerStrength: 0,
    passiveSellerStrength: 0,
    sellerAbsorption: emptyAbsorption('SELLER_ABSORPTION'),
    buyerAbsorption: emptyAbsorption('BUYER_ABSORPTION'),
    upsideVacuum: emptyVacuum('UP'),
    downsideVacuum: emptyVacuum('DOWN'),
    zones: [],
    potentialFloor: null,
    potentialCeiling: null,
    aggressionVsLiquidity: {
      aggressiveSide: 'BALANCED',
      aggression: emptyMeasure(),
      consumption: emptyMeasure(),
      replenishment: emptyMeasure(),
      withdrawal: emptyMeasure(),
      displacementBps: emptyMeasure(),
      interpretation: 'no order book data',
    },
    effortVsResult: { effortScore: 0, resultScore: 0, passiveDefenseScore: 0, labels: [] },
    state: 'NO_DIRECTIONAL_EDGE',
    stateConfidence: 0,
    why: [],
    events: [],
    dataQuality: {
      score: 0,
      trustworthy: false,
      snapshotAgeMs: -1,
      sequenceContinuous: false,
      bookStreamContinuous: false,
      tradeStreamContinuous: false,
      reconnects: 0,
      sequenceGaps: 0,
      crossedBook: false,
      invalidLevels: 0,
      timestampDriftMs: 0,
      visibleDepthBps: 0,
      observations: 0,
      reasons: ['no order book data'],
    },
    context: emptyPassiveLiquidityContext(),
    features: emptyPassiveLiquidityFeatures(),
  };
}
