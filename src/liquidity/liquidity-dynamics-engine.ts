import { clamp } from '../core/integrity.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import type { LiquidityDynamicsSnapshot } from '../models/liquidity.js';
import type { LocalOrderBook } from './local-order-book.js';

interface SideMaps {
  asks: Map<number, number>;
  bids: Map<number, number>;
}

/**
 * Tracks displayed book changes vs aggressive flow:
 * consumed (drop explained by trades), pulled (drop without fills), replenished (size returns).
 */
export class LiquidityDynamicsEngine {
  private prev: SideMaps | null = null;
  private windowStart = 0;
  private askConsumed = 0;
  private bidConsumed = 0;
  private askReplaced = 0;
  private bidReplaced = 0;
  private askPulled = 0;
  private bidPulled = 0;
  lastAskDropByPrice = new Map<number, number>();
  lastBidDropByPrice = new Map<number, number>();
  lastBuyFlowAvailable = 0;
  lastSellFlowAvailable = 0;
  private unmatchedBuy = 0;
  private unmatchedSell = 0;
  private lastFlowAt = 0;
  private readonly flowMatchMs = 2_000;

  private readonly askConsHist: RollingDistribution;
  private readonly bidConsHist: RollingDistribution;
  private readonly askReplHist: RollingDistribution;
  private readonly bidReplHist: RollingDistribution;
  private readonly askPullHist: RollingDistribution;
  private readonly bidPullHist: RollingDistribution;

  constructor(
    private readonly windowMs = 60_000,
    sampleSize = 1_024,
  ) {
    this.askConsHist = new RollingDistribution(sampleSize);
    this.bidConsHist = new RollingDistribution(sampleSize);
    this.askReplHist = new RollingDistribution(sampleSize);
    this.bidReplHist = new RollingDistribution(sampleSize);
    this.askPullHist = new RollingDistribution(sampleSize);
    this.bidPullHist = new RollingDistribution(sampleSize);
  }

  observe(
    timestamp: number,
    book: LocalOrderBook,
    buyDelta: number,
    sellDelta: number,
  ): LiquidityDynamicsSnapshot {
    const curr: SideMaps = {
      asks: quoteMap(book, 'ask'),
      bids: quoteMap(book, 'bid'),
    };
    this.lastAskDropByPrice = new Map();
    this.lastBidDropByPrice = new Map();

    if (!this.prev) {
      this.prev = curr;
      this.windowStart = timestamp;
      this.creditFlow(timestamp, buyDelta, sellDelta);
      return this.snapshot();
    }

    this.creditFlow(timestamp, buyDelta, sellDelta);
    const ask = diffSide(this.prev.asks, curr.asks);
    const bid = diffSide(this.prev.bids, curr.bids);
    this.lastAskDropByPrice = ask.dropByPrice;
    this.lastBidDropByPrice = bid.dropByPrice;
    this.lastBuyFlowAvailable = this.unmatchedBuy;
    this.lastSellFlowAvailable = this.unmatchedSell;

    const askConsumedNow = Math.min(ask.drop, this.unmatchedBuy);
    const bidConsumedNow = Math.min(bid.drop, this.unmatchedSell);
    this.unmatchedBuy -= askConsumedNow;
    this.unmatchedSell -= bidConsumedNow;
    const askPulledNow = Math.max(0, ask.drop - askConsumedNow);
    const bidPulledNow = Math.max(0, bid.drop - bidConsumedNow);

    this.askConsumed += askConsumedNow;
    this.bidConsumed += bidConsumedNow;
    this.askPulled += askPulledNow;
    this.bidPulled += bidPulledNow;
    this.askReplaced += ask.rise;
    this.bidReplaced += bid.rise;

    if (askConsumedNow > 0) this.askConsHist.add(askConsumedNow);
    if (ask.rise > 0) this.askReplHist.add(ask.rise);
    if (askPulledNow > 0) this.askPullHist.add(askPulledNow);
    if (bidConsumedNow > 0) this.bidConsHist.add(bidConsumedNow);
    if (bid.rise > 0) this.bidReplHist.add(bid.rise);
    if (bidPulledNow > 0) this.bidPullHist.add(bidPulledNow);

    this.prev = curr;
    if (timestamp - this.windowStart > this.windowMs) {
      const scale = this.windowMs / Math.max(1, timestamp - this.windowStart);
      this.askConsumed *= scale;
      this.bidConsumed *= scale;
      this.askReplaced *= scale;
      this.bidReplaced *= scale;
      this.askPulled *= scale;
      this.bidPulled *= scale;
      this.windowStart = timestamp - this.windowMs;
    }

    return this.snapshot();
  }

  private creditFlow(timestamp: number, buyDelta: number, sellDelta: number): void {
    if (this.lastFlowAt > 0 && timestamp - this.lastFlowAt > this.flowMatchMs) {
      this.unmatchedBuy = 0;
      this.unmatchedSell = 0;
    }
    this.unmatchedBuy += Math.max(0, buyDelta);
    this.unmatchedSell += Math.max(0, sellDelta);
    if (buyDelta > 0 || sellDelta > 0) this.lastFlowAt = timestamp;
  }

  snapshot(): LiquidityDynamicsSnapshot {
    return {
      askConsumptionRate: this.askConsumed,
      bidConsumptionRate: this.bidConsumed,
      askReplenishmentRate: this.askReplaced,
      bidReplenishmentRate: this.bidReplaced,
      askPullRate: this.askPulled,
      bidPullRate: this.bidPulled,
      askConsumptionNorm: norm(this.askConsHist, this.askConsumed),
      bidConsumptionNorm: norm(this.bidConsHist, this.bidConsumed),
      askReplenishmentNorm: norm(this.askReplHist, this.askReplaced),
      bidReplenishmentNorm: norm(this.bidReplHist, this.bidReplaced),
      askPullNorm: norm(this.askPullHist, this.askPulled),
      bidPullNorm: norm(this.bidPullHist, this.bidPulled),
    };
  }
}

function quoteMap(book: LocalOrderBook, side: 'ask' | 'bid'): Map<number, number> {
  const map = new Map<number, number>();
  for (const lvl of book.sortedLevels(side)) map.set(lvl.price, lvl.quoteValue);
  return map;
}

function diffSide(prev: Map<number, number>, curr: Map<number, number>) {
  let drop = 0;
  let rise = 0;
  const dropByPrice = new Map<number, number>();
  const prices = new Set([...prev.keys(), ...curr.keys()]);
  for (const price of prices) {
    const a = prev.get(price) ?? 0;
    const b = curr.get(price) ?? 0;
    const d = Math.max(0, a - b);
    const r = Math.max(0, b - a);
    drop += d;
    rise += r;
    if (d > 0) dropByPrice.set(price, d);
  }
  return { drop, rise, dropByPrice };
}

function norm(hist: RollingDistribution, value: number): number {
  if (value <= 0) return 0;
  if (hist.size < 4) return 0.65;
  return clamp(hist.percentileRank(value) / 100, 0, 1);
}
