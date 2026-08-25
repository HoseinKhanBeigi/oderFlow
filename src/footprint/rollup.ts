import type { FootprintBar, FootprintLevel } from './types.js';

interface Accum {
  time: number;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  totalBuy: number;
  totalSell: number;
  trades: number;
  buyTrades: number;
  sellTrades: number;
  largestBuy: number;
  largestSell: number;
  levels: Map<number, FootprintLevel>;
}

/**
 * Merges 1-minute bars (optionally from several exchanges) into `tfMinutes`
 * bars. Mirrors `aggregateFrom1m()` in the browser so seeded history and live
 * bars roll up the same way.
 */
export function rollup(bars: FootprintBar[], tfMinutes: number): FootprintBar[] {
  if (tfMinutes <= 0) return [];
  const bucket = tfMinutes * 60;
  const byTime = new Map<number, Accum>();

  for (const bar of bars) { 
    const t = bar.time - (bar.time % bucket);
    let acc = byTime.get(t);
    if (!acc) {
      acc = {
        time: t,
        openTime: bar.time,
        closeTime: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        totalBuy: 0,
        totalSell: 0,
        trades: 0,
        buyTrades: 0,
        sellTrades: 0,
        largestBuy: 0,
        largestSell: 0,
        levels: new Map(),
      };
      byTime.set(t, acc);
    }

    // Bars can arrive interleaved across exchanges, so open/close are chosen by
    // timestamp rather than iteration order.
    if (bar.time <= acc.openTime) {
      acc.openTime = bar.time;
      acc.open = bar.open;
    }
    if (bar.time >= acc.closeTime) {
      acc.closeTime = bar.time;
      acc.close = bar.close;
    }
    acc.high = Math.max(acc.high, bar.high);
    acc.low = Math.min(acc.low, bar.low);
    acc.totalBuy += bar.totalBuy;
    acc.totalSell += bar.totalSell;
    acc.trades += bar.trades;
    acc.buyTrades += bar.buyTrades ?? 0;
    acc.sellTrades += bar.sellTrades ?? 0;
    acc.largestBuy = Math.max(acc.largestBuy, bar.largestBuy ?? 0);
    acc.largestSell = Math.max(acc.largestSell, bar.largestSell ?? 0);

    for (const level of bar.levels) {
      const entry = acc.levels.get(level.price);
      if (entry) {
        entry.buy += level.buy;
        entry.sell += level.sell;
      } else {
        acc.levels.set(level.price, { price: level.price, buy: level.buy, sell: level.sell });
      }
    }
  }

  const first = bars[0];
  return [...byTime.values()]
    .sort((a, b) => a.time - b.time)
    .map((acc) => ({
      symbol: first?.symbol ?? '',
      exchange: first?.exchange ?? 'binance',
      market: first?.market ?? 'perp',
      time: acc.time,
      open: acc.open,
      high: acc.high,
      low: acc.low,
      close: acc.close,
      totalBuy: acc.totalBuy,
      totalSell: acc.totalSell,
      trades: acc.trades,
      buyTrades: acc.buyTrades,
      sellTrades: acc.sellTrades,
      largestBuy: acc.largestBuy,
      largestSell: acc.largestSell,
      levels: [...acc.levels.values()].sort((a, b) => a.price - b.price),
    }));
}
