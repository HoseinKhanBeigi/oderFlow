import { clamp } from '../core/integrity.js';
import type { LiquidityResponseConfig } from '../config/types.js';
import type { ConsistencyResult, IntensityLabel } from '../models/liquidity-response.js';
import type { SideWindow } from './book-accountant.js';

export interface ChangePercentInput {
  initial: number;
  remaining: number;
  consumed: number;
  cancelled: number;
  added: number;
  primed: boolean;
  hasValidPrevious: boolean;
  bookEmpty: boolean;
  bookSynchronized: boolean;
  sequenceContinuous: boolean;
  websocketHealthy: boolean;
  recentlyReset: boolean;
  bandValid: boolean;
}

export interface SideConsistencyInput {
  changePercent: number | null;
  consumption: IntensityLabel;
  withdrawal: IntensityLabel;
}

export function displayedChangePercent(input: ChangePercentInput): {
  percent: number | null;
  reason: string | null;
} {
  if (!input.primed || !input.hasValidPrevious) {
    return { percent: null, reason: 'ORDER_BOOK_DATA_RESET' };
  }
  if (input.recentlyReset || !input.websocketHealthy || !input.sequenceContinuous || !input.bookSynchronized) {
    return { percent: null, reason: 'ORDER_BOOK_DATA_RESET' };
  }
  if (input.bookEmpty || !input.bandValid) {
    return { percent: null, reason: 'ORDER_BOOK_DATA_RESET' };
  }
  if (input.initial <= 0) return { percent: null, reason: 'INSUFFICIENT_DATA' };

  const raw = ((input.remaining - input.initial) / input.initial) * 100;
  const removed = input.consumed + input.cancelled;
  const expectedRemaining = Math.max(0, input.initial + input.added - removed);
  const unexplained = Math.abs(expectedRemaining - input.remaining) > Math.max(input.initial * 0.25, 1);

  if (raw <= -99.5) {
    if (unexplained || input.remaining <= 0 && removed < input.initial * 0.5) {
      return { percent: null, reason: 'ORDER_BOOK_DATA_RESET' };
    }
  }
  if (raw <= -80 && unexplained) {
    return { percent: null, reason: 'UNEXPLAINED_ASK_LIQUIDITY_DROP' };
  }
  return { percent: raw, reason: null };
}

export function validateSideDrop(
  cfg: LiquidityResponseConfig,
  input: SideConsistencyInput,
): { valid: boolean; reason: string | null } {
  const drop = input.changePercent;
  if (drop == null || drop > -cfg.unexplainedDropPercent) return { valid: true, reason: null };
  const consumeHigh = input.consumption === 'HIGH' || input.consumption === 'EXTREME';
  const withdrawHigh = input.withdrawal === 'HIGH' || input.withdrawal === 'EXTREME';
  if (consumeHigh || withdrawHigh) return { valid: true, reason: null };
  return { valid: false, reason: 'UNEXPLAINED_ASK_LIQUIDITY_DROP' };
}

export function dataConsistencyScore(input: {
  flags?: Iterable<string>;
  bookEmpty: boolean;
  lastBookAgeMs: number;
  lastTradeAgeMs: number;
  unexplainedAsk: boolean;
  unexplainedBid: boolean;
  snapshotContinuous: boolean;
  tradeBookReconciled: boolean;
}): number {
  let s = 100;
  const flags = new Set([...(input.flags ?? [])].map(String));
  if (flags.has('reconnect')) s -= 25;
  if (flags.has('sequenceGap')) s -= 20;
  if (flags.has('staleBook')) s -= 20;
  if (flags.has('missingData')) s -= 12;
  if (input.bookEmpty) s -= 20;
  if (!input.snapshotContinuous) s -= 16;
  if (!input.tradeBookReconciled) s -= 14;
  if (input.unexplainedAsk) s -= 45;
  if (input.unexplainedBid) s -= 45;
  if (input.lastBookAgeMs > 4_000) s -= 12;
  if (input.lastTradeAgeMs > 8_000) s -= 8;
  return clamp(s, 0, 100);
}

export function validateConsistency(
  cfg: LiquidityResponseConfig,
  input: {
    flags?: Iterable<string>;
    bookEmpty: boolean;
    lastBookAgeMs: number;
    lastTradeAgeMs: number;
    ask: SideConsistencyInput;
    bid: SideConsistencyInput;
    snapshotContinuous: boolean;
    tradeBookReconciled: boolean;
  },
): ConsistencyResult {
  const ask = validateSideDrop(cfg, input.ask);
  const bid = validateSideDrop(cfg, input.bid);
  const score = dataConsistencyScore({
    flags: input.flags,
    bookEmpty: input.bookEmpty,
    lastBookAgeMs: input.lastBookAgeMs,
    lastTradeAgeMs: input.lastTradeAgeMs,
    unexplainedAsk: !ask.valid,
    unexplainedBid: !bid.valid,
    snapshotContinuous: input.snapshotContinuous,
    tradeBookReconciled: input.tradeBookReconciled,
  });
  const reason = !ask.valid ? ask.reason : !bid.valid ? bid.reason : score < cfg.minConsistencyForKnown ? 'INCONSISTENT_DATA' : null;
  return {
    valid: ask.valid && bid.valid && score >= cfg.minConsistencyForKnown,
    reason,
    score,
  };
}

export function tradeBookReconciled(aggressiveBuy: number, aggressiveSell: number, ask: SideWindow, bid: SideWindow): boolean {
  if (ask.consumed > aggressiveBuy * 1.35 + 1 && aggressiveBuy >= 0) return false;
  if (bid.consumed > aggressiveSell * 1.35 + 1 && aggressiveSell >= 0) return false;
  return true;
}
