import { describe, expect, it } from 'vitest';
import { T0, book, bookLadder, engine, trade } from './helpers.js';
import { LiquidityTargetGenerator } from '../src/movement/liquidity-target-generator.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { LocalOrderBook } from '../src/liquidity/local-order-book.js';
import { LiquidityDepthEngine } from '../src/liquidity/liquidity-depth-engine.js';

describe('liquidity target generator', () => {
  it('builds percent/ATR grids for any price scale, not hardcoded BTC dollars', () => {
    const gen = new LiquidityTargetGenerator(DEFAULT_CONFIG.movePotential);
    const cheap = gen.prices(0.42, 0.01, 'UP');
    const rich = gen.prices(72_000, 400, 'UP');
    expect(cheap[0]).toBeGreaterThan(0.42);
    expect(cheap[cheap.length - 1]).toBeLessThan(0.42 * 1.05);
    expect(rich[0]).toBeGreaterThan(72_000);
    expect(rich[0]).toBeLessThan(72_000 * 1.01);
    expect(cheap.length).toBeGreaterThan(0);
    expect(rich.length).toBeGreaterThan(0);
  });
});

describe('liquidity depth engine', () => {
  it('accumulates ask notional to each upside target', () => {
    const depth = new LiquidityDepthEngine(DEFAULT_CONFIG.movePotential);
    const book = new LocalOrderBook();
    book.applySnapshot(
      bookLadder({
        timestamp: T0,
        mid: 100,
        bids: [{ price: 99.9, quote: 5_000_000 }],
        asks: [
          { price: 100.2, quote: 40_000_000 },
          { price: 100.8, quote: 90_000_000 },
          { price: 101.5, quote: 130_000_000 },
        ],
      }),
    );
    const map = depth.map(book, 100.2, 99.8);
    const first = map.upside[0];
    const last = map.upside[map.upside.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect(last!.cumulativeLiquidity).toBeGreaterThanOrEqual(first!.cumulativeLiquidity);
    expect(map.upside.some((t) => t.cumulativeLiquidity >= 40_000_000)).toBe(true);
  });
});

describe('Phase 1 Scenario A — thin asks + strong buying', () => {
  it('favors UP path with high nearby upside reachability', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    sym.ingestBookSnapshot(
      bookLadder({
        timestamp: T0,
        mid: 100,
        bids: [
          { price: 99.9, quote: 8_000_000 },
          { price: 99.5, quote: 12_000_000 },
          { price: 99.0, quote: 15_000_000 },
        ],
        asks: [
          { price: 100.1, quote: 80_000 },
          { price: 100.3, quote: 90_000 },
          { price: 100.6, quote: 100_000 },
          { price: 101.0, quote: 120_000 },
        ],
      }),
    );
    sym.ingestTrade(
      trade({
        timestamp: T0 + 10,
        price: 100.4,
        quoteValue: 8_000_000,
        side: 'BUY',
        tradeId: 1,
      }),
    );

    const snap = sym.snapshot('10s', T0 + 10);
    const mp = snap.movePotential;
    expect(mp.direction.direction).toBe('UP');
    expect(mp.pathOfLeastResistance).toBe('UP');
    expect(mp.movePotential.upsidePotential).toBeGreaterThan(mp.movePotential.downsidePotential);
    expect(mp.flow.buyPressureRatio).toBeGreaterThan(1);
    const near = mp.targets.upside[0];
    expect(near).toBeDefined();
    expect(near!.reachabilityScore).toBeGreaterThanOrEqual(55);
    expect(['VERY_EASY', 'EASY', 'MODERATE']).toContain(near!.difficulty);
    expect(mp.warnings.some((w) => /not guaranteed/i.test(w) || /buy flow is sufficient/i.test(w))).toBe(true);
  });
});

describe('Phase 1 Scenario F — balanced market', () => {
  it('stays BALANCED with moderate/low potential on both sides', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    sym.ingestBookSnapshot(
      bookLadder({
        timestamp: T0,
        mid: 100,
        bids: [
          { price: 99.9, quote: 5_000_000 },
          { price: 99.5, quote: 5_000_000 },
          { price: 99.0, quote: 5_000_000 },
        ],
        asks: [
          { price: 100.1, quote: 5_000_000 },
          { price: 100.5, quote: 5_000_000 },
          { price: 101.0, quote: 5_000_000 },
        ],
      }),
    );
    for (let i = 0; i < 8; i++) {
      sym.ingestTrade(
        trade({
          timestamp: T0 + i * 100,
          price: 100,
          quoteValue: 40_000,
          side: i % 2 === 0 ? 'BUY' : 'SELL',
          tradeId: i + 1,
        }),
      );
    }

    const snap = sym.snapshot('10s', T0 + 800);
    const mp = snap.movePotential;
    expect(mp.pathOfLeastResistance).toBe('BALANCED');
    expect(mp.direction.direction).toBe('NEUTRAL');
    expect(mp.movePotential.upsidePotential).toBeLessThan(70);
    expect(mp.movePotential.downsidePotential).toBeLessThan(70);
    expect(Math.abs(mp.movePotential.upsidePotential - mp.movePotential.downsidePotential)).toBeLessThan(20);
  });
});

describe('existing snapshot still includes move potential when book is a single level', () => {
  it('does not break legacy scenario A state classification', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    sym.ingestBookSnapshot(book({ timestamp: T0, mid: 100, askQuote: 400_000, bidQuote: 5_000_000 }));
    sym.ingestTrade(trade({ timestamp: T0 + 10, price: 102, quoteValue: 8_000_000, side: 'BUY', tradeId: 1 }));
    const snap = sym.snapshot('10s', T0 + 10);
    expect(snap.state).toBe('LARGE_BUY_FLOW');
    expect(snap.movePotential.currentPrice).toBeGreaterThan(0);
  });
});

function restAsks(size: number) {
  return [
    { price: 100.05, quote: size },
    { price: 100.12, quote: size },
    { price: 100.25, quote: size },
    { price: 100.50, quote: size },
  ];
}

function restBids() {
  return [
    { price: 99.9, quote: 5_000_000 },
    { price: 99.5, quote: 5_000_000 },
    { price: 99.0, quote: 5_000_000 },
  ];
}

describe('Phase 2 Scenario B — huge buying + replenishing asks', () => {
  it('treats refill as absorption risk and reduces upside reachability vs consumed asks', () => {
    const replenish = engine();
    const consume = engine();
    const a = replenish.getSymbol('BTCUSDT', 'perp');
    const b = consume.getSymbol('BTCUSDT', 'perp');

    a.ingestBookSnapshot(bookLadder({ timestamp: T0, mid: 100, bids: restBids(), asks: restAsks(5_000_000) }));
    b.ingestBookSnapshot(bookLadder({ timestamp: T0, mid: 100, bids: restBids(), asks: restAsks(5_000_000) }));

    for (let i = 0; i < 20; i++) {
      const ts = T0 + (i + 1) * 40;
      a.ingestTrade(trade({ timestamp: ts, price: 100, quoteValue: 8_000_000, side: 'BUY', tradeId: i + 1 }));
      b.ingestTrade(trade({ timestamp: ts, price: 100.05, quoteValue: 8_000_000, side: 'BUY', tradeId: i + 1 }));
      a.ingestBookSnapshot(
        bookLadder({
          timestamp: ts + 1,
          mid: 100,
          bids: restBids(),
          asks: restAsks(6_000_000 + i * 400_000),
        }),
      );
      b.ingestBookSnapshot(
        bookLadder({
          timestamp: ts + 1,
          mid: 100,
          bids: restBids(),
          asks: restAsks(Math.max(60_000, 5_000_000 - i * 240_000)),
        }),
      );
    }

    const abs = a.snapshot('10s', T0 + 20 * 40);
    const thru = b.snapshot('10s', T0 + 20 * 40);
    expect(abs.absorption.type).toBe('BUYER_ABSORPTION');
    expect(abs.movePotential.liquidity.askReplenishmentRate).toBeGreaterThan(abs.movePotential.liquidity.askConsumptionRate);
    expect(thru.movePotential.liquidity.askConsumptionRate).toBeGreaterThan(abs.movePotential.liquidity.askConsumptionRate);
    const absNear =
      abs.movePotential.targets.upside.find((t) => t.cumulativeLiquidity > 0)?.reachabilityScore ?? 0;
    const thruNear =
      thru.movePotential.targets.upside.find((t) => t.cumulativeLiquidity > 0)?.reachabilityScore ?? 0;
    expect(absNear).toBeLessThan(thruNear);
    expect(
      abs.movePotential.warnings.some((w) => /replenish/i.test(w) || /absorption/i.test(w)),
    ).toBe(true);
  });
});

describe('Phase 2 Scenario C — ask wall pulled', () => {
  it('flags ASK_LIQUIDITY_PULLED and increases upside reachability', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    const neighbors = [1_000_000, 1_200_000, 20_000_000, 1_100_000, 900_000];
    sym.ingestBookSnapshot(
      bookLadder({
        timestamp: T0,
        mid: 100,
        bids: [
          { price: 99.9, quote: 4_000_000 },
          { price: 99.5, quote: 4_000_000 },
        ],
        asks: neighbors.map((quote, i) => ({ price: 100.2 + i * 0.15, quote })),
      }),
    );
    const before = sym.snapshot('10s', T0);
    expect(before.movePotential.liquidity.events).toContain('ASK_WALL_DETECTED');
    expect(before.movePotential.liquidity.walls.some((w) => w.kind === 'ASK_LIQUIDITY_WALL' && w.status === 'ACTIVE')).toBe(true);

    sym.ingestTrade(trade({ timestamp: T0 + 20, price: 100.05, quoteValue: 200_000, side: 'BUY', tradeId: 1 }));
    sym.ingestBookSnapshot(
      bookLadder({
        timestamp: T0 + 21,
        mid: 100,
        bids: [
          { price: 99.9, quote: 4_000_000 },
          { price: 99.5, quote: 4_000_000 },
        ],
        asks: [
          { price: 100.2, quote: 1_000_000 },
          { price: 100.35, quote: 1_200_000 },
          { price: 100.65, quote: 1_100_000 },
          { price: 100.8, quote: 900_000 },
        ],
      }),
    );

    const after = sym.snapshot('10s', T0 + 21);
    expect(after.movePotential.liquidity.events).toContain('ASK_LIQUIDITY_PULLED');
    expect(after.movePotential.liquidity.askPullRate).toBeGreaterThan(0);
    const beforeNear = before.movePotential.targets.upside[0]?.reachabilityScore ?? 0;
    const afterNear = after.movePotential.targets.upside[0]?.reachabilityScore ?? 0;
    expect(afterNear).toBeGreaterThanOrEqual(beforeNear);
    expect(after.movePotential.warnings.some((w) => /pulled/i.test(w))).toBe(true);
  });
});

describe('Phase 2 liquidity vacuum', () => {
  it('flags a thin ask pocket after a thicker nearby band', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    sym.ingestBookSnapshot(
      bookLadder({
        timestamp: T0,
        mid: 100,
        bids: [{ price: 99.9, quote: 4_000_000 }],
        asks: [
          { price: 100.12, quote: 12_000_000 },
          { price: 101.8, quote: 80_000 },
        ],
      }),
    );
    const snap = sym.snapshot('10s', T0);
    expect(snap.movePotential.liquidity.events).toContain('UPSIDE_LIQUIDITY_VACUUM');
    expect(snap.movePotential.liquidity.vacuums.some((v) => v.kind === 'UPSIDE_LIQUIDITY_VACUUM')).toBe(true);
  });
});
