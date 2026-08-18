import { clamp, safeDiv } from '../core/integrity.js';
import { RingBuffer } from '../core/ring-buffer.js';

interface CvdPoint {
  timestamp: number;
  cvd: number;
  price: number;
}

export interface CvdSnapshot {
  cvd: number;
  slope: number;
  acceleration: number;
  direction: 'UP' | 'DOWN' | 'FLAT';
  divergence: 'BULLISH' | 'BEARISH' | 'NONE';
}

export class CVDEngine {
  private cvd = 0;
  private readonly history: RingBuffer<CvdPoint>;

  constructor(
    private readonly slopeMs: number,
    historySize = 4_096,
  ) {
    this.history = new RingBuffer(historySize);
  }

  onTrade(timestamp: number, buyQuote: number, sellQuote: number, price: number): CvdSnapshot {
    this.cvd += buyQuote - sellQuote;
    this.history.push({ timestamp, cvd: this.cvd, price });
    return this.snapshot(timestamp);
  }

  snapshot(now: number): CvdSnapshot {
    const latest = this.history.last();
    const cvd = latest?.cvd ?? this.cvd;
    const slope = this.slopeAt(now, this.slopeMs);
    const prevSlope = this.slopeAt(now - this.slopeMs, this.slopeMs);
    const acceleration = slope - prevSlope;
    const direction: CvdSnapshot['direction'] =
      Math.abs(slope) < 1e-9 ? 'FLAT' : slope > 0 ? 'UP' : 'DOWN';
    return {
      cvd,
      slope,
      acceleration,
      direction,
      divergence: this.divergence(now),
    };
  }

  private slopeAt(now: number, lookback: number): number {
    const end = this.pointAtOrBefore(now);
    const start = this.pointAtOrBefore(now - lookback) ?? this.first();
    if (!end || !start || end.timestamp === start.timestamp) return 0;
    return (end.cvd - start.cvd) / (end.timestamp - start.timestamp);
  }

  private first(): CvdPoint | undefined {
    return this.history.at(0);
  }

  private pointAtOrBefore(timestamp: number): CvdPoint | undefined {
    let found: CvdPoint | undefined;
    for (const p of this.history.values()) {
      if (p.timestamp <= timestamp) found = p;
      else break;
    }
    return found;
  }

  private divergence(now: number): CvdSnapshot['divergence'] {
    const lookback = this.slopeMs * 3;
    const points: CvdPoint[] = [];
    for (const p of this.history.values()) {
      if (p.timestamp >= now - lookback) points.push(p);
    }
    if (points.length < 8) return 'NONE';
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const priceUp = last.price > first.price * 1.0005;
    const priceDown = last.price < first.price * 0.9995;
    const cvdUp = last.cvd > first.cvd;
    const cvdDown = last.cvd < first.cvd;
    if (priceUp && cvdDown) return 'BEARISH';
    if (priceDown && cvdUp) return 'BULLISH';
    return 'NONE';
  }

  get value(): number {
    return this.cvd;
  }
}

export { safeDiv, clamp };
