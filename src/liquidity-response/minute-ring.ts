import { barTime } from '../footprint/tick-size.js';
import type { MarketTrade } from '../models/trade.js';
import type { LiquidityTf } from '../models/liquidity-response.js';
import { LIQUIDITY_TF_MINUTES } from '../models/liquidity-response.js';

export interface MinuteBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  buy: number;
  sell: number;
  buyCount: number;
  sellCount: number;
  largeBuyCount: number;
  largeSellCount: number;
  nearAsk: number;
  nearBid: number;
}

export interface RolledMinute {
  open: number;
  high: number;
  low: number;
  close: number;
  buy: number;
  sell: number;
  buyCount: number;
  sellCount: number;
  largeBuyCount: number;
  largeSellCount: number;
  nearAsk: number;
  nearBid: number;
  atr: number;
}

/**
 * 1-minute executed-flow bars used for longer-TF efficiency (30m–4h)
 * without mixing resting book size into volume.
 */
export class MinuteRing {
  private readonly bars: MinuteBar[] = [];
  private open: MinuteBar | null = null;

  constructor(private readonly capacity: number) {}

  ingest(
    trade: MarketTrade,
    opts: { large: boolean; nearAsk: boolean; nearBid: boolean } = {
      large: false,
      nearAsk: false,
      nearBid: false,
    },
  ): MinuteBar | null {
    const time = barTime(trade.timestamp, 1);
    let closed: MinuteBar | null = null;
    if (this.open && this.open.time !== time) {
      if (time > this.open.time) {
        closed = this.closeOpen();
      } else {
        return null;
      }
    }
    if (!this.open) {
      this.open = {
        time,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        buy: 0,
        sell: 0,
        buyCount: 0,
        sellCount: 0,
        largeBuyCount: 0,
        largeSellCount: 0,
        nearAsk: 0,
        nearBid: 0,
      };
    }
    const bar = this.open;
    bar.high = Math.max(bar.high, trade.price);
    bar.low = Math.min(bar.low, trade.price);
    bar.close = trade.price;
    if (trade.isAggressiveBuy) {
      bar.buy += trade.quoteValue;
      bar.buyCount += 1;
      if (opts.large) bar.largeBuyCount += 1;
      if (opts.nearAsk) bar.nearAsk += trade.quoteValue;
    } else {
      bar.sell += trade.quoteValue;
      bar.sellCount += 1;
      if (opts.large) bar.largeSellCount += 1;
      if (opts.nearBid) bar.nearBid += trade.quoteValue;
    }
    return closed;
  }

  closeStale(now: number): MinuteBar | null {
    if (!this.open) return null;
    if (this.open.time >= barTime(now, 1)) return null;
    return this.closeOpen();
  }

  roll(tf: LiquidityTf, now = Date.now()): RolledMinute | null {
    const bars = this.liveSlice(tf, now);
    if (!bars.length) return null;
    return merge(bars, this.atr());
  }

  allTfs(now = Date.now()): Partial<Record<LiquidityTf, RolledMinute>> {
    const out: Partial<Record<LiquidityTf, RolledMinute>> = {};
    for (const tf of LIQUIDITY_TF_MINUTES) {
      const rolled = this.roll(tf, now);
      if (rolled) out[tf] = rolled;
    }
    return out;
  }

  atr(period = 14): number {
    if (this.bars.length < 2) {
      const last = this.open ?? this.bars[this.bars.length - 1];
      return last ? Math.max(0, last.high - last.low) : 0;
    }
    const n = Math.min(period, this.bars.length);
    const slice = this.bars.slice(-n);
    let sum = 0;
    for (let i = 0; i < slice.length; i++) {
      const bar = slice[i]!;
      const prev = slice[i - 1] ?? this.bars[this.bars.length - n - 1];
      const tr = prev
        ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close))
        : bar.high - bar.low;
      sum += tr;
    }
    return sum / n;
  }

  get lastClosed(): MinuteBar | null {
    return this.bars[this.bars.length - 1] ?? null;
  }

  closed(): MinuteBar[] {
    return this.bars;
  }

  private closeOpen(): MinuteBar | null {
    const bar = this.open;
    if (!bar) return null;
    this.open = null;
    this.bars.push(bar);
    if (this.bars.length > this.capacity) this.bars.shift();
    return bar;
  }

  private liveSlice(tf: LiquidityTf, now: number): MinuteBar[] {
    const live = this.open;
    const lastTime = live?.time ?? barTime(now, 1);
    const from = lastTime - (tf - 1) * 60;
    const closed = this.bars.filter((b) => b.time >= from && b.time !== live?.time);
    return live ? [...closed, live] : closed;
  }
}

function merge(bars: MinuteBar[], atr: number): RolledMinute | null {
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (!first || !last) return null;
  let buy = 0;
  let sell = 0;
  let buyCount = 0;
  let sellCount = 0;
  let largeBuyCount = 0;
  let largeSellCount = 0;
  let nearAsk = 0;
  let nearBid = 0;
  let high = first.high;
  let low = first.low;
  for (const b of bars) {
    buy += b.buy;
    sell += b.sell;
    buyCount += b.buyCount;
    sellCount += b.sellCount;
    largeBuyCount += b.largeBuyCount;
    largeSellCount += b.largeSellCount;
    nearAsk += b.nearAsk;
    nearBid += b.nearBid;
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
  }
  return {
    open: first.open,
    high,
    low,
    close: last.close,
    buy,
    sell,
    buyCount,
    sellCount,
    largeBuyCount,
    largeSellCount,
    nearAsk,
    nearBid,
    atr,
  };
}
