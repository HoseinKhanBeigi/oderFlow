import type { PassiveLiquidityConfig } from '../config/types.js';
import { clamp } from '../core/integrity.js';
import type { AbsorptionAssessment } from '../models/passive-liquidity.js';

export interface AbsorptionInput {
  /** Percentile of aggressive flow hitting the passive side. */
  aggressionPercentile: number;
  /** Percentile of passive liquidity consumed on that side. */
  consumptionPercentile: number;
  /** Percentile of replenishment on that side. */
  replenishmentPercentile: number;
  /** Percentile of price displacement in the aggressor's direction. */
  displacementPercentile: number;
  replenishmentRatio: number;
  aggressionNotional: number;
  consumedNotional: number;
}

export function emptyAbsorption(
  type: 'SELLER_ABSORPTION' | 'BUYER_ABSORPTION',
): AbsorptionAssessment {
  return {
    type: null,
    absorbingSide: type === 'SELLER_ABSORPTION' ? 'ASK' : 'BID',
    score: 0,
    confidence: 0,
    aggressionPercentile: 50,
    consumptionPercentile: 50,
    replenishmentPercentile: 50,
    displacementPercentile: 50,
    detected: false,
  };
}

/**
 * Absorption needs three independent things at once: aggressive flow arriving,
 * passive liquidity being consumed and coming back, and price failing to move.
 *
 * Delta on its own is never enough. A +$500M delta with a big upward move is
 * aggressive buyers succeeding, not passive sellers absorbing them.
 */
export function assessAbsorption(
  type: 'SELLER_ABSORPTION' | 'BUYER_ABSORPTION',
  input: AbsorptionInput,
  config: PassiveLiquidityConfig,
  trustworthy: boolean,
): AbsorptionAssessment {
  const aggression = clamp(input.aggressionPercentile / 100, 0, 1);
  const consumption = clamp(input.consumptionPercentile / 100, 0, 1);
  const replenishment = clamp(input.replenishmentPercentile / 100, 0, 1);
  const stalled = clamp(1 - input.displacementPercentile / 100, 0, 1);
  const ratio = clamp(input.replenishmentRatio, 0, 1);

  const score =
    clamp(
      0.28 * aggression + 0.22 * consumption + 0.22 * replenishment + 0.2 * stalled + 0.08 * ratio,
      0,
      1,
    ) * 100;

  const gatesMet =
    input.aggressionPercentile >= config.highPercentile &&
    input.consumptionPercentile >= config.highPercentile &&
    input.replenishmentPercentile >= config.highPercentile &&
    input.displacementPercentile <= config.lowPercentile &&
    input.aggressionNotional > 0 &&
    input.consumedNotional > 0;

  const detected = trustworthy && gatesMet && score >= config.minAbsorptionScore;

  // Weakest link caps confidence: one missing leg makes the read unreliable.
  const confidence = clamp(Math.min(aggression, consumption, replenishment, stalled), 0, 1) * 100;

  return {
    type: detected ? type : null,
    absorbingSide: type === 'SELLER_ABSORPTION' ? 'ASK' : 'BID',
    score,
    confidence,
    aggressionPercentile: input.aggressionPercentile,
    consumptionPercentile: input.consumptionPercentile,
    replenishmentPercentile: input.replenishmentPercentile,
    displacementPercentile: input.displacementPercentile,
    detected,
  };
}
