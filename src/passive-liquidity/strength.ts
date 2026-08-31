import type { PassiveStrengthWeights } from '../config/types.js';
import { clamp } from '../core/integrity.js';

export interface StrengthInput {
  depthPercentile: number;
  nearDepthPercentile: number;
  /** 0-100 notional-weighted level persistence. */
  persistenceScore: number;
  replenishmentPercentile: number;
  withdrawalPercentile: number;
  /** Percentile of opposing aggression this side absorbed. */
  absorbedAggressionPercentile: number;
  /** 0-100: how poorly price advanced against this side. */
  priceInefficiency: number;
  defendedTests: number;
  confirmedTestCount: number;
}

/**
 * Weighted composite rather than a plain average, so a single large number
 * cannot carry the score. Withdrawal enters inverted: liquidity that gets
 * pulled reduces strength no matter how much of it is displayed.
 */
export function passiveStrength(input: StrengthInput, weights: PassiveStrengthWeights): number {
  const terms: Array<[number, number]> = [
    [weights.depth, input.depthPercentile / 100],
    [weights.nearDepth, input.nearDepthPercentile / 100],
    [weights.persistence, input.persistenceScore / 100],
    [weights.replenishment, input.replenishmentPercentile / 100],
    [weights.withdrawalInverse, 1 - input.withdrawalPercentile / 100],
    [weights.absorbedAggression, input.absorbedAggressionPercentile / 100],
    [weights.priceInefficiency, input.priceInefficiency / 100],
    [
      weights.defendedTests,
      clamp(input.defendedTests / Math.max(1, input.confirmedTestCount), 0, 1),
    ],
  ];

  let weighted = 0;
  let total = 0;
  for (const [weight, value] of terms) {
    if (weight <= 0) continue;
    weighted += weight * clamp(value, 0, 1);
    total += weight;
  }
  if (total <= 0) return 0;
  return clamp(weighted / total, 0, 1) * 100;
}
