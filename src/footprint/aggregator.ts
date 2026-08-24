import type { ExchangeId } from '../exchange/venues.js';
import type { MarketTrade, MarketType } from '../models/trade.js';
import { barTime, priceToTick, tickSize } from './tick-size.js';
import type { FootprintBar, FootprintLevel } from './types.js';

interface OpenBar {
  symbol: string;
  exchange: ExchangeId;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  totalBuy: number;
  totalSell: number;
  trades: number;
  levels: Map<number, FootprintLevel>;
  dirty: boolean;
}

export interface FootprintAggregatorOptions {
  market: MarketType;
  /** Bar size. Only 1m is persisted; longer frames are rolled up on read. */
  intervalMinutes?: number;
}

/**
 * Builds 1-minute footprint bars from the normalized trade stream.
 *
 * Unlike the browser chart this consumes *every* trade, not just those above
 * the watchlist `minUsd` tape threshold, so stored bars are a true footprint
 * and line up with the Binance archive backfill.
 */
export class FootprintAggregator {
  private readonly open = new Map<string, OpenBar>();
  private closed: FootprintBar[] = [];
  private readonly intervalMinutes: number;

  constructor(private readonly options: FootprintAggregatorOptions) {
    this.intervalMinutes = options.intervalMinutes ?? 1;
  }

  ingest(trade: MarketTrade, exchange: ExchangeId = 'binance'): void {
    const { price, quoteValue, timestamp, side, symbol } = trade;
    if (!Number.isFinite(price) || price <= 0) return;
    if (!Number.isFinite(quoteValue) || quoteValue <= 0) return;

    const time = barTime(timestamp, this.intervalMinutes);
    const key = `${symbol}|${exchange}`;
    let bar = this.open.get(key);

    if (bar && bar.time !== time) {
      // A late print for an already-rolled bar would corrupt a flushed row.
      if (time < bar.time) return;
      this.closed.push(finalize(bar, this.options.market));
      bar = undefined;
    }

    if (!bar) {
      bar = {
        symbol,
        exchange,
        time,
        open: price,
        high: price,
        low: price,
        close: price,
        totalBuy: 0,
        totalSell: 0,
        trades: 0,
        levels: new Map(),
        dirty: false,
      };
      this.open.set(key, bar);
    }

    bar.high = Math.max(bar.high, price);
    bar.low = Math.min(bar.low, price);
    bar.close = price;
    bar.trades += 1;
    bar.dirty = true;

    const level = priceToTick(price, tickSize(price));
    let entry = bar.levels.get(level);
    if (!entry) {
      entry = { price: level, buy: 0, sell: 0 };
      bar.levels.set(level, entry);
    }
    if (side === 'BUY') {
      entry.buy += quoteValue;
      bar.totalBuy += quoteValue;
    } else {
      entry.sell += quoteValue;
      bar.totalSell += quoteValue;
    }
  }

  /** Rolls bars whose interval has elapsed, even if the symbol went quiet. */
  closeStale(now = Date.now()): void {
    const current = barTime(now, this.intervalMinutes);
    for (const [key, bar] of this.open) {
      if (bar.time >= current) continue;
      this.closed.push(finalize(bar, this.options.market));
      this.open.delete(key);
    }
  }

  /** Returns completed bars and clears the queue. */
  drainClosed(): FootprintBar[] {
    if (!this.closed.length) return [];
    const out = this.closed;
    this.closed = [];
    return out;
  }

  /** Snapshot of in-progress bars, for periodic checkpointing. */
  openBars(onlyDirty = false): FootprintBar[] {
    const out: FootprintBar[] = [];
    for (const bar of this.open.values()) {
      if (onlyDirty && !bar.dirty) continue;
      bar.dirty = false;
      out.push(finalize(bar, this.options.market));
    }
    return out;
  }

  currentBar(symbol: string, exchange: ExchangeId): FootprintBar | null {
    const bar = this.open.get(`${symbol}|${exchange}`);
    return bar ? finalize(bar, this.options.market) : null;
  }
}

function finalize(bar: OpenBar, market: MarketType): FootprintBar {
  return {
    symbol: bar.symbol,
    exchange: bar.exchange,
    market,
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    totalBuy: bar.totalBuy,
    totalSell: bar.totalSell,
    trades: bar.trades,
    levels: [...bar.levels.values()].sort((a, b) => a.price - b.price),
  };
}
