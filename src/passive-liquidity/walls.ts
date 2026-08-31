import type { PassiveLiquidityConfig } from '../config/types.js';
import { clamp, safeDiv } from '../core/integrity.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import type {
  PassiveLiquidityLevel,
  PassiveLiquidityWall,
  PassiveSide,
  UnreliableLiquidityLabel,
  WallLifecycle,
} from '../models/passive-liquidity.js';
import { distanceWeight } from './level-scores.js';

interface VanishedWall {
  side: PassiveSide;
  price: number;
  distanceBps: number;
  notional: number;
  at: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Finds statistically unusual resting levels and scores how much the displayed
 * size can be relied on.
 *
 * Size never decides a wall's strength on its own: a 99th-percentile level that
 * is 300ms old and pulls as price approaches scores lower than a mid-percentile
 * level that has been attacked repeatedly and keeps coming back.
 */
export class WallTracker {
  private readonly persistenceDist = new RollingDistribution(1_024);
  private readonly replenishDist = new RollingDistribution(1_024);
  private readonly vanished: VanishedWall[] = [];
  private readonly known = new Map<string, number>();

  constructor(private readonly config: PassiveLiquidityConfig) {}

  /**
   * @param priceRejection 0-1 measure of how poorly price advanced against this
   *        side, supplied by the engine so walls are scored with price response.
   */
  detect(
    levels: PassiveLiquidityLevel[],
    now: number,
    priceRejection: { bid: number; ask: number },
  ): PassiveLiquidityWall[] {
    const bySide: Record<PassiveSide, PassiveLiquidityLevel[]> = { BID: [], ASK: [] };
    for (const level of levels) {
      if (level.outOfView) continue;
      bySide[level.side].push(level);
    }

    const walls: PassiveLiquidityWall[] = [];
    for (const side of ['BID', 'ASK'] as PassiveSide[]) {
      const sorted = bySide[side].sort((a, b) => a.distanceBps - b.distanceBps);
      for (let i = 0; i < sorted.length; i++) {
        const level = sorted[i];
        if (!level || level.quantity <= 0) continue;

        const neighbours: number[] = [];
        for (let j = Math.max(0, i - 4); j <= Math.min(sorted.length - 1, i + 4); j++) {
          if (j === i) continue;
          const n = sorted[j];
          if (n) neighbours.push(n.notionalValue);
        }
        const nearbyMedian = median(neighbours);
        const vsNearbyMedian = nearbyMedian > 0 ? level.notionalValue / nearbyMedian : 0;

        const unusualSize = level.sizePercentile >= this.config.wallMinPercentile;
        const unusualLocally = vsNearbyMedian >= this.config.wallMinVsNearbyMedian;
        if (!unusualSize && !unusualLocally) continue;

        this.persistenceDist.add(level.persistenceScore);
        this.replenishDist.add(level.replenishmentScore);

        walls.push(
          this.build(level, vsNearbyMedian, now, side === 'BID' ? priceRejection.bid : priceRejection.ask),
        );
      }
    }

    this.trackDisappearance(walls, now);
    return walls.sort((a, b) => a.distanceBps - b.distanceBps);
  }

  private build(
    level: PassiveLiquidityLevel,
    vsNearbyMedian: number,
    now: number,
    priceRejection: number,
  ): PassiveLiquidityWall {
    const persistencePercentile = this.persistenceDist.size >= 8
      ? this.persistenceDist.midRank(level.persistenceScore)
      : level.persistenceScore;
    const replenishmentPercentile = this.replenishDist.size >= 8
      ? this.replenishDist.midRank(level.replenishmentScore)
      : level.replenishmentScore;

    const young = level.ageMs < this.config.wallYoungMs;
    const ageFactor = clamp(
      Math.log1p(level.presentMs / 1_000) / Math.log1p(this.config.wallMatureMs / 1_000),
      0,
      1,
    );
    const defence = level.attackCount > 0
      ? clamp(level.defendedCount / level.attackCount, 0, 1)
      : 0;
    const attackCredit = clamp(level.attackCount / 4, 0, 1);
    const replenish = clamp(level.replenishmentRatio, 0, 1);
    const withdrawal = level.withdrawalScore / 100;
    const proximity = distanceWeight(level.distanceBps, this.config.distanceWeightK);

    const strengthRaw =
      0.18 * (level.sizePercentile / 100) +
      0.1 * clamp(vsNearbyMedian / 6, 0, 1) +
      0.22 * (0.5 * ageFactor + 0.5 * persistencePercentile / 100) +
      0.2 * replenish +
      0.12 * (0.6 * defence + 0.4 * attackCredit) +
      0.1 * proximity +
      0.08 * clamp(priceRejection, 0, 1) -
      0.3 * withdrawal -
      (young ? 0.25 : 0) -
      (level.approachWithdrawal ? 0.3 : 0);

    const reliabilityRaw =
      0.35 * ageFactor +
      0.25 * replenish +
      0.2 * defence +
      0.2 * (1 - withdrawal) -
      (level.approachWithdrawal ? 0.4 : 0) -
      (young ? 0.2 : 0);

    const strength = clamp(strengthRaw, 0, 1) * 100;
    const reliability = clamp(reliabilityRaw, 0, 1) * 100;

    const labels: UnreliableLiquidityLabel[] = [];
    if (young || persistencePercentile < 30) labels.push('LOW_PERSISTENCE_WALL');
    if (level.approachWithdrawal) labels.push('APPROACH_WITHDRAWAL');
    if (reliability < 35) labels.push('UNRELIABLE_LIQUIDITY');
    if (this.reappearedFarther(level, now)) labels.push('REAPPEARS_FARTHER');

    return {
      side: level.side,
      price: level.price,
      quantity: level.quantity,
      notional: level.notionalValue,
      distanceBps: level.distanceBps,
      sizePercentile: level.sizePercentile,
      persistencePercentile,
      replenishmentPercentile,
      vsNearbyMedian,
      ageMs: level.ageMs,
      attackCount: level.attackCount,
      defendedCount: level.defendedCount,
      consumedNotional: level.consumedNotional,
      replenishedNotional: level.replenishedNotional,
      cancelledNotional: level.cancelledNotional,
      strength,
      reliability,
      lifecycle: lifecycleOf(level, young),
      labels,
      state: level.state,
    };
  }

  /** Remembers walls that vanished so a later wall farther out can be linked. */
  private trackDisappearance(walls: PassiveLiquidityWall[], now: number): void {
    const present = new Set(walls.map((w) => `${w.side}:${w.price}`));
    for (const [key, notional] of this.known) {
      if (present.has(key)) continue;
      const [side, priceRaw] = key.split(':');
      const price = Number(priceRaw);
      if (!Number.isFinite(price)) continue;
      this.vanished.push({
        side: side === 'BID' ? 'BID' : 'ASK',
        price,
        distanceBps: 0,
        notional,
        at: now,
      });
      this.known.delete(key);
    }
    for (const wall of walls) this.known.set(`${wall.side}:${wall.price}`, wall.notional);

    const cutoff = now - 60_000;
    while (this.vanished.length && (this.vanished[0]?.at ?? 0) < cutoff) this.vanished.shift();
    if (this.vanished.length > 256) this.vanished.splice(0, this.vanished.length - 256);
  }

  private reappearedFarther(level: PassiveLiquidityLevel, now: number): boolean {
    if (level.ageMs > 30_000) return false;
    for (const gone of this.vanished) {
      if (gone.side !== level.side) continue;
      if (now - gone.at > 30_000) continue;
      const farther = level.side === 'ASK' ? level.price > gone.price : level.price < gone.price;
      const comparableSize = gone.notional > 0
        && level.notionalValue >= gone.notional * 0.6
        && level.notionalValue <= gone.notional * 1.8;
      if (farther && comparableSize) return true;
    }
    return false;
  }
}

function lifecycleOf(level: PassiveLiquidityLevel, young: boolean): WallLifecycle {
  if (level.quantity <= 0) {
    return level.consumedQuantity > level.cancelledQuantity ? 'CONSUMED' : 'WITHDRAWN';
  }
  if (level.approachWithdrawal) return 'WITHDRAWN';
  if (level.state === 'BROKEN') return 'BROKEN';
  if (level.defendedCount > 0 && level.quantity >= level.maxQuantity * 0.6) return 'DEFENDED';
  if (level.attackCount > 0 && level.consumedQuantity > 0) return 'ATTACKED';
  if (young) return 'FORMING';
  return 'HOLDING';
}

/** Nearest wall on a side, ignoring ones already broken or pulled. */
export function nearestWall(
  walls: PassiveLiquidityWall[],
  side: PassiveSide,
): PassiveLiquidityWall | null {
  let best: PassiveLiquidityWall | null = null;
  for (const wall of walls) {
    if (wall.side !== side || wall.quantity <= 0) continue;
    if (wall.lifecycle === 'BROKEN' || wall.lifecycle === 'WITHDRAWN') continue;
    if (!best || wall.distanceBps < best.distanceBps) best = wall;
  }
  return best;
}

export function distanceToNextWallBps(
  walls: PassiveLiquidityWall[],
  side: PassiveSide,
  minStrength: number,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const wall of walls) {
    if (wall.side !== side || wall.strength < minStrength) continue;
    best = Math.min(best, wall.distanceBps);
  }
  return best;
}

export function wallShare(walls: PassiveLiquidityWall[], side: PassiveSide): number {
  const sideWalls = walls.filter((w) => w.side === side);
  if (!sideWalls.length) return 0;
  const reliable = sideWalls.filter((w) => w.reliability >= 50).length;
  return safeDiv(reliable, sideWalls.length);
}
