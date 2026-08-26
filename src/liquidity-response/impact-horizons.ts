import { pctChange, safeDiv } from '../core/integrity.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import type { LiquidityResponseConfig } from '../config/types.js';
import type { IntensityLabel, PriceImpactHorizons } from '../models/liquidity-response.js';

interface OpenImpact {
  start: number;
  priceBefore: number;
  quoteSum: number;
  pxQuote: number;
  immediate: number;
  at5?: number;
  at30?: number;
  at60?: number;
}

/**
 * Realized impact of aggressive flow: price before, execution VWAP,
 * then 5s / 30s / 1m marks. Classified vs this asset's own history.
 */
export class ImpactHorizonTracker {
  private current: OpenImpact | null = null;
  private readonly closed: OpenImpact[] = [];
  private readonly hist = new RollingDistribution(256);
  private lastPrice = 0;

  constructor(private readonly config: LiquidityResponseConfig) {}

  onTrade(timestamp: number, price: number, quote: number): void {
    this.advance(timestamp, this.lastPrice || price);
    const bucket = timestamp - (timestamp % 1_000);
    if (!this.current || this.current.start !== bucket) {
      if (this.current && this.current.quoteSum >= this.config.minImpactQuote) {
        this.current.immediate = this.lastPrice || price;
        this.closed.push(this.current);
        if (this.closed.length > 240) this.closed.shift();
      }
      this.current = {
        start: bucket,
        priceBefore: this.lastPrice || price,
        quoteSum: 0,
        pxQuote: 0,
        immediate: price,
      };
    }
    this.current.quoteSum += quote;
    this.current.pxQuote += price * quote;
    this.current.immediate = price;
    this.lastPrice = price;
  }

  onPrice(timestamp: number, price: number): void {
    if (price > 0) this.lastPrice = price;
    this.advance(timestamp, this.lastPrice);
  }

  snapshot(now: number, price: number): PriceImpactHorizons {
    this.advance(now, price || this.lastPrice);
    const recent = this.closed.filter((o) => now - o.start <= 60_000 && o.quoteSum >= this.config.minImpactQuote);
    const sample = recent[recent.length - 1] ?? this.current;
    if (!sample || sample.priceBefore <= 0) {
      return {
        immediateBps: 0,
        bps5s: 0,
        bps30s: 0,
        bps1m: 0,
        vwapBps: 0,
        classification: 'NORMAL',
      };
    }
    const vwap = safeDiv(sample.pxQuote, sample.quoteSum) || sample.immediate;
    const immediateBps = bps(sample.priceBefore, sample.immediate);
    const vwapBps = bps(sample.priceBefore, vwap);
    const bps5s = bps(sample.priceBefore, sample.at5 ?? sample.immediate);
    const bps30s = bps(sample.priceBefore, sample.at30 ?? sample.at5 ?? sample.immediate);
    const bps1m = bps(sample.priceBefore, sample.at60 ?? sample.at30 ?? sample.immediate);
    if (Math.abs(bps1m) > 0) this.hist.add(Math.abs(bps1m));
    return {
      immediateBps,
      bps5s,
      bps30s,
      bps1m,
      vwapBps,
      classification: classifyImpact(Math.abs(bps1m) || Math.abs(immediateBps), this.hist),
    };
  }

  private advance(now: number, price: number): void {
    if (price <= 0) return;
    for (const obs of this.closed) {
      const age = now - obs.start;
      if (age >= 5_000 && obs.at5 == null) obs.at5 = price;
      if (age >= 30_000 && obs.at30 == null) obs.at30 = price;
      if (age >= 60_000 && obs.at60 == null) obs.at60 = price;
    }
    if (this.current) {
      const age = now - this.current.start;
      if (age >= 5_000 && this.current.at5 == null) this.current.at5 = price;
      if (age >= 30_000 && this.current.at30 == null) this.current.at30 = price;
    }
  }
}

function bps(from: number, to: number): number {
  return pctChange(from, to) * 100;
}

function classifyImpact(current: number, hist: RollingDistribution): IntensityLabel {
  if (current === 0) return 'LOW';
  if (hist.size < 8) {
    if (current < 2) return 'LOW';
    if (current > 40) return 'EXTREME';
    if (current > 12) return 'HIGH';
    return 'NORMAL';
  }
  const rank = hist.percentileRank(current);
  if (rank >= 92) return 'EXTREME';
  if (rank >= 75) return 'HIGH';
  if (rank <= 25) return 'LOW';
  return 'NORMAL';
}
