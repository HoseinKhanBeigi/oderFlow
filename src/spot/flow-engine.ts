import type { ExchangeId } from '../exchange/venues.js';
import type { WindowSnapshot } from '../models/signals.js';
import type { MarketTrade, OrderBookSnapshot } from '../models/trade.js';
import { barTime } from '../footprint/tick-size.js';
import { safeDiv } from '../core/integrity.js';
import { SpotAbsorptionDetector, nearTouchShare } from './absorption.js';
import { SpotFlowClassifier, deltaPercent } from './classifier.js';
import { compareSpotFutures } from './comparison.js';
import { SpotCvdBook } from './cvd.js';
import { TradeDeduper } from './dedupe.js';
import { EffortVsResult } from './efficiency.js';
import {
  DEFAULT_IMBALANCE_RATIO,
  DEFAULT_SPOT_DEDUP,
  DEFAULT_SPOT_HISTORY_BARS,
  SPOT_CHART_TF_MINUTES,
  SPOT_EXCHANGE_IDS,
  type SpotChartTf,
  type SpotEfficiencySnapshot,
  type SpotExchangeId,
  type SpotFlowSnapshot,
  type SpotVenueStats,
  type SpotWindowStats,
} from './types.js';
import { asSpotExchange } from './venues.js';

interface VenueAcc {
  buy: number;
  sell: number;
  buyCount: number;
  sellCount: number;
  largestBuy: number;
  largestSell: number;
}

interface ClosedMinute {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  venues: Map<SpotExchangeId, VenueAcc>;
  buyNearAsk: number;
  sellNearBid: number;
  askReplenishment: number | null;
  bidReplenishment: number | null;
  hasBook: boolean;
}

interface OpenMinute {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  venues: Map<SpotExchangeId, VenueAcc>;
  buyNearAsk: number;
  sellNearBid: number;
}

interface BookTouch {
  bid: number;
  ask: number;
  timestamp: number;
}

function emptyVenue(): VenueAcc {
  return { buy: 0, sell: 0, buyCount: 0, sellCount: 0, largestBuy: 0, largestSell: 0 };
}

function addTrade(acc: VenueAcc, side: 'BUY' | 'SELL', quote: number): void {
  if (side === 'BUY') {
    acc.buy += quote;
    acc.buyCount += 1;
    if (quote > acc.largestBuy) acc.largestBuy = quote;
  } else {
    acc.sell += quote;
    acc.sellCount += 1;
    if (quote > acc.largestSell) acc.largestSell = quote;
  }
}

function sumVenues(venues: Map<SpotExchangeId, VenueAcc>, exchange: SpotExchangeId | 'all'): VenueAcc {
  if (exchange !== 'all') return venues.get(exchange) ?? emptyVenue();
  const out = emptyVenue();
  for (const v of venues.values()) {
    out.buy += v.buy;
    out.sell += v.sell;
    out.buyCount += v.buyCount;
    out.sellCount += v.sellCount;
    if (v.largestBuy > out.largestBuy) out.largestBuy = v.largestBuy;
    if (v.largestSell > out.largestSell) out.largestSell = v.largestSell;
  }
  return out;
}

function toStats(exchange: SpotExchangeId | 'all', acc: VenueAcc, cvd: number): SpotVenueStats {
  const delta = acc.buy - acc.sell;
  return {
    exchange,
    aggressiveBuyVolume: acc.buy,
    aggressiveSellVolume: acc.sell,
    delta,
    deltaPercent: deltaPercent(acc.buy, acc.sell),
    cvd,
    tradeCount: acc.buyCount + acc.sellCount,
    buyTradeCount: acc.buyCount,
    sellTradeCount: acc.sellCount,
    averageBuySize: safeDiv(acc.buy, acc.buyCount),
    averageSellSize: safeDiv(acc.sell, acc.sellCount),
    largestBuy: acc.largestBuy,
    largestSell: acc.largestSell,
  };
}

function mergeMinutes(bars: ClosedMinute[]): ClosedMinute | null {
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (!first || !last) return null;
  const venues = new Map<SpotExchangeId, VenueAcc>();
  let buyNearAsk = 0;
  let sellNearBid = 0;
  let askRepl: number | null = null;
  let bidRepl: number | null = null;
  let hasBook = false;
  for (const bar of bars) {
    buyNearAsk += bar.buyNearAsk;
    sellNearBid += bar.sellNearBid;
    hasBook = hasBook || bar.hasBook;
    if (bar.askReplenishment != null) askRepl = bar.askReplenishment;
    if (bar.bidReplenishment != null) bidRepl = bar.bidReplenishment;
    for (const [ex, acc] of bar.venues) {
      const dest = venues.get(ex) ?? emptyVenue();
      dest.buy += acc.buy;
      dest.sell += acc.sell;
      dest.buyCount += acc.buyCount;
      dest.sellCount += acc.sellCount;
      if (acc.largestBuy > dest.largestBuy) dest.largestBuy = acc.largestBuy;
      if (acc.largestSell > dest.largestSell) dest.largestSell = acc.largestSell;
      venues.set(ex, dest);
    }
  }
  return {
    time: first.time,
    open: first.open,
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    close: last.close,
    venues,
    buyNearAsk,
    sellNearBid,
    askReplenishment: askRepl,
    bidReplenishment: bidRepl,
    hasBook,
  };
}

class SymbolSpotState {
  readonly cvd = new SpotCvdBook();
  readonly minutes: ClosedMinute[] = [];
  open: OpenMinute | null = null;
  book: BookTouch | null = null;
  futures: WindowSnapshot | null = null;
  oiUsd: number | null = null;
  prevOiUsd: number | null = null;
  askReplenishment: number | null = null;
  bidReplenishment: number | null = null;
  price = 0;
  private readonly effort = new Map<SpotChartTf, EffortVsResult>();
  private readonly absorb = new SpotAbsorptionDetector();
  private readonly classifier = new SpotFlowClassifier();
  private lastSignedDelta = 0;

  constructor(
    readonly symbol: string,
    private readonly imbalanceRatio: number,
  ) {
    for (const tf of SPOT_CHART_TF_MINUTES) this.effort.set(tf, new EffortVsResult());
  }

  ingest(trade: MarketTrade, exchange: SpotExchangeId): void {
    const time = barTime(trade.timestamp, 1);
    if (this.open && this.open.time !== time) {
      if (time > this.open.time) this.closeOpen();
      else return;
    }
    if (!this.open) {
      this.open = {
        time,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        venues: new Map(),
        buyNearAsk: 0,
        sellNearBid: 0,
      };
    }
    const bar = this.open;
    bar.high = Math.max(bar.high, trade.price);
    bar.low = Math.min(bar.low, trade.price);
    bar.close = trade.price;
    this.price = trade.price;

    let acc = bar.venues.get(exchange);
    if (!acc) {
      acc = emptyVenue();
      bar.venues.set(exchange, acc);
    }
    addTrade(acc, trade.side, trade.quoteValue);

    const buyQ = trade.side === 'BUY' ? trade.quoteValue : 0;
    const sellQ = trade.side === 'SELL' ? trade.quoteValue : 0;
    this.cvd.onTrade(exchange, trade.timestamp, buyQ, sellQ, trade.price);

    if (this.book && trade.timestamp - this.book.timestamp <= 2_000) {
      const tick = Math.max((this.book.ask - this.book.bid) * 0.5, this.book.ask * 0.00005);
      if (trade.side === 'BUY' && trade.price >= this.book.ask - tick) bar.buyNearAsk += trade.quoteValue;
      if (trade.side === 'SELL' && trade.price <= this.book.bid + tick) bar.sellNearBid += trade.quoteValue;
    }
  }

  ingestBook(book: OrderBookSnapshot): void {
    const bid = book.bids[0]?.price ?? 0;
    const ask = book.asks[0]?.price ?? 0;
    if (bid > 0 && ask > 0) this.book = { bid, ask, timestamp: book.timestamp };
  }

  ingestBinanceWindow(window: WindowSnapshot): void {
    this.askReplenishment = window.askReplenishmentRate;
    this.bidReplenishment = window.bidReplenishmentRate;
  }

  setFutures(window: WindowSnapshot | null): void {
    this.futures = window;
  }

  setOi(oiUsd: number): void {
    if (this.oiUsd != null && this.oiUsd > 0 && oiUsd !== this.oiUsd) this.prevOiUsd = this.oiUsd;
    this.oiUsd = oiUsd;
  }

  closeStale(now: number): void {
    if (!this.open) return;
    if (this.open.time >= barTime(now, 1)) return;
    this.closeOpen();
  }

  snapshot(exchange: SpotExchangeId | 'all', now: number): SpotFlowSnapshot {
    this.closeStale(now);
    const windows: Partial<Record<SpotChartTf, SpotWindowStats>> = {};
    for (const tf of SPOT_CHART_TF_MINUTES) {
      const rolled = this.roll(tf, exchange);
      if (rolled) windows[tf] = rolled;
    }
    const exchanges: Partial<Record<SpotExchangeId, SpotVenueStats>> = {};
    const liveVenues = this.currentVenues();
    for (const id of SPOT_EXCHANGE_IDS) {
      exchanges[id] = toStats(id, liveVenues.get(id) ?? emptyVenue(), this.cvd.value(id));
    }
    const aggregated = toStats('all', sumVenues(liveVenues, 'all'), this.cvd.value('all'));
    const primary = windows[1] ?? this.liveWindow(exchange, now);
    return {
      symbol: this.symbol,
      price: this.price,
      timestamp: now,
      exchange,
      imbalanceRatio: this.imbalanceRatio,
      windows,
      exchanges,
      aggregated,
      comparison: primary ? compareSpotFutures(primary, { futures: this.futures, oiUsd: this.oiUsd, prevOiUsd: this.prevOiUsd }) : null,
    };
  }

  private currentVenues(): Map<SpotExchangeId, VenueAcc> {
    const out = new Map<SpotExchangeId, VenueAcc>();
    const src = this.open?.venues;
    if (!src) return out;
    for (const [ex, acc] of src) {
      out.set(ex, { ...acc });
    }
    return out;
  }

  private closeOpen(): void {
    const bar = this.open;
    if (!bar) return;
    this.open = null;
    const closed: ClosedMinute = {
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      venues: bar.venues,
      buyNearAsk: bar.buyNearAsk,
      sellNearBid: bar.sellNearBid,
      askReplenishment: this.askReplenishment,
      bidReplenishment: this.bidReplenishment,
      hasBook: this.book != null,
    };
    this.minutes.push(closed);
    if (this.minutes.length > DEFAULT_SPOT_HISTORY_BARS) this.minutes.shift();

    const acc = sumVenues(closed.venues, 'all');
    const delta = acc.buy - acc.sell;
    this.absorb.observe(Math.abs(delta), Math.abs(safeDiv(closed.close - closed.open, closed.open) * 100));
    this.classifier.observe(delta, acc.buy + acc.sell);
    for (const tf of SPOT_CHART_TF_MINUTES) {
      const bucket = tf * 60;
      const lastMinute = closed.time % bucket === bucket - 60;
      if (!lastMinute) continue;
      const slice = this.minutes.filter((b) => b.time >= closed.time - (tf - 1) * 60 && b.time <= closed.time);
      const merged = mergeMinutes(slice);
      if (!merged) continue;
      const m = sumVenues(merged.venues, 'all');
      this.effort.get(tf)?.measure(
        { open: merged.open, close: merged.close, totalVolume: m.buy + m.sell, delta: m.buy - m.sell },
        true,
      );
    }
    this.lastSignedDelta = delta;
  }

  private closedSlice(tf: SpotChartTf): ClosedMinute[] {
    if (!this.minutes.length) return [];
    const last = this.minutes[this.minutes.length - 1]!;
    const from = last.time - (tf - 1) * 60;
    return this.minutes.filter((b) => b.time >= from);
  }

  private liveSlice(tf: SpotChartTf): ClosedMinute[] {
    const closed = this.closedSlice(tf);
    if (!this.open) return closed;
    const live: ClosedMinute = {
      time: this.open.time,
      open: this.open.open,
      high: this.open.high,
      low: this.open.low,
      close: this.open.close,
      venues: this.open.venues,
      buyNearAsk: this.open.buyNearAsk,
      sellNearBid: this.open.sellNearBid,
      askReplenishment: this.askReplenishment,
      bidReplenishment: this.bidReplenishment,
      hasBook: this.book != null,
    };
    const from = live.time - (tf - 1) * 60;
    return [...closed.filter((b) => b.time >= from && b.time !== live.time), live];
  }

  private roll(tf: SpotChartTf, exchange: SpotExchangeId | 'all'): SpotWindowStats | null {
    const bars = this.liveSlice(tf);
    const merged = mergeMinutes(bars);
    if (!merged) return this.liveWindow(exchange, Date.now());
    return this.toWindow(tf, merged, exchange);
  }

  private liveWindow(exchange: SpotExchangeId | 'all', now: number): SpotWindowStats | null {
    if (!this.open) return null;
    const live: ClosedMinute = {
      time: this.open.time,
      open: this.open.open,
      high: this.open.high,
      low: this.open.low,
      close: this.open.close,
      venues: this.open.venues,
      buyNearAsk: this.open.buyNearAsk,
      sellNearBid: this.open.sellNearBid,
      askReplenishment: this.askReplenishment,
      bidReplenishment: this.bidReplenishment,
      hasBook: this.book != null,
    };
    return this.toWindow(1, live, exchange, now);
  }

  private toWindow(tf: SpotChartTf, bar: ClosedMinute, exchange: SpotExchangeId | 'all', now = Date.now()): SpotWindowStats {
    const acc = sumVenues(bar.venues, exchange);
    const stats = toStats(exchange, acc, this.cvd.value(exchange));
    const effort = this.effort.get(tf) ?? new EffortVsResult();
    const efficiency: SpotEfficiencySnapshot = effort.measure(
      { open: bar.open, close: bar.close, totalVolume: acc.buy + acc.sell, delta: acc.buy - acc.sell },
      false,
    );
    const absorption = this.absorb.detect({
      buyVolume: acc.buy,
      sellVolume: acc.sell,
      delta: acc.buy - acc.sell,
      priceChangePercent: efficiency.priceChangePercent,
      buyNearAskShare: nearTouchShare(bar.buyNearAsk, acc.buy),
      sellNearBidShare: nearTouchShare(bar.sellNearBid, acc.sell),
      askReplenishment: bar.askReplenishment,
      bidReplenishment: bar.bidReplenishment,
      hasBook: bar.hasBook,
    });
    const cvdSnap = this.cvd.snapshot(exchange, now);
    const classified = this.classifier.classify({
      delta: stats.delta,
      deltaPercent: stats.deltaPercent,
      totalVolume: acc.buy + acc.sell,
      priceChangePercent: efficiency.priceChangePercent,
      cvdDivergence: cvdSnap.divergence,
      cvdAcceleration: cvdSnap.acceleration,
      priorAbsDelta: this.lastSignedDelta,
      absorption: absorption.type,
    });
    return {
      ...stats,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      efficiency,
      absorption,
      flow: classified.flow,
      flags: classified.flags,
      cvdDirection: cvdSnap.direction,
      cvdDivergence: cvdSnap.divergence,
    };
  }
}

export class SpotFlowEngine {
  private readonly symbols = new Map<string, SymbolSpotState>();
  readonly deduper = new TradeDeduper(DEFAULT_SPOT_DEDUP);

  constructor(private readonly imbalanceRatio = DEFAULT_IMBALANCE_RATIO) {}

  ingestTrade(trade: MarketTrade, exchange: ExchangeId): boolean {
    if (trade.marketType !== 'spot') return false;
    const spotEx = asSpotExchange(exchange);
    if (!spotEx) return false;
    if (!this.deduper.accept(exchange, trade.symbol, trade.tradeId)) return false;
    this.get(trade.symbol).ingest(trade, spotEx);
    return true;
  }

  ingestBook(book: OrderBookSnapshot): void {
    if (book.marketType !== 'spot') return;
    this.get(book.symbol).ingestBook(book);
  }

  ingestBinanceWindow(symbol: string, window: WindowSnapshot): void {
    this.get(symbol).ingestBinanceWindow(window);
  }

  setFuturesWindow(symbol: string, window: WindowSnapshot | null): void {
    this.get(symbol).setFutures(window);
  }

  setOi(symbol: string, oiUsd: number): void {
    this.get(symbol).setOi(oiUsd);
  }

  snapshot(symbol: string, exchange: SpotExchangeId | 'all' = 'all', now = Date.now()): SpotFlowSnapshot {
    return this.get(symbol).snapshot(exchange, now);
  }

  private get(symbol: string): SymbolSpotState {
    let state = this.symbols.get(symbol);
    if (!state) {
      state = new SymbolSpotState(symbol, this.imbalanceRatio);
      this.symbols.set(symbol, state);
    }
    return state;
  }
}

export function toNormalizedSpotTrade(trade: MarketTrade, exchange: ExchangeId) {
  return {
    exchange,
    symbol: trade.symbol,
    timestamp: trade.timestamp,
    price: trade.price,
    quantity: trade.quantity,
    quoteValue: trade.quoteValue,
    side: trade.side,
    tradeId: trade.tradeId,
  };
}
