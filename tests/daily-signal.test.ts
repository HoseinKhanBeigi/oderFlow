import { describe, expect, it } from 'vitest';
import { evaluateDailySignal } from '../src/analysis/daily-signal.js';
import { locate } from '../src/analysis/daily-levels.js';
import type { FootprintBar } from '../src/footprint/types.js';
import type { DailyLiquidityContext } from '../src/models/daily-signal.js';

const DAY = 86_400;
const T0 = 1_700_000_000;

function daily(over: Partial<FootprintBar> & { day: number }): FootprintBar {
  const open = over.open ?? 100;
  return {
    symbol: 'BTCUSDT',
    exchange: 'binance',
    market: 'perp',
    time: T0 + over.day * DAY,
    open,
    high: over.high ?? open + 8,
    low: over.low ?? open - 8,
    close: over.close ?? open + 2,
    totalBuy: over.totalBuy ?? 1_000_000,
    totalSell: over.totalSell ?? 1_000_000,
    trades: over.trades ?? 10,
    levels: over.levels ?? [],
  };
}

/** Rising daily series so prior-day low/high are usable S/R. */
function seriesWithPrior(prior: { low: number; high: number; close: number }, today: Partial<FootprintBar>): FootprintBar[] {
  const bars: FootprintBar[] = [];
  for (let i = 0; i < 9; i++) {
    const base = 90 + i * 2;
    bars.push(
      daily({
        day: i,
        open: base,
        high: base + 5,
        low: base - 2,
        close: base + 2,
        totalBuy: 2_000_000,
        totalSell: 1_200_000,
      }),
    );
  }
  bars.push(
    daily({
      day: 9,
      open: prior.low + 2,
      high: prior.high,
      low: prior.low,
      close: prior.close,
      totalBuy: 2_200_000,
      totalSell: 1_000_000,
    }),
  );
  bars.push(
    daily({
      day: 10,
      open: prior.close,
      high: today.high ?? prior.close + 2,
      low: today.low ?? prior.low,
      close: today.close ?? prior.close,
      totalBuy: today.totalBuy ?? 1_500_000,
      totalSell: today.totalSell ?? 1_500_000,
      levels: today.levels ?? [],
    }),
  );
  return bars;
}

const defendingBid: DailyLiquidityContext = {
  price: 109,
  pathOfLeastResistance: 'UP',
  nearbyAsk: 800_000,
  nearbyBid: 4_000_000,
  askConsumption: 0.4,
  bidConsumption: 0.1,
  walls: [{ kind: 'BID_LIQUIDITY_WALL', price: 108, status: 'ACTIVE', quoteValue: 8_000_000 }],
  vacuums: [{ kind: 'UPSIDE_LIQUIDITY_VACUUM', fromPrice: 110, toPrice: 116 }],
  absorptionType: 'SELLER_ABSORPTION',
};

describe('daily location', () => {
  it('treats price within a fraction of ATR as at the level', () => {
    expect(locate(100, 99.5, 110, 4)).toBe('AT_SUPPORT');
    expect(locate(109.8, 99, 110, 4)).toBe('AT_RESISTANCE');
    expect(locate(104.5, 99, 110, 4)).toBe('MID_RANGE');
    expect(locate(112, 99, 110, 4)).toBe('ABOVE_RESISTANCE');
    expect(locate(96, 99, 110, 4)).toBe('BELOW_SUPPORT');
  });
});

describe('daily signal', () => {
  it('stays WAIT until enough daily bars exist', () => {
    const sig = evaluateDailySignal({
      symbol: 'BTCUSDT',
      market: 'perp',
      bars: [daily({ day: 0 }), daily({ day: 1 })],
      price: 100,
    });
    expect(sig.bias).toBe('WAIT');
    expect(sig.setup).toBe('INSUFFICIENT');
  });

  it('leans LONG when selling is absorbed at daily support with bids defending', () => {
    const bars = seriesWithPrior(
      { low: 108, high: 120, close: 112 },
      {
        high: 111,
        low: 107.5,
        close: 110.4,
        totalBuy: 1_000_000,
        totalSell: 5_000_000,
        levels: [
          { price: 108, buy: 200_000, sell: 4_200_000 },
          { price: 110, buy: 800_000, sell: 800_000 },
        ],
      },
    );
    const sig = evaluateDailySignal({
      symbol: 'BTCUSDT',
      market: 'perp',
      bars,
      price: 109.2,
      liquidity: defendingBid,
      footprintComplete: true,
    });
    expect(sig.location).toBe('AT_SUPPORT');
    expect(sig.bias).toBe('LONG');
    expect(sig.setup).toBe('SUPPORT_HOLD');
    expect(sig.score).toBeGreaterThan(35);
    expect(sig.levels.support).not.toBeNull();
    expect(sig.evidence.some((e) => /absorbed|support|Bid wall/i.test(e))).toBe(true);
    expect(sig.plan.entry).toBeLessThan(109.2);
    expect(sig.plan.entry).toBeGreaterThan(107);
    expect(sig.plan.entryMode).toBe('WAIT_FOR_LEVEL');
    expect(sig.plan.tp1).toBeCloseTo((sig.plan.entry ?? 0) * 1.01, 4);
    expect(sig.plan.tp2).toBeCloseTo((sig.plan.entry ?? 0) * 1.02, 4);
    expect(sig.plan.sl).toBeLessThan(sig.plan.entry ?? 109);
    expect(sig.plan.entryWhy).toMatch(/support|bid wall/i);
  });

  it('leans SHORT when buying is absorbed at daily resistance', () => {
    const bars = seriesWithPrior(
      { low: 100, high: 118, close: 116 },
      {
        high: 118.4,
        low: 114,
        close: 115.1,
        totalBuy: 6_000_000,
        totalSell: 900_000,
        levels: [
          { price: 118, buy: 5_000_000, sell: 200_000 },
          { price: 115, buy: 1_000_000, sell: 700_000 },
        ],
      },
    );
    const sig = evaluateDailySignal({
      symbol: 'BTCUSDT',
      market: 'perp',
      bars,
      price: 117.6,
      liquidity: {
        price: 117.6,
        pathOfLeastResistance: 'DOWN',
        nearbyAsk: 5_000_000,
        nearbyBid: 600_000,
        askConsumption: 0.1,
        bidConsumption: 0.5,
        walls: [{ kind: 'ASK_LIQUIDITY_WALL', price: 118, status: 'ACTIVE', quoteValue: 9_000_000 }],
        vacuums: [{ kind: 'DOWNSIDE_LIQUIDITY_VACUUM', fromPrice: 112, toPrice: 116 }],
        absorptionType: 'BUYER_ABSORPTION',
      },
      footprintComplete: true,
    });
    expect(sig.location).toBe('AT_RESISTANCE');
    expect(sig.bias).toBe('SHORT');
    expect(sig.setup).toBe('RESISTANCE_REJECT');
    expect(sig.score).toBeLessThan(-35);
  });

  it('stays WAIT in a mid-range with mixed flow', () => {
    const bars = seriesWithPrior(
      { low: 100, high: 124, close: 112 },
      {
        high: 114,
        low: 110,
        close: 112.2,
        totalBuy: 1_500_000,
        totalSell: 1_450_000,
      },
    );
    const sig = evaluateDailySignal({
      symbol: 'BTCUSDT',
      market: 'perp',
      bars,
      price: 112,
      liquidity: {
        price: 112,
        pathOfLeastResistance: 'BALANCED',
        nearbyAsk: 2_000_000,
        nearbyBid: 2_000_000,
        askConsumption: 0.2,
        bidConsumption: 0.2,
        walls: [],
        vacuums: [],
        absorptionType: null,
      },
    });
    expect(sig.bias).toBe('WAIT');
    expect(['MID_RANGE', 'FLOW_CONTINUATION']).toContain(sig.setup);
  });

  it('does not chase mid-range price — LONG waits for support', () => {
    const bars = seriesWithPrior(
      { low: 100, high: 124, close: 112 },
      {
        high: 114,
        low: 110,
        close: 113,
        totalBuy: 6_000_000,
        totalSell: 1_200_000,
      },
    );
    const sig = evaluateDailySignal({
      symbol: 'BTCUSDT',
      market: 'perp',
      bars,
      price: 113,
      liquidity: {
        price: 113,
        pathOfLeastResistance: 'UP',
        nearbyAsk: 700_000,
        nearbyBid: 4_000_000,
        askConsumption: 0.5,
        bidConsumption: 0.1,
        walls: [{ kind: 'BID_LIQUIDITY_WALL', price: 111.4, status: 'ACTIVE', quoteValue: 8_000_000 }],
        vacuums: [{ kind: 'UPSIDE_LIQUIDITY_VACUUM', fromPrice: 114, toPrice: 118 }],
        absorptionType: null,
      },
      footprintComplete: true,
    });
    expect(sig.bias).toBe('LONG');
    expect(sig.plan.entry).not.toBeNull();
    expect(sig.plan.entry).toBeLessThan(113);
    expect(sig.plan.entryMode).toBe('WAIT_FOR_LEVEL');
    expect(sig.plan.entryWhy).toMatch(/wait|support|bid wall|POC|node/i);
  });
});
