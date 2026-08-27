import { RollingDistribution } from '../core/rolling-stats.js';
import { clamp, intensityFromPercentile, intensityFromRatio, safeDiv } from './math.js';
import type { CalibrationParams, IntensityLabel } from './types.js';
import { EPSILON } from './types.js';

export interface ImpactInputs {
  aggressiveBuy: number;
  aggressiveSell: number;
  nearbyAsk: number;
  nearbyBid: number;
  askConsumption: number;
  bidConsumption: number;
  askReplenishment: number;
  bidReplenishment: number;
  askWithdrawal: number;
  bidWithdrawal: number;
  buyerAbsorption: number;
  sellerAbsorption: number;
  volatility: number;
  spreadBps: number;
  levelsClearedUp: number;
  levelsClearedDown: number;
  leftoverBuy: number;
  leftoverSell: number;
  ofi: number;
  realizedBps: number;
  typicalLevel: number;
}

export interface ImpactDiagnostics {
  upsidePressure: number;
  downsidePressure: number;
  netPressure: number;
  leftoverGapBps: number;
  temporaryImpactBps: number;
  efficiency: IntensityLabel;
  impactPerMillion: number;
}

/**
 * Empirical microstructure price-impact diagnostics.
 *
 * NOT the price integrator. Price primarily moves because the book was
 * walked. This model explains leftover pressure, vacuum gaps, and
 * efficiency — and never uses F = ma.
 *
 * Conceptually:
 *   ΔPrice = f(OFI, depth, consumption, replenishment, withdrawal,
 *              absorption, volatility, liquidations)
 *
 * The simple ratio Aggressive / NearbyDepth is a pressure diagnostic,
 * not the final displacement.
 */
export class PriceImpactEngine {
  private temporaryImpact = 0;
  private ofiMemory = 0;
  readonly impactDist = new RollingDistribution(2_048);
  readonly efficiencyDist = new RollingDistribution(2_048);

  constructor(private params: CalibrationParams) {}

  setParams(params: CalibrationParams): void {
    this.params = params;
  }

  reset(): void {
    this.temporaryImpact = 0;
    this.ofiMemory = 0;
  }

  measure(input: ImpactInputs): ImpactDiagnostics {
    const p = this.params;
    const upsidePressure = safeDiv(input.aggressiveBuy, Math.max(input.nearbyAsk, EPSILON));
    const downsidePressure = safeDiv(input.aggressiveSell, Math.max(input.nearbyBid, EPSILON));
    const netPressure = upsidePressure - downsidePressure;

    this.ofiMemory = p.imbalanceMemory * input.ofi + (1 - p.imbalanceMemory) * this.ofiMemory;

    const askRepl = safeDiv(input.askReplenishment, Math.max(input.askConsumption, input.aggressiveBuy, EPSILON));
    const bidRepl = safeDiv(input.bidReplenishment, Math.max(input.bidConsumption, input.aggressiveSell, EPSILON));
    const askPull = safeDiv(input.askWithdrawal, Math.max(input.nearbyAsk + input.askWithdrawal, EPSILON));
    const bidPull = safeDiv(input.bidWithdrawal, Math.max(input.nearbyBid + input.bidWithdrawal, EPSILON));

    const absorptionDamp = 1 - clamp(
      Math.max(input.buyerAbsorption, input.sellerAbsorption) * p.absorptionDamp,
      0,
      0.95,
    );

    // Leftover aggression only gaps when the book on that side is gone (vacuum).
    const buyGap = input.leftoverBuy > 0 && input.nearbyAsk <= EPSILON
      ? (input.leftoverBuy / Math.max(input.typicalLevel, EPSILON))
        * p.vacuumGapCoeff
        * (1 + input.volatility * p.volatilityScale)
        * (1 + askPull * p.withdrawalAmplify)
        * (1 - clamp(askRepl * p.replenishmentDamp, 0, 0.9))
      : 0;
    const sellGap = input.leftoverSell > 0 && input.nearbyBid <= EPSILON
      ? (input.leftoverSell / Math.max(input.typicalLevel, EPSILON))
        * p.vacuumGapCoeff
        * (1 + input.volatility * p.volatilityScale)
        * (1 + bidPull * p.withdrawalAmplify)
        * (1 - clamp(bidRepl * p.replenishmentDamp, 0, 0.9))
      : 0;

    const leftoverGapBps = (buyGap - sellGap) * p.leftoverPressureCoeff * absorptionDamp;

    // Temporary impact: realized walk plus a decaying memory of recent OFI.
    const memoryTerm = this.ofiMemory * input.spreadBps * 0.25 * p.nearbyDepthWeight;
    this.temporaryImpact = p.impactDecay * (input.realizedBps + leftoverGapBps + memoryTerm)
      + (1 - p.impactDecay) * this.temporaryImpact;

    const absDelta = Math.abs(input.aggressiveBuy - input.aggressiveSell);
    const impactPerMillion = safeDiv(Math.abs(input.realizedBps), absDelta / 1_000_000);
    if (impactPerMillion > 0) this.impactDist.add(impactPerMillion);
    this.efficiencyDist.add(Math.abs(input.realizedBps));

    const median = this.impactDist.size >= 8 ? this.impactDist.median() : 0.4;
    const ratio = median > 0 ? impactPerMillion / median : impactPerMillion;
    const pct = this.impactDist.percentileRank(impactPerMillion);
    const efficiency = this.impactDist.size >= 8
      ? intensityFromPercentile(pct)
      : intensityFromRatio(ratio);

    return {
      upsidePressure,
      downsidePressure,
      netPressure,
      leftoverGapBps,
      temporaryImpactBps: this.temporaryImpact,
      efficiency,
      impactPerMillion,
    };
  }

  applyLeftoverGap(price: number, leftoverGapBps: number): number {
    if (!Number.isFinite(price) || price <= 0) return price;
    return price * (1 + leftoverGapBps / 10_000);
  }
}
