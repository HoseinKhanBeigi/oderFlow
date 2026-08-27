import { RingBuffer } from '../core/ring-buffer.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import type { TradeSimEvent } from './events.js';
import { clamp, safeDiv } from './math.js';

export interface FlowTick {
  timestamp: number;
  aggressiveBuy: number;
  aggressiveSell: number;
  forcedBuy: number;
  forcedSell: number;
  delta: number;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
}

/**
 * Aggressive flow accounting. Every trade has a buyer and a seller;
 * this engine only records who was the *aggressor* (liquidity taker).
 */
export class OrderFlowSimulationEngine {
  private buy = 0;
  private sell = 0;
  private forcedBuy = 0;
  private forcedSell = 0;
  private buyCount = 0;
  private sellCount = 0;
  cvd = 0;
  private readonly ticks: RingBuffer<FlowTick>;
  readonly buyDist: RollingDistribution;
  readonly sellDist: RollingDistribution;
  readonly absDeltaDist: RollingDistribution;
  private lastTimestamp = 0;

  constructor(opts: { history?: number; sampleSize?: number } = {}) {
    this.ticks = new RingBuffer(opts.history ?? 2_400);
    this.buyDist = new RollingDistribution(opts.sampleSize ?? 2_048);
    this.sellDist = new RollingDistribution(opts.sampleSize ?? 2_048);
    this.absDeltaDist = new RollingDistribution(opts.sampleSize ?? 2_048);
  }

  reset(): void {
    this.buy = 0;
    this.sell = 0;
    this.forcedBuy = 0;
    this.forcedSell = 0;
    this.buyCount = 0;
    this.sellCount = 0;
    this.cvd = 0;
    this.ticks.clear();
    this.lastTimestamp = 0;
  }

  beginTick(): void {
    this.buy = 0;
    this.sell = 0;
    this.forcedBuy = 0;
    this.forcedSell = 0;
    this.buyCount = 0;
    this.sellCount = 0;
  }

  ingestTrade(event: TradeSimEvent): void {
    if (event.side === 'BUY') {
      this.buy += event.quoteValue;
      this.buyCount += 1;
      if (event.isForced) this.forcedBuy += event.quoteValue;
    } else {
      this.sell += event.quoteValue;
      this.sellCount += 1;
      if (event.isForced) this.forcedSell += event.quoteValue;
    }
    this.cvd += event.side === 'BUY' ? event.quoteValue : -event.quoteValue;
    this.lastTimestamp = event.timestamp;
  }

  endTick(timestamp: number): FlowTick {
    const tick: FlowTick = {
      timestamp,
      aggressiveBuy: this.buy,
      aggressiveSell: this.sell,
      forcedBuy: this.forcedBuy,
      forcedSell: this.forcedSell,
      delta: this.buy - this.sell,
      tradeCount: this.buyCount + this.sellCount,
      buyCount: this.buyCount,
      sellCount: this.sellCount,
    };
    this.ticks.push(tick);
    this.buyDist.add(this.buy);
    this.sellDist.add(this.sell);
    this.absDeltaDist.add(Math.abs(tick.delta));
    return tick;
  }

  current(): FlowTick {
    return {
      timestamp: this.lastTimestamp,
      aggressiveBuy: this.buy,
      aggressiveSell: this.sell,
      forcedBuy: this.forcedBuy,
      forcedSell: this.forcedSell,
      delta: this.buy - this.sell,
      tradeCount: this.buyCount + this.sellCount,
      buyCount: this.buyCount,
      sellCount: this.sellCount,
    };
  }

  window(now: number, windowMs: number): FlowTick {
    const from = now - windowMs;
    let buy = 0;
    let sell = 0;
    let forcedBuy = 0;
    let forcedSell = 0;
    let buyCount = 0;
    let sellCount = 0;
    for (const t of this.ticks.values()) {
      if (t.timestamp < from) continue;
      buy += t.aggressiveBuy;
      sell += t.aggressiveSell;
      forcedBuy += t.forcedBuy;
      forcedSell += t.forcedSell;
      buyCount += t.buyCount;
      sellCount += t.sellCount;
    }
    return {
      timestamp: now,
      aggressiveBuy: buy,
      aggressiveSell: sell,
      forcedBuy,
      forcedSell,
      delta: buy - sell,
      tradeCount: buyCount + sellCount,
      buyCount,
      sellCount,
    };
  }

  imbalance(buy: number, sell: number): number {
    const total = buy + sell;
    return safeDiv(buy - sell, total);
  }

  ofiEma(now: number, windowMs: number, memory: number): number {
    const w = this.window(now, windowMs);
    const ofi = this.imbalance(w.aggressiveBuy, w.aggressiveSell);
    return clamp(ofi * memory + ofi * (1 - memory), -1, 1);
  }

  buyPercentile(value: number): number {
    return this.buyDist.percentileRank(value);
  }

  sellPercentile(value: number): number {
    return this.sellDist.percentileRank(value);
  }
}
