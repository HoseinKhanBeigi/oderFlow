import type {
  AggressionSide,
  LiquidityMarketCompare,
  LiquidityMarketLeg,
  LiquidityMarketRelation,
  LiquidityResponseSnapshot,
  LiquiditySideResponse,
} from '../models/liquidity-response.js';

export interface OtherMarketContext {
  snapshot: LiquidityResponseSnapshot;
  oiChangePercent: number | null;
  forcedBuyVolume: number;
  forcedSellVolume: number;
}

/**
 * Compare independently-run spot and futures liquidity-response snapshots.
 * Raw deltas are never summed.
 */
export function compareLiquidityMarkets(
  spot: LiquidityResponseSnapshot,
  futures: OtherMarketContext | null,
): LiquidityMarketCompare | null {
  if (!futures) return null;
  const f = futures.snapshot;
  const spotLeg = toLeg('spot', spot, null, 0, 0);
  const futLeg = toLeg('perp', f, futures.oiChangePercent, futures.forcedBuyVolume, futures.forcedSellVolume);
  const relation = classifyRelation(spotLeg, futLeg);
  return {
    spot: spotLeg,
    futures: futLeg,
    relation,
    confirmed:
      relation === 'BROAD_BUYING_CONFIRMATION' || relation === 'BROAD_SELLING_CONFIRMATION',
  };
}

function toLeg(
  market: 'spot' | 'perp',
  snap: LiquidityResponseSnapshot,
  oiChangePercent: number | null,
  forcedBuy: number,
  forcedSell: number,
): LiquidityMarketLeg {
  const withdrawal = market === 'spot'
    ? maxIntensity(snap.askWithdrawal, snap.bidWithdrawal)
    : maxIntensity(snap.askWithdrawal, snap.bidWithdrawal);
  const bookResponse = dominantBook(snap);
  return {
    market,
    aggression: snap.aggression,
    delta: snap.delta,
    bookResponse,
    absorption: snap.absorption.kind,
    withdrawal,
    efficiency: snap.efficiency,
    oiChangePercent,
    liquidations: forcedBuy + forcedSell,
  };
}

function dominantBook(snap: LiquidityResponseSnapshot): LiquiditySideResponse {
  if (snap.aggression === 'BUYERS') return snap.askResponse;
  if (snap.aggression === 'SELLERS') return snap.bidResponse;
  return snap.askResponse !== 'QUIET' ? snap.askResponse : snap.bidResponse;
}

function classifyRelation(spot: LiquidityMarketLeg, fut: LiquidityMarketLeg): LiquidityMarketRelation {
  const spotBuy = isBuy(spot.aggression, spot.delta);
  const spotSell = isSell(spot.aggression, spot.delta);
  const futBuy = isBuy(fut.aggression, fut.delta);
  const futSell = isSell(fut.aggression, fut.delta);
  const oiUp = (fut.oiChangePercent ?? 0) > 0.05;
  const oiDown = (fut.oiChangePercent ?? 0) < -0.05;
  const shortLiqDom = fut.liquidations > 0 && fut.aggression === 'BUYERS' && oiDown;
  const longLiqDom = fut.liquidations > 0 && fut.aggression === 'SELLERS' && oiDown;

  const askGone = spot.bookResponse === 'WITHDRAWAL' || spot.bookResponse === 'CONSUMPTION';
  const spotEfficientBuy = spotBuy && spot.efficiency !== 'LOW' && askGone;

  if (spotEfficientBuy && futBuy && oiUp) return 'BROAD_BUYING_CONFIRMATION';
  if (spotSell && futSell && (oiUp || spot.efficiency !== 'LOW')) return 'BROAD_SELLING_CONFIRMATION';
  if (spot.absorption === 'SELL_ABSORPTION' && futBuy && (oiDown || shortLiqDom)) {
    return 'SHORT_SQUEEZE_DOMINATED_MOVE';
  }
  if (spot.absorption === 'BUY_ABSORPTION' && futSell && (oiDown || longLiqDom)) {
    return 'LONG_LIQUIDATION_DOMINATED_MOVE';
  }
  if ((spotBuy && futSell) || (spotSell && futBuy)) return 'SPOT_FUTURES_DIVERGENCE';
  if (spotBuy && futBuy) return 'BROAD_BUYING_CONFIRMATION';
  if (spotSell && futSell) return 'BROAD_SELLING_CONFIRMATION';
  return 'NEUTRAL';
}

function isBuy(side: AggressionSide, delta: number): boolean {
  return side === 'BUYERS' || (side === 'BALANCED' && delta > 0);
}

function isSell(side: AggressionSide, delta: number): boolean {
  return side === 'SELLERS' || (side === 'BALANCED' && delta < 0);
}

function maxIntensity(a: LiquidityResponseSnapshot['askWithdrawal'], b: LiquidityResponseSnapshot['bidWithdrawal']) {
  const rank = { LOW: 0, NORMAL: 1, HIGH: 2, EXTREME: 3 };
  return rank[a] >= rank[b] ? a : b;
}
