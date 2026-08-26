import { describe, expect, it } from 'vitest';
import { T0, bookLadder, engine, trade } from './helpers.js';
import { LiquidityResponseEngine } from '../src/liquidity-response/engine.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { LocalOrderBook } from '../src/liquidity/local-order-book.js';
import { emptyLiquidityResponse } from '../src/liquidity-response/empty.js';
import { compareLiquidityMarkets } from '../src/liquidity-response/compare.js';
import { interpretOi } from '../src/liquidity-response/oi-context.js';
import { confidenceScore } from '../src/liquidity-response/confidence-score.js';
import { classifyEntry } from '../src/liquidity-response/entry-context.js';
import { emptyStructure } from '../src/liquidity-response/structure.js';
import { validateConsistency } from '../src/liquidity-response/consistency.js';
import { classifyChangeState, consumptionRatio } from '../src/liquidity-response/side-response.js';
import { classifyMarketMechanics } from '../src/liquidity-response/mechanics.js';

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
    expect(lr.entryContext).not.toBe('SHORT_CONFIRMATION');
    expect(lr.entryContext).not.toBe('LONG_CONFIRMATION');
  });
});

describe('cross-market confirmation and confidence', () => {
  it('does not emit Spot confirmation on a single-market snapshot', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    seedQuiet(sym);
    sym.ingestBookSnapshot(ladder(T0, 100, 80_000_000, 80_000_000));
    const lr = sym.snapshot('10s', T0).liquidityResponse;
    expect(lr.compare).toBeNull();
    expect(lr.why.some((f) => /spot confirmation/i.test(f.label))).toBe(false);
    expect(JSON.stringify(lr.why)).not.toMatch(/Spot confirmation/);
  });

  it('does not call buyers in control from a positive delta alone', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    seedQuiet(sym);
    sym.ingestBookSnapshot(ladder(T0, 100, 80_000_000, 80_000_000));
    for (let i = 0; i < 8; i++) {
      sym.ingestTrade(
        trade({ timestamp: T0 + i * 30, price: 100, quoteValue: 15_000_000, side: 'BUY', tradeId: i + 1 }),
      );
    }
    const lr = sym.snapshot('10s', T0 + 250).liquidityResponse;
    expect(lr.delta).toBeGreaterThan(0);
    expect(lr.state).not.toBe('BUYERS_IN_CONTROL');
    expect(lr.entryContext).toBe('NO_ENTRY');
  });

  it('labels NO_DIRECTIONAL_EDGE when aggression, delta, and book are unremarkable', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    seedQuiet(sym);
    sym.ingestBookSnapshot(ladder(T0, 100, 80_000_000, 80_000_000));
    sym.ingestTrade(trade({ timestamp: T0 + 10, price: 100.01, quoteValue: 80_000, side: 'BUY', tradeId: 1 }));
    sym.ingestTrade(trade({ timestamp: T0 + 20, price: 99.99, quoteValue: 80_000, side: 'SELL', tradeId: 2 }));
    const lr = sym.snapshot('10s', T0 + 30).liquidityResponse;
    expect(['NO_DIRECTIONAL_EDGE', 'BALANCED']).toContain(lr.state);
    expect(lr.confidence).toBe('LOW');
    expect(lr.confidenceScore).toBeLessThan(40);
  });

  it('classifies broad buying when spot and futures buyers agree', () => {
    const spot = emptyLiquidityResponse();
    spot.aggression = 'BUYERS';
    spot.state = 'BUYERS_IN_CONTROL';
    spot.delta = 10_000_000;
    spot.executed = 12_000_000;
    spot.efficiency = 'HIGH';
    spot.cvdDirection = 'UP';
    const fut = emptyLiquidityResponse();
    fut.aggression = 'BUYERS';
    fut.state = 'BUYERS_IN_CONTROL';
    fut.delta = 40_000_000;
    fut.executed = 50_000_000;
    fut.efficiency = 'HIGH';
    fut.cvdDirection = 'UP';
    fut.priceMovePercent = 0.2;
    const cmp = compareLiquidityMarkets(spot, {
      snapshot: fut,
      oiChangePercent: 1.2,
      forcedBuyVolume: 0,
      forcedSellVolume: 0,
    });
    expect(cmp?.relation).toBe('BROAD_BUYING');
    expect(cmp?.confirmed).toBe(true);
  });

  it('uses OI as likely context, not a fact', () => {
    expect(
      interpretOi({ priceChangePercent: 0.4, futuresDelta: 10, oiChangePercent: 1.2, threshold: 0.05 }),
    ).toBe('LIKELY_NEW_LONGS');
    expect(
      interpretOi({ priceChangePercent: 0.4, futuresDelta: 10, oiChangePercent: -1.2, threshold: 0.05 }),
    ).toBe('LIKELY_SHORT_COVERING');
    expect(
      interpretOi({ priceChangePercent: -0.4, futuresDelta: -10, oiChangePercent: 1.2, threshold: 0.05 }),
    ).toBe('LIKELY_NEW_SHORTS');
    expect(
      interpretOi({ priceChangePercent: -0.4, futuresDelta: -10, oiChangePercent: -1.2, threshold: 0.05 }),
    ).toBe('LIKELY_LONG_UNWIND');
  });

  it('treats short covering as dominated when OI falls and short liquidations are large', () => {
    const spot = emptyLiquidityResponse();
    spot.aggression = 'BALANCED';
    const fut = emptyLiquidityResponse();
    fut.aggression = 'BUYERS';
    fut.delta = 80_000_000;
    fut.executed = 90_000_000;
    fut.priceMovePercent = 0.5;
    fut.cvdDirection = 'UP';
    const cmp = compareLiquidityMarkets(spot, {
      snapshot: fut,
      oiChangePercent: -1.4,
      forcedBuyVolume: 25_000_000,
      forcedSellVolume: 1_000_000,
    });
    expect(cmp?.relation).toBe('SHORT_COVERING_DOMINATED');
  });

  it('never promotes absorption alone into a confirmed entry', () => {
    const ctx = classifyEntry({
      state: 'BUYERS_BEING_ABSORBED',
      absorption: {
        detected: true,
        kind: 'SELL_ABSORPTION',
        absorbingSide: 'PASSIVE_SELLER',
        strength: 0.8,
        usedBookEvidence: true,
        usedPriceEvidence: true,
      },
      structure: emptyStructure(),
      effort: 'BUY_ABSORPTION',
      aggression: 'BUYERS',
      delta: 10_000_000,
      priceMovePercent: 0.02,
      efficiency: 'LOW',
      askReplenishment: 'EXTREME',
      bidReplenishment: 'LOW',
      cvdDirection: 'UP',
      reversal: null,
      spotDeltaTurnsPositive: false,
      spotDeltaTurnsNegative: false,
    });
    expect(ctx).not.toBe('SHORT_CONFIRMATION');
    expect(['SHORT_SETUP_FORMING', 'NO_ENTRY']).toContain(ctx);
  });

  it('caps confidence at MEDIUM when data quality is below the high-confidence threshold', () => {
    const input = {
      buy: 1,
      sell: 1,
      delta: 0,
      priceStart: 100,
      priceEnd: 100,
      priceHigh: 100,
      priceLow: 100,
      atr: 1,
      nearAskShare: 0,
      nearBidShare: 0,
      book: {
        ask: { initial: 1, added: 0, cancelled: 0, consumed: 0, remaining: 1, replenishEvents: 0, response: 'QUIET' as const },
        bid: { initial: 1, added: 0, cancelled: 0, consumed: 0, remaining: 1, replenishEvents: 0, response: 'QUIET' as const },
        spreadBps: 1,
        spreadDeltaBps: 0,
        askDepthChange: 0,
        bidDepthChange: 0,
        bandWalked: false,
        resetRecent: false,
        primed: true,
        hasValidPrevious: true,
      },
      buyPct: 95,
      sellPct: 20,
      deltaPct: 90,
      movePct: 90,
      absEffPct: 20,
      askConsPct: 90,
      askReplPct: 10,
      askPullPct: 80,
      bidConsPct: 20,
      bidReplPct: 20,
      bidPullPct: 20,
      repeatedAsk: false,
      repeatedBid: false,
      hasBook: true,
      ticks: 40,
    };
    const conf = confidenceScore(DEFAULT_CONFIG.liquidityResponse, {
      input,
      state: 'BUYERS_IN_CONTROL',
      dataQuality: 20,
      persisted: true,
      fadedImpact: false,
      cvdAligned: true,
      bookClear: true,
      crossAgree: true,
    });
    expect(conf.score).toBeLessThan(70);
    expect(conf.label).not.toBe('HIGH');
  });
});

describe('WHY percentiles, liquidity change, and mechanics', () => {
  it('describes delta with direction plus absolute magnitude percentile, not a signed percentile', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    seedQuiet(sym);
    sym.ingestBookSnapshot(ladder(T0, 100, 80_000_000, 80_000_000));
    for (let i = 0; i < 6; i++) {
      sym.ingestTrade(
        trade({ timestamp: T0 + 20 + i * 10, price: 99.9, quoteValue: 2_000_000, side: 'SELL', tradeId: i + 1 }),
      );
    }
    const lr = sym.snapshot('10s', T0 + 100).liquidityResponse;
    expect(lr.deltaAnalysis.direction).toBe('SELL');
    expect(lr.deltaAnalysis.delta).toBeLessThan(0);
    expect(lr.why.some((f) => /negative delta/i.test(f.label))).toBe(false);
    expect(lr.why.some((f) => f.label === 'Delta' && /SELL/i.test(f.value))).toBe(true);
  });

  it('does not display -100% ask change after an order-book reset', () => {
    const of = engine();
    const sym = of.getSymbol('BTCUSDT', 'perp');
    seedQuiet(sym);
    sym.ingestBookSnapshot(ladder(T0, 100, 80_000_000, 80_000_000));
    sym.liquidityResponse.noteReset(T0 + 50);
    sym.ingestBookSnapshot(ladder(T0 + 80, 100, 1_000, 80_000_000));
    const lr = sym.snapshot('10s', T0 + 80).liquidityResponse;
    expect(lr.askDepth.changePercent).toBeNull();
    expect(lr.askDepth.changeReason).toBe('ORDER_BOOK_DATA_RESET');
    expect(JSON.stringify(lr.why)).not.toMatch(/-100%/);
    expect(lr.askDepth.changeState).toBe('UNKNOWN');
  });

  it('rejects an unexplained 80%+ drop when consumption and withdrawal are both normal', () => {
    const cfg = DEFAULT_CONFIG.liquidityResponse;
    const result = validateConsistency(cfg, {
      flags: [],
      bookEmpty: false,
      lastBookAgeMs: 200,
      lastTradeAgeMs: 200,
      ask: { changePercent: -100, consumption: 'NORMAL', withdrawal: 'NORMAL' },
      bid: { changePercent: 0, consumption: 'NORMAL', withdrawal: 'NORMAL' },
      snapshotContinuous: true,
      tradeBookReconciled: true,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('UNEXPLAINED_ASK_LIQUIDITY_DROP');
    expect(result.score).toBeLessThan(60);
  });

  it('splits removal into consumption vs withdrawal using executed vs cancelled', () => {
    expect(consumptionRatio(85, 15)).toBeCloseTo(0.85, 5);
    expect(classifyChangeState(
      { initial: 100, added: 0, cancelled: 80, consumed: 20, remaining: 0, replenishEvents: 0, response: 'WITHDRAWAL' },
      -100,
    )).toBe('WITHDRAWAL_DOMINATED');
    expect(classifyChangeState(
      { initial: 100, added: 0, cancelled: 15, consumed: 85, remaining: 0, replenishEvents: 0, response: 'CONSUMPTION' },
      -100,
    )).toBe('CONSUMPTION_DOMINATED');
  });

  it('classifies liquidity-driven up when buying is weak and asks are withdrawn', () => {
    expect(
      classifyMarketMechanics({
        buyPct: 28,
        sellPct: 41,
        delta: -7_000,
        movePct: 84,
        priceMovePercent: 0.42,
        ask: {
          current: 42_000_000,
          currentPercentile: 31,
          changePercent: -68,
          changeReason: null,
          consumed: 8_000_000,
          cancelled: 60_000_000,
          replenished: 2_000_000,
          removed: 68_000_000,
          consumptionRatio: 8 / 68,
          changeState: 'WITHDRAWAL_DOMINATED',
          sideState: 'ASKS_BEING_WITHDRAWN',
        },
        bid: emptyLiquidityResponse().bidDepth,
        bands: DEFAULT_CONFIG.liquidityResponse.percentileBands,
      }),
    ).toBe('LIQUIDITY_DRIVEN_UP');
  });

  it('classifies buyer absorption when aggressive buying is extreme and asks replenish', () => {
    expect(
      classifyMarketMechanics({
        buyPct: 96,
        sellPct: 30,
        delta: 500_000_000,
        movePct: 22,
        priceMovePercent: 0.03,
        ask: {
          current: 90_000_000,
          currentPercentile: 80,
          changePercent: 12,
          changeReason: null,
          consumed: 40_000_000,
          cancelled: 5_000_000,
          replenished: 55_000_000,
          removed: 45_000_000,
          consumptionRatio: 40 / 45,
          changeState: 'REPLENISHMENT_DOMINATED',
          sideState: 'PASSIVE_SELLERS_DEFENDING',
        },
        bid: emptyLiquidityResponse().bidDepth,
        bands: DEFAULT_CONFIG.liquidityResponse.percentileBands,
      }),
    ).toBe('BUYER_ABSORPTION');
  });

  it('classifies flow-driven up when aggressive buying consumes asks and price displaces', () => {
    expect(
      classifyMarketMechanics({
        buyPct: 91,
        sellPct: 20,
        delta: 310_000_000,
        movePct: 92,
        priceMovePercent: 0.55,
        ask: {
          current: 12_000_000,
          currentPercentile: 20,
          changePercent: -40,
          changeReason: null,
          consumed: 70_000_000,
          cancelled: 20_000_000,
          replenished: 8_000_000,
          removed: 90_000_000,
          consumptionRatio: 70 / 90,
          changeState: 'CONSUMPTION_DOMINATED',
          sideState: 'PASSIVE_SELLERS_FAILING',
        },
        bid: emptyLiquidityResponse().bidDepth,
        bands: DEFAULT_CONFIG.liquidityResponse.percentileBands,
      }),
    ).toBe('FLOW_DRIVEN_UP');
  });

  it('blocks HIGH confidence when data consistency is below 60', () => {
    const input = {
      buy: 1,
      sell: 0,
      delta: 1,
      priceStart: 100,
      priceEnd: 101,
      priceHigh: 101,
      priceLow: 100,
      atr: 1,
      nearAskShare: 0,
      nearBidShare: 0,
      book: {
        ask: { initial: 1, added: 0, cancelled: 0, consumed: 1, remaining: 0, replenishEvents: 0, response: 'CONSUMPTION' as const },
        bid: { initial: 1, added: 0, cancelled: 0, consumed: 0, remaining: 1, replenishEvents: 0, response: 'QUIET' as const },
        spreadBps: 1,
        spreadDeltaBps: 0,
        askDepthChange: -1,
        bidDepthChange: 0,
        bandWalked: false,
        resetRecent: false,
        primed: true,
        hasValidPrevious: true,
      },
      buyPct: 95,
      sellPct: 10,
      deltaPct: 90,
      movePct: 90,
      absEffPct: 20,
      askConsPct: 90,
      askReplPct: 10,
      askPullPct: 10,
      bidConsPct: 20,
      bidReplPct: 20,
      bidPullPct: 20,
      repeatedAsk: false,
      repeatedBid: false,
      hasBook: true,
      ticks: 40,
    };
    const conf = confidenceScore(DEFAULT_CONFIG.liquidityResponse, {
      input,
      state: 'BUYERS_IN_CONTROL',
      dataQuality: 90,
      persisted: true,
      fadedImpact: false,
      cvdAligned: true,
      bookClear: true,
      crossAgree: true,
      dataConsistency: 40,
    });
    expect(conf.score).toBeLessThan(70);
    expect(conf.label).not.toBe('HIGH');
  });
});
