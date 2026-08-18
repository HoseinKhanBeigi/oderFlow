import { describe, expect, it } from 'vitest';
import { T0, book, engine, trade } from './helpers.js';

describe('A. one massive buy', () => {
  it('labels LARGE_BUY_FLOW when a huge aggressive buy lifts price through thin asks', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    sym.ingestBookSnapshot(
      book({ timestamp: T0, mid: 100, askQuote: 400_000, bidQuote: 5_000_000 }),
    );
    sym.ingestTrade(
      trade({
        timestamp: T0 + 10,
        price: 102,
        quoteValue: 8_000_000,
        side: 'BUY',
        tradeId: 1,
      }),
    );

    const snap = sym.snapshot('10s', T0 + 10);
    expect(snap.aggressiveBuyVolume).toBe(8_000_000);
    expect(snap.largestBuy).toBe(8_000_000);
    expect(snap.priceChangePercent).toBeGreaterThan(0);
    expect(snap.state).toBe('LARGE_BUY_FLOW');
    expect(snap.absorption.detected).toBe(false);
  });
});

describe('B. many split buys', () => {
  it('detects BUY_BURST and persistent same-side flow', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    sym.seedFlowBaseline('BUY', Array.from({ length: 400 }, () => 40_000));
    sym.ingestBookSnapshot(book({ timestamp: T0, mid: 100 }));

    for (let i = 0; i < 100; i++) {
      const size = 100_000 + (i % 5) * 80_000;
      sym.ingestTrade(
        trade({
          timestamp: T0 + i * 50,
          price: 100 + i * 0.02,
          quoteValue: size,
          side: 'BUY',
          tradeId: i + 1,
        }),
      );
    }

    const snap = sym.snapshot('5s', T0 + 99 * 50);
    expect(snap.buyTradeCount).toBe(100);
    expect(snap.buyBurstDetected).toBe(true);
    expect(snap.persistentBuyFlow).toBe(true);
    expect(['BUY_BURST', 'PERSISTENT_BUY_FLOW']).toContain(snap.state);
  });
});

describe('C. huge buying but no movement', () => {
  it('classifies BUYER_ABSORPTION when delta is huge and price barely rises', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    const mid = 100;
    sym.ingestBookSnapshot(book({ timestamp: T0, mid, askQuote: 2_000_000, bidQuote: 2_000_000 }));

    for (let i = 0; i < 50; i++) {
      sym.ingestTrade(
        trade({
          timestamp: T0 + i * 20,
          price: 100.00,
          quoteValue: 10_000_000,
          side: 'BUY',
          tradeId: i + 1,
        }),
      );
      sym.ingestBookSnapshot(
        book({ timestamp: T0 + i * 20 + 1, mid, askQuote: 2_000_000, bidQuote: 2_000_000 }),
      );
    }

    const snap = sym.snapshot('10s', T0 + 49 * 20);
    expect(snap.delta).toBe(500_000_000);
    expect(Math.abs(snap.priceChangePercent)).toBeLessThan(0.05);
    expect(snap.absorption.detected).toBe(true);
    expect(snap.absorption.type).toBe('BUYER_ABSORPTION');
    expect(snap.state).toBe('BUYER_ABSORPTION');
    expect(snap.priceImpactEfficiency).toBe('LOW');
  });
});

describe('D. huge selling but no movement', () => {
  it('classifies SELLER_ABSORPTION when delta is hugely negative and price barely falls', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    const mid = 100;
    sym.ingestBookSnapshot(book({ timestamp: T0, mid, askQuote: 2_000_000, bidQuote: 2_000_000 }));

    for (let i = 0; i < 50; i++) {
      sym.ingestTrade(
        trade({
          timestamp: T0 + i * 20,
          price: 100.00,
          quoteValue: 10_000_000,
          side: 'SELL',
          tradeId: i + 1,
        }),
      );
      sym.ingestBookSnapshot(
        book({ timestamp: T0 + i * 20 + 1, mid, askQuote: 2_000_000, bidQuote: 2_000_000 }),
      );
    }

    const snap = sym.snapshot('10s', T0 + 49 * 20);
    expect(snap.delta).toBe(-500_000_000);
    expect(snap.absorption.detected).toBe(true);
    expect(snap.absorption.type).toBe('SELLER_ABSORPTION');
    expect(snap.state).toBe('SELLER_ABSORPTION');
  });
});

describe('E. moderate buying + thin liquidity', () => {
  it('labels LIQUIDITY_VACUUM_UP when moderate flow punches through thin asks', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    sym.seedFlowBaseline('BUY', Array.from({ length: 400 }, () => 8_000_000));
    sym.seedImpactBaseline(Array.from({ length: 40 }, () => 0.02));
    sym.ingestBookSnapshot(
      book({ timestamp: T0, mid: 100, askQuote: 80_000, bidQuote: 5_000_000 }),
    );

    let remaining = 20_000_000;
    let i = 0;
    while (remaining > 0) {
      const size = Math.min(200_000, remaining);
      sym.ingestTrade(
        trade({
          timestamp: T0 + i * 30,
          price: 100 + (i / 100) * 2,
          quoteValue: size,
          side: 'BUY',
          tradeId: i + 1,
        }),
      );
      remaining -= size;
      i += 1;
    }

    const lastTs = T0 + (i - 1) * 30;
    const snap = sym.snapshot('10s', lastTs);
    expect(snap.aggressiveBuyVolume).toBeCloseTo(20_000_000, 0);
    expect(snap.priceChangePercent).toBeGreaterThan(0.4);
    expect(snap.buyPressure).toBeGreaterThan(3);
    expect(snap.flowMultipleBuy).toBeLessThanOrEqual(2.5);
    expect(snap.state).toBe('LIQUIDITY_VACUUM_UP');
  });
});

describe('F. relative size BTC vs small alt', () => {
  it('does not treat the same notional as equally significant across assets', () => {
    const of = engine();
    const btc = of.getSymbol('BTCUSDT', 'perp');
    const alt = of.getSymbol('FARTCOINUSDT', 'perp');

    const btcSizes: number[] = [];
    for (let i = 0; i < 3_000; i++) {
      btcSizes.push(10_000 + (i / 3_000) * 20_000_000);
    }
    btc.seedTradeSizeBaseline(btcSizes);

    const altSizes: number[] = [];
    for (let i = 0; i < 3_000; i++) {
      altSizes.push(50 + (i / 3_000) * 5_000);
    }
    alt.seedTradeSizeBaseline(altSizes);

    const btcRel = btc.largeTrades.relativeSize(10_000_000);
    const altRel = alt.largeTrades.relativeSize(10_000_000);

    expect(altRel.vsMedian).toBeGreaterThan(btcRel.vsMedian * 10);
    expect(altRel.classification).toBe('EXTREME');
    expect(['NORMAL', 'LARGE']).toContain(btcRel.classification);
  });
});
