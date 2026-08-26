import { safeDiv } from '../core/integrity.js';
import { RingBuffer } from '../core/ring-buffer.js';
import type { LiquidityResponseConfig } from '../config/types.js';
import type { LocalOrderBook } from '../liquidity/local-order-book.js';
import type {
  FootprintLiquidityMark,
  LiquidityBandAccounting,
  LiquidityLevelEvent,
  LiquiditySideResponse,
} from '../models/liquidity-response.js';
import { priceToTick, tickSize } from '../footprint/tick-size.js';

export interface BookTick {
  timestamp: number;
  mid: number;
  spreadBps: number;
  bid: number;
  ask: number;
  bidAdded: number;
  askAdded: number;
  bidCancelled: number;
  askCancelled: number;
  bidConsumed: number;
  askConsumed: number;
}

export interface SideWindow {
  initial: number;
  added: number;
  cancelled: number;
  consumed: number;
  remaining: number;
  replenishEvents: number;
  response: LiquiditySideResponse;
}

export interface BookWindow {
  bid: SideWindow;
  ask: SideWindow;
  spreadBps: number;
  spreadDeltaBps: number;
  askDepthChange: number;
  bidDepthChange: number;
  bandWalked: boolean;
  resetRecent: boolean;
  primed: boolean;
  hasValidPrevious: boolean;
}

interface BandState {
  bid: number;
  ask: number;
  bidAdded: number;
  askAdded: number;
  bidCancelled: number;
  askCancelled: number;
  bidConsumed: number;
  askConsumed: number;
}

interface LevelMark {
  price: number;
  restingBid: number;
  restingAsk: number;
  event: LiquidityLevelEvent;
  at: number;
}

/**
 * Separates executed consumption from cancelled/pulled liquidity.
 * Resting book size is never treated as executed volume.
 */
export class BookAccountant {
  private readonly ticks: RingBuffer<BookTick>;
  private readonly bandState = new Map<number, BandState>();
  private readonly marks = new Map<number, LevelMark>();
  private primed = false;
  private lastAsk = 0;
  private lastBid = 0;
  private lastSpread = 0;
  private askReplenishEvents = 0;
  private bidReplenishEvents = 0;
  private lastAskConsumed = false;
  private lastBidConsumed = false;
  private windowAskReplenish = 0;
  private windowBidReplenish = 0;
  private unmatchedBuy = 0;
  private unmatchedSell = 0;
  private lastFlowAt = 0;
  private readonly flowMatchMs = 2_000;
  private lastMid = 0;
  private resetAt = 0;
  private validSnapshots = 0;
  private bandWalked = false;

  constructor(private readonly config: LiquidityResponseConfig) {
    this.ticks = new RingBuffer(4_096);
  }

  observe(
    timestamp: number,
    book: LocalOrderBook,
    buyDelta: number,
    sellDelta: number,
    tradePrice?: number,
    tradeSide?: 'BUY' | 'SELL',
  ): void {
    if (book.empty()) return;
    const mid = book.mid();
    const bandPct = this.config.bandPct;
    const ask = book.notionalWithin('ask', mid, bandPct);
    const bid = book.notionalWithin('bid', mid, bandPct);
    const spreadBps = book.spreadBps();

    const midMoved =
      this.primed &&
      this.lastMid > 0 &&
      mid > 0 &&
      Math.abs(mid - this.lastMid) / this.lastMid >= this.config.bandPct;
    this.bandWalked = midMoved;

    const buy = Math.max(0, buyDelta);
    const sell = Math.max(0, sellDelta);
    if (this.lastFlowAt > 0 && timestamp - this.lastFlowAt > this.flowMatchMs) {
      this.unmatchedBuy = 0;
      this.unmatchedSell = 0;
    }
    this.unmatchedBuy += buy;
    this.unmatchedSell += sell;
    if (buy > 0 || sell > 0) this.lastFlowAt = timestamp;

    const askAdded = this.primed ? Math.max(0, ask - this.lastAsk) : 0;
    const bidAdded = this.primed ? Math.max(0, bid - this.lastBid) : 0;
    const askDrop = this.primed ? Math.max(0, this.lastAsk - ask) : 0;
    const bidDrop = this.primed ? Math.max(0, this.lastBid - bid) : 0;

    const askConsumed = Math.min(askDrop, this.unmatchedBuy);
    const bidConsumed = Math.min(bidDrop, this.unmatchedSell);
    this.unmatchedBuy -= askConsumed;
    this.unmatchedSell -= bidConsumed;
    const askCancelled = Math.max(0, askDrop - askConsumed);
    const bidCancelled = Math.max(0, bidDrop - bidConsumed);

    if (this.lastAskConsumed && askAdded > 0) {
      this.askReplenishEvents += 1;
      this.windowAskReplenish += 1;
    }
    if (this.lastBidConsumed && bidAdded > 0) {
      this.bidReplenishEvents += 1;
      this.windowBidReplenish += 1;
    }
    this.lastAskConsumed = askConsumed > 0 || buy > 0;
    this.lastBidConsumed = bidConsumed > 0 || sell > 0;

    this.ticks.push({
      timestamp,
      mid,
      spreadBps: Number.isFinite(spreadBps) ? spreadBps : 0,
      bid,
      ask,
      bidAdded,
      askAdded,
      bidCancelled,
      askCancelled,
      bidConsumed,
      askConsumed,
    });

    this.updateBands(book, mid, buy, sell);
    this.updateMarks(book, timestamp, buy, sell, tradePrice, tradeSide);

    this.lastAsk = ask;
    this.lastBid = bid;
    this.lastMid = mid;
    this.lastSpread = Number.isFinite(spreadBps) ? spreadBps : this.lastSpread;
    if (this.primed) this.validSnapshots += 1;
    this.primed = true;
  }

  noteReset(timestamp = Date.now()): void {
    this.primed = false;
    this.resetAt = timestamp;
    this.validSnapshots = 0;
    this.bandWalked = false;
    this.unmatchedBuy = 0;
    this.unmatchedSell = 0;
    this.lastAsk = 0;
    this.lastBid = 0;
    this.lastMid = 0;
    this.lastSpread = 0;
    this.ticks.clear();
    this.bandState.clear();
    this.windowAskReplenish = 0;
    this.windowBidReplenish = 0;
    this.askReplenishEvents = 0;
    this.bidReplenishEvents = 0;
  }

  window(now: number, windowMs: number): BookWindow {
    const start = now - windowMs;
    let bidAdded = 0;
    let askAdded = 0;
    let bidCancelled = 0;
    let askCancelled = 0;
    let bidConsumed = 0;
    let askConsumed = 0;
    let bidInitial = this.lastBid;
    let askInitial = this.lastAsk;
    let bidFinal = this.lastBid;
    let askFinal = this.lastAsk;
    let firstSpread = this.lastSpread;
    let lastSpread = this.lastSpread;
    let first = true;
    let askRepl = 0;
    let bidRepl = 0;
    let prevAskConsumed = false;
    let prevBidConsumed = false;

    for (const tick of this.ticks.toArray()) {
      if (tick.timestamp < start || tick.timestamp > now) continue;
      if (first) {
        bidInitial = Math.max(0, tick.bid - tick.bidAdded + tick.bidCancelled + tick.bidConsumed);
        askInitial = Math.max(0, tick.ask - tick.askAdded + tick.askCancelled + tick.askConsumed);
        firstSpread = tick.spreadBps;
        first = false;
      }
      bidAdded += tick.bidAdded;
      askAdded += tick.askAdded;
      bidCancelled += tick.bidCancelled;
      askCancelled += tick.askCancelled;
      bidConsumed += tick.bidConsumed;
      askConsumed += tick.askConsumed;
      bidFinal = tick.bid;
      askFinal = tick.ask;
      lastSpread = tick.spreadBps;
      if (prevAskConsumed && tick.askAdded > 0) askRepl += 1;
      if (prevBidConsumed && tick.bidAdded > 0) bidRepl += 1;
      prevAskConsumed = tick.askConsumed > 0;
      prevBidConsumed = tick.bidConsumed > 0;
    }

    return {
      bid: toSide(bidInitial, bidAdded, bidCancelled, bidConsumed, bidFinal, bidRepl),
      ask: toSide(askInitial, askAdded, askCancelled, askConsumed, askFinal, askRepl),
      spreadBps: lastSpread,
      spreadDeltaBps: lastSpread - firstSpread,
      askDepthChange: askFinal - askInitial,
      bidDepthChange: bidFinal - bidInitial,
      bandWalked: this.bandWalked,
      resetRecent: this.resetAt > 0 && now - this.resetAt < 8_000,
      primed: this.primed,
      hasValidPrevious: this.validSnapshots >= 1,
    };
  }

  bandAccounting(): LiquidityBandAccounting[] {
    const out: LiquidityBandAccounting[] = [];
    for (const [bandPct, state] of this.bandState) {
      out.push({
        bandPct,
        side: 'ask',
        initial: Math.max(0, state.ask + state.askCancelled + state.askConsumed - state.askAdded),
        added: state.askAdded,
        cancelled: state.askCancelled,
        consumed: state.askConsumed,
        remaining: state.ask,
        response: classifyResponse(state.askAdded, state.askCancelled, state.askConsumed),
      });
      out.push({
        bandPct,
        side: 'bid',
        initial: Math.max(0, state.bid + state.bidCancelled + state.bidConsumed - state.bidAdded),
        added: state.bidAdded,
        cancelled: state.bidCancelled,
        consumed: state.bidConsumed,
        remaining: state.bid,
        response: classifyResponse(state.bidAdded, state.bidCancelled, state.bidConsumed),
      });
    }
    return out.sort((a, b) => a.bandPct - b.bandPct || (a.side === 'ask' ? 0 : 1));
  }

  levels(now: number, absorption: 'bid' | 'ask' | null = null): FootprintLiquidityMark[] {
    const ttl = this.config.markTtlMs;
    const out: FootprintLiquidityMark[] = [];
    for (const mark of this.marks.values()) {
      let event = now - mark.at > ttl ? ('NONE' as LiquidityLevelEvent) : mark.event;
      if (absorption === 'ask' && mark.restingAsk > 0) event = 'ABSORPTION_ASK';
      if (absorption === 'bid' && mark.restingBid > 0) event = 'ABSORPTION_BID';
      out.push({
        price: mark.price,
        restingBid: mark.restingBid,
        restingAsk: mark.restingAsk,
        event,
      });
    }
    return out.sort((a, b) => b.price - a.price).slice(0, 48);
  }

  repeatedAskReplenishment(min = this.config.replenishRepeatMin): boolean {
    return this.windowAskReplenish >= min || this.askReplenishEvents >= min;
  }

  repeatedBidReplenishment(min = this.config.replenishRepeatMin): boolean {
    return this.windowBidReplenish >= min || this.bidReplenishEvents >= min;
  }

  get currentAsk(): number {
    return this.lastAsk;
  }

  get currentBid(): number {
    return this.lastBid;
  }

  private updateBands(book: LocalOrderBook, mid: number, buy: number, sell: number): void {
    for (const bandPct of this.config.bands) {
      const ask = book.notionalWithin('ask', mid, bandPct);
      const bid = book.notionalWithin('bid', mid, bandPct);
      const prev = this.bandState.get(bandPct);
      if (!prev) {
        this.bandState.set(bandPct, {
          bid,
          ask,
          bidAdded: 0,
          askAdded: 0,
          bidCancelled: 0,
          askCancelled: 0,
          bidConsumed: 0,
          askConsumed: 0,
        });
        continue;
      }
      const askDrop = Math.max(0, prev.ask - ask);
      const bidDrop = Math.max(0, prev.bid - bid);
      const askConsumed = Math.min(askDrop, buy);
      const bidConsumed = Math.min(bidDrop, sell);
      prev.askAdded += Math.max(0, ask - prev.ask);
      prev.bidAdded += Math.max(0, bid - prev.bid);
      prev.askConsumed += askConsumed;
      prev.bidConsumed += bidConsumed;
      prev.askCancelled += Math.max(0, askDrop - askConsumed);
      prev.bidCancelled += Math.max(0, bidDrop - bidConsumed);
      prev.ask = ask;
      prev.bid = bid;
    }
  }

  private updateMarks(
    book: LocalOrderBook,
    timestamp: number,
    buy: number,
    sell: number,
    tradePrice?: number,
    tradeSide?: 'BUY' | 'SELL',
  ): void {
    const tick = tickSize(book.mid() || tradePrice || 1);
    const seen = new Set<number>();

    for (const lvl of book.sortedLevels('ask').slice(0, 20)) {
      const price = priceToTick(lvl.price, tick);
      seen.add(price);
      const prev = this.marks.get(price) ?? emptyMark(price);
      const d = lvl.quoteValue - prev.restingAsk;
      let event: LiquidityLevelEvent = prev.event;
      if (d > 0) event = 'REPLENISH_ASK';
      else if (d < 0) event = buy > 0 || tradeSide === 'BUY' ? 'CONSUME_ASK' : 'WITHDRAW_ASK';
      this.marks.set(price, {
        price,
        restingBid: prev.restingBid,
        restingAsk: lvl.quoteValue,
        event,
        at: timestamp,
      });
    }

    for (const lvl of book.sortedLevels('bid').slice(0, 20)) {
      const price = priceToTick(lvl.price, tick);
      seen.add(price);
      const prev = this.marks.get(price) ?? emptyMark(price);
      const d = lvl.quoteValue - prev.restingBid;
      let event: LiquidityLevelEvent = prev.event;
      if (d > 0) event = 'REPLENISH_BID';
      else if (d < 0) event = sell > 0 || tradeSide === 'SELL' ? 'CONSUME_BID' : 'WITHDRAW_BID';
      this.marks.set(price, {
        price,
        restingBid: lvl.quoteValue,
        restingAsk: prev.restingAsk,
        event,
        at: timestamp,
      });
    }

    if (tradePrice && tradeSide) {
      const price = priceToTick(tradePrice, tick);
      const prev = this.marks.get(price) ?? emptyMark(price);
      prev.event = tradeSide === 'BUY' ? 'CONSUME_ASK' : 'CONSUME_BID';
      prev.at = timestamp;
      this.marks.set(price, prev);
    }

    for (const [price, mark] of this.marks) {
      if (!seen.has(price) && timestamp - mark.at > this.config.markTtlMs) this.marks.delete(price);
    }
    if (this.marks.size > 80) {
      const ordered = [...this.marks.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [price] of ordered.slice(0, this.marks.size - 80)) this.marks.delete(price);
    }
  }
}

function emptyMark(price: number): LevelMark {
  return { price, restingBid: 0, restingAsk: 0, event: 'NONE', at: 0 };
}

export function classifyResponse(added: number, cancelled: number, consumed: number): LiquiditySideResponse {
  const total = added + cancelled + consumed;
  if (total <= 0) return 'QUIET';
  const a = safeDiv(added, total);
  const c = safeDiv(cancelled, total);
  const x = safeDiv(consumed, total);
  if (c >= 0.45 && c >= a && c >= x) return 'WITHDRAWAL';
  if (a >= 0.45 && a >= x) return 'REPLENISHMENT';
  if (x >= 0.45) return 'CONSUMPTION';
  if (Math.abs(a - c) < 0.15 && x < 0.25) return 'REPRICING';
  return 'MIXED';
}

function toSide(
  initial: number,
  added: number,
  cancelled: number,
  consumed: number,
  remaining: number,
  replenishEvents: number,
): SideWindow {
  return {
    initial: Math.max(0, initial),
    added,
    cancelled,
    consumed,
    remaining: Math.max(0, remaining),
    replenishEvents,
    response: classifyResponse(added, cancelled, consumed),
  };
}
