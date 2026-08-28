import type { FootprintBar } from '../footprint/types.js';
import type { DataCoverage, MarketBar } from './types.js';

export interface CandleRow {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DatasetInput {
  candles: CandleRow[];
  footprint: FootprintBar[];
  spotFootprint?: FootprintBar[];
  tfMinutes: number;
  fromSec: number;
  toSec: number;
}

export function mergeDataset(input: DatasetInput): { bars: MarketBar[]; coverage: DataCoverage } {
  const tf = input.tfMinutes * 60;
  const fp = indexBars(input.footprint, tf);
  const spot = indexBars(input.spotFootprint ?? [], tf);
  const bars: MarketBar[] = [];
  let fpHits = 0;
  let spotHits = 0;

  for (const c of input.candles) {
    const t = align(c.time, tf);
    if (t < input.fromSec || t >= input.toSec) continue;
    const f = fp.get(t);
    const s = spot.get(t);
    if (f) fpHits += 1;
    if (s) spotHits += 1;
    const buy = f?.totalBuy ?? 0;
    const sell = f?.totalSell ?? 0;
    bars.push({
      time: t,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      aggressiveBuy: buy,
      aggressiveSell: sell,
      trades: f?.trades ?? 0,
      buyTrades: f?.buyTrades ?? 0,
      sellTrades: f?.sellTrades ?? 0,
      largestBuy: f?.largestBuy ?? 0,
      largestSell: f?.largestSell ?? 0,
      levels: f?.levels ?? [],
      hasFootprint: Boolean(f),
      hasBook: false,
      spotBuy: s?.totalBuy ?? buy,
      spotSell: s?.totalSell ?? sell,
      futuresBuy: buy,
      futuresSell: sell,
      bidDepth: null,
      askDepth: null,
      bidReplenishment: null,
      askReplenishment: null,
      bidWithdrawal: null,
      askWithdrawal: null,
      oi: null,
      oiChange: null,
      funding: null,
      longLiquidations: null,
      shortLiquidations: null,
    });
  }

  const n = bars.length || 1;
  const warnings: string[] = [];
  const tradesPct = (fpHits / n) * 100;
  const spotPct = (spotHits / n) * 100;
  if (tradesPct < 50) warnings.push('Order-flow footprint covers under 50% of candles. Absorption and delta will be sparse.');
  if (spotPct < 20) warnings.push('Spot footprint missing for most bars. Spot vs futures conditions will not fire.');
  warnings.push('L2 book, OI, funding, and liquidations are not in this historical series (Phase 2). Implied replenishment/vacuum proxies are used.');

  const coverage: DataCoverage = {
    candles: 100,
    trades: round(tradesPct),
    l2: 0,
    oi: 0,
    funding: 0,
    liquidations: 0,
    spot: round(spotPct),
    futures: round(tradesPct),
    fromSec: bars[0]?.time ?? input.fromSec,
    toSec: (bars[bars.length - 1]?.time ?? input.toSec) + tf,
    barCount: bars.length,
    warnings,
  };
  return { bars, coverage };
}

function indexBars(bars: FootprintBar[], tfSec: number): Map<number, FootprintBar> {
  const m = new Map<number, FootprintBar>();
  for (const b of bars) m.set(align(b.time, tfSec), b);
  return m;
}

function align(timeSec: number, tfSec: number): number {
  return timeSec - (timeSec % tfSec);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function tfToInterval(tfMinutes: number): string {
  const map: Record<number, string> = {
    1: '1m',
    5: '5m',
    15: '15m',
    30: '30m',
    45: '15m',
    60: '1h',
    120: '2h',
    240: '4h',
    1440: '1d',
  };
  return map[tfMinutes] ?? '15m';
}

export function sourceTfMinutes(tfMinutes: number): number {
  return tfMinutes === 45 ? 15 : tfMinutes;
}

export function rollCandles(candles: CandleRow[], sourceTf: number, targetTf: number): CandleRow[] {
  if (targetTf <= sourceTf) return candles;
  const bucket = targetTf * 60;
  const byTime = new Map<number, CandleRow>();
  for (const c of candles) {
    const t = c.time - (c.time % bucket);
    const acc = byTime.get(t);
    if (!acc) {
      byTime.set(t, { ...c, time: t });
      continue;
    }
    acc.high = Math.max(acc.high, c.high);
    acc.low = Math.min(acc.low, c.low);
    acc.close = c.close;
    acc.volume += c.volume;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function klinesToCandles(rows: Array<[number, string, string, string, string, string]>): CandleRow[] {
  return rows.map((r) => ({
    time: Math.floor(Number(r[0]) / 1000),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5] ?? 0),
  }));
}

export function footprintFromWire(
  rows: Array<{
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
    tb: number;
    ts: number;
    n: number;
    bt?: number;
    st?: number;
    lb?: number;
    ls?: number;
    lv: [number, number, number][];
  }>,
  symbol: string,
  exchange: FootprintBar['exchange'],
  market: FootprintBar['market'],
): FootprintBar[] {
  return rows.map((r) => ({
    symbol,
    exchange,
    market,
    time: r.t,
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
    totalBuy: r.tb,
    totalSell: r.ts,
    trades: r.n,
    buyTrades: r.bt,
    sellTrades: r.st,
    largestBuy: r.lb,
    largestSell: r.ls,
    levels: (r.lv ?? []).map(([price, buy, sell]) => ({ price, buy, sell })),
  }));
}
