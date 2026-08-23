import type { ExchangeId } from '../exchange/venues.js';
import type { MarketType } from '../models/trade.js';

/** Buy/sell quote volume executed at one price bucket inside a bar. */
export interface FootprintLevel {
  price: number;
  buy: number;
  sell: number;
}

/**
 * One aggregated footprint bar. `levels` is the per-price split; `totalBuy`
 * and `totalSell` are quote (USD) notional, matching the dashboard tape.
 */
export interface FootprintBar {
  symbol: string;
  exchange: ExchangeId;
  market: MarketType;
  /** Bar open time, unix seconds, aligned to the bar interval. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  totalBuy: number;
  totalSell: number;
  trades: number;
  levels: FootprintLevel[];
}

/** Wire form used on the WS feed and the REST API. Compact on purpose. */
export interface FootprintBarWire {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  tb: number;
  ts: number;
  n: number;
  /** `[price, buy, sell]` triples. */
  lv: [number, number, number][];
}

export type FootprintSource = 'live' | 'backfill';

export function toWire(bar: FootprintBar): FootprintBarWire {
  return {
    t: bar.time,
    o: bar.open,
    h: bar.high,
    l: bar.low,
    c: bar.close,
    tb: round2(bar.totalBuy),
    ts: round2(bar.totalSell),
    n: bar.trades,
    lv: bar.levels.map((l) => [l.price, round2(l.buy), round2(l.sell)]),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
