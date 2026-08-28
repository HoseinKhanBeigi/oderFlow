import { describe, expect, it } from 'vitest';
import { OrderBookSimulationEngine } from '../src/simulation/order-book-engine.js';
import { MarketSimulationEngine } from '../src/simulation/market-simulation-engine.js';
import { ScenarioEngine } from '../src/simulation/scenario-engine.js';
import { ReplayEngine } from '../src/simulation/replay-engine.js';
import { SeededRng } from '../src/simulation/prng.js';
import { CrossMarketSimulationEngine, classifyCross } from '../src/simulation/cross-market-engine.js';
import { OpenInterestEngine, FundingEngine } from '../src/simulation/oi-funding.js';
import { CalibrationStore, defaultCalibration, validateImpact } from '../src/simulation/calibration.js';
import type { SimulationEvent } from '../src/simulation/events.js';
import { SimulationClock } from '../src/simulation/clock.js';
import { candlesFromStates, formingBarSnapshots, closedHistory, nextBarTime, scaleFromHistory, emptyBar } from '../simulator/sim-candles.js';
import { pathsFromFlow, readFlow } from '../simulator/flow-paths.js';

function btcBook() {
  return {
    price: 79_100,
    asks: [
      { price: 79_150, quote: 30_000_000 },
      { price: 79_200, quote: 40_000_000 },
      { price: 79_250, quote: 50_000_000 },
    ],
    bids: [
      { price: 79_050, quote: 60_000_000 },
      { price: 79_000, quote: 100_000_000 },
      { price: 78_950, quote: 180_000_000 },
    ],
  };
}

describe('order book consumption', () => {
  it('walks asks across multiple levels and partial-fills the last', () => {
    const book = new OrderBookSimulationEngine({ tickSize: 50, price: 79_100 });
    book.seedLadder(btcBook());
    const walk = book.consumeAsks(100_000_000);
    expect(walk.filled).toBe(100_000_000);
    expect(walk.leftover).toBe(0);
    expect(walk.levelsCleared).toBe(2);
    expect(walk.fills.map((f) => f.consumed)).toEqual([30_000_000, 40_000_000, 30_000_000]);
    expect(walk.fills[2]?.remainingAtLevel).toBe(20_000_000);
    expect(book.price).toBe(79_250);
    expect(book.bestAsk()?.price).toBe(79_250);
    expect(book.bestAsk()?.restingLiquidity).toBe(20_000_000);
  });

  it('walks bids for aggressive sells', () => {
    const book = new OrderBookSimulationEngine({ tickSize: 50, price: 79_100 });
    book.seedLadder(btcBook());
    const walk = book.consumeBids(80_000_000);
    expect(walk.fills[0]?.price).toBe(79_050);
    expect(walk.levelsCleared).toBe(1);
    expect(book.price).toBe(79_000);
    expect(book.bestBid()?.price).toBe(79_000);
    expect(book.bestBid()?.restingLiquidity).toBe(80_000_000);
  });

  it('leaves leftover when the book is exhausted', () => {
    const book = new OrderBookSimulationEngine({ tickSize: 50, price: 79_100 });
    book.seedLadder(btcBook());
    const walk = book.consumeAsks(200_000_000);
    expect(walk.filled).toBe(120_000_000);
    expect(walk.leftover).toBe(80_000_000);
    expect(book.bestAsk()).toBeNull();
  });
});

describe('replenishment vs withdrawal', () => {
  it('rebuilds an ask after consumption (replenishment ≠ new trade)', () => {
    const book = new OrderBookSimulationEngine({ tickSize: 50, price: 79_100 });
    book.setLevel('ask', 79_200, 100_000_000);
    book.consumeAsks(80_000_000);
    expect(book.bestAsk()?.restingLiquidity).toBe(20_000_000);
    book.addLiquidity('ask', 79_200, 70_000_000, true);
    const lvl = book.bestAsk();
    expect(lvl?.restingLiquidity).toBe(90_000_000);
    expect(lvl?.replenishedLiquidity).toBe(70_000_000);
    expect(lvl?.executedLiquidity).toBe(80_000_000);
  });

  it('withdrawal shrinks a wall without execution', () => {
    const book = new OrderBookSimulationEngine({ tickSize: 50, price: 79_100 });
    book.setLevel('ask', 79_200, 100_000_000);
    const pulled = book.withdrawLiquidity('ask', 79_200, 80_000_000);
    expect(pulled).toBe(80_000_000);
    expect(book.bestAsk()?.restingLiquidity).toBe(20_000_000);
    expect(book.bestAsk()?.cancelledLiquidity).toBe(80_000_000);
    expect(book.bestAsk()?.executedLiquidity).toBe(0);
  });
});

describe('absorption', () => {
  it('flags buyer absorption when huge buys meet ask replenishment and tiny displacement', () => {
    const engine = new MarketSimulationEngine({ symbol: 'BTCUSDT', tickSize: 50, fillMode: 'walk' });
    engine.seedBook({
      price: 79_100,
      asks: [
        { price: 79_150, quote: 80_000_000 },
        { price: 79_200, quote: 120_000_000 },
        { price: 79_250, quote: 120_000_000 },
      ],
      bids: [{ price: 79_050, quote: 80_000_000 }],
    });
    for (let t = 50; t <= 400; t += 50) {
      engine.queueAggression('BUY', 20_000_000, t);
      engine.queueReplenish('ask', 22_000_000, 79_150);
      engine.tick(t);
    }
    const snap = engine.snapshot();
    expect(snap.buyerAbsorption).toBeGreaterThan(0.2);
    expect(snap.price).toBeLessThanOrEqual(79_250);
    expect(['BUYER_ABSORPTION', 'PASSIVE_SELLERS_DEFENDING', 'BUYERS_BEING_ABSORBED', 'INEFFICIENT_BUYING']).toContain(
      snap.effortVsResult === 'BUYER_ABSORPTION' ? snap.effortVsResult : snap.marketState,
    );
  });
});

describe('liquidity vacuum', () => {
  it('moves price a long way without enormous executed volume when asks are pulled', () => {
    const engine = new MarketSimulationEngine({ symbol: 'BTCUSDT', tickSize: 50, fillMode: 'walk' });
    engine.seedBook({
      price: 79_100,
      asks: [
        { price: 79_150, quote: 8_000_000 },
        { price: 79_200, quote: 8_000_000 },
        { price: 79_250, quote: 8_000_000 },
        { price: 79_400, quote: 8_000_000 },
      ],
      bids: [{ price: 79_050, quote: 80_000_000 }],
    });
    engine.queueWithdraw('ask', 20_000_000);
    engine.queueAggression('BUY', 12_000_000, 50);
    const snap = engine.tick(50);
    expect(snap.price).toBeGreaterThan(79_150);
    expect(snap.askWithdrawal).toBeGreaterThan(0);
    expect(snap.aggressiveBuy).toBeLessThan(20_000_000);
  });
});

describe('liquidation cascades', () => {
  it('forced buys from short clusters walk price into the next cluster', () => {
    const engine = new MarketSimulationEngine({ symbol: 'BTCUSDT', tickSize: 50, fillMode: 'walk' });
    engine.seedBook({
      price: 79_000,
      asks: [
        { price: 79_100, quote: 20_000_000 },
        { price: 79_300, quote: 20_000_000 },
        { price: 79_500, quote: 20_000_000 },
        { price: 79_800, quote: 20_000_000 },
        { price: 80_000, quote: 20_000_000 },
      ],
      bids: [{ price: 78_900, quote: 50_000_000 }],
    });
    engine.setZones([
      { id: 's1', price: 79_300, side: 'short', quoteValue: 40_000_000 },
      { id: 's2', price: 79_500, side: 'short', quoteValue: 40_000_000 },
      { id: 's3', price: 79_800, side: 'short', quoteValue: 40_000_000 },
    ]);
    engine.queueAggression('BUY', 45_000_000, 50);
    const snap = engine.tick(50);
    expect(snap.price).toBeGreaterThanOrEqual(79_500);
    expect(snap.shortLiquidations).toBeGreaterThan(0);
    expect(snap.visual.forcedBuyImpulse).toBeGreaterThan(0);
  });
});

describe('OI and funding classification', () => {
  it('classifies short covering when price rises, buys print, OI falls, shorts liquidate', () => {
    const oi = new OpenInterestEngine();
    oi.set(1_000_000_000);
    oi.addChange(-50_000_000);
    expect(
      oi.classify({
        priceChange: 200,
        aggressiveBuy: 80,
        aggressiveSell: 10,
        shortLiquidations: 40,
        longLiquidations: 0,
      }),
    ).toBe('SHORT_COVERING');
  });

  it('classifies new leveraged longs when price and OI rise with aggressive buying', () => {
    const oi = new OpenInterestEngine();
    oi.set(1_000_000_000);
    oi.addChange(40_000_000);
    expect(
      oi.classify({
        priceChange: 150,
        aggressiveBuy: 80,
        aggressiveSell: 10,
        shortLiquidations: 0,
        longLiquidations: 0,
      }),
    ).toBe('NEW_LEVERAGED_LONGS');
  });

  it('does not treat positive funding as a short signal', () => {
    const f = new FundingEngine();
    f.set(0.0008);
    expect(f.classify()).toBe('LONG_CROWDING');
    f.set(-0.0008);
    expect(f.classify()).toBe('SHORT_CROWDING');
  });
});

describe('spot / futures divergence', () => {
  it('labels spot-led buying when spot delta dominates', () => {
    expect(
      classifyCross(
        { aggressiveBuy: 100, aggressiveSell: 10, delta: 90, priceChangeBps: 4 },
        { aggressiveBuy: 20, aggressiveSell: 15, delta: 5, priceChangeBps: 1 },
      ),
    ).toBe('SPOT_LED_BUYING');
  });

  it('labels divergence when spot buys and futures sell', () => {
    expect(
      classifyCross(
        { aggressiveBuy: 80, aggressiveSell: 10, delta: 70, priceChangeBps: 3 },
        { aggressiveBuy: 10, aggressiveSell: 80, delta: -70, priceChangeBps: -2 },
      ),
    ).toBe('SPOT_FUTURES_DIVERGENCE');
  });

  it('runs two independent books', () => {
    const cross = new CrossMarketSimulationEngine({ tickSize: 50 });
    cross.spot.seedBook({
      price: 79_100,
      asks: [{ price: 79_150, quote: 10_000_000 }],
      bids: [{ price: 79_050, quote: 10_000_000 }],
    });
    cross.futures.seedBook({
      price: 79_100,
      asks: [{ price: 79_150, quote: 10_000_000 }],
      bids: [{ price: 79_050, quote: 10_000_000 }],
    });
    cross.spot.queueAggression('BUY', 10_000_000, 50);
    cross.futures.queueAggression('SELL', 10_000_000, 50);
    const snap = cross.tick(50);
    expect(snap.combined).toBe('SPOT_FUTURES_DIVERGENCE');
    expect(snap.spot?.price).toBeGreaterThan(snap.futures?.price ?? 0);
  });
});

describe('price impact emerges from the book', () => {
  it('does not move price by a random increment — stalling at a huge ask', () => {
    const engine = new MarketSimulationEngine({ tickSize: 50, fillMode: 'walk' });
    engine.seedBook({
      price: 79_100,
      asks: [
        { price: 79_150, quote: 5_000_000 },
        { price: 79_200, quote: 5_000_000 },
        { price: 79_250, quote: 500_000_000 },
      ],
      bids: [{ price: 79_050, quote: 50_000_000 }],
    });
    engine.queueAggression('BUY', 12_000_000, 50);
    const snap = engine.tick(50);
    expect(snap.price).toBe(79_250);
    expect(snap.levelsConsumedUp).toBe(2);
    engine.queueAggression('BUY', 5_000_000, 100);
    const stall = engine.tick(100);
    expect(stall.price).toBe(79_250);
  });

  it('records diagnostic pressure separately from walked price', () => {
    const engine = new MarketSimulationEngine({ tickSize: 50, fillMode: 'walk' });
    engine.seedBook(btcBook());
    engine.queueAggression('BUY', 30_000_000, 50);
    const snap = engine.tick(50);
    expect(snap.upsidePressure).toBeGreaterThan(0);
    expect(snap.price).toBe(79_150);
    expect(snap.disclaimer).toBe('MARKET_MICROSTRUCTURE_SIMULATION');
  });
});

describe('deterministic replay and seeded synthetic', () => {
  it('replays an explicit event stream to the same price', () => {
    const events: SimulationEvent[] = [
      {
        kind: 'book_snapshot',
        seq: 1,
        timestamp: 0,
        symbol: 'BTCUSDT',
        marketType: 'perp',
        bids: [{ price: 79_050, quoteValue: 60_000_000 }],
        asks: [
          { price: 79_150, quoteValue: 30_000_000 },
          { price: 79_200, quoteValue: 40_000_000 },
        ],
      },
      {
        kind: 'trade',
        seq: 2,
        timestamp: 50,
        symbol: 'BTCUSDT',
        marketType: 'perp',
        price: 79_150,
        quantity: 0,
        quoteValue: 50_000_000,
        side: 'BUY',
      },
    ];

    const prices: number[] = [];
    for (let i = 0; i < 2; i++) {
      const engine = new MarketSimulationEngine({ tickSize: 50, fillMode: 'walk' });
      const replay = new ReplayEngine();
      replay.load(events);
      engine.ingest(replay.drainUntil(0)[0]!);
      engine.tick(0);
      for (const ev of replay.drainUntil(50)) engine.ingest(ev);
      prices.push(engine.tick(50).price);
    }
    expect(prices[0]).toBe(prices[1]);
    expect(prices[0]).toBe(79_200);
  });

  it('produces identical synthetic results for the same seed', () => {
    const a = new ScenarioEngine().runPreset('BUYER_ABSORPTION', { seed: 12345, durationMs: 2_000 });
    const b = new ScenarioEngine().runPreset('BUYER_ABSORPTION', { seed: 12345, durationMs: 2_000 });
    expect(a.final.price).toBe(b.final.price);
    expect(a.final.aggressiveBuy).toBe(b.final.aggressiveBuy);
    expect(a.final.askReplenishment).toBe(b.final.askReplenishment);
    expect(a.states.map((s) => s.price)).toEqual(b.states.map((s) => s.price));
  });

  it('changes synthetic output when the seed changes', () => {
    const a = new ScenarioEngine().runPreset('BALANCED_MARKET', { seed: 1, durationMs: 1_000 });
    const b = new ScenarioEngine().runPreset('BALANCED_MARKET', { seed: 99, durationMs: 1_000 });
    const same = a.states.every((s, i) => s.aggressiveBuy === b.states[i]?.aggressiveBuy);
    expect(same).toBe(false);
  });

  it('SeededRng is deterministic', () => {
    const a = new SeededRng(12345);
    const b = new SeededRng(12345);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });
});

describe('scenarios', () => {
  it('strong buy breakout lifts price and classifies efficient / vacuum-like upside', () => {
    const { final } = new ScenarioEngine().runPreset('STRONG_BUY_BREAKOUT', { durationMs: 4_000 });
    expect(final.price).toBeGreaterThan(79_100);
    expect(final.aggressiveBuy).toBeGreaterThan(final.aggressiveSell);
  });

  it('buyer absorption scenario keeps displacement small vs aggression', () => {
    const { final } = new ScenarioEngine().runPreset('BUYER_ABSORPTION', { durationMs: 4_000 });
    expect(final.aggressiveBuy).toBeGreaterThan(1_000_000);
    expect(Math.abs(final.price - 79_100) / 79_100).toBeLessThan(0.02);
  });

  it('short squeeze triggers forced buys and lifts through clusters', () => {
    const { final } = new ScenarioEngine().runPreset('SHORT_SQUEEZE', { durationMs: 6_000 });
    expect(final.price).toBeGreaterThan(79_000);
    expect((final.shortLiquidations ?? 0) + final.aggressiveBuy).toBeGreaterThan(0);
  });
});

describe('calibration and validation', () => {
  it('stores per-symbol parameters so BTC is not silently reused for ETH', () => {
    const store = new CalibrationStore();
    const btc = defaultCalibration({ symbol: 'BTCUSDT' });
    const eth = defaultCalibration({ symbol: 'ETHUSDT' });
    expect(btc.vacuumGapCoeff).not.toBe(eth.vacuumGapCoeff);
    store.set({ ...btc, leftoverPressureCoeff: 9 });
    expect(store.get({ symbol: 'ETHUSDT' }).leftoverPressureCoeff).not.toBe(9);
    expect(store.get({ symbol: 'BTCUSDT' }).leftoverPressureCoeff).toBe(9);
  });

  it('reports MAE/RMSE not only direction accuracy', () => {
    const metrics = validateImpact([1, 2, -1, 4], [1.5, 1.5, -0.5, -4]);
    expect(metrics.n).toBe(4);
    expect(metrics.mae).toBeGreaterThan(0);
    expect(metrics.rmse).toBeGreaterThan(metrics.mae);
    expect(metrics.directionAccuracy).toBe(0.75);
  });
});

describe('simulation clock is independent of frames', () => {
  it('steps a fixed tick', () => {
    const clock = new SimulationClock({ tickMs: 50, startTime: 0 });
    const ticks: number[] = [];
    clock.onTick((t) => ticks.push(t));
    clock.step();
    clock.step();
    expect(ticks).toEqual([50, 100]);
  });
});

describe('scenario ticks become chart candles', () => {
  it('builds sequential OHLC from seller absorption', () => {
    const { states, spec } = new ScenarioEngine().runPreset('SELLER_ABSORPTION', { durationMs: 1_000 });
    const { bars, frames } = candlesFromStates(states, spec.startPrice, 4, 1_700_000_000);
    expect(bars.length).toBeGreaterThan(4);
    expect(bars.length).toBe(frames.length);
    expect(bars[0]!.open).toBe(spec.startPrice);
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i]!.time).toBe(bars[i - 1]!.time + 1);
      expect(bars[i]!.open).toBe(bars[i - 1]!.close);
    }
    expect(bars[bars.length - 1]!.close).toBe(states[states.length - 1]!.price);
  });

  it('forms one next-timeframe candle from previous close', () => {
    const { states, spec } = new ScenarioEngine().runPreset('STRONG_BUY_BREAKOUT', { durationMs: 1_000 });
    const nextTime = 1_700_000_000 + 4 * 3600;
    const { bars, frames } = formingBarSnapshots(states, spec.startPrice, nextTime, 12);
    expect(bars.length).toBeGreaterThan(2);
    expect(bars.length).toBe(frames.length);
    for (const b of bars) {
      expect(b.time).toBe(nextTime);
      expect(b.open).toBe(spec.startPrice);
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
    }
    expect(bars[bars.length - 1]!.close).toBe(states[states.length - 1]!.price);
    expect(bars[bars.length - 1]!.high).toBeGreaterThanOrEqual(bars[0]!.high);
  });

  it('drops the in-progress bar and sizes the next 4h from ATR', () => {
    const now = 2_000_000_000;
    const tf = 240;
    const bars = [
      emptyBar({ time: now - 3 * tf * 60, open: 100, high: 110, low: 95, close: 108 }),
      emptyBar({ time: now - 2 * tf * 60, open: 108, high: 120, low: 107, close: 118 }),
      emptyBar({ time: now - tf * 60, open: 118, high: 121, low: 116, close: 117 }),
      emptyBar({ time: now - 60, open: 117, high: 119, low: 116, close: 118 }),
    ];
    const closed = closedHistory(bars, tf, now);
    expect(closed).toHaveLength(3);
    expect(nextBarTime(closed[closed.length - 1]!.time, tf)).toBe(now);
    const scale = scaleFromHistory(closed);
    expect(scale.startPrice).toBe(117);
    expect(scale.tickSize).toBeGreaterThan(0);
    expect(scale.atr).toBeGreaterThan(0);
  });

  it('reads footprint and builds four colored next-bar paths', () => {
    const bars = Array.from({ length: 8 }, (_, i) =>
      emptyBar({
        time: 1_700_000_000 + i * 14_400,
        open: 100,
        high: 112,
        low: 99,
        close: 110,
        aggressiveBuy: 80,
        aggressiveSell: 20,
        hasFootprint: true,
      }),
    );
    const flow = readFlow(bars);
    expect(flow.buyShare).toBeGreaterThan(0.7);
    expect(flow.hasFootprint).toBe(true);
    const paths = pathsFromFlow(bars);
    expect(paths).toHaveLength(4);
    expect(new Set(paths.map((p) => p.color)).size).toBe(4);
    expect(paths[0]!.label).toMatch(/Buy continue/i);
    expect(paths.map((p) => p.id)).toEqual(['continue', 'absorb', 'vacuum', 'fade']);
  });
});
