import { describe, expect, it } from 'vitest';
import { T0, book, engine, trade } from './helpers.js';

describe('passive vs aggressive winner', () => {
  it('does not call +delta a buyer win when asks replenish and price is flat', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    const mid = 100;
    sym.ingestBookSnapshot(book({ timestamp: T0, mid, askQuote: 8_000_000, bidQuote: 8_000_000 }));

    for (let i = 0; i < 40; i++) {
      sym.ingestTrade(
        trade({
          timestamp: T0 + i * 40,
          price: 100.02,
          quoteValue: 8_000_000,
          side: 'BUY',
          tradeId: i + 1,
        }),
      );
      sym.ingestBookSnapshot(
        book({ timestamp: T0 + i * 40 + 1, mid, askQuote: 8_000_000, bidQuote: 8_000_000 }),
      );
    }

    const snap = sym.snapshot('10s', T0 + 39 * 40);
    expect(snap.delta).toBeGreaterThan(50_000_000);
    expect(snap.flowBattle.metrics.passiveSellExecutedVolume).toBe(snap.aggressiveBuyVolume);
    expect(snap.flowBattle.winner.winner).toBe('PASSIVE_SELLERS');
    expect(snap.flowBattle.state).toMatch(/BUYERS_ABSORBED|PASSIVE_SELLERS_DEFENDING/);
    expect(snap.flowBattle.battle.passiveSellerStrength).toBeGreaterThan(
      snap.flowBattle.battle.aggressiveBuyerStrength,
    );
  });

  it('calls aggressive buyers the winner when asks are consumed and price lifts', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    let ask = 6_000_000;
    sym.ingestBookSnapshot(book({ timestamp: T0, mid: 100, askQuote: ask, bidQuote: 6_000_000 }));

    for (let i = 0; i < 12; i++) {
      sym.ingestTrade(
        trade({
          timestamp: T0 + i * 80,
          price: 100 + i * 0.35,
          quoteValue: 2_500_000,
          side: 'BUY',
          tradeId: i + 1,
        }),
      );
      ask = Math.max(80_000, ask - 2_400_000);
      sym.ingestBookSnapshot(
        book({
          timestamp: T0 + i * 80 + 1,
          mid: 100 + i * 0.35,
          askQuote: ask,
          bidQuote: 6_000_000,
        }),
      );
    }

    const snap = sym.snapshot('10s', T0 + 11 * 80);
    expect(snap.delta).toBeGreaterThan(0);
    expect(snap.priceChangePercent).toBeGreaterThan(0.2);
    expect(snap.flowBattle.winner.winner).toBe('AGGRESSIVE_BUYERS');
    expect(snap.flowBattle.state).toBe('BUYERS_BREAKING_ASKS');
  });

  it('does not call -delta a seller win when bids replenish and price holds', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    const mid = 100;
    sym.ingestBookSnapshot(book({ timestamp: T0, mid, askQuote: 8_000_000, bidQuote: 8_000_000 }));

    for (let i = 0; i < 40; i++) {
      sym.ingestTrade(
        trade({
          timestamp: T0 + i * 40,
          price: 99.98,
          quoteValue: 8_000_000,
          side: 'SELL',
          tradeId: i + 1,
        }),
      );
      sym.ingestBookSnapshot(
        book({ timestamp: T0 + i * 40 + 1, mid, askQuote: 8_000_000, bidQuote: 8_000_000 }),
      );
    }

    const snap = sym.snapshot('10s', T0 + 39 * 40);
    expect(snap.delta).toBeLessThan(-50_000_000);
    expect(snap.flowBattle.metrics.passiveBuyExecutedVolume).toBe(snap.aggressiveSellVolume);
    expect(snap.flowBattle.winner.winner).toBe('PASSIVE_BUYERS');
    expect(snap.flowBattle.state).toMatch(/SELLERS_ABSORBED|PASSIVE_BUYERS_DEFENDING/);
  });

  it('stays balanced when both sides are moderate', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    sym.ingestBookSnapshot(book({ timestamp: T0, mid: 100 }));
    sym.ingestTrade(trade({ timestamp: T0 + 10, price: 100.01, quoteValue: 80_000, side: 'BUY', tradeId: 1 }));
    sym.ingestTrade(trade({ timestamp: T0 + 20, price: 99.99, quoteValue: 70_000, side: 'SELL', tradeId: 2 }));
    const snap = sym.snapshot('10s', T0 + 20);
    expect(snap.flowBattle.winner.winner).toBe('BALANCED');
    expect(snap.flowBattle.state).toBe('BALANCED_AUCTION');
  });
});

describe('passive liquidity trade matching', () => {
  it('records consumption when a depth reduction follows its trade by several hundred milliseconds', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    sym.ingestBookSnapshot(book({ timestamp: T0, mid: 100, askQuote: 1_000_000 }));
    sym.ingestTrade(trade({
      timestamp: T0 + 100,
      price: 100.1,
      quoteValue: 100_000,
      side: 'BUY',
      tradeId: 'delayed-depth',
    }));
    sym.ingestBookSnapshot(book({ timestamp: T0 + 600, mid: 100, askQuote: 900_000 }));

    const snap = sym.passiveLiquidity.snapshot({ now: T0 + 600 });
    expect(snap.ask.consumedNotional).toBeCloseTo(100_000, -2);
    expect(snap.ask.cancelledNotional).toBe(0);
  });

  it('records consumption when the trade arrives after the depth reduction', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    sym.ingestBookSnapshot(book({ timestamp: T0, mid: 100, askQuote: 1_000_000 }));
    sym.ingestBookSnapshot(book({ timestamp: T0 + 100, mid: 100, askQuote: 900_000 }));
    sym.ingestTrade(trade({
      timestamp: T0 + 600,
      price: 100.1,
      quoteValue: 100_000,
      side: 'BUY',
      tradeId: 'delayed-trade',
    }));

    const snap = sym.passiveLiquidity.snapshot({ now: T0 + 600 });
    expect(snap.ask.consumedNotional).toBeCloseTo(100_000, -2);
    expect(snap.ask.cancelledNotional).toBe(0);
  });
});
