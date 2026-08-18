import type { ClusterConfig } from '../config/types.js';
import { clamp } from '../core/integrity.js';
import type { LargeTradeCluster } from '../models/flow.js';
import type { AggressorSide, MarketTrade } from '../models/trade.js';

interface ClusterPrint {
  timestamp: number;
  price: number;
  quoteValue: number;
  side: AggressorSide;
}

export class FlowClusterDetector {
  private active: ClusterPrint[] = [];
  last: LargeTradeCluster | null = null;

  constructor(private readonly config: ClusterConfig) {}

  onTrade(trade: MarketTrade, isLarge: boolean): LargeTradeCluster | null {
    if (!isLarge && trade.quoteValue < this.config.minTotalQuoteValue / this.config.minTradeCount) {
      return this.maybeClose(trade.timestamp);
    }

    const print: ClusterPrint = {
      timestamp: trade.timestamp,
      price: trade.price,
      quoteValue: trade.quoteValue,
      side: trade.side,
    };

    if (this.active.length === 0) {
      this.active.push(print);
      return null;
    }

    const first = this.active[0]!;
    const last = this.active[this.active.length - 1]!;
    const priceRangeBps = (Math.abs(print.price - first.price) / first.price) * 10_000;
    const sameSide = print.side === last.side;
    const closeInTime = print.timestamp - last.timestamp <= this.config.maxGapMs;

    if (sameSide && closeInTime && priceRangeBps <= this.config.maxPriceRangeBps) {
      this.active.push(print);
      const cluster = this.build(this.active);
      if (cluster) this.last = cluster;
      return cluster;
    }

    const closed = this.build(this.active);
    this.active = [print];
    if (closed) this.last = closed;
    return closed;
  }

  current(now: number): LargeTradeCluster | null {
    const live = this.build(this.active);
    if (live && now - live.endTime <= this.config.maxGapMs) return live;
    if (this.last && now - this.last.endTime <= this.config.maxGapMs) return this.last;
    return null;
  }

  private maybeClose(now: number): LargeTradeCluster | null {
    if (this.active.length === 0) return this.last && now - this.last.endTime <= this.config.maxGapMs ? this.last : null;
    const last = this.active[this.active.length - 1]!;
    if (now - last.timestamp > this.config.maxGapMs) {
      const closed = this.build(this.active);
      this.active = [];
      if (closed) this.last = closed;
      return closed;
    }
    return this.build(this.active);
  }

  private build(prints: ClusterPrint[]): LargeTradeCluster | null {
    if (prints.length < this.config.minTradeCount) return null;
    const total = prints.reduce((s, p) => s + p.quoteValue, 0);
    if (total < this.config.minTotalQuoteValue) return null;
    const prices = prints.map((p) => p.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const duration = Math.max(1, prints[prints.length - 1]!.timestamp - prints[0]!.timestamp);
    const tightness = clamp(1 - duration / (this.config.maxGapMs * prints.length), 0, 1);
    return {
      side: prints[0]!.side,
      minPrice,
      maxPrice,
      startTime: prints[0]!.timestamp,
      endTime: prints[prints.length - 1]!.timestamp,
      tradeCount: prints.length,
      totalVolume: total,
      relativeStrength: clamp(tightness * 0.5 + clamp(total / (this.config.minTotalQuoteValue * 10), 0, 1) * 0.5, 0, 1),
    };
  }
}
