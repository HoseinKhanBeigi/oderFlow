import type {
  CrossMarketState,
  IntensityLabel,
  LiquidityMarketCompare,
  LiquidityMarketLeg,
  LiquidityResponseSnapshot,
  LiquiditySideResponse,
  OiInterpretation,
} from '../models/liquidity-response.js';
import { interpretOi } from './oi-context.js';

export interface CrossMarketLegInput {
  snapshot: LiquidityResponseSnapshot;
  deltaPercent: number;
  oiChangePercent: number | null;
  shortLiquidationUsd: number;
  longLiquidationUsd: number;
}

export class CrossMarketConfirmationEngine {
  classify(spot: CrossMarketLegInput, futures: CrossMarketLegInput, oiThreshold: number): LiquidityMarketCompare {
    const spotLeg = toLeg('spot', spot, null, oiThreshold);
    const futOi = interpretOi({
      priceChangePercent: futures.snapshot.priceMovePercent,
      futuresDelta: futures.snapshot.delta,
      oiChangePercent: futures.oiChangePercent,
      threshold: oiThreshold,
    });
    const futLeg = toLeg('perp', futures, futOi, oiThreshold);
    const relation = relationOf(spotLeg, futLeg, futures.snapshot.priceMovePercent, futOi);
    const confirmed = relation === 'BROAD_BUYING' || relation === 'BROAD_SELLING';
    const inefficient =
      (relation === 'BROAD_BUYING' || relation === 'LEVERAGE_DRIVEN_LONGS') &&
      (spotLeg.efficiency === 'LOW' || futLeg.efficiency === 'LOW');
    return {
      spot: spotLeg,
      futures: futLeg,
      relation,
      confirmed,
      inefficient,
      oiInterpretation: futOi,
      confidenceScore: combinedConfidence(spotLeg, futLeg, relation, confirmed),
      note: noteFor(relation, inefficient, futOi),
    };
  }
}

function toLeg(
  market: 'spot' | 'perp',
  src: CrossMarketLegInput,
  oi: OiInterpretation | null,
  _threshold: number,
): LiquidityMarketLeg {
  const s = src.snapshot;
  const total = Math.max(1, s.executed);
  return {
    market,
    state: s.state,
    aggression: s.aggression,
    delta: s.delta,
    deltaPercent: src.deltaPercent || s.delta / total,
    cvdDirection: s.cvdDirection,
    bookResponse: dominantBook(s),
    absorption: s.absorption.kind,
    withdrawal: maxIntensity(s.askWithdrawal, s.bidWithdrawal),
    efficiency: s.efficiency,
    effort: s.effort,
    oiChangePercent: src.oiChangePercent,
    oiInterpretation: market === 'perp' ? oi : null,
    shortLiquidationUsd: src.shortLiquidationUsd,
    longLiquidationUsd: src.longLiquidationUsd,
    liquidations: src.shortLiquidationUsd + src.longLiquidationUsd,
  };
}

function dominantBook(s: LiquidityResponseSnapshot): LiquiditySideResponse {
  if (s.aggression === 'BUYERS') return s.askResponse;
  if (s.aggression === 'SELLERS') return s.bidResponse;
  return s.askResponse !== 'QUIET' ? s.askResponse : s.bidResponse;
}

function relationOf(
  spot: LiquidityMarketLeg,
  fut: LiquidityMarketLeg,
  priceChangePercent: number,
  oi: OiInterpretation | null,
): CrossMarketState {
  const sBuy = isBuy(spot);
  const sSell = isSell(spot);
  const fBuy = isBuy(fut);
  const fSell = isSell(fut);
  const pxUp = priceChangePercent > 0.04;
  const pxDown = priceChangePercent < -0.04;
  const shortLiq = fut.shortLiquidationUsd > 0 && fut.shortLiquidationUsd >= fut.longLiquidationUsd * 1.25;
  const longLiq = fut.longLiquidationUsd > 0 && fut.longLiquidationUsd >= fut.shortLiquidationUsd * 1.25;

  if (pxUp && fBuy && oi === 'LIKELY_SHORT_COVERING' && shortLiq) return 'SHORT_COVERING_DOMINATED';
  if (pxDown && fSell && oi === 'LIKELY_LONG_UNWIND' && longLiq) return 'LONG_LIQUIDATION_DOMINATED';
  if (pxUp && fBuy && oi === 'LIKELY_NEW_LONGS') {
    if (sBuy) return 'BROAD_BUYING';
    return 'LEVERAGE_DRIVEN_LONGS';
  }
  if (pxDown && fSell && oi === 'LIKELY_NEW_SHORTS') {
    if (sSell) return 'BROAD_SELLING';
    return 'LEVERAGE_DRIVEN_SHORTS';
  }

  if (sBuy && fBuy) return 'BROAD_BUYING';
  if (sSell && fSell) return 'BROAD_SELLING';
  if (sBuy && !fBuy && !fSell) return 'SPOT_LED_BUYING';
  if (sSell && !fBuy && !fSell) return 'SPOT_LED_SELLING';
  if (fBuy && !sBuy && !sSell) return 'FUTURES_LED_BUYING';
  if (fSell && !sBuy && !sSell) return 'FUTURES_LED_SELLING';
  if (sBuy && fSell) return 'SPOT_FUTURES_BULLISH_DIVERGENCE';
  if (sSell && fBuy) return 'SPOT_FUTURES_BEARISH_DIVERGENCE';
  if (!sBuy && !sSell && !fBuy && !fSell) return 'BALANCED';
  return 'UNRESOLVED';
}

function isBuy(leg: LiquidityMarketLeg): boolean {
  return (
    leg.aggression === 'BUYERS' ||
    (leg.aggression === 'BALANCED' && leg.delta > 0 && Math.abs(leg.deltaPercent) >= 0.12)
  );
}

function isSell(leg: LiquidityMarketLeg): boolean {
  return (
    leg.aggression === 'SELLERS' ||
    (leg.aggression === 'BALANCED' && leg.delta < 0 && Math.abs(leg.deltaPercent) >= 0.12)
  );
}

function combinedConfidence(
  spot: LiquidityMarketLeg,
  fut: LiquidityMarketLeg,
  relation: CrossMarketState,
  confirmed: boolean,
): number {
  let s = 40;
  if (confirmed) s += 22;
  if (relation.includes('DIVERGENCE')) s -= 18;
  if (spot.efficiency === fut.efficiency && spot.efficiency !== 'LOW') s += 8;
  if (spot.cvdDirection === fut.cvdDirection && spot.cvdDirection !== 'FLAT') s += 8;
  if (fut.oiChangePercent == null) s -= 8;
  return Math.max(0, Math.min(100, s));
}

function noteFor(relation: CrossMarketState, inefficient: boolean, oi: OiInterpretation | null): string {
  if (relation === 'BROAD_BUYING' && inefficient) return 'BROAD BUYING BUT INEFFICIENT';
  if (relation === 'BROAD_SELLING' && inefficient) return 'BROAD SELLING BUT INEFFICIENT';
  if (oi && oi !== 'UNCLEAR') return `${relation.replace(/_/g, ' ')} · ${oi.replace(/_/g, ' ')}`;
  return relation.replace(/_/g, ' ');
}

function maxIntensity(a: IntensityLabel, b: IntensityLabel): IntensityLabel {
  const rank: Record<IntensityLabel, number> = { LOW: 0, NORMAL: 1, HIGH: 2, EXTREME: 3 };
  return rank[a] >= rank[b] ? a : b;
}
