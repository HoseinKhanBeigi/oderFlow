import { describe, expect, it } from 'vitest';
import { classifyTrade } from '../src/flow/trade-classifier.js';
import { computeDelta } from '../src/flow/delta-engine.js';
import { CVDEngine } from '../src/flow/cvd-engine.js';
import { LargeTradeDetector } from '../src/flow/large-trade-detector.js';
import { BinanceSpotAdapter, BinanceFuturesAdapter } from '../src/exchange/binance-adapters.js';
import { testConfig } from './helpers.js';

describe('trade classifier', () => {
  it('marks aggressive BUY when the buyer is taker (isBuyerMaker=false)', () => {
    const trade = classifyTrade({
      symbol: 'BTCUSDT',
      timestamp: 1,
      price: 100,
      quantity: 2,
      isBuyerMaker: false,
      tradeId: 1,
    });
    expect(trade.quoteValue).toBe(200);
    expect(trade.isAggressiveBuy).toBe(true);
    expect(trade.isAggressiveSell).toBe(false);
    expect(trade.side).toBe('BUY');
  });

  it('marks aggressive SELL when the buyer is maker', () => {
    const trade = classifyTrade({
      symbol: 'ETHUSDT',
      timestamp: 1,
      price: 10,
      quantity: 5,
      isBuyerMaker: true,
    });
    expect(trade.isAggressiveSell).toBe(true);
    expect(trade.side).toBe('SELL');
  });

  it('does not infer aggression from price direction', () => {
    expect(() =>
      classifyTrade({
        symbol: 'BTCUSDT',
        timestamp: 1,
        price: 101,
        quantity: 1,
      }),
    ).toThrow(/maker\/taker/);
  });
});

describe('delta and CVD', () => {
  it('computes delta and deltaPercent in [-1, 1]', () => {
    const d = computeDelta({
      buyVolume: 1_200_000_000,
      sellVolume: 400_000_000,
      buyCount: 10,
      sellCount: 4,
      largestBuy: 1,
      largestSell: 1,
      largeBuyVolume: 0,
      largeSellVolume: 0,
      forcedBuyVolume: 0,
      forcedSellVolume: 0,
      priceOpen: 100,
      priceHigh: 101,
      priceLow: 99,
      priceClose: 100,
      bucketCount: 1,
    });
    expect(d.delta).toBe(800_000_000);
    expect(d.deltaPercent).toBeCloseTo(0.5);
  });

  it('accumulates CVD as buy - sell', () => {
    const cvd = new CVDEngine(5_000);
    cvd.onTrade(1_000, 100, 0, 10);
    cvd.onTrade(2_000, 50, 0, 10);
    const snap = cvd.snapshot(2_000);
    expect(snap.cvd).toBe(150);
    expect(snap.direction).toBe('UP');
  });
});

describe('relative large trade detection', () => {
  it('classifies using percentiles, not only dollar tiers', () => {
    const detector = new LargeTradeDetector(testConfig());
    for (let i = 0; i < 1_000; i++) detector.observe({
      symbol: 'X',
      marketType: 'spot',
      timestamp: i,
      price: 1,
      quantity: 100,
      quoteValue: 50 + i,
      side: 'BUY',
      isAggressiveBuy: true,
      isAggressiveSell: false,
    });
    const small = detector.relativeSize(80);
    const extreme = detector.relativeSize(50_000);
    expect(small.classification).toBe('NORMAL');
    expect(extreme.classification).toBe('EXTREME');
    expect(extreme.vsMedian).toBeGreaterThan(50);
  });
});

describe('Binance adapters', () => {
  it('normalizes aggTrade maker flag into aggression', () => {
    const spot = new BinanceSpotAdapter();
    const buy = spot.normalizeAggTrade({
      e: 'aggTrade',
      E: 1,
      s: 'BTCUSDT',
      a: 9,
      p: '63000',
      q: '2',
      T: 1,
      m: false,
    });
    expect(buy.isAggressiveBuy).toBe(true);
    expect(buy.quoteValue).toBe(126_000);

    const futures = new BinanceFuturesAdapter();
    const liq = futures.normalizeForceOrder({
      e: 'forceOrder',
      E: 1,
      o: {
        s: 'BTCUSDT',
        S: 'BUY',
        o: 'LIMIT',
        q: '1',
        p: '100',
        ap: '100',
        X: 'FILLED',
        T: 2,
      },
    });
    expect(liq.type).toBe('SHORT_LIQUIDATION');
    expect(liq.side).toBe('BUY');
  });
});
