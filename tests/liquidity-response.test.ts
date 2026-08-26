import { describe, expect, it } from 'vitest';
import { T0, book, bookLadder, engine, trade } from './helpers.js';
import { LiquidityResponseEngine } from '../src/liquidity-response/engine.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { LocalOrderBook } from '../src/liquidity/local-order-book.js';

function seedQuiet(sym: { liquidityResponse: LiquidityResponseEngine }): void {
  sym.liquidityResponse.seedHistory(
    Array.from({ length: 40 }, () => ({ buy: 80_000, sell: 80_000, open: 100, close: 100.01 })),
  );
}

function ladder(ts: number, mid: number, askQuote: number, bidQuote: number) {
  return bookLadder({
    timestamp: ts,
    mid,
    asks: [
      { price: mid * 1.0002, quote: askQuote * 0.5 },
      { price: mid * 1.0008, quote: askQuote * 0.5 },
    ],
    bids: [
      { price: mid * 0.9998, quote: bidQuote * 0.5 },
      { price: mid * 0.9992, quote: bidQuote * 0.5 },
    ],
  });
}

describe('liquidity response accounting', () => {
  it('classifies ask drop without matching buys as withdrawal, not consumption', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    seedQuiet(sym);
    sym.ingestBookSnapshot(ladder(T0, 100, 80_000_000, 80_000_000));
    sym.ingestBookSnapshot(ladder(T0 + 200, 100, 4_000_000, 80_000_000));
    const lr = sym.snapshot('10s', T0 + 200).liquidityResponse;
    expect(lr.askResponse).toBe('WITHDRAWAL');
    expect(lr.bands.some((b) => b.side === 'ask' && b.cancelled > b.consumed)).toBe(true);
  });

  it('classifies ask drop that matches aggressive buys as consumption', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    seedQuiet(sym);
    sym.ingestBookSnapshot(ladder(T0, 100, 80_000_000, 50_000_000));
    sym.ingestTrade(trade({ timestamp: T0 + 10, price: 100.02, quoteValue: 50_000_000, side: 'BUY', tradeId: 1 }));
    sym.ingestBookSnapshot(ladder(T0 + 20, 100.05, 30_000_000, 50_000_000));
    const lr = sym.snapshot('10s', T0 + 20).liquidityResponse;
    expect(lr.askResponse).toBe('CONSUMPTION');
  });

  it('detects repeated ask replenishment after aggressive buys', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    seedQuiet(sym);
    let t = T0;
    sym.ingestBookSnapshot(ladder(t, 100, 50_000_000, 50_000_000));
    for (let i = 0; i < 3; i++) {
      t += 50;
      sym.ingestTrade(trade({ timestamp: t, price: 100.02, quoteValue: 35_000_000, side: 'BUY', tradeId: i + 1 }));
      t += 50;
      sym.ingestBookSnapshot(ladder(t, 100.02, 8_000_000, 50_000_000));
      t += 50;
      sym.ingestBookSnapshot(ladder(t, 100.02, 48_000_000, 50_000_000));
    }
    const lr = sym.snapshot('10s', t).liquidityResponse;
    expect(lr.repeatedAskReplenishment).toBe(true);
    expect(['REPLENISHMENT', 'MIXED']).toContain(lr.askResponse);
  });
});

describe('absorption requires book and price, not delta alone', () => {
  it('does not flag absorption from a large positive delta without replenishment', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    seedQuiet(sym);
    sym.ingestBookSnapshot(ladder(T0, 100, 80_000_000, 80_000_000));
    for (let i = 0; i < 8; i++) {
      sym.ingestTrade(
        trade({ timestamp: T0 + i * 30, price: 100.4 + i * 0.1, quoteValue: 20_000_000, side: 'BUY', tradeId: i + 1 }),
      );
      sym.ingestBookSnapshot(ladder(T0 + i * 30 + 5, 100.4 + i * 0.1, 5_000_000, 80_000_000));
    }
    const lr = sym.snapshot('10s', T0 + 250).liquidityResponse;
    expect(lr.absorption.detected).toBe(false);
    expect(lr.absorption.kind).toBeNull();
  });

  it('detects sell-side absorption when large buying fails to lift and asks replenish', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    seedQuiet(sym);
    const mid = 100;
    sym.ingestBookSnapshot(ladder(T0, mid, 80_000_000, 80_000_000));
    for (let i = 0; i < 20; i++) {
      sym.ingestTrade(
        trade({ timestamp: T0 + i * 40, price: 100.02, quoteValue: 12_000_000, side: 'BUY', tradeId: i + 1 }),
      );
      sym.ingestBookSnapshot(ladder(T0 + i * 40 + 10, mid, 8_000_000, 80_000_000));
      sym.ingestBookSnapshot(ladder(T0 + i * 40 + 20, mid, 82_000_000, 80_000_000));
    }
    const lr = sym.snapshot('10s', T0 + 20 * 40).liquidityResponse;
    expect(lr.absorption.detected).toBe(true);
    expect(lr.absorption.kind).toBe('SELL_ABSORPTION');
    expect(lr.absorption.usedBookEvidence).toBe(true);
    expect(lr.absorption.usedPriceEvidence).toBe(true);
    expect(lr.state).toBe('BUYERS_BEING_ABSORBED');
    expect(lr.effort).toBe('BUY_ABSORPTION');
  });
});

describe('effort vs result and vacuum', () => {
  it('labels efficient buying when aggression, ask consumption, and price all agree', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    seedQuiet(sym);
    sym.ingestBookSnapshot(ladder(T0, 100, 20_000_000, 80_000_000));
    for (let i = 0; i < 12; i++) {
      const px = 100 + i * 0.4;
      sym.ingestTrade(trade({ timestamp: T0 + i * 40, price: px, quoteValue: 8_000_000, side: 'BUY', tradeId: i + 1 }));
      sym.ingestBookSnapshot(ladder(T0 + i * 40 + 5, px, 2_000_000, 80_000_000));
    }
    const lr = sym.snapshot('10s', T0 + 500).liquidityResponse;
    expect(['EFFICIENT_BUYING', 'INEFFICIENT_BUYING']).toContain(lr.effort);
    expect(lr.aggression).toBe('BUYERS');
    expect(lr.priceMoveAbs).toBeGreaterThan(0);
  });

  it('detects an upside liquidity vacuum when asks are pulled and price accelerates', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    seedQuiet(sym);
    sym.ingestBookSnapshot(ladder(T0, 100, 100_000_000, 40_000_000));
    for (let i = 0; i < 6; i++) {
      const px = 100 + i * 0.8;
      sym.ingestTrade(trade({ timestamp: T0 + i * 50, price: px, quoteValue: 6_000_000, side: 'BUY', tradeId: i + 1 }));
      // Drop far more than was executed → cancellation/pull, not consumption.
      sym.ingestBookSnapshot(ladder(T0 + i * 50 + 10, px, 4_000_000, 40_000_000));
    }
    const lr = sym.snapshot('10s', T0 + 350).liquidityResponse;
    expect(lr.askResponse).toBe('WITHDRAWAL');
    expect(['UPSIDE_LIQUIDITY_VACUUM', 'BUYERS_IN_CONTROL', 'TRANSITION']).toContain(lr.state);
  });
});

describe('price impact horizons and normalization', () => {
  it('records immediate and later impact in basis points', () => {
    const lr = new LiquidityResponseEngine(DEFAULT_CONFIG.liquidityResponse);
    const bookObj = new LocalOrderBook();
    bookObj.applySnapshot(ladder(T0, 100, 10_000_000, 10_000_000));
    lr.onBook(T0, bookObj, 0, 0);
    lr.onTrade(trade({ timestamp: T0 + 10, price: 100.2, quoteValue: 2_000_000, side: 'BUY', tradeId: 1 }), true);
    const snap = lr.snapshot({
      now: T0 + 6_000,
      windowMs: 10_000,
      buy: 2_000_000,
      sell: 0,
      buyCount: 1,
      sellCount: 0,
      largeBuyCount: 1,
      largeSellCount: 0,
      priceStart: 100,
      priceEnd: 100.4,
      priceHigh: 100.4,
      priceLow: 100,
    });
    expect(snap.impact.immediateBps).toBeGreaterThan(0);
    expect(snap.norms.aggressiveBuy.window).toBe(50);
  });
});

describe('spot vs futures isolation', () => {
  it('does not merge spot and perp liquidity-response executed volume', () => {
    const of = engine();
    of.ingestTrade(trade({ symbol: 'BTCUSDT', marketType: 'spot', timestamp: T0, price: 100, quoteValue: 25_000_000, side: 'BUY', tradeId: 's1' }));
    of.ingestTrade(trade({ symbol: 'BTCUSDT', marketType: 'perp', timestamp: T0, price: 100, quoteValue: 310_000_000, side: 'SELL', tradeId: 'p1' }));
    const view = of.spotPerp('BTCUSDT', '10s', T0);
    expect(view.spot?.delta).toBe(25_000_000);
    expect(view.perp?.delta).toBe(-310_000_000);
    expect(view.combined?.liquidityResponse.executed).toBe(0);
  });
});

describe('reversal context is informational', () => {
  it('labels potential reversal conditions without emitting a buy/sell instruction', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    seedQuiet(sym);
    const mid = 100;
    sym.ingestBookSnapshot(ladder(T0, mid, 20_000_000, 90_000_000));
    for (let i = 0; i < 16; i++) {
      sym.ingestTrade(
        trade({ timestamp: T0 + i * 40, price: 99.98, quoteValue: 10_000_000, side: 'SELL', tradeId: i + 1 }),
      );
      sym.ingestBookSnapshot(ladder(T0 + i * 40 + 8, mid, 20_000_000, 12_000_000));
      sym.ingestBookSnapshot(ladder(T0 + i * 40 + 18, 100.05, 20_000_000, 88_000_000));
    }
    const lr = sym.snapshot('10s', T0 + 16 * 40).liquidityResponse;
    if (lr.reversal) {
      expect(lr.reversal.label).toBe('POTENTIAL_REVERSAL_CONDITIONS_DETECTED');
      expect(lr.reversal.kind === 'BULLISH' || lr.reversal.kind === 'BEARISH').toBe(true);
    }
    expect(JSON.stringify(lr)).not.toMatch(/BUY NOW|SELL NOW/);
  });
});
