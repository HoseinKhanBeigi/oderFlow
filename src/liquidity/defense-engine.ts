import type { FlowBattleConfig } from '../config/types.js';
import { clamp } from '../core/integrity.js';
import type { PassiveDefenseZone, PassiveFailureEvent } from '../models/passive.js';

export interface DefenseInput {
  price: number;
  aggressiveBuy: number;
  aggressiveSell: number;
  askConsumed: number;
  bidConsumed: number;
  askReplenished: number;
  bidReplenished: number;
  askInitial: number;
  bidInitial: number;
  askFinal: number;
  bidFinal: number;
  priceChangePercent: number;
  impactLow: boolean;
}

export class DefenseEngine {
  private readonly zones = new Map<string, PassiveDefenseZone>();

  constructor(private readonly config: FlowBattleConfig) {}

  bidDefenseStrength(input: DefenseInput): number {
    if (input.aggressiveSell < this.config.minAttackQuote * 0.25) return 0;
    const persist = persistRatio(input.bidFinal, input.bidInitial);
    const replenish = replenishShare(input.bidReplenished, input.bidConsumed);
    const reject = input.priceChangePercent >= -0.08 ? 1 : clamp(1 + input.priceChangePercent / 0.4, 0, 1);
    return clamp(100 * (0.35 * replenish + 0.3 * persist + 0.35 * reject), 0, 100);
  }

  askDefenseStrength(input: DefenseInput): number {
    if (input.aggressiveBuy < this.config.minAttackQuote * 0.25) return 0;
    const persist = persistRatio(input.askFinal, input.askInitial);
    const replenish = replenishShare(input.askReplenished, input.askConsumed);
    const reject = input.priceChangePercent <= 0.08 ? 1 : clamp(1 - input.priceChangePercent / 0.4, 0, 1);
    return clamp(100 * (0.35 * replenish + 0.3 * persist + 0.35 * reject), 0, 100);
  }

  failure(input: DefenseInput): PassiveFailureEvent | null {
    const askRatio = consumeRatio(input.askConsumed, input.askReplenished);
    const bidRatio = consumeRatio(input.bidConsumed, input.bidReplenished);
    if (
      input.aggressiveBuy >= this.config.minAttackQuote &&
      askRatio >= this.config.consumeOverReplenish &&
      input.priceChangePercent > 0.05 &&
      input.askFinal < input.askInitial * 0.6
    ) {
      return {
        type: 'PASSIVE_SELLER_FAILURE',
        price: input.price,
        consumedLiquidity: input.askConsumed,
        priceResponse: input.priceChangePercent,
        confidence: clamp(0.55 + Math.min(askRatio / 10, 0.3), 0, 1),
      };
    }
    if (
      input.aggressiveSell >= this.config.minAttackQuote &&
      bidRatio >= this.config.consumeOverReplenish &&
      input.priceChangePercent < -0.05 &&
      input.bidFinal < input.bidInitial * 0.6
    ) {
      return {
        type: 'PASSIVE_BUYER_FAILURE',
        price: input.price,
        consumedLiquidity: input.bidConsumed,
        priceResponse: input.priceChangePercent,
        confidence: clamp(0.55 + Math.min(bidRatio / 10, 0.3), 0, 1),
      };
    }
    return null;
  }

  noteDefense(price: number, side: 'BUY' | 'SELL', absorbed: number, replenished: number, priceResponse: number, strength: number): PassiveDefenseZone {
    const key = `${side}:${bucket(price, this.config.zoneBps)}`;
    const half = price * (this.config.zoneBps / 10_000);
    const prev = this.zones.get(key);
    const zone: PassiveDefenseZone = prev
      ? {
          ...prev,
          testCount: prev.testCount + 1,
          totalAggressiveVolumeAbsorbed: prev.totalAggressiveVolumeAbsorbed + absorbed,
          replenishmentVolume: prev.replenishmentVolume + replenished,
          averagePriceResponse:
            (prev.averagePriceResponse * prev.testCount + priceResponse) / (prev.testCount + 1),
          defenseStrength: Math.max(prev.defenseStrength, strength),
        }
      : {
          priceMin: price - half,
          priceMax: price + half,
          side,
          testCount: 1,
          totalAggressiveVolumeAbsorbed: absorbed,
          replenishmentVolume: replenished,
          averagePriceResponse: priceResponse,
          defenseStrength: strength,
        };
    this.zones.set(key, zone);
    if (this.zones.size > 64) {
      const first = this.zones.keys().next().value;
      if (first) this.zones.delete(first);
    }
    return zone;
  }
}

function persistRatio(finalV: number, initial: number): number {
  if (initial <= 0) return finalV > 0 ? 1 : 0;
  return clamp(finalV / initial, 0, 1.5) / 1.5;
}

function replenishShare(replenished: number, consumed: number): number {
  const tot = replenished + consumed;
  if (tot <= 0) return 0;
  return clamp(replenished / tot, 0, 1);
}

function consumeRatio(consumed: number, replenished: number): number {
  if (replenished <= 0) return consumed > 0 ? 99 : 0;
  return consumed / replenished;
}

function bucket(price: number, bps: number): number {
  const step = price * (bps / 10_000);
  if (step <= 0) return price;
  return Math.round(price / step) * step;
}
