import type { BookDeltaSimEvent, BookLevelQuote, BookSnapshotSimEvent } from './events.js';
import { almostEqual, clamp, roundToTick } from './math.js';
import {
  DEFAULT_NEARBY_LEVELS,
  DEFAULT_VISIBLE_LEVELS,
  EPSILON,
  type BookWalkResult,
  type LevelFill,
  type LiquidityLevel,
} from './types.js';

function emptyLevel(price: number): LiquidityLevel {
  return {
    price,
    restingLiquidity: 0,
    addedLiquidity: 0,
    cancelledLiquidity: 0,
    executedLiquidity: 0,
    replenishedLiquidity: 0,
  };
}

function cloneLevel(level: LiquidityLevel): LiquidityLevel {
  return { ...level };
}

/**
 * Simulated limit book. Price displacement is produced by walking these
 * levels — not by adding a random increment to price.
 *
 * Per-level counters (executed / added / cancelled / replenished) are tick
 * scoped and reset in `beginTick`.
 */
export class OrderBookSimulationEngine {
  private bids = new Map<number, LiquidityLevel>();
  private asks = new Map<number, LiquidityLevel>();
  tickSize: number;
  price = 0;
  private lastTradePrice = 0;

  constructor(opts: { tickSize?: number; price?: number } = {}) {
    this.tickSize = opts.tickSize ?? 0.1;
    this.price = opts.price ?? 0;
    this.lastTradePrice = this.price;
  }

  reset(price = 0): void {
    this.bids.clear();
    this.asks.clear();
    this.price = price;
    this.lastTradePrice = price;
  }

  beginTick(): void {
    for (const level of this.bids.values()) this.resetTickCounters(level);
    for (const level of this.asks.values()) this.resetTickCounters(level);
  }

  bestBid(): LiquidityLevel | null {
    return this.best('bid');
  }

  bestAsk(): LiquidityLevel | null {
    return this.best('ask');
  }

  mid(): number {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (bid && ask) return (bid.price + ask.price) / 2;
    return bid?.price ?? ask?.price ?? this.price;
  }

  spread(): number {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (!bid || !ask) return 0;
    return Math.max(0, ask.price - bid.price);
  }

  spreadBps(): number {
    const mid = this.mid();
    if (mid <= 0) return 0;
    return (this.spread() / mid) * 10_000;
  }

  depth(side: 'bid' | 'ask'): number {
    let sum = 0;
    for (const level of this.map(side).values()) sum += level.restingLiquidity;
    return sum;
  }

  nearbyDepth(side: 'bid' | 'ask', levels = DEFAULT_NEARBY_LEVELS): number {
    return this.sorted(side)
      .slice(0, levels)
      .reduce((s, l) => s + l.restingLiquidity, 0);
  }

  snapshotLevels(side: 'bid' | 'ask', limit = DEFAULT_VISIBLE_LEVELS): LiquidityLevel[] {
    return this.sorted(side).slice(0, limit).map(cloneLevel);
  }

  allLevels(side: 'bid' | 'ask'): LiquidityLevel[] {
    return this.sorted(side).map(cloneLevel);
  }

  setLevel(side: 'bid' | 'ask', price: number, quote: number): LiquidityLevel {
    const px = roundToTick(price, this.tickSize);
    const map = this.map(side);
    const existing = map.get(px) ?? emptyLevel(px);
    const next = Math.max(0, quote);
    if (next <= EPSILON) {
      map.delete(px);
      existing.restingLiquidity = 0;
      return existing;
    }
    existing.price = px;
    existing.restingLiquidity = next;
    map.set(px, existing);
    return existing;
  }

  addLiquidity(side: 'bid' | 'ask', price: number, quote: number, asReplenishment = false): number {
    if (quote <= 0) return 0;
    const px = roundToTick(price, this.tickSize);
    const map = this.map(side);
    const level = map.get(px) ?? emptyLevel(px);
    level.restingLiquidity += quote;
    level.addedLiquidity += quote;
    if (asReplenishment) level.replenishedLiquidity += quote;
    map.set(px, level);
    return quote;
  }

  withdrawLiquidity(side: 'bid' | 'ask', price: number, quote: number): number {
    if (quote <= 0) return 0;
    const px = roundToTick(price, this.tickSize);
    const map = this.map(side);
    const level = map.get(px);
    if (!level) return 0;
    const take = Math.min(level.restingLiquidity, quote);
    level.restingLiquidity -= take;
    level.cancelledLiquidity += take;
    if (level.restingLiquidity <= EPSILON) map.delete(px);
    return take;
  }

  /**
   * Aggressive BUY walks asks from the inside out.
   * Price becomes the last fill price as levels are consumed.
   */
  consumeAsks(aggression: number): BookWalkResult {
    return this.walk('ask', aggression);
  }

  /**
   * Aggressive SELL walks bids from the inside out.
   */
  consumeBids(aggression: number): BookWalkResult {
    return this.walk('bid', aggression);
  }

  /**
   * Consume at a known trade price (live/replay with authoritative prints).
   * Still reduces resting size so walls shrink from execution, not cancellation.
   */
  consumeAtPrice(side: 'bid' | 'ask', price: number, quote: number): LevelFill | null {
    if (quote <= 0) return null;
    const px = roundToTick(price, this.tickSize);
    const map = this.map(side);
    let level = map.get(px);
    if (!level) {
      const nearest = this.nearest(side, px);
      if (!nearest) {
        this.lastTradePrice = px;
        this.price = px;
        return { price: px, consumed: 0, remainingAtLevel: 0, cleared: false };
      }
      level = nearest;
    }
    const take = Math.min(level.restingLiquidity, quote);
    level.restingLiquidity -= take;
    level.executedLiquidity += take;
    const cleared = level.restingLiquidity <= EPSILON;
    if (cleared) map.delete(level.price);
    this.lastTradePrice = level.price;
    this.price = level.price;
    return {
      price: level.price,
      consumed: take,
      remainingAtLevel: Math.max(0, level.restingLiquidity),
      cleared,
    };
  }

  applySnapshot(event: BookSnapshotSimEvent): { added: { bid: number; ask: number }; cancelled: { bid: number; ask: number } } {
    const added = { bid: 0, ask: 0 };
    const cancelled = { bid: 0, ask: 0 };
    cancelled.bid += this.reconcileSide('bid', event.bids, added);
    cancelled.ask += this.reconcileSide('ask', event.asks, added);
    if (!this.price) this.price = this.mid();
    return { added, cancelled };
  }

  applyDelta(event: BookDeltaSimEvent): { added: { bid: number; ask: number }; cancelled: { bid: number; ask: number } } {
    const added = { bid: 0, ask: 0 };
    const cancelled = { bid: 0, ask: 0 };
    cancelled.bid += this.applyDeltaSide('bid', event.bids, added);
    cancelled.ask += this.applyDeltaSide('ask', event.asks, added);
    return { added, cancelled };
  }

  seedLadder(opts: {
    price: number;
    bids: Array<{ price: number; quote: number }>;
    asks: Array<{ price: number; quote: number }>;
  }): void {
    this.reset(opts.price);
    for (const lvl of opts.bids) this.setLevel('bid', lvl.price, lvl.quote);
    for (const lvl of opts.asks) this.setLevel('ask', lvl.price, lvl.quote);
  }

  private walk(side: 'bid' | 'ask', aggression: number): BookWalkResult {
    let remaining = Math.max(0, aggression);
    const fills: LevelFill[] = [];
    let filled = 0;
    let lastFillPrice: number | null = null;
    let levelsCleared = 0;

    while (remaining > EPSILON) {
      const best = this.best(side);
      if (!best || best.restingLiquidity <= EPSILON) break;
      const take = Math.min(remaining, best.restingLiquidity);
      best.restingLiquidity -= take;
      best.executedLiquidity += take;
      remaining -= take;
      filled += take;
      lastFillPrice = best.price;
      const cleared = best.restingLiquidity <= EPSILON;
      if (cleared) {
        this.map(side).delete(best.price);
        levelsCleared += 1;
      }
      fills.push({
        price: best.price,
        consumed: take,
        remainingAtLevel: Math.max(0, best.restingLiquidity),
        cleared,
      });
    }

    if (lastFillPrice !== null) {
      this.lastTradePrice = lastFillPrice;
      this.price = lastFillPrice;
    }

    return { filled, leftover: remaining, lastFillPrice, levelsCleared, fills };
  }

  private reconcileSide(
    side: 'bid' | 'ask',
    incoming: BookLevelQuote[],
    addedAcc: { bid: number; ask: number },
  ): number {
    const map = this.map(side);
    const nextPrices = new Set<number>();
    let cancelled = 0;
    for (const row of incoming) {
      const px = roundToTick(row.price, this.tickSize);
      nextPrices.add(px);
      const prev = map.get(px)?.restingLiquidity ?? 0;
      const next = Math.max(0, row.quoteValue);
      if (next > prev + EPSILON) {
        const add = next - prev;
        addedAcc[side] += add;
        const level = map.get(px) ?? emptyLevel(px);
        level.addedLiquidity += add;
        level.replenishedLiquidity += add;
        level.restingLiquidity = next;
        map.set(px, level);
      } else if (next + EPSILON < prev) {
        const drop = prev - next;
        cancelled += drop;
        const level = map.get(px) ?? emptyLevel(px);
        level.cancelledLiquidity += drop;
        level.restingLiquidity = next;
        if (next <= EPSILON) map.delete(px);
        else map.set(px, level);
      } else {
        const level = map.get(px) ?? emptyLevel(px);
        level.restingLiquidity = next;
        if (next <= EPSILON) map.delete(px);
        else map.set(px, level);
      }
    }
    for (const [px, level] of [...map.entries()]) {
      if (nextPrices.has(px)) continue;
      cancelled += level.restingLiquidity;
      level.cancelledLiquidity += level.restingLiquidity;
      map.delete(px);
    }
    return cancelled;
  }

  private applyDeltaSide(
    side: 'bid' | 'ask',
    rows: BookLevelQuote[],
    addedAcc: { bid: number; ask: number },
  ): number {
    let cancelled = 0;
    for (const row of rows) {
      const px = roundToTick(row.price, this.tickSize);
      const prev = this.map(side).get(px)?.restingLiquidity ?? 0;
      const next = Math.max(0, row.quoteValue);
      if (almostEqual(next, 0)) {
        cancelled += this.withdrawLiquidity(side, px, prev || 0);
        continue;
      }
      if (next > prev) addedAcc[side] += this.addLiquidity(side, px, next - prev, true) ? next - prev : 0;
      else if (next < prev) cancelled += this.withdrawLiquidity(side, px, prev - next);
    }
    return cancelled;
  }

  private best(side: 'bid' | 'ask'): LiquidityLevel | null {
    const levels = this.sorted(side);
    return levels[0] ?? null;
  }

  private nearest(side: 'bid' | 'ask', price: number): LiquidityLevel | null {
    const levels = this.sorted(side);
    if (!levels.length) return null;
    let best = levels[0]!;
    let dist = Math.abs(best.price - price);
    for (const level of levels) {
      const d = Math.abs(level.price - price);
      if (d < dist) {
        best = level;
        dist = d;
      }
    }
    return best;
  }

  private sorted(side: 'bid' | 'ask'): LiquidityLevel[] {
    const values = [...this.map(side).values()].filter((l) => l.restingLiquidity > EPSILON);
    values.sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price));
    return values;
  }

  private map(side: 'bid' | 'ask'): Map<number, LiquidityLevel> {
    return side === 'bid' ? this.bids : this.asks;
  }

  private resetTickCounters(level: LiquidityLevel): void {
    level.addedLiquidity = 0;
    level.cancelledLiquidity = 0;
    level.executedLiquidity = 0;
    level.replenishedLiquidity = 0;
  }

  gapTicksIfEmpty(side: 'bid' | 'ask', leftover: number, typicalLevel: number, coeff: number): number {
    if (leftover <= EPSILON) return 0;
    if (this.best(side)) return 0;
    const steps = leftover / Math.max(typicalLevel, EPSILON);
    return clamp(steps * coeff, 0, 64);
  }
}
