import type { PassiveLiquidityConfig } from '../config/types.js';
import { clamp, safeDiv } from '../core/integrity.js';
import { priceToTick, tickSize } from '../footprint/tick-size.js';
import type { MarketTrade } from '../models/trade.js';
import type {
  PassiveLiquidityLevel,
  PassiveSide,
  PriceLevelMemory,
} from '../models/passive-liquidity.js';
import { replenishmentRatio } from './level-scores.js';

interface Baseline {
  firstSeenAt: number;
  consumed: number;
  replenished: number;
  cancelled: number;
  attacks: number;
  defended: number;
}

interface MemoryEntry {
  price: number;
  side: PassiveSide;
  firstSeenAt: number;
  lastTestAt: number;
  attacks: number;
  defendedTests: number;
  brokenTests: number;
  totalAggressionAbsorbed: number;
  totalConsumed: number;
  totalReplenished: number;
  totalCancelled: number;
  extendedThrough: boolean;
  displacementSamples: number[];
  activeTest: { startMid: number; extreme: number } | null;
  baseline: Baseline;
}

function newBaseline(firstSeenAt: number): Baseline {
  return { firstSeenAt, consumed: 0, replenished: 0, cancelled: 0, attacks: 0, defended: 0 };
}

/**
 * Remembers what happened at each price across the level's whole life, including
 * after the level itself is gone from the book.
 *
 * Counters are folded as deltas against a per-level baseline so a level that is
 * removed and re-posted at the same price accumulates history instead of
 * resetting it, while its own internal counters restarting does not double count.
 */
export class PriceLevelMemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(private readonly config: PassiveLiquidityConfig) {}

  onTrade(trade: MarketTrade): void {
    if (trade.quoteValue <= 0) return;
    // Aggressive buys are absorbed by resting asks; aggressive sells by bids.
    const side: PassiveSide = trade.isAggressiveBuy ? 'ASK' : 'BID';
    const price = priceToTick(trade.price, tickSize(trade.price));
    const entry = this.entry(side, price, trade.timestamp);
    entry.totalAggressionAbsorbed += trade.quoteValue;
  }

  fold(levels: PassiveLiquidityLevel[], now: number, mid: number): void {
    if (mid <= 0) return;
    for (const level of levels) {
      if (level.outOfView) continue;
      const entry = this.entry(level.side, level.price, level.firstSeenAt);

      if (entry.baseline.firstSeenAt !== level.firstSeenAt) {
        entry.baseline = newBaseline(level.firstSeenAt);
      }
      const base = entry.baseline;

      entry.totalConsumed += Math.max(0, level.consumedNotional - base.consumed);
      entry.totalReplenished += Math.max(0, level.replenishedNotional - base.replenished);
      entry.totalCancelled += Math.max(0, level.cancelledNotional - base.cancelled);

      const newAttacks = Math.max(0, level.attackCount - base.attacks);
      const newDefended = Math.max(0, level.defendedCount - base.defended);

      base.consumed = level.consumedNotional;
      base.replenished = level.replenishedNotional;
      base.cancelled = level.cancelledNotional;
      base.attacks = level.attackCount;
      base.defended = level.defendedCount;

      if (newAttacks > 0) {
        entry.attacks += newAttacks;
        entry.lastTestAt = now;
        entry.activeTest = { startMid: mid, extreme: mid };
      }
      if (entry.activeTest) {
        entry.activeTest.extreme = level.side === 'BID'
          ? Math.min(entry.activeTest.extreme, mid)
          : Math.max(entry.activeTest.extreme, mid);
      }
      if (newDefended > 0) {
        entry.defendedTests += newDefended;
        this.closeTest(entry);
      }

      const buffer = this.config.zoneBps / 10_000;
      const through = level.side === 'BID'
        ? mid < level.price * (1 - buffer)
        : mid > level.price * (1 + buffer);
      if (through && entry.attacks > 0) {
        if (!entry.extendedThrough) entry.brokenTests += 1;
        entry.extendedThrough = true;
        this.closeTest(entry);
      } else if (!through) {
        entry.extendedThrough = false;
      }
    }
    this.trim();
  }

  get(side: PassiveSide, price: number, mid: number): PriceLevelMemory | null {
    const key = `${side}:${priceToTick(price, tickSize(mid || price))}`;
    const entry = this.entries.get(key);
    return entry ? this.toPublic(entry) : null;
  }

  all(): PriceLevelMemory[] {
    return [...this.entries.values()]
      .filter((e) => e.attacks > 0 || e.totalConsumed > 0)
      .map((e) => this.toPublic(e))
      .sort((a, b) => b.defenseScore - a.defenseScore);
  }

  reset(): void {
    this.entries.clear();
  }

  private closeTest(entry: MemoryEntry): void {
    const test = entry.activeTest;
    if (!test || test.startMid <= 0) {
      entry.activeTest = null;
      return;
    }
    const moved = entry.side === 'BID' ? test.startMid - test.extreme : test.extreme - test.startMid;
    entry.displacementSamples.push((Math.max(0, moved) / test.startMid) * 10_000);
    if (entry.displacementSamples.length > 32) entry.displacementSamples.shift();
    entry.activeTest = null;
  }

  private entry(side: PassiveSide, price: number, now: number): MemoryEntry {
    const key = `${side}:${price}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        price,
        side,
        firstSeenAt: now,
        lastTestAt: now,
        attacks: 0,
        defendedTests: 0,
        brokenTests: 0,
        totalAggressionAbsorbed: 0,
        totalConsumed: 0,
        totalReplenished: 0,
        totalCancelled: 0,
        extendedThrough: false,
        displacementSamples: [],
        activeTest: null,
        baseline: newBaseline(now),
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private trim(): void {
    if (this.entries.size <= this.config.memoryCapacity) return;
    const ordered = [...this.entries.entries()].sort((a, b) => a[1].lastTestAt - b[1].lastTestAt);
    for (const [key] of ordered.slice(0, this.entries.size - this.config.memoryCapacity)) {
      this.entries.delete(key);
    }
  }

  private toPublic(entry: MemoryEntry): PriceLevelMemory {
    return {
      price: entry.price,
      side: entry.side,
      attacks: entry.attacks,
      defendedTests: entry.defendedTests,
      brokenTests: entry.brokenTests,
      totalAggressionAbsorbed: entry.totalAggressionAbsorbed,
      totalConsumed: entry.totalConsumed,
      totalReplenished: entry.totalReplenished,
      totalCancelled: entry.totalCancelled,
      lastTestAt: entry.lastTestAt,
      firstSeenAt: entry.firstSeenAt,
      defenseScore: defenseScoreOf(entry),
      extendedThrough: entry.extendedThrough,
    };
  }
}

export function meanDisplacementBps(samples: number[]): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const s of samples) sum += s;
  return sum / samples.length;
}

function defenseScoreOf(entry: MemoryEntry): number {
  if (entry.attacks <= 0) return 0;
  const held = clamp(safeDiv(entry.defendedTests, entry.attacks), 0, 1);
  const replenish = clamp(replenishmentRatio(entry.totalReplenished, entry.totalConsumed), 0, 1);
  const tested = clamp(entry.attacks / 4, 0, 1);
  const pulled = clamp(
    safeDiv(entry.totalCancelled, entry.totalCancelled + entry.totalConsumed),
    0,
    1,
  );
  const displacement = meanDisplacementBps(entry.displacementSamples);
  // Small displacement per test means aggression failed to make progress.
  const inefficiency = clamp(1 - displacement / 25, 0, 1);

  const raw =
    0.3 * held +
    0.25 * replenish +
    0.2 * inefficiency +
    0.15 * tested -
    0.25 * pulled -
    (entry.extendedThrough ? 0.3 : 0);
  return clamp(raw, 0, 1) * 100;
}
