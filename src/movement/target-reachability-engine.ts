import type { MovePotentialConfig } from '../config/types.js';
import { clamp } from '../core/integrity.js';
import type { LiquidityTarget, TargetDifficulty, TargetReachabilityInput } from '../models/movement.js';
import { clamp01, efficiencyFactor } from './math.js';

/**
 * Reachability Score is a 0–100 path-difficulty index, NOT a probability.
 * Phase 1 uses flow/liquidity, density, ATR-normalized distance, impact, and absorption.
 * Phase 2 adds consumption, replenishment, pulling, walls, and vacuums.
 * Liquidations remain a neutral 0.5 until Phase 3.
 */
export class TargetReachabilityEngine {
  constructor(private readonly config: MovePotentialConfig) {}

  score(input: TargetReachabilityInput): LiquidityTarget {
    const w = this.config.reachability;
    const distAbs = Math.abs(input.target.distancePercent);
    const priceMove = Math.abs(input.target.price) * (distAbs / 100);
    const atrDistance = input.atr > 0 ? priceMove / input.atr : distAbs;

    const coverage = input.target.cumulativeLiquidity > 0
      ? input.flowToward / input.target.cumulativeLiquidity
      : input.flowToward > 0 ? 2 : 0;
    const flowToLiq = clamp01(coverage / 1.5);
    const pressure = clamp01(input.pressureRatio / this.config.pressureVeryStrong);
    const percentile = clamp01(input.pressurePercentile / 100);
    const flowComponent = flowToLiq * 0.6 + pressure * 0.25 + percentile * 0.15;

    const thickPenalty = input.target.densityClass === 'EXTREMELY_THICK'
      ? 0.15
      : input.target.densityClass === 'THICK'
        ? 0.4
        : input.target.densityClass === 'THIN'
          ? 0.9
          : 0.65;
    const relativeHard = clamp01(input.target.relativeLiquidity / 4);
    const densityEase = thickPenalty * (1 - relativeHard * 0.5);

    const distanceEase = 1 - clamp01(atrDistance / 3);
    const efficiency = efficiencyFactor(input.impactEfficiency);
    const absorption = input.absorptionToward ? 0.35 : 1;
    const quality = clamp01(input.dataQualityScore);

    const consumptionEase = clamp01(input.consumptionEase * (1 - input.replenishmentDrag));
    const pullingEase = clamp01(input.pullEase);
    let structure = densityEase;
    if (input.wallAhead && input.pullEase < 0.45 && input.consumptionEase < 0.45) structure *= 0.45;
    if (input.vacuumAhead) structure = clamp01(structure + 0.2);

    const raw =
      w.flowToLiquidity * flowComponent +
      w.flowAcceleration * 0.5 +
      w.liquidityConsumption * consumptionEase +
      w.liquidityPulling * pullingEase +
      w.liquidationAcceleration * 0.5 +
      w.priceEfficiency * efficiency +
      w.volatilityDistance * distanceEase +
      w.structuralAlignment * structure;

    const replenishmentPenalty = input.replenishmentDrag > 0.55 ? 0.7 : 1;
    const reachabilityScore = Math.round(
      clamp(raw * absorption * replenishmentPenalty * (0.5 + 0.5 * quality) * 100, 0, 100),
    );

    return {
      ...input.target,
      reachabilityScore,
      difficulty: this.difficulty(reachabilityScore),
    };
  }

  difficulty(score: number): TargetDifficulty {
    if (score >= this.config.easyScore + 10) return 'VERY_EASY';
    if (score >= this.config.easyScore) return 'EASY';
    if (score >= this.config.moderateScore) return 'MODERATE';
    if (score >= this.config.difficultScore) return 'DIFFICULT';
    return 'VERY_DIFFICULT';
  }
}
