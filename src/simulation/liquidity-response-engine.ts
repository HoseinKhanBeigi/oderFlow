import { RollingDistribution } from '../core/rolling-stats.js';
import { clamp, safeDiv } from './math.js';
import type { BookWalkResult } from './types.js';

export interface LiquidityResponseTick {
  bidConsumption: number;
  askConsumption: number;
  bidReplenishment: number;
  askReplenishment: number;
  bidWithdrawal: number;
  askWithdrawal: number;
  buyerAbsorption: number;
  sellerAbsorption: number;
  askDefense: boolean;
  bidDefense: boolean;
  upsideVacuum: boolean;
  downsideVacuum: boolean;
}

/**
 * Book response to aggression. Distinguishes:
 *   consumption  — size removed by execution
 *   replenishment — size added after (or during) hits
 *   withdrawal   — size cancelled without execution
 */
export class LiquidityResponseSimulationEngine {
  private tick: LiquidityResponseTick = emptyTick();
  readonly consumeAskDist = new RollingDistribution(2_048);
  readonly consumeBidDist = new RollingDistribution(2_048);
  readonly replenishAskDist = new RollingDistribution(2_048);
  readonly replenishBidDist = new RollingDistribution(2_048);
  readonly withdrawAskDist = new RollingDistribution(2_048);
  readonly withdrawBidDist = new RollingDistribution(2_048);

  reset(): void {
    this.tick = emptyTick();
  }

  beginTick(): void {
    this.tick = emptyTick();
  }

  noteAskWalk(walk: BookWalkResult): void {
    this.tick.askConsumption += walk.filled;
  }

  noteBidWalk(walk: BookWalkResult): void {
    this.tick.bidConsumption += walk.filled;
  }

  noteAskReplenishment(quote: number): void {
    this.tick.askReplenishment += Math.max(0, quote);
  }

  noteBidReplenishment(quote: number): void {
    this.tick.bidReplenishment += Math.max(0, quote);
  }

  noteAskWithdrawal(quote: number): void {
    this.tick.askWithdrawal += Math.max(0, quote);
  }

  noteBidWithdrawal(quote: number): void {
    this.tick.bidWithdrawal += Math.max(0, quote);
  }

  endTick(input: {
    aggressiveBuy: number;
    aggressiveSell: number;
    priceChangeBps: number;
    nearbyAsk: number;
    nearbyBid: number;
  }): LiquidityResponseTick {
    const askReplRatio = safeDiv(this.tick.askReplenishment, Math.max(this.tick.askConsumption, input.aggressiveBuy));
    const bidReplRatio = safeDiv(this.tick.bidReplenishment, Math.max(this.tick.bidConsumption, input.aggressiveSell));
    const askPullRatio = safeDiv(this.tick.askWithdrawal, input.nearbyAsk + this.tick.askWithdrawal);
    const bidPullRatio = safeDiv(this.tick.bidWithdrawal, input.nearbyBid + this.tick.bidWithdrawal);

    const largeBuy = input.aggressiveBuy > 0 && input.aggressiveBuy >= input.aggressiveSell * 1.4;
    const largeSell = input.aggressiveSell > 0 && input.aggressiveSell >= input.aggressiveBuy * 1.4;
    const weakUp = input.priceChangeBps <= 8;
    const weakDown = input.priceChangeBps >= -8;

    this.tick.askDefense = largeBuy && askReplRatio >= 0.55 && weakUp;
    this.tick.bidDefense = largeSell && bidReplRatio >= 0.55 && weakDown;

    this.tick.buyerAbsorption = largeBuy && this.tick.askDefense
      ? clamp(askReplRatio * (1 - Math.min(1, Math.abs(input.priceChangeBps) / 40)), 0, 1)
      : 0;
    this.tick.sellerAbsorption = largeSell && this.tick.bidDefense
      ? clamp(bidReplRatio * (1 - Math.min(1, Math.abs(input.priceChangeBps) / 40)), 0, 1)
      : 0;

    const modestBuy = input.aggressiveBuy > 0 && !this.tick.askDefense;
    const modestSell = input.aggressiveSell > 0 && !this.tick.bidDefense;
    this.tick.upsideVacuum = modestBuy && askPullRatio >= 0.28 && input.priceChangeBps >= 6;
    this.tick.downsideVacuum = modestSell && bidPullRatio >= 0.28 && input.priceChangeBps <= -6;

    this.consumeAskDist.add(this.tick.askConsumption);
    this.consumeBidDist.add(this.tick.bidConsumption);
    this.replenishAskDist.add(this.tick.askReplenishment);
    this.replenishBidDist.add(this.tick.bidReplenishment);
    this.withdrawAskDist.add(this.tick.askWithdrawal);
    this.withdrawBidDist.add(this.tick.bidWithdrawal);

    return { ...this.tick };
  }

  current(): LiquidityResponseTick {
    return { ...this.tick };
  }
}

function emptyTick(): LiquidityResponseTick {
  return {
    bidConsumption: 0,
    askConsumption: 0,
    bidReplenishment: 0,
    askReplenishment: 0,
    bidWithdrawal: 0,
    askWithdrawal: 0,
    buyerAbsorption: 0,
    sellerAbsorption: 0,
    askDefense: false,
    bidDefense: false,
    upsideVacuum: false,
    downsideVacuum: false,
  };
}
