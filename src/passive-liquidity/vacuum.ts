import type { PassiveLiquidityConfig } from '../config/types.js';
import { clamp } from '../core/integrity.js';
import type { VacuumAssessment } from '../models/passive-liquidity.js';

export interface VacuumInput {
  nearDepthPercentile: number;
  withdrawalPercentile: number;
  replenishmentPercentile: number;
  distanceToNextWallBps: number;
  priceEfficiencyPercentile: number;
  spreadExpansionBps: number;
}

export function emptyVacuum(direction: 'UP' | 'DOWN'): VacuumAssessment {
  return {
    direction,
    score: 0,
    detected: false,
    nearDepthPercentile: 50,
    withdrawalPercentile: 50,
    replenishmentPercentile: 50,
    distanceToNextWallBps: Number.POSITIVE_INFINITY,
    priceEfficiencyPercentile: 50,
    spreadExpansionBps: 0,
  };
}

/**
 * A vacuum is thin, withdrawing, non-replenishing liquidity where modest
 * aggression produces outsized displacement. Thin depth alone is not a vacuum.
 */
export function assessVacuum(
  direction: 'UP' | 'DOWN',
  input: VacuumInput,
  config: PassiveLiquidityConfig,
  trustworthy: boolean,
): VacuumAssessment {
  const thin = clamp(1 - input.nearDepthPercentile / 100, 0, 1);
  const withdrawing = clamp(input.withdrawalPercentile / 100, 0, 1);
  const notReplenishing = clamp(1 - input.replenishmentPercentile / 100, 0, 1);
  const efficient = clamp(input.priceEfficiencyPercentile / 100, 0, 1);
  const runway = Number.isFinite(input.distanceToNextWallBps)
    ? clamp(input.distanceToNextWallBps / config.maxTrackedBps, 0, 1)
    : 1;
  const spread = clamp(input.spreadExpansionBps / 5, 0, 1);

  const score =
    clamp(
      0.28 * thin + 0.22 * withdrawing + 0.18 * notReplenishing + 0.14 * runway + 0.13 * efficient + 0.05 * spread,
      0,
      1,
    ) * 100;

  const gatesMet =
    input.nearDepthPercentile <= config.lowPercentile &&
    input.replenishmentPercentile <= config.highPercentile &&
    (input.withdrawalPercentile >= config.highPercentile ||
      input.priceEfficiencyPercentile >= config.highPercentile);

  return {
    direction,
    score,
    detected: trustworthy && gatesMet && score >= config.minVacuumScore,
    nearDepthPercentile: input.nearDepthPercentile,
    withdrawalPercentile: input.withdrawalPercentile,
    replenishmentPercentile: input.replenishmentPercentile,
    distanceToNextWallBps: input.distanceToNextWallBps,
    priceEfficiencyPercentile: input.priceEfficiencyPercentile,
    spreadExpansionBps: input.spreadExpansionBps,
  };
}
