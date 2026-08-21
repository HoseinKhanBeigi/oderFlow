import type { MovePotentialConfig } from '../config/types.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import type {
  LiquidityWall,
  LiquidityWallKind,
  MovePotentialEventType,
} from '../models/liquidity.js';
import type { LocalOrderBook } from './local-order-book.js';
import type { LiquidityDynamicsEngine } from './liquidity-dynamics-engine.js';

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Flags abnormal displayed size vs nearby levels and vs this book's recent level-size history.
 */
export class LiquidityWallDetector {
  private readonly levelHist: RollingDistribution;
  private readonly lastQuote = new Map<string, number>();

  constructor(
    private readonly config: MovePotentialConfig,
    sampleSize = 2_048,
  ) {
    this.levelHist = new RollingDistribution(sampleSize);
  }

  detect(
    book: LocalOrderBook,
    dynamics: LiquidityDynamicsEngine,
    buyDelta: number,
    sellDelta: number,
  ): { walls: LiquidityWall[]; events: MovePotentialEventType[] } {
    const events: MovePotentialEventType[] = [];
    const walls: LiquidityWall[] = [
      ...this.scan(book, 'ask', 'ASK_LIQUIDITY_WALL', dynamics.lastAskDropByPrice, buyDelta, events),
      ...this.scan(book, 'bid', 'BID_LIQUIDITY_WALL', dynamics.lastBidDropByPrice, sellDelta, events),
    ];
    return { walls, events };
  }

  private scan(
    book: LocalOrderBook,
    side: 'ask' | 'bid',
    kind: LiquidityWallKind,
    dropByPrice: Map<number, number>,
    flowDelta: number,
    events: MovePotentialEventType[],
  ): LiquidityWall[] {
    const levels = book.sortedLevels(side);
    const out: LiquidityWall[] = [];
    const look = this.config.wallLookaround;

    for (let i = 0; i < levels.length; i++) {
      const lvl = levels[i]!;
      const nearby: number[] = [];
      for (let j = Math.max(0, i - look); j <= Math.min(levels.length - 1, i + look); j++) {
        if (j === i) continue;
        nearby.push(levels[j]!.quoteValue);
      }
      const nearbyMed = median(nearby);
      if (lvl.quoteValue > 0) this.levelHist.add(lvl.quoteValue);
      const ratio = nearbyMed > 0 ? lvl.quoteValue / nearbyMed : 0;
      const percentile = this.levelHist.percentileRank(lvl.quoteValue);
      const bootstrap = this.levelHist.size < 8 && ratio >= this.config.wallMultiple * 1.25;
      const relative = ratio >= this.config.wallMultiple && percentile >= this.config.wallMinPercentile;
      if (!bootstrap && !relative) continue;

      const key = `${kind}:${lvl.price}`;
      const isNew = !this.lastQuote.has(key);
      const prev = this.lastQuote.get(key) ?? lvl.quoteValue;
      const drop = dropByPrice.get(lvl.price) ?? Math.max(0, prev - lvl.quoteValue);
      let status: LiquidityWall['status'] = 'ACTIVE';
      if (prev > 0 && drop / prev >= this.config.wallDropFraction) {
        const explained = Math.min(drop, flowDelta) / Math.max(drop, 1e-9);
        status = explained < this.config.pullUnexplainedFraction ? 'PULLED' : 'CONSUMED';
        events.push(
          status === 'PULLED'
            ? side === 'ask' ? 'ASK_LIQUIDITY_PULLED' : 'BID_LIQUIDITY_PULLED'
            : side === 'ask' ? 'ASK_WALL_CONSUMED' : 'BID_WALL_CONSUMED',
        );
      } else if (isNew) {
        events.push(side === 'ask' ? 'ASK_WALL_DETECTED' : 'BID_WALL_DETECTED');
      }
      this.lastQuote.set(key, lvl.quoteValue);
      out.push({
        kind,
        price: lvl.price,
        quoteValue: lvl.quoteValue,
        vsNearbyMedian: ratio,
        percentile,
        status,
      });
    }

    this.markMissingWalls(kind, levels, dropByPrice, flowDelta, events, out);
    return out;
  }

  private markMissingWalls(
    kind: LiquidityWallKind,
    levels: { price: number; quoteValue: number }[],
    dropByPrice: Map<number, number>,
    flowDelta: number,
    events: MovePotentialEventType[],
    out: LiquidityWall[],
  ): void {
    const present = new Set(levels.map((l) => l.price));
    const prefix = `${kind}:`;
    for (const [key, prev] of [...this.lastQuote.entries()]) {
      if (!key.startsWith(prefix)) continue;
      const price = Number(key.slice(prefix.length));
      if (present.has(price) || prev <= 0) continue;
      const drop = dropByPrice.get(price) ?? prev;
      const explained = Math.min(drop, flowDelta) / Math.max(drop, 1e-9);
      const pulled = explained < this.config.pullUnexplainedFraction;
      events.push(
        pulled
          ? kind === 'ASK_LIQUIDITY_WALL' ? 'ASK_LIQUIDITY_PULLED' : 'BID_LIQUIDITY_PULLED'
          : kind === 'ASK_LIQUIDITY_WALL' ? 'ASK_WALL_CONSUMED' : 'BID_WALL_CONSUMED',
      );
      out.push({
        kind,
        price,
        quoteValue: 0,
        vsNearbyMedian: 0,
        percentile: 100,
        status: pulled ? 'PULLED' : 'CONSUMED',
      });
      this.lastQuote.delete(key);
    }
  }
}
