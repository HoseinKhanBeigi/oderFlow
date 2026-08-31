import type { PassiveLiquidityConfig } from '../config/types.js';
import { clamp } from '../core/integrity.js';
import type { PassiveLiquidityDataQuality } from '../models/passive-liquidity.js';

export interface DataQualityInput {
  now: number;
  lastBookAt: number;
  lastTradeAt: number;
  observations: number;
  reconnects: number;
  sequenceGaps: number;
  sequenceContinuous: boolean;
  crossedBook: boolean;
  invalidLevels: number;
  bookEmpty: boolean;
  timestampDriftMs: number;
  visibleDepthBps: number;
}

/**
 * Consumption, cancellation, replenishment and absorption are all inferences
 * from stream continuity. When continuity is in doubt the engine reports low
 * quality and callers must stop trusting those classifications rather than
 * presenting a confident but unfounded read.
 */
export function assessDataQuality(
  input: DataQualityInput,
  config: PassiveLiquidityConfig,
): PassiveLiquidityDataQuality {
  const reasons: string[] = [];
  let score = 100;

  const snapshotAgeMs = input.lastBookAt > 0 ? Math.max(0, input.now - input.lastBookAt) : Infinity;
  if (input.bookEmpty) {
    score -= 60;
    reasons.push('no order book');
  }
  if (!Number.isFinite(snapshotAgeMs)) {
    score -= 40;
    reasons.push('no book snapshot received');
  } else if (snapshotAgeMs > config.bookStaleMs) {
    score -= 30;
    reasons.push(`book stale by ${Math.round(snapshotAgeMs)}ms`);
  }

  const tradeStreamContinuous = input.lastTradeAt > 0
    && input.now - input.lastTradeAt <= Math.max(30_000, config.bookStaleMs * 10);
  if (!tradeStreamContinuous) {
    score -= 15;
    reasons.push('trade stream quiet or absent');
  }

  if (!input.sequenceContinuous || input.sequenceGaps > 0) {
    score -= 35;
    reasons.push(`sequence gaps: ${input.sequenceGaps}`);
  }
  if (input.reconnects > 0) {
    score -= 20;
    reasons.push(`reconnects: ${input.reconnects}`);
  }
  if (input.crossedBook) {
    score -= 25;
    reasons.push('crossed book');
  }
  if (input.invalidLevels > 0) {
    score -= Math.min(15, input.invalidLevels * 3);
    reasons.push(`invalid levels: ${input.invalidLevels}`);
  }
  if (Math.abs(input.timestampDriftMs) > config.maxTimestampDriftMs) {
    score -= 15;
    reasons.push(`timestamp drift ${Math.round(input.timestampDriftMs)}ms`);
  }

  // Lifecycle metrics need a history of observations to mean anything.
  if (input.observations < 8) {
    score -= 30;
    reasons.push('warming up');
  } else if (input.observations < 32) {
    score -= 10;
    reasons.push('limited history');
  }

  const bounded = clamp(score, 0, 100);
  return {
    score: bounded,
    trustworthy: bounded >= config.minTrustedQuality,
    snapshotAgeMs: Number.isFinite(snapshotAgeMs) ? snapshotAgeMs : -1,
    sequenceContinuous: input.sequenceContinuous && input.sequenceGaps === 0,
    bookStreamContinuous: Number.isFinite(snapshotAgeMs) && snapshotAgeMs <= config.bookStaleMs,
    tradeStreamContinuous,
    reconnects: input.reconnects,
    sequenceGaps: input.sequenceGaps,
    crossedBook: input.crossedBook,
    invalidLevels: input.invalidLevels,
    timestampDriftMs: input.timestampDriftMs,
    visibleDepthBps: input.visibleDepthBps,
    observations: input.observations,
    reasons,
  };
}
