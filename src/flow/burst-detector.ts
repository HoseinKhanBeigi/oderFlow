import type { BurstConfig } from '../config/types.js';
import { clamp, safeDiv } from '../core/integrity.js';
import { RingBuffer } from '../core/ring-buffer.js';
import type { FlowBurst } from '../models/flow.js';
import type { AggressorSide, MarketTrade } from '../models/trade.js';

interface BurstTrade {
  timestamp: number;
  price: number;
  quoteValue: number;
  side: AggressorSide;
  vsMedian: number;
}

export class BurstDetector {
  private readonly recent = new RingBuffer<BurstTrade>(4_096);
  private active: BurstTrade[] = [];
  lastBurst: FlowBurst | null = null;

  constructor(private readonly config: BurstConfig) {}

  onTrade(trade: MarketTrade, vsMedian: number): FlowBurst | null {
    const item: BurstTrade = {
      timestamp: trade.timestamp,
      price: trade.price,
      quoteValue: trade.quoteValue,
      side: trade.side,
      vsMedian,
    };
    this.recent.push(item);

    if (this.active.length === 0) {
      this.active.push(item);
      return null;
    }

    const first = this.active[0]!;
    const last = this.active[this.active.length - 1]!;
    const sameSide = item.side === last.side;
    const gap = item.timestamp - last.timestamp;
    const span = item.timestamp - first.timestamp;

    if (sameSide && gap <= this.config.maxGapMs) {
      this.active.push(item);
    } else {
      const closed = this.finalize(this.active);
      this.active = [item];
      if (closed) {
        this.lastBurst = closed;
        return closed;
      }
      return null;
    }

    if (span >= this.config.maxGapMs || this.active.length >= 8) {
      const burst = this.finalize(this.active);
      if (burst) this.lastBurst = burst;
      return burst;
    }

    return this.lastBurstIfCovers(item.timestamp);
  }

  current(now: number): FlowBurst | null {
    const live = this.active.filter((t) => now - t.timestamp <= this.config.maxGapMs * 4);
    return this.finalize(live.length ? live : this.active) ?? this.lastBurstIfCovers(now);
  }

  private lastBurstIfCovers(now: number): FlowBurst | null {
    if (!this.lastBurst) return null;
    if (now - this.lastBurst.endTime > this.config.maxGapMs * 2) return null;
    return this.lastBurst;
  }

  private finalize(trades: BurstTrade[]): FlowBurst | null {
    if (trades.length < this.config.minTradeCount) return null;
    const side = trades[0]!.side;
    const sameSide = trades.filter((t) => t.side === side);
    if (sameSide.length / trades.length < this.config.minSameSideShare) return null;

    const total = sameSide.reduce((s, t) => s + t.quoteValue, 0);
    if (total < this.config.minTotalQuoteValue) return null;

    const start = sameSide[0]!;
    const end = sameSide[sameSide.length - 1]!;
    const largest = sameSide.reduce((m, t) => Math.max(m, t.quoteValue), 0);
    const avgVsMedian =
      sameSide.reduce((s, t) => s + Math.min(t.vsMedian, 20), 0) / sameSide.length;
    const duration = Math.max(1, end.timestamp - start.timestamp);
    const tightness = clamp(1 - duration / (this.config.maxGapMs * sameSide.length), 0, 1);
    const move = Math.abs(end.price - start.price) / start.price;

    const w = this.config;
    const strength = clamp(
      w.strengthVolumeWeight * clamp(total / (this.config.minTotalQuoteValue * 8), 0, 1) +
        w.strengthCountWeight * clamp(sameSide.length / 40, 0, 1) +
        w.strengthTightnessWeight * tightness +
        w.strengthRelativeWeight * clamp(avgVsMedian / 8, 0, 1) +
        w.strengthMoveWeight * clamp(move * 50, 0, 1),
      0,
      1,
    );

    return {
      side,
      startTime: start.timestamp,
      endTime: end.timestamp,
      tradeCount: sameSide.length,
      totalQuoteValue: total,
      largestTrade: largest,
      averageTradeSize: safeDiv(total, sameSide.length),
      priceStart: start.price,
      priceEnd: end.price,
      strength,
    };
  }
}
