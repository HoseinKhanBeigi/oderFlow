import { clamp, safeDiv } from '../core/integrity.js';
import { RingBuffer } from '../core/ring-buffer.js';

interface LiqSample {
  timestamp: number;
  bid: number;
  ask: number;
  buyVolume: number;
  sellVolume: number;
}

export interface ConsumptionRates {
  askConsumptionRate: number;
  bidConsumptionRate: number;
  askReplenishmentRate: number;
  bidReplenishmentRate: number;
}

/**
 * Nearby liquidity path vs aggressive flow:
 * expected ask drop ≈ aggressive buy notional; replenishment is flow that did not appear as a drop.
 */
export class ConsumptionEngine {
  private readonly samples: RingBuffer<LiqSample>;
  private last: LiqSample | null = null;
  private askConsumed = 0;
  private bidConsumed = 0;
  private askReplaced = 0;
  private bidReplaced = 0;
  private windowStart = 0;

  constructor(private readonly windowMs: number, capacity = 2_048) {
    this.samples = new RingBuffer(capacity);
  }

  observe(timestamp: number, bid: number, ask: number, buyVolumeDelta: number, sellVolumeDelta: number): ConsumptionRates {
    if (!this.last) {
      this.last = { timestamp, bid, ask, buyVolume: buyVolumeDelta, sellVolume: sellVolumeDelta };
      this.windowStart = timestamp;
      this.samples.push(this.last);
      return this.rates();
    }

    const askDrop = Math.max(0, this.last.ask - ask);
    const askRise = Math.max(0, ask - this.last.ask);
    const bidDrop = Math.max(0, this.last.bid - bid);
    const bidRise = Math.max(0, bid - this.last.bid);

    const expectedAskDrop = buyVolumeDelta;
    const expectedBidDrop = sellVolumeDelta;

    this.askConsumed += Math.min(askDrop, expectedAskDrop || askDrop);
    this.bidConsumed += Math.min(bidDrop, expectedBidDrop || bidDrop);
    this.askReplaced += Math.max(askRise, Math.max(0, expectedAskDrop - askDrop));
    this.bidReplaced += Math.max(bidRise, Math.max(0, expectedBidDrop - bidDrop));

    this.last = { timestamp, bid, ask, buyVolume: buyVolumeDelta, sellVolume: sellVolumeDelta };
    this.samples.push(this.last);

    if (timestamp - this.windowStart > this.windowMs) {
      const scale = this.windowMs / Math.max(1, timestamp - this.windowStart);
      this.askConsumed *= scale;
      this.bidConsumed *= scale;
      this.askReplaced *= scale;
      this.bidReplaced *= scale;
      this.windowStart = timestamp - this.windowMs;
    }

    return this.rates();
  }

  rates(): ConsumptionRates {
    return {
      askConsumptionRate: this.askConsumed,
      bidConsumptionRate: this.bidConsumed,
      askReplenishmentRate: this.askReplaced,
      bidReplenishmentRate: this.bidReplaced,
    };
  }

  replenishmentRatio(side: 'ask' | 'bid'): number {
    const rates = this.rates();
    if (side === 'ask') {
      return safeDiv(rates.askReplenishmentRate, rates.askReplenishmentRate + rates.askConsumptionRate);
    }
    return safeDiv(rates.bidReplenishmentRate, rates.bidReplenishmentRate + rates.bidConsumptionRate);
  }

  reset(): void {
    this.last = null;
    this.askConsumed = 0;
    this.bidConsumed = 0;
    this.askReplaced = 0;
    this.bidReplaced = 0;
  }
}

export { clamp };
