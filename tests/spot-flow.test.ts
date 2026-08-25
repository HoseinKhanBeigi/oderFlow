import { describe, expect, it } from 'vitest';
import { classifyTrade, inferAggressorFromBook, tryClassifyTrade } from '../src/flow/trade-classifier.js';
import { FootprintAggregator } from '../src/footprint/aggregator.js';
import { compareSpotFutures } from '../src/spot/comparison.js';
import { TradeDeduper } from '../src/spot/dedupe.js';
import { EffortVsResult } from '../src/spot/efficiency.js';
import { SpotFlowEngine } from '../src/spot/flow-engine.js';
import { SpotAbsorptionDetector } from '../src/spot/absorption.js';
import { trade } from './helpers.js';
import type { SpotWindowStats } from '../src/spot/types.js';
import type { WindowSnapshot } from '../src/models/signals.js';

const T0 = 1_700_000_000_000;

describe('aggressor inference', () => {
  it('classifies a print at the ask as aggressive buy', () => {
    expect(inferAggressorFromBook(100.02, 100, 100.02)).toBe('BUY');
  });

  it('classifies a print at the bid as aggressive sell', () => {
    expect(inferAggressorFromBook(100, 100, 100.02)).toBe('SELL');
  });

  it('does not classify inside-spread prints', () => {
    expect(inferAggressorFromBook(100.01, 100, 100.02)).toBeNull();
  });

  it('does not use candle direction and skips stale or wide books', () => {
    expect(inferAggressorFromBook(101, 100, 101, 5_000)).toBeNull();
    expect(inferAggressorFromBook(110, 100, 108)).toBeNull();
  });

  it('tryClassifyTrade returns null when the aggressor is unknown', () => {
    expect(
      tryClassifyTrade({
        symbol: 'BTCUSDT',
        timestamp: T0,
        price: 100.5,
        quantity: 1,
        bestBid: 100,
        bestAsk: 101,
      }),
    ).toBeNull();
  });

  it('classifyTrade uses a reliable book when maker/taker is missing', () => {
    const t = classifyTrade({
      symbol: 'BTCUSDT',
      marketType: 'spot',
      timestamp: T0,
      price: 100.02,
      quantity: 1,
      bestBid: 100,
      bestAsk: 100.02,
    });
    expect(t.side).toBe('BUY');
    expect(t.quoteValue).toBeCloseTo(100.02);
  });
});

describe('spot trade dedupe', () => {
  it('drops the same venue trade id and keeps distinct exchanges', () => {
    const d = new TradeDeduper(8);
    expect(d.accept('binance', 'BTCUSDT', '1')).toBe(true);
    expect(d.accept('binance', 'BTCUSDT', '1')).toBe(false);
    expect(d.accept('bybit', 'BTCUSDT', '1')).toBe(true);
  });
});

describe('spot footprint isolation', () => {
  it('never mixes spot and perp bars in the aggregator', () => {
    const spot = new FootprintAggregator({ market: 'spot' });
    const perp = new FootprintAggregator({ market: 'perp' });
    spot.ingest(trade({ timestamp: T0 + 1_000, price: 100, quantity: 2, side: 'BUY', marketType: 'spot' }), 'binance');
    perp.ingest(trade({ timestamp: T0 + 1_000, price: 100, quantity: 9, side: 'SELL', marketType: 'perp' }), 'binance');
    expect(spot.currentBar('BTCUSDT', 'binance')?.totalBuy).toBeCloseTo(200);
    expect(spot.currentBar('BTCUSDT', 'binance')?.totalSell).toBe(0);
    expect(perp.currentBar('BTCUSDT', 'binance')?.totalSell).toBeCloseTo(900);
    expect(perp.currentBar('BTCUSDT', 'binance')?.market).toBe('perp');
    expect(spot.currentBar('BTCUSDT', 'binance')?.market).toBe('spot');
  });

  it('keeps per-exchange stats so ALL can aggregate without collapsing venues', () => {
    const engine = new SpotFlowEngine();
    engine.ingestTrade(trade({ timestamp: T0, price: 100, quantity: 10, side: 'BUY', marketType: 'spot', tradeId: 'b1' }), 'binance');
    engine.ingestTrade(trade({ timestamp: T0 + 10, price: 100, quantity: 4, side: 'SELL', marketType: 'spot', tradeId: 'y1' }), 'bybit');
    const snap = engine.snapshot('BTCUSDT', 'all', T0 + 20);
    expect(snap.exchanges.binance?.delta).toBeCloseTo(1_000);
    expect(snap.exchanges.bybit?.delta).toBeCloseTo(-400);
    expect(snap.aggregated.delta).toBeCloseTo(600);
  });

  it('does not count a duplicate trade id twice', () => {
    const engine = new SpotFlowEngine();
    const t = trade({ timestamp: T0, price: 100, quantity: 1, side: 'BUY', marketType: 'spot', tradeId: 'dup' });
    expect(engine.ingestTrade(t, 'binance')).toBe(true);
    expect(engine.ingestTrade(t, 'binance')).toBe(false);
    expect(engine.snapshot('BTCUSDT', 'all', T0 + 20).aggregated.aggressiveBuyVolume).toBeCloseTo(100);
  });

  it('ignores perpetual trades on the spot engine', () => {
    const engine = new SpotFlowEngine();
    expect(engine.ingestTrade(trade({ timestamp: T0, price: 100, quantity: 1, side: 'BUY', marketType: 'perp' }), 'binance')).toBe(false);
    expect(engine.snapshot('BTCUSDT', 'all', T0).aggregated.tradeCount).toBe(0);
  });
});

describe('effort vs result', () => {
  it('labels absorbed buying as inefficient without a fixed dollar cutoff', () => {
    const e = new EffortVsResult(32);
    for (let i = 0; i < 20; i++) {
      e.measure({ open: 100, close: 100.4, totalVolume: 1_000_000, delta: 400_000 }, true);
    }
    const absorbed = e.measure({ open: 100, close: 100.01, totalVolume: 20_000_000, delta: 8_000_000 }, false);
    expect(absorbed.effortVsResult).toBe('BUYERS_INEFFICIENT');
    expect(absorbed.rank).toBe('LOW');
  });
});

describe('passive absorption', () => {
  it('does not flag absorption from volume alone', () => {
    const d = new SpotAbsorptionDetector();
    for (let i = 0; i < 20; i++) d.observe(1_000_000, 0.2);
    const result = d.detect({
      buyVolume: 9_000_000,
      sellVolume: 1_000_000,
      delta: 8_000_000,
      priceChangePercent: 0.01,
      buyNearAskShare: 0.1,
      sellNearBidShare: 0,
      askReplenishment: null,
      bidReplenishment: null,
      hasBook: false,
    });
    expect(result.detected).toBe(false);
  });

  it('flags seller absorption when aggressive buys stall at the ask', () => {
    const d = new SpotAbsorptionDetector();
    for (let i = 0; i < 20; i++) d.observe(500_000, 0.15);
    const result = d.detect({
      buyVolume: 9_000_000,
      sellVolume: 1_000_000,
      delta: 8_000_000,
      priceChangePercent: 0.01,
      buyNearAskShare: 0.8,
      sellNearBidShare: 0,
      askReplenishment: 0.6,
      bidReplenishment: 0,
      hasBook: true,
    });
    expect(result.type).toBe('PASSIVE_SELL_ABSORPTION');
  });
});

function windowStats(partial: Partial<SpotWindowStats>): SpotWindowStats {
  return {
    exchange: 'all',
    aggressiveBuyVolume: 2_000_000,
    aggressiveSellVolume: 1_000_000,
    delta: 1_000_000,
    deltaPercent: 0.33,
    cvd: 1_000_000,
    tradeCount: 10,
    buyTradeCount: 7,
    sellTradeCount: 3,
    averageBuySize: 200_000,
    averageSellSize: 100_000,
    largestBuy: 400_000,
    largestSell: 200_000,
    open: 100,
    high: 101,
    low: 99.5,
    close: 101,
    efficiency: {
      priceChange: 1,
      priceChangePercent: 1,
      totalVolume: 3_000_000,
      delta: 1_000_000,
      absDelta: 1_000_000,
      volumePerDollar: 3_000_000,
      volumePerBps: 30_000,
      rank: 'HIGH',
      effortVsResult: 'BUYERS_EFFICIENT',
    },
    absorption: { detected: false, type: null, confidence: 0, usedBookEvidence: false },
    flow: 'SPOT_BUYING',
    flags: [],
    cvdDirection: 'UP',
    cvdDivergence: 'NONE',
    ...partial,
  };
}

function futWindow(partial: Partial<WindowSnapshot>): WindowSnapshot {
  return {
    symbol: 'BTCUSDT',
    marketType: 'perp',
    price: 101,
    window: '1m',
    aggressiveBuyVolume: 2_000_000,
    aggressiveSellVolume: 1_000_000,
    buyTradeCount: 8,
    sellTradeCount: 4,
    averageBuySize: 250_000,
    averageSellSize: 250_000,
    delta: 1_000_000,
    deltaPercent: 0.33,
    largeBuyVolume: 0,
    largeSellVolume: 0,
    largeBuyFlowShare: 0,
    largeSellFlowShare: 0,
    largestBuy: 0,
    largestSell: 0,
    buyBurstDetected: false,
    sellBurstDetected: false,
    persistentBuyFlow: false,
    persistentSellFlow: false,
    priceStart: 100,
    priceEnd: 101,
    absolutePriceChange: 1,
    priceChangePercent: 1,
    priceImpactEfficiency: 'HIGH',
    flowMultipleBuy: 1,
    flowMultipleSell: 1,
    forcedBuyVolume: 0,
    forcedSellVolume: 0,
    buyPressure: 0,
    sellPressure: 0,
    askReplenishmentRate: 0,
    bidReplenishmentRate: 0,
    askConsumptionRate: 0,
    bidConsumptionRate: 0,
    largeBuyFlowAcceleration: 'NONE',
    largeSellFlowAcceleration: 'NONE',
    absorption: { detected: false, type: null, absorbingSide: null, aggressiveSide: null, strength: 0, confidence: 0 },
    largeFlowDirectionalScore: 20,
    largeParticipantFlowScore: 0,
    confidence: 0.5,
    state: 'LARGE_BUY_FLOW',
    movePotential: {} as WindowSnapshot['movePotential'],
    flowBattle: {} as WindowSnapshot['flowBattle'],
    ...partial,
  };
}

describe('spot vs futures comparison', () => {
  it('labels aligned buying as broad confirmation, not a trade signal', () => {
    const cmp = compareSpotFutures(windowStats({ flow: 'SPOT_BUYING' }), {
      futures: futWindow({ delta: 2_000_000, deltaPercent: 0.4 }),
      oiUsd: 110,
      prevOiUsd: 100,
    });
    expect(cmp.relation).toBe('BROAD_BUYING_CONFIRMATION');
    expect(cmp.interpretation).toBe('NEW_LEVERAGED_BUYING_SPOT_CONFIRMATION');
  });

  it('labels spot buy vs futures sell as divergence', () => {
    const cmp = compareSpotFutures(windowStats({ flow: 'SPOT_BUYING' }), {
      futures: futWindow({ delta: -2_000_000, deltaPercent: -0.4, aggressiveBuyVolume: 500_000, aggressiveSellVolume: 2_500_000 }),
      oiUsd: 100,
      prevOiUsd: 100,
    });
    expect(cmp.relation).toBe('SPOT_FUTURES_DIVERGENCE');
    expect(cmp.interpretation).toBe('DIVERGENCE');
  });

  it('labels a rally with falling OI and short liquidations as short-covering', () => {
    const cmp = compareSpotFutures(
      windowStats({
        flow: 'BALANCED',
        delta: -10_000,
        deltaPercent: -0.02,
        efficiency: {
          priceChange: 1,
          priceChangePercent: 0.8,
          totalVolume: 1,
          delta: 0,
          absDelta: 0,
          volumePerDollar: 1,
          volumePerBps: 1,
          rank: 'LOW',
          effortVsResult: 'BALANCED',
        },
      }),
      {
        futures: futWindow({
          delta: 3_000_000,
          deltaPercent: 0.5,
          aggressiveBuyVolume: 4_000_000,
          aggressiveSellVolume: 1_000_000,
          forcedBuyVolume: 800_000,
          forcedSellVolume: 50_000,
        }),
        oiUsd: 90,
        prevOiUsd: 100,
      },
    );
    expect(cmp.interpretation).toBe('SHORT_COVERING_DOMINATED_RALLY');
  });
});
