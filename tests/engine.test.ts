import { describe, expect, it } from 'vitest';
import { T0, book, engine, trade } from './helpers.js';

describe('tape, spot vs perp, liquidations, integrity', () => {
  it('filters the large-trade tape', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    sym.ingestBookSnapshot(book({ timestamp: T0, mid: 63000 }));
    sym.ingestTrade(trade({ timestamp: T0 + 1, price: 63010, quoteValue: 1_200_000, side: 'BUY', tradeId: 1 }));
    sym.ingestTrade(trade({ timestamp: T0 + 2, price: 63015, quoteValue: 4_800_000, side: 'BUY', tradeId: 2 }));
    sym.ingestTrade(trade({ timestamp: T0 + 3, price: 63012, quoteValue: 900_000, side: 'SELL', tradeId: 3 }));
    const buys = sym.queryTape({ side: 'BUY', minQuoteValue: 1_000_000 });
    expect(buys).toHaveLength(2);
    expect(sym.formatTape({ minQuoteValue: 1_000_000 })).toMatch(/BUY/);
  });

  it('keeps spot and perp deltas separate and exposes combined', () => {
    const of = engine();
    of.ingestTrade(trade({ symbol: 'BTCUSDT', marketType: 'spot', timestamp: T0, price: 100, quoteValue: 25_000_000, side: 'BUY', tradeId: 's1' }));
    of.ingestTrade(trade({ symbol: 'BTCUSDT', marketType: 'perp', timestamp: T0, price: 100, quoteValue: 310_000_000, side: 'SELL', tradeId: 'p1' }));
    const view = of.spotPerp('BTCUSDT', '10s', T0);
    expect(view.spot?.delta).toBe(25_000_000);
    expect(view.perp?.delta).toBe(-310_000_000);
    expect(view.combined?.delta).toBe(25_000_000 - 310_000_000);
  });

  it('tracks forced liquidation volume separately from discretionary flow', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    sym.ingestTrade(trade({ timestamp: T0, price: 100, quoteValue: 1_000_000, side: 'BUY', tradeId: 1 }));
    of.ingestLiquidation({
      symbol: 'BTCUSDT',
      marketType: 'perp',
      timestamp: T0 + 1,
      price: 100,
      quantity: 5_000,
      quoteValue: 500_000,
      side: 'BUY',
      type: 'SHORT_LIQUIDATION',
    });
    const snap = of.snapshot('BTCUSDT', 'perp', '10s', T0 + 1);
    expect(snap.forcedBuyVolume).toBe(500_000);
    expect(snap.aggressiveBuyVolume).toBe(1_500_000);
  });

  it('drops duplicate trade ids and lowers confidence after reconnect', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    const t = trade({ timestamp: T0, price: 100, quoteValue: 2_000_000, side: 'BUY', tradeId: 'dup' });
    sym.ingestTrade(t);
    sym.ingestTrade(t);
    expect(sym.snapshot('1s', T0).buyTradeCount).toBe(1);
    sym.noteReconnect(T0 + 10);
    const snap = sym.snapshot('1s', T0 + 10);
    expect(snap.confidence).toBeLessThan(0.7);
  });

  it('builds multi-window snapshots', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    for (let i = 0; i < 20; i++) {
      sym.ingestTrade(
        trade({ timestamp: T0 + i * 100, price: 100, quoteValue: 600_000, side: 'BUY', tradeId: i }),
      );
    }
    const multi = sym.multiWindow(T0 + 1_900);
    expect(multi.windows['1s']?.aggressiveBuyVolume).toBeGreaterThan(0);
    expect(multi.windows['5m']?.aggressiveBuyVolume).toBeGreaterThan(0);
  });
});
