import type { ScoreWeights } from '../config/types.js';
import { clamp } from '../core/integrity.js';
import type { AccelerationLabel, PriceImpactEfficiency } from '../models/trade.js';

export interface DirectionalInput {
  deltaPercent: number;
  largeBuyShare: number;
  largeSellShare: number;
  buyBurstStrength: number;
  sellBurstStrength: number;
  persistentBuy: boolean;
  persistentSell: boolean;
  cvdSlopeSign: number;
  askConsumption: number;
  bidConsumption: number;
  priceChangePercent: number;
  impactEfficiency: PriceImpactEfficiency;
  accelerationBuy: AccelerationLabel;
  accelerationSell: AccelerationLabel;
}

/**
 * Directional score describes who is aggressing, not a trade recommendation.
 * Absorption does not flip the sign; it is a separate state.
 */
export class FlowScoreEngine {
  constructor(private readonly weights: ScoreWeights) {}

  score(input: DirectionalInput): number {
    const w = this.weights;
    const burst = input.buyBurstStrength - input.sellBurstStrength;
    const persist = (input.persistentBuy ? 1 : 0) - (input.persistentSell ? 1 : 0);
    const share = input.largeBuyShare - input.largeSellShare;
    const consumption = Math.sign(input.askConsumption - input.bidConsumption);
    const move = clamp(input.priceChangePercent / 0.5, -1, 1);
    const responseWeight =
      input.impactEfficiency === 'LOW' ? 0.25 : input.impactEfficiency === 'EXTREME' ? 1 : 0.7;

    const raw =
      w.deltaPercent * input.deltaPercent +
      w.largeFlowShare * share +
      w.burst * burst +
      w.persistence * persist +
      w.cvdSlope * clamp(input.cvdSlopeSign, -1, 1) +
      w.consumption * consumption +
      w.priceResponse * move * responseWeight;

    return clamp(Math.round(raw * 100), -100, 100);
  }
}
