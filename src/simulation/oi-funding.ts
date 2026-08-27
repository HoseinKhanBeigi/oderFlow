import { safeDiv } from './math.js';
import type { FundingSimEvent, OiSimEvent } from './events.js';
import type { FundingClassification, OiClassification } from './types.js';

export class OpenInterestEngine {
  private oi = 0;
  private prevOi = 0;
  private lastChange = 0;

  reset(): void {
    this.oi = 0;
    this.prevOi = 0;
    this.lastChange = 0;
  }

  ingest(event: OiSimEvent): void {
    this.prevOi = this.oi || event.openInterest;
    this.lastChange = event.openInterest - this.prevOi;
    this.oi = event.openInterest;
  }

  set(openInterest: number): void {
    this.prevOi = this.oi || openInterest;
    this.lastChange = openInterest - this.prevOi;
    this.oi = openInterest;
  }

  addChange(delta: number): void {
    if (!this.oi) this.oi = 1;
    this.prevOi = this.oi;
    this.oi = Math.max(0, this.oi + delta);
    this.lastChange = this.oi - this.prevOi;
  }

  snapshot(): {
    openInterest: number;
    oiChange: number;
    oiChangePercent: number;
  } {
    return {
      openInterest: this.oi,
      oiChange: this.lastChange,
      oiChangePercent: safeDiv(this.lastChange, this.prevOi || this.oi) * 100,
    };
  }

  /**
   * OI classifies positioning. It does not push price.
   */
  classify(input: {
    priceChange: number;
    aggressiveBuy: number;
    aggressiveSell: number;
    shortLiquidations: number;
    longLiquidations: number;
  }): OiClassification {
    const oiUp = this.lastChange > 0;
    const oiDown = this.lastChange < 0;
    const priceUp = input.priceChange > 0;
    const priceDown = input.priceChange < 0;
    const buyDom = input.aggressiveBuy > input.aggressiveSell * 1.15;
    const sellDom = input.aggressiveSell > input.aggressiveBuy * 1.15;
    const shortLiq = input.shortLiquidations > input.longLiquidations && input.shortLiquidations > 0;
    const longLiq = input.longLiquidations > input.shortLiquidations && input.longLiquidations > 0;

    if (priceUp && buyDom && oiUp) return 'NEW_LEVERAGED_LONGS';
    if (priceUp && buyDom && oiDown && shortLiq) return 'SHORT_COVERING';
    if (priceDown && sellDom && oiUp) return 'NEW_LEVERAGED_SHORTS';
    if (priceDown && sellDom && oiDown && longLiq) return 'LONG_UNWIND';
    if (oiUp) return 'EXPANDING';
    if (oiDown) return 'CONTRACTING';
    return 'NEUTRAL';
  }
}

export class FundingEngine {
  private rate = 0;

  reset(): void {
    this.rate = 0;
  }

  ingest(event: FundingSimEvent): void {
    this.rate = event.fundingRate;
  }

  set(rate: number): void {
    this.rate = rate;
  }

  /**
   * Funding is crowding context, not a mean-reversion trigger.
   * Positive funding ≠ price goes down.
   */
  classify(): FundingClassification {
    if (this.rate > 0.0003) return 'LONG_CROWDING';
    if (this.rate < -0.0003) return 'SHORT_CROWDING';
    return 'NEUTRAL';
  }

  rateValue(): number {
    return this.rate;
  }
}