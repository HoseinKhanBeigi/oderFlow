import { clamp, safeDiv } from '../core/integrity.js';
import type { PassiveLiquidityConfig } from '../config/types.js';

export interface LevelScoreInput {
  ageMs: number;
  presentMs: number;
  distanceBps: number;
  quantity: number;
  maxQuantity: number;
  consumedQuantity: number;
  cancelledQuantity: number;
  replenishedQuantity: number;
  attackCount: number;
  defendedCount: number;
  replenishmentCount: number;
}

/** exp(-k * bps): near-touch liquidity is worth more than distant liquidity. */
export function distanceWeight(distanceBps: number, k: number): number {
  if (!Number.isFinite(distanceBps) || distanceBps < 0) return 0;
  return Math.exp(-k * distanceBps);
}

export function replenishmentRatio(replenished: number, consumed: number): number {
  if (consumed <= 0) return replenished > 0 ? 1 : 0;
  return replenished / consumed;
}

/**
 * Share of the level's disappearance that was pulled rather than executed.
 * Remaining size counts in the denominator so a level that mostly still exists
 * cannot score as heavily withdrawn.
 */
export function withdrawalShare(input: LevelScoreInput): number {
  const total = input.cancelledQuantity + input.consumedQuantity + input.quantity;
  return total <= 0 ? 0 : input.cancelledQuantity / total;
}

/**
 * Age alone is not persistence. A level that has been attacked and replenished
 * scores higher than an untested level of the same age, and a level bleeding
 * cancellations is penalised regardless of how long it has existed.
 */
export function persistenceScore(input: LevelScoreInput, config: PassiveLiquidityConfig): number {
  const matureSec = Math.max(1, config.wallMatureMs / 1_000);
  const ageFactor = clamp(
    Math.log1p(Math.max(0, input.presentMs) / 1_000) / Math.log1p(matureSec),
    0,
    1,
  );
  const presenceRatio = input.ageMs > 0 ? clamp(input.presentMs / input.ageMs, 0, 1) : 0;
  const replenish = clamp(replenishmentRatio(input.replenishedQuantity, input.consumedQuantity), 0, 1);
  const survival = input.attackCount > 0
    ? clamp(input.defendedCount / input.attackCount, 0, 1)
    : 0.5;
  const proximity = distanceWeight(input.distanceBps, config.distanceWeightK);
  const pulled = withdrawalShare(input);

  const raw =
    0.4 * ageFactor +
    0.2 * presenceRatio +
    0.15 * replenish +
    0.15 * survival +
    0.1 * proximity -
    0.35 * pulled;
  return clamp(raw, 0, 1) * 100;
}

export function replenishmentScoreOf(input: LevelScoreInput): number {
  const ratio = clamp(replenishmentRatio(input.replenishedQuantity, input.consumedQuantity), 0, 1.5);
  const repeat = clamp(input.replenishmentCount / 4, 0, 1);
  return clamp(0.75 * (ratio / 1.5) + 0.25 * repeat, 0, 1) * 100;
}

export function withdrawalScoreOf(input: LevelScoreInput, config: PassiveLiquidityConfig): number {
  const share = withdrawalShare(input);
  const proximity = distanceWeight(input.distanceBps, config.distanceWeightK);
  const shrink = input.maxQuantity > 0
    ? clamp(1 - input.quantity / input.maxQuantity, 0, 1)
    : 0;
  return clamp(0.55 * share + 0.25 * shrink + 0.2 * share * proximity, 0, 1) * 100;
}

/**
 * Absorption at a level needs all three: it was executed into, it came back,
 * and it is still there. Any one of them alone is not absorption.
 */
export function absorptionScoreOf(input: LevelScoreInput): number {
  if (input.consumedQuantity <= 0) return 0;
  const consumedShare = input.maxQuantity > 0
    ? clamp(input.consumedQuantity / input.maxQuantity, 0, 1)
    : 0;
  const replenish = clamp(replenishmentRatio(input.replenishedQuantity, input.consumedQuantity), 0, 1);
  const stillThere = input.maxQuantity > 0 ? clamp(input.quantity / input.maxQuantity, 0, 1) : 0;
  const repeat = clamp(safeDiv(input.attackCount, 3), 0, 1);
  return clamp(0.35 * consumedShare + 0.35 * replenish + 0.2 * stillThere + 0.1 * repeat, 0, 1) * 100;
}
