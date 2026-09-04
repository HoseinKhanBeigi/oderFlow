import { describe, expect, it } from 'vitest';
import { emptyFlowBattle } from '../src/models/passive.js';
import { emptyLiquidityResponse } from '../src/liquidity-response/empty.js';
import { MarketBattleEngine } from '../src/market-battle/engine.js';
import type { MarketBattleInput } from '../src/market-battle/engine.js';
import { buildNetAggression } from '../src/flow/net-aggression.js';

function baseInput(overrides: Partial<MarketBattleInput> = {}): MarketBattleInput {
  const lr = emptyLiquidityResponse();
  lr.dataQuality = 80;
  lr.confidence = 'HIGH';
  lr.confidenceScore = 80;
  lr.askDepth.changeState = 'STABLE';
  lr.bidDepth.changeState = 'STABLE';

  const fb = emptyFlowBattle();

  return {
    window: '1m',
    aggressiveBuyVolume: 1_000_000,
    aggressiveSellVolume: 1_000_000,
    buyTradeCount: 100,
    sellTradeCount: 100,
    largeBuyVolume: 200_000,
    largeSellVolume: 200_000,
    priceChangePercent: 0,
    priceImpactEfficiency: 'NORMAL',
    confidence: 0.8,
    tradeDataMissing: false,
    flowBattle: fb,
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
    ...overrides,
  };
}

describe('MarketBattleEngine', () => {
  const engine = new MarketBattleEngine();

  it('marks NO DATA path when trade tape is missing', () => {
    const snap = engine.analyze(
      baseInput({
        tradeDataMissing: true,
        aggressiveBuyVolume: 0,
        aggressiveSellVolume: 0,
      }),
    );
    expect(snap.upside.aggressive.hasData).toBe(false);
    expect(snap.downside.aggressive.hasData).toBe(false);
    expect(snap.upside.state).toBe('NO_MEANINGFUL_BATTLE');
    expect(snap.downside.state).toBe('NO_MEANINGFUL_BATTLE');
  });

  it('detects seller absorption from high buy + replenishment + low efficiency', () => {
    const fb = emptyFlowBattle();
    fb.battle.aggressiveBuyerStrength = 78;
    fb.battle.passiveSellerStrength = 72;
    fb.buyExecutionEfficiency = 0.1;

    const lr = emptyLiquidityResponse();
    lr.dataQuality = 85;
    lr.confidence = 'HIGH';
    lr.askConsumption = 'HIGH';
    lr.askReplenishment = 'HIGH';
    lr.askWithdrawal = 'LOW';
    lr.efficiency = 'LOW';
    lr.absorption.kind = 'BUY_ABSORPTION';
    lr.absorption.detected = true;
    lr.norms.aggressiveBuy.percentile = 82;

    const snap = engine.analyze(
      baseInput({
        aggressiveBuyVolume: 18_400_000,
        priceChangePercent: 0.02,
        priceImpactEfficiency: 'LOW',
        flowBattle: fb,
        liquidityResponse: lr,
        netAggression: buildNetAggression({
          window: '1m',
          buyVolume: 18_400_000,
          sellVolume: 4_000_000,
          buyCount: 900,
          sellCount: 200,
          largeBuyVolume: 6_000_000,
          largeSellVolume: 500_000,
          buyPercentile: 82,
          sellPercentile: 30,
          netMagnitudePercentile: 80,
        }),
      }),
    );

    expect(snap.upside.state).toBe('SELLER_ABSORPTION');
    expect(snap.upside.aggressive.score).toBeGreaterThan(50);
    expect(snap.upsideBattleScore).toBeGreaterThan(0);
  });

  it('detects buyers winning from high buy + low replenishment + high efficiency', () => {
    const fb = emptyFlowBattle();
    fb.battle.aggressiveBuyerStrength = 80;
    fb.battle.passiveSellerStrength = 35;
    fb.buyExecutionEfficiency = 0.85;

    const lr = emptyLiquidityResponse();
    lr.dataQuality = 85;
    lr.confidence = 'HIGH';
    lr.askConsumption = 'HIGH';
    lr.askReplenishment = 'LOW';
    lr.askWithdrawal = 'NORMAL';
    lr.efficiency = 'HIGH';
    lr.norms.aggressiveBuy.percentile = 85;

    const snap = engine.analyze(
      baseInput({
        aggressiveBuyVolume: 20_000_000,
        priceChangePercent: 0.35,
        priceImpactEfficiency: 'HIGH',
        flowBattle: fb,
        liquidityResponse: lr,
        netAggression: buildNetAggression({
          window: '1m',
          buyVolume: 20_000_000,
          sellVolume: 3_000_000,
          buyCount: 1000,
          sellCount: 150,
          largeBuyVolume: 7_000_000,
          largeSellVolume: 400_000,
          buyPercentile: 85,
          sellPercentile: 25,
          netMagnitudePercentile: 88,
        }),
      }),
    );

    expect(snap.upside.state).toBe('BUYERS_WINNING');
  });

  it('detects upside vacuum from withdrawal + thin survival + efficient upside', () => {
    const fb = emptyFlowBattle();
    fb.battle.aggressiveBuyerStrength = 55;
    fb.battle.passiveSellerStrength = 20;
    fb.buyExecutionEfficiency = 0.8;

    const lr = emptyLiquidityResponse();
    lr.dataQuality = 80;
    lr.confidence = 'HIGH';
    lr.askConsumption = 'NORMAL';
    lr.askReplenishment = 'LOW';
    lr.askWithdrawal = 'HIGH';
    lr.efficiency = 'HIGH';
    lr.vacuum = 'UPSIDE_LIQUIDITY_VACUUM';
    lr.norms.aggressiveBuy.percentile = 55;

    const snap = engine.analyze(
      baseInput({
        aggressiveBuyVolume: 8_000_000,
        priceChangePercent: 0.28,
        priceImpactEfficiency: 'HIGH',
        flowBattle: fb,
        liquidityResponse: lr,
        netAggression: buildNetAggression({
          window: '1m',
          buyVolume: 8_000_000,
          sellVolume: 2_000_000,
          buyCount: 400,
          sellCount: 100,
          largeBuyVolume: 2_000_000,
          largeSellVolume: 200_000,
          buyPercentile: 55,
          sellPercentile: 20,
          netMagnitudePercentile: 60,
        }),
      }),
    );

    expect(snap.upside.state).toBe('UPSIDE_VACUUM');
  });

  it('detects buyers defending on the downside battle', () => {
    const fb = emptyFlowBattle();
    fb.battle.aggressiveSellerStrength = 70;
    fb.battle.passiveBuyerStrength = 82;
    fb.sellExecutionEfficiency = 0.1;

    const lr = emptyLiquidityResponse();
    lr.dataQuality = 85;
    lr.confidence = 'HIGH';
    lr.bidConsumption = 'HIGH';
    lr.bidReplenishment = 'HIGH';
    lr.bidWithdrawal = 'LOW';
    lr.efficiency = 'LOW';
    lr.absorption.kind = 'SELL_ABSORPTION';
    lr.norms.aggressiveSell.percentile = 72;

    const snap = engine.analyze(
      baseInput({
        aggressiveSellVolume: 11_200_000,
        priceChangePercent: -0.02,
        priceImpactEfficiency: 'LOW',
        flowBattle: fb,
        liquidityResponse: lr,
        netAggression: buildNetAggression({
          window: '1m',
          buyVolume: 4_000_000,
          sellVolume: 11_200_000,
          buyCount: 200,
          sellCount: 800,
          largeBuyVolume: 500_000,
          largeSellVolume: 4_000_000,
          buyPercentile: 35,
          sellPercentile: 72,
          netMagnitudePercentile: 70,
        }),
      }),
    );

    expect(snap.downside.state === 'BUYER_ABSORPTION' || snap.downside.state === 'BUYERS_DEFENDING').toBe(true);
  });

  it('keeps upside and downside battle scores independent', () => {
    const fb = emptyFlowBattle();
    fb.battle.aggressiveBuyerStrength = 78;
    fb.battle.passiveSellerStrength = 40;
    fb.battle.aggressiveSellerStrength = 50;
    fb.battle.passiveBuyerStrength = 85;
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
    lr.norms.aggressiveBuy.percentile = 80;
    lr.norms.aggressiveSell.percentile = 55;

    const snap = engine.analyze(
      baseInput({
        aggressiveBuyVolume: 18_000_000,
        aggressiveSellVolume: 9_000_000,
        priceChangePercent: 0.25,
        priceImpactEfficiency: 'HIGH',
        flowBattle: fb,
        liquidityResponse: lr,
        netAggression: buildNetAggression({
          window: '1m',
          buyVolume: 18_000_000,
          sellVolume: 9_000_000,
          buyCount: 900,
          sellCount: 500,
          largeBuyVolume: 5_000_000,
          largeSellVolume: 2_000_000,
          buyPercentile: 80,
          sellPercentile: 55,
          netMagnitudePercentile: 70,
        }),
      }),
    );

    expect(snap.upsideBattleScore + snap.downsideBattleScore).not.toBe(100);
    expect(snap.upsideBattleScore).toBeGreaterThan(0);
    expect(snap.downsideBattleScore).toBeGreaterThan(0);
    expect(snap.summary.state).toBe('BUYERS_IN_CONTROL');
  });

  it('returns LOW_CONFIDENCE when book quality is poor during an attack', () => {
    const fb = emptyFlowBattle();
    fb.battle.aggressiveBuyerStrength = 75;

    const lr = emptyLiquidityResponse();
    lr.dataQuality = 20;
    lr.confidence = 'LOW';
    lr.norms.aggressiveBuy.percentile = 80;

    const snap = engine.analyze(
      baseInput({
        aggressiveBuyVolume: 15_000_000,
        flowBattle: fb,
        liquidityResponse: lr,
        netAggression: buildNetAggression({
          window: '1m',
          buyVolume: 15_000_000,
          sellVolume: 2_000_000,
          buyCount: 700,
          sellCount: 100,
          largeBuyVolume: 4_000_000,
          largeSellVolume: 200_000,
          buyPercentile: 80,
          sellPercentile: 20,
          netMagnitudePercentile: 75,
        }),
      }),
    );

    expect(snap.upside.state).toBe('LOW_CONFIDENCE');
    expect(snap.upside.passive.reliable).toBe(false);
  });
});
