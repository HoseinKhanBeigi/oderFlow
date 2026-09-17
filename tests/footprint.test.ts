import { describe, expect, it } from 'vitest';
import { FootprintAggregator } from '../src/footprint/aggregator.js';
import { rollup } from '../src/footprint/rollup.js';
import { readAttackMomentum, readThreeCandleFootprint } from '../src/footprint/structure.js';
import { barTime, priceToTick, tickSize } from '../src/footprint/tick-size.js';
import { classifyTrade } from '../src/flow/trade-classifier.js';
import type { FootprintBar, FootprintLevel } from '../src/footprint/types.js';

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

describe('three-candle footprint structure', () => {
  const T = T0 / 1000;

  function candle(
    time: number,
    levels: FootprintLevel[],
    ohlc: { open?: number; high: number; low: number; close: number },
  ): FootprintBar {
    return {
      symbol: 'BTCUSDT',
      exchange: 'binance',
      market: 'perp',
      time,
      open: ohlc.open ?? ohlc.close,
      high: ohlc.high,
      low: ohlc.low,
      close: ohlc.close,
      totalBuy: levels.reduce((s, l) => s + l.buy, 0),
      totalSell: levels.reduce((s, l) => s + l.sell, 0),
      trades: 1,
      levels,
    };
  }

  it('returns null when there are no bars', () => {
    expect(readThreeCandleFootprint([])).toBeNull();
    expect(readThreeCandleFootprint(undefined)).toBeNull();
  });

  it('formats each candle as timestamp, bid×ask levels high-to-low, and delta', () => {
    const read = readThreeCandleFootprint([
      candle(T, [{ price: 100, buy: 10, sell: 20 }, { price: 100.5, buy: 5, sell: 4 }], {
        high: 100.5,
        low: 100,
        close: 100,
      }),
    ]);
    expect(read?.candles).toHaveLength(1);
    expect(read?.candles[0]).toEqual({
      t: T,
      delta: -9,
      levels: [
        [100.5, 5, 4],
        [100, 10, 20],
      ],
    });
  });

  it('is indeterminate when the largest ask cluster is on the latest candle', () => {
    const read = readThreeCandleFootprint([
      candle(T, [{ price: 100, buy: 20_000, sell: 10_000 }], { high: 100, low: 100, close: 100 }),
      candle(T + 60, [{ price: 100, buy: 15_000, sell: 12_000 }], { high: 100.5, low: 100, close: 100.5 }),
      candle(T + 120, [{ price: 100.5, buy: 8_000, sell: 90_000 }], { high: 100.5, low: 100, close: 100 }),
    ]);
    expect(read?.askCluster?.price).toBe(100.5);
    expect(read?.defense).toBe('unobserved');
    expect(read?.structure).toBe('indeterminate');
  });

  it('is indeterminate when no level is sell-dominant', () => {
    const read = readThreeCandleFootprint([
      candle(T, [{ price: 100, buy: 50_000, sell: 10_000 }], { high: 100, low: 100, close: 100 }),
      candle(T + 60, [{ price: 100.5, buy: 40_000, sell: 8_000 }], { high: 100.5, low: 100, close: 100.5 }),
      candle(T + 120, [{ price: 101, buy: 30_000, sell: 5_000 }], { high: 101, low: 100.5, close: 101 }),
    ]);
    expect(read?.askCluster).toBeNull();
    expect(read?.structure).toBe('indeterminate');
  });

  it('labels absorption when subsequent bids defend the ask cluster and price holds', () => {
    const read = readThreeCandleFootprint([
      candle(
        T,
        [
          { price: 100.5, buy: 8_000, sell: 6_000 },
          { price: 100, buy: 10_000, sell: 80_000 },
        ],
        { high: 100.5, low: 99.5, close: 100 },
      ),
      candle(T + 60, [{ price: 100, buy: 50_000, sell: 10_000 }], { high: 100.5, low: 100, close: 100.5 }),
      candle(T + 120, [{ price: 100, buy: 40_000, sell: 5_000 }], { high: 101, low: 100, close: 100.5 }),
    ]);
    expect(read?.askCluster).toMatchObject({ price: 100, t: T, ask: 80_000, bid: 10_000 });
    expect(read?.subsequentBid).toBe(90_000);
    expect(read?.subsequentAsk).toBe(15_000);
    expect(read?.defense).toBe('defended');
    expect(read?.structure).toBe('absorption');
  });

  it('labels absorption when price gaps up after the ask cluster', () => {
    const read = readThreeCandleFootprint([
      candle(T, [{ price: 100, buy: 5_000, sell: 80_000 }], { high: 100.5, low: 100, close: 100 }),
      candle(T + 60, [{ price: 101, buy: 20_000, sell: 5_000 }], { high: 101.5, low: 101, close: 101.5 }),
      candle(T + 120, [{ price: 101.5, buy: 15_000, sell: 5_000 }], { high: 102, low: 101.5, close: 102 }),
    ]);
    expect(read?.defense).toBe('defended');
    expect(read?.structure).toBe('absorption');
  });

  it('labels breakout when bids fail and price accepts below the cluster', () => {
    const read = readThreeCandleFootprint([
      candle(
        T,
        [
          { price: 102, buy: 10_000, sell: 5_000 },
          { price: 101, buy: 8_000, sell: 8_000 },
          { price: 100, buy: 5_000, sell: 80_000 },
        ],
        { high: 102, low: 100, close: 100 },
      ),
      candle(T + 60, [{ price: 99, buy: 8_000, sell: 20_000 }], { high: 99.5, low: 98.5, close: 99 }),
      candle(T + 120, [{ price: 98.5, buy: 5_000, sell: 15_000 }], { high: 99, low: 98, close: 98.5 }),
    ]);
    expect(read?.askCluster?.price).toBe(100);
    expect(read?.defense).toBe('collapsed');
    expect(read?.structure).toBe('breakout');
  });

  it('labels distribution when the ask cluster sits at the high and subsequent candles roll over while still overlapping', () => {
    const read = readThreeCandleFootprint([
      candle(
        T,
        [
          { price: 100.5, buy: 10_000, sell: 20_000 },
          { price: 100, buy: 20_000, sell: 15_000 },
        ],
        { high: 100.5, low: 100, close: 100.5 },
      ),
      candle(
        T + 60,
        [
          { price: 100.5, buy: 8_000, sell: 90_000 },
          { price: 100, buy: 10_000, sell: 15_000 },
        ],
        { high: 100.5, low: 100, close: 100 },
      ),
      candle(
        T + 120,
        [
          { price: 100.5, buy: 12_000, sell: 20_000 },
          { price: 100, buy: 15_000, sell: 25_000 },
        ],
        { high: 100.5, low: 99.5, close: 99.5 },
      ),
    ]);
    expect(read?.askCluster).toMatchObject({ price: 100.5, t: T + 60, ask: 90_000 });
    expect(read?.defense).toBe('collapsed');
    expect(read?.structure).toBe('distribution');
  });

  it('counts bid volume within one tick of the cluster', () => {
    const read = readThreeCandleFootprint([
      candle(T, [{ price: 100, buy: 5_000, sell: 80_000 }], { high: 100, low: 100, close: 100 }),
      candle(T + 60, [{ price: 100.5, buy: 40_000, sell: 5_000 }], { high: 100.5, low: 100, close: 100.5 }),
      candle(T + 120, [{ price: 99.5, buy: 20_000, sell: 4_000 }], { high: 100, low: 99.5, close: 100 }),
    ]);
    expect(read?.subsequentBid).toBe(60_000);
    expect(read?.defense).toBe('defended');
    expect(read?.structure).toBe('absorption');
  });
});

describe('three-candle attack momentum', () => {
  const T = T0 / 1000;

  function candle(
    time: number,
    buy: number,
    sell: number,
    ohlc: { open: number; close: number },
  ): FootprintBar {
    return {
      symbol: 'BTCUSDT',
      exchange: 'binance',
      market: 'perp',
      time,
      open: ohlc.open,
      high: Math.max(ohlc.open, ohlc.close),
      low: Math.min(ohlc.open, ohlc.close),
      close: ohlc.close,
      totalBuy: buy,
      totalSell: sell,
      trades: 1,
      levels: [{ price: ohlc.close, buy, sell }],
    };
  }

  it('is flat when fewer than 3 candles exist', () => {
    const m = readAttackMomentum([candle(T, 80, 20, { open: 100, close: 100.5 })]);
    expect(m.scores).toEqual([null, null, 60]);
    expect(m.state).toBe('flat');
  });

  it('is building when buy attack expands and price rises', () => {
    const m = readAttackMomentum([
      candle(T, 40_000, 60_000, { open: 100, close: 100 }),
      candle(T + 60, 55_000, 45_000, { open: 100, close: 100.5 }),
      candle(T + 120, 80_000, 20_000, { open: 100.5, close: 101.5 }),
    ]);
    expect(m.scores).toEqual([-20, 10, 60]);
    expect(m.priceFrom).toBe(100);
    expect(m.priceTo).toBe(101.5);
    expect(m.state).toBe('building');
    expect(m.implies).toMatch(/momentum_state = building/);
  });

  it('is building when sell attack expands and price falls', () => {
    const m = readAttackMomentum([
      candle(T, 60_000, 40_000, { open: 101, close: 101 }),
      candle(T + 60, 45_000, 55_000, { open: 101, close: 100.5 }),
      candle(T + 120, 20_000, 80_000, { open: 100.5, close: 99.5 }),
    ]);
    expect(m.scores).toEqual([20, -10, -60]);
    expect(m.state).toBe('building');
  });

  it('is diverging when buy attack expands but price does not follow', () => {
    const m = readAttackMomentum([
      candle(T, 55_000, 45_000, { open: 100, close: 100 }),
      candle(T + 60, 70_000, 30_000, { open: 100, close: 100 }),
      candle(T + 120, 85_000, 15_000, { open: 100, close: 99.5 }),
    ]);
    expect(m.scores[0]).toBe(10);
    expect(m.scores[2]).toBe(70);
    expect(m.state).toBe('diverging');
    expect(m.implies).toMatch(/momentum_state = diverging/);
  });

  it('is flat when attack and price barely change', () => {
    const m = readAttackMomentum([
      candle(T, 52_000, 48_000, { open: 100, close: 100 }),
      candle(T + 60, 51_000, 49_000, { open: 100, close: 100 }),
      candle(T + 120, 53_000, 47_000, { open: 100, close: 100 }),
    ]);
    expect(m.state).toBe('flat');
  });
});
