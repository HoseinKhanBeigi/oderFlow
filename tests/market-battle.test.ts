import { describe, expect, it } from 'vitest';
import { emptyFlowBattle } from '../src/models/passive.js';
import { emptyLiquidityResponse } from '../src/liquidity-response/empty.js';
import { MarketBattleEngine } from '../src/market-battle/engine.js';
import type { MarketBattleInput } from '../src/market-battle/engine.js';
import { AggressiveFlowEngine } from '../src/aggressive-flow/engine.js';
import { emptyAggressiveFlow } from '../src/models/aggressive-flow.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { buildNetAggression } from '../src/flow/net-aggression.js';

function baseInput(overrides: Partial<MarketBattleInput> = {}): MarketBattleInput {
  const lr = emptyLiquidityResponse();
  lr.dataQuality = 80;
  lr.confidence = 'HIGH';
  lr.confidenceScore = 80;
  lr.askDepth.changeState = 'STABLE';
  lr.bidDepth.changeState = 'STABLE';

  return {
    window: '1m',
    priceChangePercent: 0,
    priceImpactEfficiency: 'NORMAL',
    confidence: 0.8,
    tradeDataMissing: false,
    flowBattle: emptyFlowBattle(),
    liquidityResponse: lr,
    passiveLiquidity: null,
    netAggression: buildNetAggression({
      window: '1m',
      buyVolume: 1_000_000,
      sellVolume: 1_000_000,
      buyCount: 100,
      sellCount: 100,
      largeBuyVolume: 200_000,
      largeSellVolume: 200_000,
      buyPercentile: 50,
      sellPercentile: 50,
      netMagnitudePercentile: 40,
    }),
    aggressiveFlow: emptyAggressiveFlow('1m', 60_000),
    ...overrides,
  };
}

function flowFromEngine(side: 'buy' | 'sell' | 'both' = 'buy') {
  const engine = new AggressiveFlowEngine(DEFAULT_CONFIG.marketBattle);
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 40; i++) {
    if (side === 'buy' || side === 'both') {
      engine.onTrade(t0 + i * 200, 'BUY', 500_000 + i * 10_000, 100 + (i % 5) * 0.5, i % 4 === 0);
    }
    if (side === 'sell' || side === 'both') {
      engine.onTrade(t0 + i * 200 + 50, 'SELL', 200_000, 100 + (i % 5) * 0.5, false);
    }
  }
  // Stack buy imbalances at a few prices
  for (let i = 0; i < 8; i++) {
    engine.onTrade(t0 + 10_000 + i * 100, 'BUY', 900_000, 103.6, true);
  }
  return engine.snapshot('1m', t0 + 15_000);
}

describe('AggressiveFlowEngine', () => {
  it('treats ASK-executed volume as aggressive buys', () => {
    const engine = new AggressiveFlowEngine(DEFAULT_CONFIG.marketBattle);
    const t0 = 1_700_000_000_000;
    engine.onTrade(t0, 'BUY', 1_000_000, 100, true);
    engine.onTrade(t0 + 100, 'SELL', 250_000, 100, false);
    const snap = engine.snapshot('10s', t0 + 500);
    expect(snap.buy.executedVolume).toBe(1_000_000);
    expect(snap.sell.executedVolume).toBe(250_000);
    expect(snap.buy.hasData).toBe(true);
    expect(snap.aggressiveBuyPower).toBeGreaterThan(0);
    expect(snap.buy.contributions.length).toBeGreaterThan(0);
  });

  it('detects footprint buy imbalances', () => {
    const snap = flowFromEngine('buy');
    expect(snap.buy.imbalanceCount).toBeGreaterThan(0);
    expect(snap.buy.topLevels.length).toBeGreaterThan(0);
    expect(snap.buy.topLevels[0]!.side).toBe('BUY');
  });

  it('returns NO DATA when trade tape missing', () => {
    const engine = new AggressiveFlowEngine(DEFAULT_CONFIG.marketBattle);
    const snap = engine.snapshot('1m', Date.now(), { tradeDataMissing: true });
    expect(snap.buy.hasData).toBe(false);
    expect(snap.buy.executedVolume).toBe(0);
  });
});

describe('MarketBattleEngine with footprint aggression', () => {
  const engine = new MarketBattleEngine();

  it('shows FOOTPRINT DATA UNAVAILABLE when aggressive flow missing', () => {
    const snap = engine.analyze(
      baseInput({
        tradeDataMissing: true,
        aggressiveFlow: emptyAggressiveFlow('1m', 60_000),
      }),
    );
    expect(snap.upside.aggressive.hasData).toBe(false);
    expect(snap.upside.state).toBe('NO_MEANINGFUL_BATTLE');
    expect(snap.upside.why[0]).toMatch(/FOOTPRINT/i);
  });

  it('uses AggressiveBuyPower for attack and passive defense for sellers', () => {
    const af = flowFromEngine('buy');
    const fb = emptyFlowBattle();
    fb.battle.passiveSellerStrength = 40;
    fb.buyExecutionEfficiency = 0.85;

    const lr = emptyLiquidityResponse();
    lr.dataQuality = 85;
    lr.confidence = 'HIGH';
    lr.askConsumption = 'HIGH';
    lr.askReplenishment = 'LOW';
    lr.efficiency = 'HIGH';

    const snap = engine.analyze(
      baseInput({
        priceChangePercent: 0.35,
        priceImpactEfficiency: 'HIGH',
        flowBattle: fb,
        liquidityResponse: lr,
        aggressiveFlow: af,
      }),
    );

    expect(snap.upside.aggressive.hasData).toBe(true);
    expect(snap.upside.aggressive.power).toBe(af.aggressiveBuyPower);
    expect(snap.upside.aggressive.contributions.length).toBeGreaterThan(0);
    expect(snap.upside.state).toBe('BUYERS_WINNING');
  });

  it('detects seller absorption from high buy power + replenishment + low efficiency', () => {
    const af = flowFromEngine('buy');
    const fb = emptyFlowBattle();
    fb.battle.passiveSellerStrength = 75;
    fb.buyExecutionEfficiency = 0.1;

    const lr = emptyLiquidityResponse();
    lr.dataQuality = 85;
    lr.confidence = 'HIGH';
    lr.askConsumption = 'HIGH';
    lr.askReplenishment = 'HIGH';
    lr.efficiency = 'LOW';
    lr.absorption.kind = 'BUY_ABSORPTION';
    lr.absorption.detected = true;

    const snap = engine.analyze(
      baseInput({
        priceChangePercent: 0.02,
        priceImpactEfficiency: 'LOW',
        flowBattle: fb,
        liquidityResponse: lr,
        aggressiveFlow: af,
      }),
    );

    expect(snap.upside.state).toBe('SELLER_ABSORPTION');
  });

  it('marks LOW_CONFIDENCE when tape is stale and there is no attack volume', () => {
    const af = emptyAggressiveFlow('1m', 60_000);
    af.buy.lowConfidence = true;

    const lr = emptyLiquidityResponse();
    lr.dataQuality = 80;
    lr.confidence = 'HIGH';

    const snap = engine.analyze(
      baseInput({
        tradeDataLowConfidence: true,
        liquidityResponse: lr,
        aggressiveFlow: af,
      }),
    );

    expect(snap.upside.state).toBe('LOW_CONFIDENCE');
  });

  it('still classifies when tape is briefly quiet but the window has attack volume', () => {
    const af = flowFromEngine('buy');
    af.buy.lowConfidence = true;

    const lr = emptyLiquidityResponse();
    lr.dataQuality = 80;
    lr.confidence = 'HIGH';
    lr.askConsumption = 'HIGH';
    lr.askReplenishment = 'HIGH';
    lr.efficiency = 'LOW';

    const fb = emptyFlowBattle();
    fb.battle.passiveSellerStrength = 70;
    fb.buyExecutionEfficiency = 0.2;

    const snap = engine.analyze(
      baseInput({
        tradeDataLowConfidence: true,
        priceChangePercent: 0.02,
        priceImpactEfficiency: 'LOW',
        flowBattle: fb,
        liquidityResponse: lr,
        aggressiveFlow: af,
      }),
    );

    expect(snap.upside.state).not.toBe('LOW_CONFIDENCE');
    expect(snap.upside.state).not.toBe('NO_MEANINGFUL_BATTLE');
  });

  it('keeps upside and downside battle scores independent', () => {
    const af = flowFromEngine('both');
    const fb = emptyFlowBattle();
    fb.battle.passiveSellerStrength = 35;
    fb.battle.passiveBuyerStrength = 80;
    fb.buyExecutionEfficiency = 0.8;
    fb.sellExecutionEfficiency = 0.15;

    const lr = emptyLiquidityResponse();
    lr.dataQuality = 85;
    lr.confidence = 'HIGH';
    lr.askConsumption = 'HIGH';
    lr.askReplenishment = 'LOW';
    lr.efficiency = 'HIGH';
    lr.bidConsumption = 'HIGH';
    lr.bidReplenishment = 'HIGH';

    const snap = engine.analyze(
      baseInput({
        priceChangePercent: 0.25,
        priceImpactEfficiency: 'HIGH',
        flowBattle: fb,
        liquidityResponse: lr,
        aggressiveFlow: af,
      }),
    );

    expect(snap.upsideBattleScore + snap.downsideBattleScore).not.toBe(100);
    expect(snap.upside.aggressive.power).toBeGreaterThan(0);
    expect(snap.downside.aggressive.power).toBeGreaterThan(0);
  });
});
