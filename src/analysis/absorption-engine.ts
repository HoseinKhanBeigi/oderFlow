import type { AbsorptionConfig, SamePriceConfig } from '../config/types.js';
import { clamp } from '../core/integrity.js';
import type { AbsorptionResult } from '../models/signals.js';
import type { AggressorSide } from '../models/trade.js';
import type { PriceImpactEfficiency } from '../models/trade.js';

export interface AbsorptionInput {
  delta: number;
  deltaPercent: number;
  flowMultipleBuy: number;
  flowMultipleSell: number;
  priceChangePercent: number;
  impactEfficiency: PriceImpactEfficiency;
  buyBurst: boolean;
  sellBurst: boolean;
  persistentBuy: boolean;
  persistentSell: boolean;
  askReplenishmentRatio: number;
  bidReplenishmentRatio: number;
  samePriceBuy: boolean;
  samePriceSell: boolean;
  icebergSellAbsorption: boolean;
  icebergBuyAbsorption: boolean;
}

export class AbsorptionEngine {
  constructor(
    private readonly config: AbsorptionConfig,
    private readonly samePrice: SamePriceConfig,
  ) {}

  detect(input: AbsorptionInput): AbsorptionResult {
    const buyer = this.buyerAbsorption(input);
    const seller = this.sellerAbsorption(input);
    if (buyer.strength >= seller.strength && buyer.detected) return buyer;
    if (seller.detected) return seller;
    return { detected: false, type: null, absorbingSide: null, aggressiveSide: null, strength: 0, confidence: 0 };
  }

  samePriceHit(
    side: AggressorSide,
    prices: number[],
    notionals: number[],
    priceStart: number,
    priceEnd: number,
  ): boolean {
    if (prices.length < this.samePrice.minTradeCount) return false;
    const total = notionals.reduce((s, n) => s + n, 0);
    if (total < this.samePrice.minTotalQuoteValue) return false;
    const anchor = prices[0]!;
    const clustered = prices.every(
      (p) => (Math.abs(p - anchor) / anchor) * 10_000 <= this.samePrice.maxPriceDeviationBps,
    );
    if (!clustered) return false;
    const movedThrough =
      side === 'BUY' ? priceEnd > priceStart * (1 + 0.00005) : priceEnd < priceStart * (1 - 0.00005);
    return !movedThrough;
  }

  private buyerAbsorption(input: AbsorptionInput): AbsorptionResult {
    const hugeBuy =
      input.delta >= this.config.minAbsDeltaQuote &&
      input.deltaPercent >= this.config.minDeltaPercent &&
      input.flowMultipleBuy >= this.config.minFlowMultiple;
    const noLift = Math.abs(input.priceChangePercent) <= this.config.maxPriceChangePercent && input.priceChangePercent >= -this.config.maxPriceChangePercent;
    const lowImpact = input.impactEfficiency === 'LOW' || noLift;
    const burstOk = !this.config.minBurstOrPersistent || input.buyBurst || input.persistentBuy;
    if (!hugeBuy || !lowImpact || !burstOk || input.priceChangePercent < -this.config.maxPriceChangePercent * 3) {
      return { detected: false, type: null, absorbingSide: null, aggressiveSide: null, strength: 0, confidence: 0 };
    }

    let strength = 0.55;
    strength += clamp((input.deltaPercent - this.config.minDeltaPercent) / 0.5, 0, 0.15);
    strength += clamp(input.askReplenishmentRatio, 0, 1) * this.config.replenishmentBoost;
    if (input.samePriceBuy) strength += this.config.samePriceBoost;
    if (input.icebergSellAbsorption) strength += 0.08;
    if (input.buyBurst) strength += 0.05;
    strength = clamp(strength, 0, 1);

    const confidence = clamp(
      0.5 +
        (input.askReplenishmentRatio > 0.4 ? 0.15 : 0) +
        (input.samePriceBuy ? 0.1 : 0) +
        (input.buyBurst || input.persistentBuy ? 0.1 : 0),
      0,
      1,
    );

    const detected = strength >= this.config.minStrength && confidence >= this.config.minConfidence;
    return {
      detected,
      type: detected ? 'BUYER_ABSORPTION' : null,
      absorbingSide: detected ? 'PASSIVE_SELLER' : null,
      aggressiveSide: detected ? 'BUYER' : null,
      strength,
      confidence,
    };
  }

  private sellerAbsorption(input: AbsorptionInput): AbsorptionResult {
    const hugeSell =
      input.delta <= -this.config.minAbsDeltaQuote &&
      input.deltaPercent <= -this.config.minDeltaPercent &&
      input.flowMultipleSell >= this.config.minFlowMultiple;
    const noDrop = Math.abs(input.priceChangePercent) <= this.config.maxPriceChangePercent;
    const lowImpact = input.impactEfficiency === 'LOW' || noDrop;
    const burstOk = !this.config.minBurstOrPersistent || input.sellBurst || input.persistentSell;
    if (!hugeSell || !lowImpact || !burstOk || input.priceChangePercent > this.config.maxPriceChangePercent * 3) {
      return { detected: false, type: null, absorbingSide: null, aggressiveSide: null, strength: 0, confidence: 0 };
    }

    let strength = 0.55;
    strength += clamp((-input.deltaPercent - this.config.minDeltaPercent) / 0.5, 0, 0.15);
    strength += clamp(input.bidReplenishmentRatio, 0, 1) * this.config.replenishmentBoost;
    if (input.samePriceSell) strength += this.config.samePriceBoost;
    if (input.icebergBuyAbsorption) strength += 0.08;
    if (input.sellBurst) strength += 0.05;
    strength = clamp(strength, 0, 1);

    const confidence = clamp(
      0.5 +
        (input.bidReplenishmentRatio > 0.4 ? 0.15 : 0) +
        (input.samePriceSell ? 0.1 : 0) +
        (input.sellBurst || input.persistentSell ? 0.1 : 0),
      0,
      1,
    );

    const detected = strength >= this.config.minStrength && confidence >= this.config.minConfidence;
    return {
      detected,
      type: detected ? 'SELLER_ABSORPTION' : null,
      absorbingSide: detected ? 'PASSIVE_BUYER' : null,
      aggressiveSide: detected ? 'SELLER' : null,
      strength,
      confidence,
    };
  }
}
