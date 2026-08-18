import type { ParticipantScoreWeights } from '../config/types.js';
import { clamp } from '../core/integrity.js';
import type { LargeParticipantFlow } from '../models/signals.js';
import type { AggressorSide, PriceImpactEfficiency } from '../models/trade.js';

export interface ParticipantInput {
  largeBuyCount: number;
  largeSellCount: number;
  largeBuyVolume: number;
  largeSellVolume: number;
  buyVolume: number;
  sellVolume: number;
  largeBuyShare: number;
  largeSellShare: number;
  maxPercentileRank: number;
  buyBurstStrength: number;
  sellBurstStrength: number;
  persistentBuy: boolean;
  persistentSell: boolean;
  deltaPercent: number;
  impactEfficiency: PriceImpactEfficiency;
  askConsumption: number;
  bidConsumption: number;
  buyPressure: number;
  sellPressure: number;
}

export class LargeParticipantFlowEngine {
  constructor(private readonly weights: ParticipantScoreWeights) {}

  score(input: ParticipantInput): LargeParticipantFlow {
    const buy = this.sideScore(input, 'BUY');
    const sell = this.sideScore(input, 'SELL');
    if (buy.score < 20 && sell.score < 20) {
      return {
        side: 'NONE',
        largeParticipantFlowScore: Math.max(buy.score, sell.score),
        confidence: 0.3,
        interpretation: 'No unusually large persistent aggressive flow.',
      };
    }
    const pick = buy.score >= sell.score ? buy : sell;
    return {
      side: pick.side,
      largeParticipantFlowScore: pick.score,
      confidence: pick.confidence,
      interpretation:
        pick.side === 'BUY'
          ? 'Unusually large and persistent aggressive buying is occurring.'
          : 'Unusually large and persistent aggressive selling is occurring.',
    };
  }

  private sideScore(input: ParticipantInput, side: AggressorSide): { side: AggressorSide; score: number; confidence: number } {
    const w = this.weights;
    const largeCount = side === 'BUY' ? input.largeBuyCount : input.largeSellCount;
    const largeVol = side === 'BUY' ? input.largeBuyVolume : input.largeSellVolume;
    const total = side === 'BUY' ? input.buyVolume : input.sellVolume;
    const share = side === 'BUY' ? input.largeBuyShare : input.largeSellShare;
    const burst = side === 'BUY' ? input.buyBurstStrength : input.sellBurstStrength;
    const persistent = side === 'BUY' ? input.persistentBuy : input.persistentSell;
    const dominance = side === 'BUY' ? Math.max(0, input.deltaPercent) : Math.max(0, -input.deltaPercent);
    const consumption = side === 'BUY' ? input.askConsumption : input.bidConsumption;
    const pressure = side === 'BUY' ? input.buyPressure : input.sellPressure;

    const frequency = clamp(largeCount / 20, 0, 1);
    const volume = clamp(largeVol / Math.max(total, 1), 0, 1);
    const percentile = clamp((input.maxPercentileRank - 90) / 10, 0, 1);
    const burstPersist = clamp(burst * 0.6 + (persistent ? 0.4 : 0), 0, 1);
    const response =
      input.impactEfficiency === 'EXTREME' ? 1 : input.impactEfficiency === 'HIGH' ? 0.7 : input.impactEfficiency === 'NORMAL' ? 0.4 : 0.15;
    const liq = clamp(Math.max(consumption > 0 ? 0.5 : 0, Math.min(pressure / 5, 1)), 0, 1);

    const score = clamp(
      100 *
        (w.largeTradeFrequency * frequency +
          w.largeTradeVolume * volume +
          w.relativePercentile * percentile +
          w.burstPersistence * burstPersist +
          w.sameSideDominance * dominance +
          w.largeFlowShare * clamp(share, 0, 1) +
          w.priceResponse * response +
          w.liquidityConsumption * liq),
      0,
      100,
    );

    const confidence = clamp(0.4 + dominance * 0.2 + burstPersist * 0.2 + (share > 0.25 ? 0.15 : 0), 0, 1);
    return { side, score: Math.round(score), confidence };
  }
}
