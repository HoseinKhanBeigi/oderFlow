import type { PassiveLiquidityConfig } from '../config/types.js';
import type { MarketTrade } from '../models/trade.js';
import type { PassiveSide } from '../models/passive-liquidity.js';
/** Float-safe price key; 8dp is finer than any venue increment in use. */
function exactKey(price: number): number {
  return Number(price.toFixed(8));
}

interface ExecutionEntry {
  at: number;
  price: number;
  /** Base quantity still available to explain a book reduction. */
  remaining: number;
}

/**
 * Holds recently executed aggressive volume per price so that a reduction in
 * resting size can be attributed to an execution rather than a cancellation.
 *
 * Book updates and trades do not arrive together, so claims are served in both
 * directions: a drop can match a trade already seen, and an unresolved drop can
 * be retried once its trade shows up. Anything still unmatched when the window
 * closes is a cancellation — never assumed before then.
 */
export class TradeMatcher {
  /** `${side}:${tick}` -> executions, oldest first. */
  private readonly byPrice = new Map<string, ExecutionEntry[]>();
  private executedBuyNotional = 0;
  private executedSellNotional = 0;
  private readonly recentExecutions: Array<{ at: number; buy: number; sell: number }> = [];
  private lastTradeAt = 0;

  constructor(private readonly config: PassiveLiquidityConfig) {}

  get lastTradeTimestamp(): number {
    return this.lastTradeAt;
  }

  /**
   * Aggressive buys lift asks; aggressive sells hit bids. The passive side that
   * lost liquidity is therefore the opposite of the aggressor.
   */
  onTrade(trade: MarketTrade): void {
    if (trade.quantity <= 0 || trade.price <= 0) return;
    const side: PassiveSide = trade.isAggressiveBuy ? 'ASK' : 'BID';
    // Keyed by the traded price itself. Bucketing here would need the venue's
    // increment, which is not known until the book reveals it, and a trade must
    // stay matchable to the exact level it consumed.
    const price = exactKey(trade.price);
    const key = `${side}:${price}`;
    const list = this.byPrice.get(key) ?? [];
    list.push({ at: trade.timestamp, price, remaining: trade.quantity });
    this.byPrice.set(key, list);

    this.lastTradeAt = Math.max(this.lastTradeAt, trade.timestamp);
    if (trade.isAggressiveBuy) this.executedBuyNotional += trade.quoteValue;
    else this.executedSellNotional += trade.quoteValue;
    this.recentExecutions.push({
      at: trade.timestamp,
      buy: trade.isAggressiveBuy ? trade.quoteValue : 0,
      sell: trade.isAggressiveSell ? trade.quoteValue : 0,
    });
    if (this.recentExecutions.length > 8_192) this.recentExecutions.splice(0, 4_096);
  }

  /**
   * Attribute up to `quantity` of a reduction at `price` to executed volume.
   * `at` is the time of the book change, which may precede or follow the trade.
   * `tick` is the venue increment observed on the book, used to widen the search
   * to neighbouring prices when a sweep clears several levels at once.
   */
  claim(side: PassiveSide, price: number, quantity: number, at: number, tick: number): number {
    if (quantity <= 0 || tick <= 0) return 0;
    const window = this.config.tradeMatchWindowMs;
    const reach = this.config.tradeMatchTicks;
    let need = quantity;
    let matched = 0;

    for (let step = 0; step <= reach && need > 0; step++) {
      const candidates = step === 0 ? [0] : [-step, step];
      for (const offset of candidates) {
        if (need <= 0) break;
        const key = `${side}:${exactKey(price + offset * tick)}`;
        const list = this.byPrice.get(key);
        if (!list) continue;
        for (const entry of list) {
          if (need <= 0) break;
          if (entry.remaining <= 0) continue;
          if (Math.abs(entry.at - at) > window) continue;
          const take = Math.min(entry.remaining, need);
          entry.remaining -= take;
          need -= take;
          matched += take;
        }
        this.byPrice.set(key, list.filter((e) => e.remaining > 1e-12));
      }
    }
    return matched;
  }

  /** Executed notional in the trailing window, for relative normalization. */
  executedNotional(side: 'BUY' | 'SELL', now: number, windowMs: number): number {
    const from = now - windowMs;
    let sum = 0;
    for (let i = this.recentExecutions.length - 1; i >= 0; i--) {
      const e = this.recentExecutions[i];
      if (!e || e.at < from) break;
      sum += side === 'BUY' ? e.buy : e.sell;
    }
    return sum;
  }

  cumulativeNotional(side: 'BUY' | 'SELL'): number {
    return side === 'BUY' ? this.executedBuyNotional : this.executedSellNotional;
  }

  /** Drops expired executions so stale trades cannot explain new reductions. */
  prune(now: number): void {
    const cutoff = now - this.config.tradeMatchWindowMs;
    for (const [key, list] of this.byPrice) {
      const kept = list.filter((e) => e.remaining > 1e-12 && e.at >= cutoff);
      if (kept.length) this.byPrice.set(key, kept);
      else this.byPrice.delete(key);
    }
    const trim = now - 300_000;
    while (this.recentExecutions.length && (this.recentExecutions[0]?.at ?? 0) < trim) {
      this.recentExecutions.shift();
    }
  }

  reset(): void {
    this.byPrice.clear();
  }
}
