import { describe, expect, it } from 'vitest';
import { FootprintAggregator } from '../src/footprint/aggregator.js';
import { rollup } from '../src/footprint/rollup.js';
import { barTime, priceToTick, tickSize } from '../src/footprint/tick-size.js';
import { classifyTrade } from '../src/flow/trade-classifier.js';
import type { FootprintBar } from '../src/footprint/types.js';

const MINUTE = 60_000;
/** Hour-aligned so that every timeframe boundary in these tests lines up. */
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % 3_600_000);

function trade(price: number, quantity: number, timestamp: number, isBuyerMaker: boolean) {
  return classifyTrade({ symbol: 'BTCUSDT', marketType: 'perp', timestamp, price, quantity, isBuyerMaker });
}

describe('footprint tick bucketing', () => {
  it('matches the tiers used by the browser chart', () => {
    expect(tickSize(50_000)).toBe(10);
    expect(tickSize(2_500)).toBe(1);
    expect(tickSize(216)).toBe(0.5);
    expect(tickSize(45)).toBe(0.1);
    expect(tickSize(2.5)).toBe(0.01);
    expect(tickSize(0.4)).toBe(0.001);
  });

  it('uses a penny grid for US stocks', () => {
    expect(tickSize(180.12, 'stock')).toBe(0.01);
    expect(tickSize(0.42, 'stock')).toBe(0.0001);
    expect(priceToTick(180.124, tickSize(180.124, 'stock'))).toBe(180.12);
    expect(priceToTick(180.126, tickSize(180.126, 'stock'))).toBe(180.13);
  });

  it('collapses nearby prices into one bucket', () => {
    expect(priceToTick(69_312.4)).toBe(69_310);
    expect(priceToTick(69_314.9)).toBe(69_310);
    expect(priceToTick(69_315.1)).toBe(69_320);
    // Exact halves round up, matching Math.round in the browser.
    expect(priceToTick(69_325)).toBe(69_330);
  });

  it('avoids float drift that would split a bucket', () => {
    expect(priceToTick(0.3004)).toBe(0.3);
    expect(String(priceToTick(0.3004))).toBe('0.3');
  });

  it('aligns bar times to the interval', () => {
    expect(barTime(T0 + 35_000, 1)).toBe(T0 / 1000);
    expect(barTime(T0 + 5 * MINUTE, 15)).toBe(barTime(T0, 15));
  });
});

describe('footprint aggregator', () => {
  it('splits buy and sell volume per price level', () => {
    const agg = new FootprintAggregator({ market: 'perp' });
    agg.ingest(trade(69_311, 1, T0 + 1_000, false), 'binance');
    agg.ingest(trade(69_313, 2, T0 + 2_000, true), 'binance');
    agg.ingest(trade(69_324, 1, T0 + 3_000, false), 'binance');

    const bar = agg.currentBar('BTCUSDT', 'binance');
    expect(bar).not.toBeNull();
    expect(bar?.levels).toHaveLength(2);

    const [low, high] = bar!.levels;
    expect(low?.price).toBe(69_310);
    expect(low?.buy).toBeCloseTo(69_311, 4);
    expect(low?.sell).toBeCloseTo(69_313 * 2, 4);
    expect(high?.price).toBe(69_320);
    expect(high?.buy).toBeCloseTo(69_324, 4);
    expect(high?.sell).toBe(0);
  });

  it('tracks OHLC and totals across a bar', () => {
    const agg = new FootprintAggregator({ market: 'perp' });
    agg.ingest(trade(100, 1, T0 + 1_000, false), 'binance');
    agg.ingest(trade(120, 1, T0 + 2_000, false), 'binance');
    agg.ingest(trade(90, 1, T0 + 3_000, true), 'binance');
    agg.ingest(trade(110, 1, T0 + 4_000, false), 'binance');

    const bar = agg.currentBar('BTCUSDT', 'binance')!;
    expect(bar.open).toBe(100);
    expect(bar.high).toBe(120);
    expect(bar.low).toBe(90);
    expect(bar.close).toBe(110);
    expect(bar.trades).toBe(4);
    expect(bar.totalBuy).toBeCloseTo(330, 4);
    expect(bar.totalSell).toBeCloseTo(90, 4);
  });

  it('rolls a closed bar when the minute advances', () => {
    const agg = new FootprintAggregator({ market: 'perp' });
    agg.ingest(trade(100, 1, T0 + 1_000, false), 'binance');
    expect(agg.drainClosed()).toHaveLength(0);

    agg.ingest(trade(101, 1, T0 + MINUTE + 1_000, false), 'binance');
    const closed = agg.drainClosed();
    expect(closed).toHaveLength(1);
    expect(closed[0]?.time).toBe(T0 / 1000);
    expect(agg.currentBar('BTCUSDT', 'binance')?.time).toBe((T0 + MINUTE) / 1000);
  });

  it('closes stale bars for symbols that went quiet', () => {
    const agg = new FootprintAggregator({ market: 'perp' });
    agg.ingest(trade(100, 1, T0 + 1_000, false), 'binance');
    agg.closeStale(T0 + 3 * MINUTE);
    expect(agg.drainClosed()).toHaveLength(1);
    expect(agg.currentBar('BTCUSDT', 'binance')).toBeNull();
  });

  it('drops late prints for an already-closed bar', () => {
    const agg = new FootprintAggregator({ market: 'perp' });
    agg.ingest(trade(100, 1, T0 + MINUTE + 1_000, false), 'binance');
    agg.ingest(trade(999, 5, T0 + 1_000, false), 'binance');

    const bar = agg.currentBar('BTCUSDT', 'binance')!;
    expect(bar.trades).toBe(1);
    expect(bar.high).toBe(100);
  });

  it('keeps exchanges in separate bars', () => {
    const agg = new FootprintAggregator({ market: 'perp' });
    agg.ingest(trade(100, 1, T0 + 1_000, false), 'binance');
    agg.ingest(trade(100, 3, T0 + 1_000, false), 'bybit');

    expect(agg.currentBar('BTCUSDT', 'binance')?.totalBuy).toBeCloseTo(100, 4);
    expect(agg.currentBar('BTCUSDT', 'bybit')?.totalBuy).toBeCloseTo(300, 4);
  });

  it('ignores non-finite and zero-value prints', () => {
    const agg = new FootprintAggregator({ market: 'perp' });
    agg.ingest(trade(Number.NaN, 1, T0 + 1_000, false), 'binance');
    agg.ingest(trade(100, 0, T0 + 1_000, false), 'binance');
    expect(agg.currentBar('BTCUSDT', 'binance')).toBeNull();
  });
});

describe('footprint rollup', () => {
  function bar(time: number, over: Partial<FootprintBar> = {}): FootprintBar {
    return {
      symbol: 'BTCUSDT',
      exchange: 'binance',
      market: 'perp',
      time,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      totalBuy: 0,
      totalSell: 0,
      trades: 0,
      levels: [],
      ...over,
    };
  }

  it('merges minutes into one higher-timeframe bar', () => {
    const base = barTime(T0, 15);
    const out = rollup(
      [
        bar(base, { open: 10, high: 12, low: 9, close: 11, totalBuy: 100, trades: 2, levels: [{ price: 10, buy: 100, sell: 0 }] }),
        bar(base + 60, { open: 11, high: 20, low: 8, close: 15, totalSell: 50, trades: 3, levels: [{ price: 10, buy: 0, sell: 50 }] }),
      ],
      15,
    );

    expect(out).toHaveLength(1);
    const merged = out[0]!;
    expect(merged.open).toBe(10);
    expect(merged.close).toBe(15);
    expect(merged.high).toBe(20);
    expect(merged.low).toBe(8);
    expect(merged.trades).toBe(5);
    expect(merged.levels).toEqual([{ price: 10, buy: 100, sell: 50 }]);
  });

  it('picks open and close by timestamp, not arrival order', () => {
    const base = barTime(T0, 15);
    const out = rollup([bar(base + 120, { open: 30, close: 33 }), bar(base, { open: 10, close: 11 })], 15);
    expect(out[0]?.open).toBe(10);
    expect(out[0]?.close).toBe(33);
  });

  it('sums the same minute across exchanges without duplicating it', () => {
    const base = barTime(T0, 5);
    const out = rollup(
      [
        bar(base, { exchange: 'binance', totalBuy: 100, levels: [{ price: 10, buy: 100, sell: 0 }] }),
        bar(base, { exchange: 'bybit', totalBuy: 40, levels: [{ price: 10, buy: 40, sell: 0 }] }),
      ],
      5,
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.totalBuy).toBeCloseTo(140, 4);
    expect(out[0]?.levels).toEqual([{ price: 10, buy: 140, sell: 0 }]);
  });

  it('returns bars in ascending time order', () => {
    const base = barTime(T0, 5);
    const out = rollup([bar(base + 600), bar(base), bar(base + 300)], 5);
    expect(out.map((b) => b.time)).toEqual([base, base + 300, base + 600]);
  });
});
