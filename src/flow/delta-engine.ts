import { safeDiv } from '../core/integrity.js';
import type { WindowAggregate } from '../core/bucket-ring.js';

export interface DeltaSnapshot {
  delta: number;
  deltaPercent: number;
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
}

export function computeDelta(agg: WindowAggregate): DeltaSnapshot {
  const buy = agg.buyVolume;
  const sell = agg.sellVolume;
  const delta = buy - sell;
  const total = buy + sell;
  return {
    delta,
    deltaPercent: total === 0 ? 0 : clampUnit(delta / total),
    aggressiveBuyVolume: buy,
    aggressiveSellVolume: sell,
  };
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

export function flowShares(agg: WindowAggregate): {
  largeBuyFlowShare: number;
  largeSellFlowShare: number;
  averageBuySize: number;
  averageSellSize: number;
} {
  return {
    largeBuyFlowShare: safeDiv(agg.largeBuyVolume, agg.buyVolume),
    largeSellFlowShare: safeDiv(agg.largeSellVolume, agg.sellVolume),
    averageBuySize: safeDiv(agg.buyVolume, agg.buyCount),
    averageSellSize: safeDiv(agg.sellVolume, agg.sellCount),
  };
}
