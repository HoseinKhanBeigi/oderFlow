import type { BookLevel, OrderBookDelta, OrderBookSnapshot } from '../models/trade.js';
import { DEFAULT_BPS_BANDS, type BpsBand, type NearbyLiquidity } from '../models/liquidity.js';

function key(price: number): string {
  return price.toString();
}

/**
 * Local bid/ask book. Quantities are base-asset size; quote notional is price * qty.
 */
export class LocalOrderBook {
  private bids = new Map<string, { price: number; quantity: number }>();
  private asks = new Map<string, { price: number; quantity: number }>();
  lastUpdateId = 0;
  timestamp = 0;
  symbol = '';
  stale = false;

  applySnapshot(snapshot: OrderBookSnapshot): void {
    // Top-of-book (bookTicker) must never replace a depth ladder.
    const thin = snapshot.bids.length <= 1 && snapshot.asks.length <= 1;
    if (thin && this.bids.size + this.asks.size > 2) {
      return;
    }
    this.bids.clear();
    this.asks.clear();
    this.symbol = snapshot.symbol;
    this.timestamp = snapshot.timestamp;
    this.lastUpdateId = snapshot.lastUpdateId ?? this.lastUpdateId;
    this.stale = false;
    for (const lvl of snapshot.bids) this.upsert('bid', lvl);
    for (const lvl of snapshot.asks) this.upsert('ask', lvl);
  }

  applyDelta(delta: OrderBookDelta): { ok: boolean; gap: boolean } {
    if (this.lastUpdateId && delta.firstUpdateId !== undefined && delta.firstUpdateId > this.lastUpdateId + 1) {
      this.stale = true;
      return { ok: false, gap: true };
    }
    this.timestamp = delta.timestamp;
    this.lastUpdateId = delta.finalUpdateId ?? this.lastUpdateId;
    for (const lvl of delta.bids) this.upsert('bid', lvl);
    for (const lvl of delta.asks) this.upsert('ask', lvl);
    return { ok: true, gap: false };
  }

  bestBid(): BookLevel | null {
    let best: BookLevel | null = null;
    for (const lvl of this.bids.values()) {
      if (!best || lvl.price > best.price) best = toLevel(lvl);
    }
    return best;
  }

  bestAsk(): BookLevel | null {
    let best: BookLevel | null = null;
    for (const lvl of this.asks.values()) {
      if (!best || lvl.price < best.price) best = toLevel(lvl);
    }
    return best;
  }

  mid(): number {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (bid && ask) return (bid.price + ask.price) / 2;
    return bid?.price ?? ask?.price ?? 0;
  }

  spreadBps(): number {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (!bid || !ask || bid.price === 0) return Number.POSITIVE_INFINITY;
    return ((ask.price - bid.price) / bid.price) * 10_000;
  }

  levelQuote(side: 'bid' | 'ask', price: number): number {
    const map = side === 'bid' ? this.bids : this.asks;
    const lvl = map.get(key(price));
    if (!lvl) return 0;
    return lvl.price * lvl.quantity;
  }

  nearbyLiquidity(bands: BpsBand[] = DEFAULT_BPS_BANDS): NearbyLiquidity {
    const mid = this.mid();
    const bid: Record<string, number> = {};
    const ask: Record<string, number> = {};
    for (const band of bands) {
      const label = band.toFixed(2);
      bid[label] = this.notionalWithin('bid', mid, band);
      ask[label] = this.notionalWithin('ask', mid, band);
    }
    return { bid, ask };
  }

  notionalWithin(side: 'bid' | 'ask', mid: number, bandPct: number): number {
    if (mid <= 0) return 0;
    const bound = side === 'bid' ? mid * (1 - bandPct / 100) : mid * (1 + bandPct / 100);
    return this.notionalBetween(side, mid, bound);
  }

  /** Quote notional between two prices, inclusive of the farther bound, exclusive of mid. */
  notionalBetween(side: 'bid' | 'ask', fromPrice: number, toPrice: number): number {
    const lo = Math.min(fromPrice, toPrice);
    const hi = Math.max(fromPrice, toPrice);
    const map = side === 'bid' ? this.bids : this.asks;
    let sum = 0;
    for (const lvl of map.values()) {
      if (side === 'ask' && lvl.price > lo && lvl.price <= hi) sum += lvl.price * lvl.quantity;
      if (side === 'bid' && lvl.price < hi && lvl.price >= lo) sum += lvl.price * lvl.quantity;
    }
    return sum;
  }

  sortedLevels(side: 'bid' | 'ask'): BookLevel[] {
    const map = side === 'bid' ? this.bids : this.asks;
    const levels = [...map.values()].map(toLevel);
    levels.sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price));
    return levels;
  }

  empty(): boolean {
    return this.bids.size === 0 && this.asks.size === 0;
  }

  private upsert(side: 'bid' | 'ask', lvl: BookLevel): void {
    const map = side === 'bid' ? this.bids : this.asks;
    const k = key(lvl.price);
    if (lvl.quantity <= 0) {
      map.delete(k);
      return;
    }
    map.set(k, { price: lvl.price, quantity: lvl.quantity });
  }
}

function toLevel(lvl: { price: number; quantity: number }): BookLevel {
  return { price: lvl.price, quantity: lvl.quantity, quoteValue: lvl.price * lvl.quantity };
}
