import type { PassiveLiquidityConfig } from '../config/types.js';
import { safeDiv } from '../core/integrity.js';
import type {
  BookImbalanceCut,
  LiquidityBandBucket,
  PassiveLiquidityLevel,
} from '../models/passive-liquidity.js';
import { distanceWeight } from './level-scores.js';

export interface DepthAggregate {
  bidNotional: number;
  askNotional: number;
  bidQuantity: number;
  askQuantity: number;
  nearBidNotional: number;
  nearAskNotional: number;
  weightedBidNotional: number;
  weightedAskNotional: number;
  bidLevels: number;
  askLevels: number;
}

function bandLabel(fromBps: number, toBps: number): string {
  return `${fromBps}-${toBps}bps`;
}

/**
 * Aggregates levels into configurable bps bands. Out-of-view levels are excluded
 * because their current size is unknown, not zero.
 */
export function buildBands(
  levels: PassiveLiquidityLevel[],
  config: PassiveLiquidityConfig,
): LiquidityBandBucket[] {
  const edges = config.bandEdgesBps;
  const buckets: LiquidityBandBucket[] = [];

  for (let i = 0; i < edges.length - 1; i++) {
    const fromBps = edges[i];
    const toBps = edges[i + 1];
    if (fromBps === undefined || toBps === undefined) continue;
    buckets.push({
      fromBps,
      toBps,
      label: bandLabel(fromBps, toBps),
      bidQuantity: 0,
      bidNotional: 0,
      askQuantity: 0,
      askNotional: 0,
      bidLevels: 0,
      askLevels: 0,
      imbalance: 0,
    });
  }

  for (const level of levels) {
    if (level.outOfView || level.quantity <= 0) continue;
    const bucket = buckets.find(
      (b) => level.distanceBps >= b.fromBps && level.distanceBps < b.toBps,
    );
    if (!bucket) continue;
    if (level.side === 'BID') {
      bucket.bidQuantity += level.quantity;
      bucket.bidNotional += level.notionalValue;
      bucket.bidLevels += 1;
    } else {
      bucket.askQuantity += level.quantity;
      bucket.askNotional += level.notionalValue;
      bucket.askLevels += 1;
    }
  }

  for (const bucket of buckets) {
    const total = bucket.bidNotional + bucket.askNotional;
    bucket.imbalance = total > 0 ? (bucket.bidNotional - bucket.askNotional) / total : 0;
  }
  return buckets;
}

/**
 * Book imbalance at several distances. A book can be balanced at 100bps while
 * strongly bid-dominant at 10bps, which is why one number is never enough.
 */
export function buildImbalanceCuts(
  levels: PassiveLiquidityLevel[],
  config: PassiveLiquidityConfig,
): BookImbalanceCut[] {
  return config.imbalanceCutsBps.map((withinBps) => {
    let bidNotional = 0;
    let askNotional = 0;
    for (const level of levels) {
      if (level.outOfView || level.quantity <= 0) continue;
      if (level.distanceBps > withinBps) continue;
      if (level.side === 'BID') bidNotional += level.notionalValue;
      else askNotional += level.notionalValue;
    }
    const total = bidNotional + askNotional;
    return {
      withinBps,
      bidNotional,
      askNotional,
      imbalance: total > 0 ? (bidNotional - askNotional) / total : 0,
    };
  });
}

export function aggregateDepth(
  levels: PassiveLiquidityLevel[],
  config: PassiveLiquidityConfig,
): DepthAggregate {
  const out: DepthAggregate = {
    bidNotional: 0,
    askNotional: 0,
    bidQuantity: 0,
    askQuantity: 0,
    nearBidNotional: 0,
    nearAskNotional: 0,
    weightedBidNotional: 0,
    weightedAskNotional: 0,
    bidLevels: 0,
    askLevels: 0,
  };

  for (const level of levels) {
    if (level.outOfView || level.quantity <= 0) continue;
    const weighted = level.notionalValue * distanceWeight(level.distanceBps, config.distanceWeightK);
    const near = level.distanceBps <= config.nearTouchBps;
    if (level.side === 'BID') {
      out.bidNotional += level.notionalValue;
      out.bidQuantity += level.quantity;
      out.weightedBidNotional += weighted;
      out.bidLevels += 1;
      if (near) out.nearBidNotional += level.notionalValue;
    } else {
      out.askNotional += level.notionalValue;
      out.askQuantity += level.quantity;
      out.weightedAskNotional += weighted;
      out.askLevels += 1;
      if (near) out.nearAskNotional += level.notionalValue;
    }
  }
  return out;
}

export function imbalanceOf(bidNotional: number, askNotional: number): number {
  return safeDiv(bidNotional - askNotional, bidNotional + askNotional);
}

/** Notional resting between two distances on one side. */
export function notionalBetween(
  levels: PassiveLiquidityLevel[],
  side: 'BID' | 'ASK',
  fromBps: number,
  toBps: number,
): number {
  let sum = 0;
  for (const level of levels) {
    if (level.side !== side || level.outOfView || level.quantity <= 0) continue;
    if (level.distanceBps < fromBps || level.distanceBps >= toBps) continue;
    sum += level.notionalValue;
  }
  return sum;
}
