import { describe, expect, it } from 'vitest';
import { RollingDistribution } from '../src/core/rolling-stats.js';
import { FeatureBuilder } from '../src/backtest/features.js';
import { MicrostructureBacktestEngine } from '../src/backtest/engine.js';
import { and, cond } from '../src/backtest/conditions.js';
import { getStrategyPreset } from '../src/backtest/presets.js';
import { runSignalStudy, getStudyPreset } from '../src/backtest/signal-study.js';
import { coverageGate } from '../src/backtest/coverage.js';
import type { DataCoverage, MarketBar, Strategy } from '../src/backtest/types.js';
import { DEFAULT_EXECUTION, DEFAULT_RISK } from '../src/backtest/types.js';

function bar(i: number, extra: Partial<MarketBar> = {}): MarketBar {
  const time = 1_700_000_000 + i * 900;
  const close = extra.close ?? 100 + Math.sin(i / 8) * 2;
  const open = extra.open ?? close - 0.2;
  return {
    time,
    open,
    high: extra.high ?? Math.max(open, close) + 0.4,
    low: extra.low ?? Math.min(open, close) - 0.4,
    close,
    volume: 1_000_000,
    aggressiveBuy: extra.aggressiveBuy ?? 50_000,
    aggressiveSell: extra.aggressiveSell ?? 50_000,
    trades: 100,
    buyTrades: 50,
    sellTrades: 50,
    largestBuy: 5_000,
    largestSell: 5_000,
    levels: extra.levels ?? [],
    hasFootprint: true,
    hasBook: false,
    spotBuy: extra.spotBuy ?? extra.aggressiveBuy ?? 50_000,
    spotSell: extra.spotSell ?? extra.aggressiveSell ?? 50_000,
    futuresBuy: extra.futuresBuy ?? extra.aggressiveBuy ?? 50_000,
    futuresSell: extra.futuresSell ?? extra.aggressiveSell ?? 50_000,
    bidDepth: null,
    askDepth: null,
    bidReplenishment: extra.bidReplenishment ?? null,
    askReplenishment: extra.askReplenishment ?? null,
    bidWithdrawal: extra.bidWithdrawal ?? null,
    askWithdrawal: extra.askWithdrawal ?? null,
    oi: null,
    oiChange: extra.oiChange ?? null,
    funding: null,
    longLiquidations: extra.longLiquidations ?? null,
    shortLiquidations: extra.shortLiquidations ?? null,
    ...extra,
    time,
  };
}

function coverage(n: number): DataCoverage {
  return {
    candles: 100,
    trades: 100,
    l2: 0,
    oi: 0,
    funding: 0,
    liquidations: 0,
    spot: 100,
    futures: 100,
    fromSec: 0,
    toSec: 1,
    barCount: n,
    warnings: [],
  };
}

function alwaysLong(): Strategy {
  return {
    id: 'always',
    name: 'Always long',
    version: 1,
    createdAt: 0,
    longEntry: cond('close', '>', 0),
    execution: { ...DEFAULT_EXECUTION, orderType: 'MARKET', slippageBps: 0, takerFeeBps: 0, makerFeeBps: 0 },
    risk: {
      ...DEFAULT_RISK,
      stopKind: 'FIXED_PCT',
      stopValue: 50,
      takeProfits: [{ kind: 'FIXED_PCT', value: 50, closePct: 1 }],
      sizing: 'FIXED_QTY',
      fixedQty: 1,
      accountEquity: 100_000,
    },
  };
}

const cfg = {
  mode: 'BACKTEST' as const,
  tfMinutes: 15,
  percentileWindow: '100' as const,
  minDataQuality: 0,
};

describe('causal percentiles', () => {
  it('ranks a value against prior bars only', () => {
    const bars = Array.from({ length: 80 }, (_, i) =>
      bar(i, { aggressiveBuy: i < 40 ? 10_000 : 1_000_000, aggressiveSell: 10_000, close: 100 }),
    );
    const builder = new FeatureBuilder(100);
    let snap20 = builder.push(bars[0]!);
    for (let i = 1; i <= 20; i++) snap20 = builder.push(bars[i]!);

    const prior = new RollingDistribution(100);
    for (let i = 0; i < 20; i++) prior.add(bars[i]!.aggressiveBuy);
    expect(snap20.buyPercentile).toBeCloseTo(prior.percentileRank(bars[20]!.aggressiveBuy), 4);

    const full = new RollingDistribution(100);
    for (const b of bars) full.add(b.aggressiveBuy);
    expect(Math.abs(snap20.buyPercentile - full.percentileRank(bars[20]!.aggressiveBuy))).toBeGreaterThan(5);
  });
});

describe('causal structure', () => {
  it('does not confirm a swing high until two later bars have closed', () => {
    const bars: MarketBar[] = [];
    for (let i = 0; i < 20; i++) {
      const peak = i === 8;
      bars.push(
        bar(i, {
          high: peak ? 120 : 101,
          low: 99,
          close: peak ? 118 : 100.2,
          open: 100,
        }),
      );
    }
    const builder = new FeatureBuilder(100);
    let atPeak = builder.push(bars[0]!);
    for (let i = 1; i <= 8; i++) atPeak = builder.push(bars[i]!);
    expect(atPeak.structure.swingHigh).not.toBe(120);

    let later = atPeak;
    for (let i = 9; i <= 10; i++) later = builder.push(bars[i]!);
    expect(later.structure.swingHigh).toBe(120);
  });
});

describe('execution', () => {
  it('fills a market order on the next bar open, not the signal bar close', () => {
    const bars = Array.from({ length: 12 }, (_, i) => bar(i, { open: 100 + i, close: 100 + i + 0.3, high: 101 + i, low: 99 + i }));
    const result = new MicrostructureBacktestEngine().run(bars, alwaysLong(), coverage(bars.length), cfg);
    const t = result.trades[0];
    expect(t).toBeTruthy();
    expect(t!.entryTime).toBe(bars[1]!.time);
    expect(t!.entryPrice).toBeCloseTo(bars[1]!.open, 6);
    expect(t!.entryPrice).not.toBeCloseTo(bars[0]!.close, 6);
  });

  it('does not fill a conservative limit on a mere touch', () => {
    const strategy: Strategy = {
      ...alwaysLong(),
      execution: {
        ...DEFAULT_EXECUTION,
        orderType: 'LIMIT',
        fillModel: 'CONSERVATIVE',
        limitOffsetBps: 20,
        conservativeBps: 10,
        slippageBps: 0,
        takerFeeBps: 0,
        makerFeeBps: 0,
      },
    };
    const bars = Array.from({ length: 8 }, (_, i) =>
      bar(i, {
        open: 100,
        close: 100,
        high: 100.05,
        low: 99.82,
      }),
    );
    const result = new MicrostructureBacktestEngine().run(bars, strategy, coverage(bars.length), cfg);
    expect(result.trades.filter((t) => !t.open).length + result.trades.filter((t) => t.open).length).toBe(0);
  });

  it('fills an optimistic limit on a touch', () => {
    const strategy: Strategy = {
      ...alwaysLong(),
      execution: {
        ...DEFAULT_EXECUTION,
        orderType: 'LIMIT',
        fillModel: 'OPTIMISTIC',
        limitOffsetBps: 20,
        slippageBps: 0,
        takerFeeBps: 0,
        makerFeeBps: 0,
      },
    };
    const bars = Array.from({ length: 8 }, (_, i) =>
      bar(i, {
        open: 100,
        close: 100,
        high: 100.1,
        low: i === 0 ? 100 : 99.7,
      }),
    );
    const result = new MicrostructureBacktestEngine().run(bars, strategy, coverage(bars.length), cfg);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades[0]!.entryTime).toBe(bars[1]!.time);
  });
});

describe('MAE / MFE and forward returns', () => {
  it('tracks adverse and favorable excursion after entry', () => {
    const bars = [
      bar(0, { open: 100, close: 100, high: 100.2, low: 99.8 }),
      bar(1, { open: 100, close: 100.5, high: 103, low: 98.5 }),
      bar(2, { open: 100.5, close: 101, high: 101.2, low: 100.4 }),
    ];
    const strategy: Strategy = {
      ...alwaysLong(),
      risk: {
        ...alwaysLong().risk,
        stopKind: 'FIXED_PCT',
        stopValue: 10,
        takeProfits: [{ kind: 'FIXED_PCT', value: 20, closePct: 1 }],
      },
    };
    const result = new MicrostructureBacktestEngine().run(bars, strategy, coverage(bars.length), cfg);
    const t = result.trades[0];
    expect(t).toBeTruthy();
    expect(t!.mfe).toBeGreaterThanOrEqual(2.9);
    expect(t!.mae).toBeGreaterThanOrEqual(1.4);
  });

  it('records forward returns after the signal without using them as inputs', () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(i, { close: 100 + i, open: 100 + i - 0.1 }));
    const result = new MicrostructureBacktestEngine().run(bars, alwaysLong(), coverage(bars.length), cfg);
    const entry = result.signals.find((s) => s.kind === 'LONG_ENTRY');
    expect(entry).toBeTruthy();
    expect(entry!.forwardReturns['15m']).not.toBeNull();
  });
});

describe('condition engine', () => {
  it('supports nested AND / OR groups', () => {
    const bars = Array.from({ length: 30 }, (_, i) =>
      bar(i, {
        aggressiveSell: i > 20 ? 5_000_000 : 10_000,
        aggressiveBuy: 8_000,
        close: 100,
        bidReplenishment: 90,
        bidWithdrawal: 10,
      }),
    );
    const strategy: Strategy = {
      ...alwaysLong(),
      longEntry: and(cond('aggressiveSell', 'percentile_above', 80), cond('close', '>', 0)),
    };
    const result = new MicrostructureBacktestEngine().run(bars, strategy, coverage(bars.length), cfg);
    expect(result.signals.some((s) => s.kind === 'LONG_ENTRY')).toBe(true);
  });
});

describe('presets', () => {
  it('loads seller absorption as a real rule set', () => {
    const s = getStrategyPreset('SELLER_ABSORPTION');
    expect(s.longSetup).toBeTruthy();
    expect(s.longEntry).toBeTruthy();
    expect(s.execution.orderType).toBe('MARKET');
  });
});

describe('signal study', () => {
  it('measures forward returns against a same-window baseline without look-ahead', () => {
    const bars: MarketBar[] = [];
    for (let i = 0; i < 150; i++) {
      const absorb = i >= 80 && i <= 83;
      const rally = i >= 84;
      bars.push(
        bar(i, {
          aggressiveSell: absorb ? 8_000_000 : 12_000,
          aggressiveBuy: 9_000,
          bidReplenishment: absorb ? 92 : 20,
          open: absorb || rally ? 100 : 99.4,
          close: rally ? 100 + (i - 83) * 0.6 : 100,
          high: rally ? 100 + (i - 83) * 0.6 + 0.2 : 100.1,
          low: 99.2,
        }),
      );
    }
    const study = runSignalStudy(bars, getStudyPreset('seller_abs'), 15, '100', bars[0]!.time);
    expect(study.occurrences).toBeGreaterThan(0);
    const h1 = study.horizons.find((h) => h.horizon === '1h');
    expect(h1).toBeTruthy();
    expect(h1!.count).toBe(study.occurrences);
    expect(h1!.posPct).toBeGreaterThan(h1!.baselinePosPct);
    expect(h1!.edge).toBeGreaterThan(0);
  });
});

describe('coverage gate', () => {
  it('rejects absorption strategies when footprint coverage is missing', () => {
    const gate = coverageGate(getStrategyPreset('SELLER_ABSORPTION'), {
      ...coverage(10),
      trades: 0,
    });
    expect(gate.reject).toBe(true);
    expect(gate.warnings.some((w) => /footprint/i.test(w))).toBe(true);
  });
});
