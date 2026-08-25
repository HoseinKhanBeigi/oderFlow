import type { WindowSnapshot } from '../models/signals.js';
import type {
  FlowBias,
  FuturesContextLabel,
  SpotFuturesComparison,
  SpotFuturesLeg,
  SpotVsFuturesRelation,
  SpotWindowStats,
} from './types.js';

export interface FuturesContextInput {
  futures: WindowSnapshot | null;
  oiUsd: number | null;
  prevOiUsd: number | null;
}

function biasFromDelta(delta: number, deltaPercent: number, flow?: string): FlowBias {
  if (flow?.includes('BUYING') || flow?.includes('BUY')) return 'BUY';
  if (flow?.includes('SELLING') || flow?.includes('SELL')) return 'SELL';
  if (deltaPercent >= 0.12 && delta > 0) return 'BUY';
  if (deltaPercent <= -0.12 && delta < 0) return 'SELL';
  return 'NEUTRAL';
}

function relation(spot: FlowBias, futures: FlowBias): SpotVsFuturesRelation {
  if (spot === 'BUY' && futures === 'BUY') return 'BROAD_BUYING_CONFIRMATION';
  if (spot === 'SELL' && futures === 'SELL') return 'BROAD_SELLING_CONFIRMATION';
  if (spot === 'BUY' && futures === 'SELL') return 'SPOT_FUTURES_DIVERGENCE';
  if (spot === 'SELL' && futures === 'BUY') return 'SPOT_FUTURES_DIVERGENCE';
  if (spot === 'BUY' && futures === 'NEUTRAL') return 'SPOT_LED_BUYING';
  if (spot === 'SELL' && futures === 'NEUTRAL') return 'SPOT_LED_SELLING';
  if (spot === 'NEUTRAL' && futures === 'BUY') return 'FUTURES_LED_BUYING';
  if (spot === 'NEUTRAL' && futures === 'SELL') return 'FUTURES_LED_SELLING';
  return 'NEUTRAL';
}

function oiChangePercent(oiUsd: number | null, prevOiUsd: number | null): number | null {
  if (oiUsd == null || prevOiUsd == null || prevOiUsd <= 0) return null;
  return ((oiUsd - prevOiUsd) / prevOiUsd) * 100;
}

/**
 * Classify how spot and futures currently relate. Labels are interpretations,
 * not trade signals.
 */
export function compareSpotFutures(spot: SpotWindowStats, ctx: FuturesContextInput): SpotFuturesComparison {
  const fw = ctx.futures;
  const oiPct = oiChangePercent(ctx.oiUsd, ctx.prevOiUsd);
  const shortLiq = fw?.forcedBuyVolume ?? 0;
  const longLiq = fw?.forcedSellVolume ?? 0;
  const futuresCvd = fw ? fw.aggressiveBuyVolume - fw.aggressiveSellVolume : 0;

  const spotLeg: SpotFuturesLeg = {
    aggressiveBuyVolume: spot.aggressiveBuyVolume,
    aggressiveSellVolume: spot.aggressiveSellVolume,
    delta: spot.delta,
    cvd: spot.cvd,
    efficiency: spot.efficiency.rank,
    oiChangePercent: null,
    liquidationUsd: 0,
    shortLiquidationUsd: 0,
    longLiquidationUsd: 0,
  };

  const futuresLeg: SpotFuturesLeg = {
    aggressiveBuyVolume: fw?.aggressiveBuyVolume ?? 0,
    aggressiveSellVolume: fw?.aggressiveSellVolume ?? 0,
    delta: fw?.delta ?? 0,
    cvd: futuresCvd,
    efficiency: fw?.priceImpactEfficiency ?? 'NORMAL',
    oiChangePercent: oiPct,
    liquidationUsd: shortLiq + longLiq,
    shortLiquidationUsd: shortLiq,
    longLiquidationUsd: longLiq,
  };

  const spotBias = biasFromDelta(spot.delta, spot.deltaPercent, spot.flow);
  const futuresBias = biasFromDelta(fw?.delta ?? 0, fw?.deltaPercent ?? 0);
  const rel = relation(spotBias, futuresBias);
  const priceChange = spot.efficiency.priceChangePercent;
  const futuresDelta = fw?.delta ?? 0;
  const oiUp = oiPct != null && oiPct > 0.05;
  const oiDown = oiPct != null && oiPct < -0.05;
  const futuresBuy = futuresDelta > 0 && (fw?.deltaPercent ?? 0) > 0.05;
  const futuresSell = futuresDelta < 0 && (fw?.deltaPercent ?? 0) < -0.05;
  const spotBuy = spotBias === 'BUY';
  const spotSell = spotBias === 'SELL';
  const spotWeak = !spotBuy;
  const liqTotal = shortLiq + longLiq;
  const shortCovering =
    liqTotal > 0 && shortLiq >= longLiq * 1.25 && shortLiq / Math.max(fw?.aggressiveBuyVolume ?? 1, 1) >= 0.08;
  const longWiping =
    liqTotal > 0 && longLiq >= shortLiq * 1.25 && longLiq / Math.max(fw?.aggressiveSellVolume ?? 1, 1) >= 0.08;

  let interpretation: FuturesContextLabel = 'UNCLEAR';
  if (priceChange > 0 && futuresBuy && oiDown && shortCovering && spotWeak) {
    interpretation = 'SHORT_COVERING_DOMINATED_RALLY';
  } else if (priceChange < 0 && futuresSell && oiDown && longWiping) {
    interpretation = 'LONG_LIQUIDATION_DELEVERAGING';
  } else if (priceChange > 0 && futuresBuy && oiUp && spotBuy) {
    interpretation = 'NEW_LEVERAGED_BUYING_SPOT_CONFIRMATION';
  } else if (priceChange < 0 && futuresSell && oiUp && spotSell) {
    interpretation = 'NEW_SHORTS_SPOT_SELLING';
  } else if (rel === 'SPOT_LED_BUYING') {
    interpretation = 'SPOT_LED_BUYING';
  } else if (rel === 'FUTURES_LED_BUYING') {
    interpretation = 'FUTURES_LED_BUYING';
  } else if (rel === 'BROAD_BUYING_CONFIRMATION') {
    interpretation = 'BROAD_BUYING';
  } else if (rel === 'BROAD_SELLING_CONFIRMATION') {
    interpretation = 'BROAD_SELLING';
  } else if (rel === 'SPOT_FUTURES_DIVERGENCE') {
    interpretation = 'DIVERGENCE';
  } else if (rel === 'SPOT_LED_SELLING' || rel === 'FUTURES_LED_SELLING') {
    interpretation = 'DIVERGENCE';
  }

  return {
    spot: spotLeg,
    futures: futuresLeg,
    spotBias,
    futuresBias,
    relation: rel,
    interpretation,
  };
}
