import type { LiquidityMarketCompare, LiquidityResponseSnapshot } from '../models/liquidity-response.js';
import { CrossMarketConfirmationEngine, type CrossMarketLegInput } from './cross-market.js';

export interface OtherMarketContext {
  snapshot: LiquidityResponseSnapshot;
  oiChangePercent: number | null;
  forcedBuyVolume: number;
  forcedSellVolume: number;
}

const engine = new CrossMarketConfirmationEngine();

/**
 * Compare independently-run spot and futures liquidity-response snapshots.
 * Raw deltas are never summed. Cross-market confirmation is only meaningful
 * when both legs exist (Spot vs Futures mode).
 */
export function compareLiquidityMarkets(
  spot: LiquidityResponseSnapshot,
  futures: OtherMarketContext | null,
  oiThreshold = 0.05,
): LiquidityMarketCompare | null {
  if (!futures) return null;
  const spotIn: CrossMarketLegInput = {
    snapshot: spot,
    deltaPercent: spot.executed > 0 ? spot.delta / spot.executed : 0,
    oiChangePercent: null,
    shortLiquidationUsd: 0,
    longLiquidationUsd: 0,
  };
  const futIn: CrossMarketLegInput = {
    snapshot: futures.snapshot,
    deltaPercent: futures.snapshot.executed > 0 ? futures.snapshot.delta / futures.snapshot.executed : 0,
    oiChangePercent: futures.oiChangePercent,
    shortLiquidationUsd: futures.forcedBuyVolume,
    longLiquidationUsd: futures.forcedSellVolume,
  };
  return engine.classify(spotIn, futIn, oiThreshold);
}
