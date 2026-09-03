import type { PassiveLiquidityConfig } from '../config/types.js';
import { RingBuffer } from '../core/ring-buffer.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import { BookTickEstimator, levelKey } from './tick.js';
import type { LocalOrderBook } from '../liquidity/local-order-book.js';
import type {
  LiquidityLevelTimelinePoint,
  PassiveLiquidityEvent,
  PassiveLiquidityEventType,
  PassiveLiquidityLevel,
  PassiveLiquidityState,
  PassiveSide,
} from '../models/passive-liquidity.js';
import {
  absorptionScoreOf,
  persistenceScore,
  replenishmentRatio,
  replenishmentScoreOf,
  withdrawalScoreOf,
  type LevelScoreInput,
} from './level-scores.js';
import type { TradeMatcher } from './trade-matcher.js';

interface UnresolvedDrop {
  at: number;
  quantity: number;
}

interface AttackEpisode {
  startedAt: number;
  startQuantity: number;
  lastConsumedAt: number;
  consumed: number;
}

interface TrackedLevel {
  side: PassiveSide;
  price: number;
  quantity: number;

  firstSeenAt: number;
  lastUpdatedAt: number;
  lastPresentAt: number;
  presentMs: number;

  initialQuantity: number;
  addedQuantity: number;
  consumedQuantity: number;
  cancelledQuantity: number;
  replenishedQuantity: number;

  maxQuantity: number;
  maxNotional: number;

  executionCount: number;
  updateCount: number;
  replenishmentCount: number;
  attackCount: number;
  defendedCount: number;
  brokenCount: number;

  /** Consumed size not yet replaced, drives replenishment detection. */
  outstandingConsumed: number;
  lastConsumedAt: number;
  episode: AttackEpisode | null;

  unresolved: UnresolvedDrop[];

  visible: boolean;
  outOfView: boolean;
  removedAt: number;

  approachRefBps: number;
  approachRefQuantity: number;
  approachRefCancelled: number;
  approachRefConsumed: number;
  closestApproachBps: number;
  quantityAtClosestApproach: number;
  approachWithdrawal: boolean;

  sizePercentile: number;
  lastEvent: PassiveLiquidityEventType | 'NONE';
  timeline: RingBuffer<LiquidityLevelTimelinePoint>;
}

export interface SideFlowDelta {
  addedQuantity: number;
  addedNotional: number;
  consumedQuantity: number;
  consumedNotional: number;
  cancelledQuantity: number;
  cancelledNotional: number;
  replenishedQuantity: number;
  replenishedNotional: number;
}

export interface LevelFlowDelta extends SideFlowDelta {
  side: PassiveSide;
  price: number;
  distanceBps: number;
}

export interface ObservationDelta {
  at: number;
  mid: number;
  bid: SideFlowDelta;
  ask: SideFlowDelta;
  /** Per-price activity, used for band accounting without treating range migration as cancellation. */
  levels: LevelFlowDelta[];
  /** Levels dropped by the exchange's depth truncation, excluded from cancels. */
  truncatedLevels: number;
  invalidLevels: number;
  crossedBook: boolean;
}

function emptyFlow(): SideFlowDelta {
  return {
    addedQuantity: 0,
    addedNotional: 0,
    consumedQuantity: 0,
    consumedNotional: 0,
    cancelledQuantity: 0,
    cancelledNotional: 0,
    replenishedQuantity: 0,
    replenishedNotional: 0,
  };
}

function flowForLevel(
  flows: LevelFlowDelta[],
  level: Pick<TrackedLevel, 'side' | 'price'>,
  mid: number,
): LevelFlowDelta {
  let flow = flows.find((entry) => entry.side === level.side && entry.price === level.price);
  if (!flow) {
    flow = {
      side: level.side,
      price: level.price,
      distanceBps: distanceBpsOf(level.side, level.price, mid),
      ...emptyFlow(),
    };
    flows.push(flow);
  }
  return flow;
}

/**
 * Tracks every resting price level's full lifecycle: how much is there, how long
 * it has been there, what happened to it, and whether the change was explained
 * by an execution.
 *
 * Truncated depth feeds (for example Binance depth20) are handled explicitly:
 * a level that falls outside the venue's visible window is frozen as out of
 * view, never counted as a cancellation.
 */
export class LevelTracker {
  private readonly levels: Record<PassiveSide, Map<number, TrackedLevel>> = {
    BID: new Map(),
    ASK: new Map(),
  };
  private readonly sizeDist: Record<PassiveSide, RollingDistribution>;
  private readonly events: RingBuffer<PassiveLiquidityEvent>;
  private readonly ticks = new BookTickEstimator();
  private lastObservedAt = 0;
  private lastMid = 0;
  private visibleDepthBps = 0;

  constructor(
    private readonly config: PassiveLiquidityConfig,
    private readonly matcher: TradeMatcher,
  ) {
    this.sizeDist = {
      BID: new RollingDistribution(config.levelSampleSize),
      ASK: new RollingDistribution(config.levelSampleSize),
    };
    this.events = new RingBuffer<PassiveLiquidityEvent>(config.eventCapacity);
  }

  get mid(): number {
    return this.lastMid;
  }

  /** Distance beyond which the venue stops publishing levels. */
  get truncationBps(): number {
    return this.visibleDepthBps;
  }

  observe(now: number, book: LocalOrderBook): ObservationDelta | null {
    const mid = book.mid();
    if (!Number.isFinite(mid) || mid <= 0 || book.empty()) return null;

    const tick = this.ticks.observe(book);
    const delta: ObservationDelta = {
      at: now,
      mid,
      bid: emptyFlow(),
      ask: emptyFlow(),
      levels: [],
      truncatedLevels: 0,
      invalidLevels: 0,
      crossedBook: false,
    };

    const bestBid = book.bestBid();
    const bestAsk = book.bestAsk();
    if (bestBid && bestAsk && bestBid.price >= bestAsk.price) delta.crossedBook = true;

    const bidView = this.collect(book, 'BID', mid, tick, delta);
    const askView = this.collect(book, 'ASK', mid, tick, delta);
    this.visibleDepthBps = Math.min(bidView.edgeBps, askView.edgeBps);

    this.matcher.prune(now);
    this.reconcile('BID', bidView.levels, bidView.edgePrice, now, mid, delta.bid, delta);
    this.reconcile('ASK', askView.levels, askView.edgePrice, now, mid, delta.ask, delta);

    this.lastObservedAt = now;
    this.lastMid = mid;
    return delta;
  }

  /**
   * A sequence gap means incremental state can no longer be trusted. All
   * lifecycle history is dropped rather than carried across the discontinuity.
   */
  reset(): void {
    this.levels.BID.clear();
    this.levels.ASK.clear();
    this.matcher.reset();
    this.ticks.reset();
    this.lastObservedAt = 0;
    this.lastMid = 0;
  }

  drainEvents(): PassiveLiquidityEvent[] {
    const out = this.events.toArray();
    this.events.clear();
    return out;
  }

  snapshotLevels(now: number, mid: number): PassiveLiquidityLevel[] {
    const out: PassiveLiquidityLevel[] = [];
    for (const side of ['ASK', 'BID'] as PassiveSide[]) {
      for (const level of this.levels[side].values()) {
        if (level.quantity <= 0 && level.removedAt > 0) continue;
        out.push(this.toPublic(level, now, mid));
      }
    }
    return out.sort((a, b) => b.price - a.price);
  }

  levelAt(side: PassiveSide, price: number, now: number, mid: number): PassiveLiquidityLevel | null {
    const level = this.levels[side].get(levelKey(price, this.ticks.tickFor(price)));
    return level ? this.toPublic(level, now, mid) : null;
  }

  timelineAt(side: PassiveSide, price: number, mid: number): LiquidityLevelTimelinePoint[] {
    const level = this.levels[side].get(levelKey(price, this.ticks.tickFor(price)));
    return level ? level.timeline.toArray() : [];
  }

  /** Removes long-dead levels so the map stays bounded on a live feed. */
  prune(now: number): void {
    const ttl = Math.max(60_000, this.config.replenishWindowMs * 12);
    for (const side of ['BID', 'ASK'] as PassiveSide[]) {
      const map = this.levels[side];
      for (const [price, level] of map) {
        if (level.quantity <= 0 && level.removedAt > 0 && now - level.removedAt > ttl) {
          map.delete(price);
        }
      }
      if (map.size > 4_000) {
        const ordered = [...map.entries()].sort((a, b) => a[1].lastUpdatedAt - b[1].lastUpdatedAt);
        for (const [price] of ordered.slice(0, map.size - 4_000)) map.delete(price);
      }
    }
  }

  private collect(
    book: LocalOrderBook,
    side: PassiveSide,
    mid: number,
    tick: number,
    delta: ObservationDelta,
  ): { levels: Map<number, number>; edgePrice: number; edgeBps: number } {
    const bookSide = side === 'BID' ? 'bid' : 'ask';
    const levels = new Map<number, number>();
    let edgePrice = side === 'BID' ? Number.POSITIVE_INFINITY : 0;

    for (const raw of book.sortedLevels(bookSide)) {
      if (!Number.isFinite(raw.price) || !Number.isFinite(raw.quantity) || raw.price <= 0) {
        delta.invalidLevels += 1;
        continue;
      }
      if (raw.quantity <= 0) continue;
      if (side === 'BID') edgePrice = Math.min(edgePrice, raw.price);
      else edgePrice = Math.max(edgePrice, raw.price);

      if (distanceBpsOf(side, raw.price, mid) > this.config.maxTrackedBps) continue;
      const key = levelKey(raw.price, tick);
      levels.set(key, (levels.get(key) ?? 0) + raw.quantity);
    }

    if (!Number.isFinite(edgePrice) || edgePrice <= 0) {
      return { levels, edgePrice: 0, edgeBps: this.config.maxTrackedBps };
    }
    return {
      levels,
      edgePrice,
      edgeBps: Math.min(this.config.maxTrackedBps, distanceBpsOf(side, edgePrice, mid)),
    };
  }

  private reconcile(
    side: PassiveSide,
    current: Map<number, number>,
    edgePrice: number,
    now: number,
    mid: number,
    flow: SideFlowDelta,
    delta: ObservationDelta,
  ): void {
    const map = this.levels[side];

    for (const [price, quantity] of current) {
      const level = map.get(price) ?? this.create(side, price, now, quantity, mid);
      if (!map.has(price)) map.set(price, level);
      level.visible = true;
      level.outOfView = false;
      level.removedAt = 0;
      this.applyQuantity(level, quantity, now, mid, flow, delta.levels);
      this.trackApproach(level, now, mid);
      if (quantity > 0) this.sizeDist[side].add(quantity * price);
      level.sizePercentile = this.sizeDist[side].midRank(quantity * price);
    }

    for (const [price, level] of map) {
      if (current.has(price)) continue;
      if (level.quantity <= 0) continue;

      const beyondEdge = edgePrice > 0 && (side === 'BID' ? price < edgePrice : price > edgePrice);
      if (beyondEdge) {
        // The venue stopped publishing this level. Its size is unknown, not zero.
        level.outOfView = true;
        level.visible = false;
        delta.truncatedLevels += 1;
        continue;
      }
      level.visible = false;
      this.applyQuantity(level, 0, now, mid, flow, delta.levels);
      if (level.quantity <= 0) level.removedAt = now;
    }

    for (const level of map.values()) {
      this.settleUnresolved(level, now, mid, flow, delta.levels);
      this.settleEpisode(level, now, mid);
    }
  }

  private create(
    side: PassiveSide,
    price: number,
    now: number,
    quantity: number,
    mid: number,
  ): TrackedLevel {
    const level: TrackedLevel = {
      side,
      price,
      quantity: 0,
      firstSeenAt: now,
      lastUpdatedAt: now,
      lastPresentAt: now,
      presentMs: 0,
      initialQuantity: quantity,
      addedQuantity: 0,
      consumedQuantity: 0,
      cancelledQuantity: 0,
      replenishedQuantity: 0,
      maxQuantity: 0,
      maxNotional: 0,
      executionCount: 0,
      updateCount: 0,
      replenishmentCount: 0,
      attackCount: 0,
      defendedCount: 0,
      brokenCount: 0,
      outstandingConsumed: 0,
      lastConsumedAt: 0,
      episode: null,
      unresolved: [],
      visible: true,
      outOfView: false,
      removedAt: 0,
      approachRefBps: distanceBpsOf(side, price, mid),
      approachRefQuantity: quantity,
      approachRefCancelled: 0,
      approachRefConsumed: 0,
      closestApproachBps: distanceBpsOf(side, price, mid),
      quantityAtClosestApproach: quantity,
      approachWithdrawal: false,
      sizePercentile: 50,
      lastEvent: 'NONE',
      timeline: new RingBuffer<LiquidityLevelTimelinePoint>(this.config.timelinePoints),
    };
    return level;
  }

  private applyQuantity(
    level: TrackedLevel,
    quantity: number,
    now: number,
    mid: number,
    flow: SideFlowDelta,
    levelFlows: LevelFlowDelta[],
  ): void {
    const previous = level.quantity;
    const change = quantity - previous;

    if (previous > 0 && now > level.lastPresentAt) {
      level.presentMs += now - level.lastPresentAt;
    }
    level.lastPresentAt = now;

    if (Math.abs(change) < 1e-12) {
      level.quantity = quantity;
      level.lastUpdatedAt = now;
      return;
    }

    let event: PassiveLiquidityEventType = change > 0 ? 'LIQUIDITY_ADDED' : 'LIQUIDITY_CANCELLED';

    if (change > 0) {
      const levelFlow = flowForLevel(levelFlows, level, mid);
      level.addedQuantity += change;
      flow.addedQuantity += change;
      flow.addedNotional += change * level.price;
      levelFlow.addedQuantity += change;
      levelFlow.addedNotional += change * level.price;

      const withinWindow = now - level.lastConsumedAt <= this.config.replenishWindowMs;
      if (level.outstandingConsumed > 0 && withinWindow) {
        const replenished = Math.min(change, level.outstandingConsumed);
        level.replenishedQuantity += replenished;
        level.outstandingConsumed -= replenished;
        level.replenishmentCount += 1;
        flow.replenishedQuantity += replenished;
        flow.replenishedNotional += replenished * level.price;
        levelFlow.replenishedQuantity += replenished;
        levelFlow.replenishedNotional += replenished * level.price;
        event = 'LIQUIDITY_REPLENISHED';
      }
    } else {
      const drop = -change;
      const matched = this.matcher.claim(level.side, level.price, drop, now, this.ticks.tick);
      if (matched > 0) {
        this.recordConsumption(level, matched, now, flow, previous, levelFlows, mid);
        event = 'LIQUIDITY_CONSUMED';
      }
      const remainder = drop - matched;
      if (remainder > 1e-12) {
        level.unresolved.push({ at: now, quantity: remainder });
        // Deliberately not classified yet: the trade may still arrive.
        if (matched <= 0) event = 'LIQUIDITY_MOVED';
      }
    }

    level.quantity = quantity;
    level.lastUpdatedAt = now;
    level.updateCount += 1;
    if (quantity > level.maxQuantity) {
      level.maxQuantity = quantity;
      level.maxNotional = quantity * level.price;
    }
    level.lastEvent = event;
    level.timeline.push({
      at: now,
      notional: quantity * level.price,
      quantity,
      event,
    });
    this.pushEvent(level, event, Math.abs(change), now, mid, eventNote(event));
  }

  /**
   * `sizeBefore` is the resting size immediately before this attack started and
   * must be supplied by the caller: `level.quantity` still holds the pre-drop
   * size when called from `applyQuantity`, but has already been updated when
   * called from the unresolved-drop retry. Deriving it here from `level.quantity`
   * would be wrong in one of the two paths and would skew every subsequent
   * defended/broken verdict for the level.
   */
  private recordConsumption(
    level: TrackedLevel,
    quantity: number,
    now: number,
    flow: SideFlowDelta,
    sizeBefore: number,
    levelFlows: LevelFlowDelta[],
    mid: number,
  ): void {
    level.consumedQuantity += quantity;
    level.executionCount += 1;
    level.outstandingConsumed += quantity;
    level.lastConsumedAt = now;
    flow.consumedQuantity += quantity;
    flow.consumedNotional += quantity * level.price;
    const levelFlow = flowForLevel(levelFlows, level, mid);
    levelFlow.consumedQuantity += quantity;
    levelFlow.consumedNotional += quantity * level.price;

    if (!level.episode) {
      level.episode = {
        startedAt: now,
        startQuantity: sizeBefore,
        lastConsumedAt: now,
        consumed: quantity,
      };
      level.attackCount += 1;
    } else {
      level.episode.lastConsumedAt = now;
      level.episode.consumed += quantity;
    }
  }

  /**
   * Retries unmatched drops against trades that arrived after the book update,
   * then commits whatever is still unexplained as a cancellation.
   */
  private settleUnresolved(
    level: TrackedLevel,
    now: number,
    mid: number,
    flow: SideFlowDelta,
    levelFlows: LevelFlowDelta[],
  ): void {
    if (!level.unresolved.length) return;
    const kept: UnresolvedDrop[] = [];

    for (const pending of level.unresolved) {
      let remaining = pending.quantity;
      if (now - pending.at <= this.config.tradeMatchWindowMs) {
        const matched = this.matcher.claim(level.side, level.price, remaining, pending.at, this.ticks.tick);
        if (matched > 0) {
          // Quantity is already reduced here, so add the drop back to recover
          // the size the level held before this attack.
          this.recordConsumption(level, matched, pending.at, flow, level.quantity + pending.quantity, levelFlows, mid);
          remaining -= matched;
        }
      }
      if (remaining <= 1e-12) continue;

      if (now - pending.at >= this.config.unresolvedCommitMs) {
        level.cancelledQuantity += remaining;
        flow.cancelledQuantity += remaining;
        flow.cancelledNotional += remaining * level.price;
        const levelFlow = flowForLevel(levelFlows, level, mid);
        levelFlow.cancelledQuantity += remaining;
        levelFlow.cancelledNotional += remaining * level.price;
        this.pushEvent(
          level,
          'LIQUIDITY_CANCELLED',
          remaining,
          now,
          mid,
          'size removed with no matching execution',
        );
      } else {
        kept.push({ at: pending.at, quantity: remaining });
      }
    }
    level.unresolved = kept;
  }

  /**
   * Closes an attack episode once consumption stops, then decides whether the
   * level held (defended) or gave way (broken).
   *
   * An episode also closes early once the level has fully recovered its starting
   * size with nothing left outstanding. Waiting for a lull would mean a level
   * under sustained pressure that refills after every hit — the clearest form of
   * defence there is — never settles, and so never counts as defended at all.
   */
  private settleEpisode(level: TrackedLevel, now: number, mid: number): void {
    const episode = level.episode;
    if (!episode) return;

    const recovered =
      episode.startQuantity > 0 &&
      level.quantity >= episode.startQuantity &&
      level.outstandingConsumed <= 1e-12;
    if (!recovered && now - episode.lastConsumedAt < this.config.replenishWindowMs) return;

    const start = episode.startQuantity;
    level.episode = null;
    if (start <= 0) return;

    if (level.quantity >= start * 0.6) {
      level.defendedCount += 1;
      this.pushEvent(level, 'WALL_DEFENDED', level.quantity, now, mid, 'size restored after attack');
      return;
    }
    if (level.quantity <= start * (1 - this.config.wallBreakFraction)) {
      level.brokenCount += 1;
      this.pushEvent(level, 'WALL_BROKEN', episode.consumed, now, mid, 'level gave way under aggression');
    }
  }

  /**
   * Records what a level does as price closes in on it. Losing size to
   * cancellations during an approach is withdrawal, not defence.
   */
  private trackApproach(level: TrackedLevel, now: number, mid: number): void {
    const bps = distanceBpsOf(level.side, level.price, mid);

    if (bps < level.closestApproachBps) {
      level.closestApproachBps = bps;
      level.quantityAtClosestApproach = level.quantity;
    }

    if (bps > level.approachRefBps) {
      level.approachRefBps = bps;
      level.approachRefQuantity = level.quantity;
      level.approachRefCancelled = level.cancelledQuantity;
      level.approachRefConsumed = level.consumedQuantity;
      return;
    }

    if (level.approachRefBps - bps < this.config.approachArmBps) return;
    if (level.approachRefQuantity <= 0) return;

    const lost = level.approachRefQuantity - level.quantity;
    if (lost <= 0) return;
    const spanCancelled = level.cancelledQuantity - level.approachRefCancelled;
    const spanConsumed = level.consumedQuantity - level.approachRefConsumed;
    const shrankEnough = lost >= level.approachRefQuantity * this.config.approachWithdrawalFraction;

    if (shrankEnough && spanCancelled > spanConsumed) {
      if (!level.approachWithdrawal) {
        this.pushEvent(
          level,
          'WALL_DISAPPEARED',
          lost,
          now,
          mid,
          'size pulled as price approached, before being attacked',
        );
      }
      level.approachWithdrawal = true;
    }
  }

  private pushEvent(
    level: TrackedLevel,
    type: PassiveLiquidityEventType,
    quantity: number,
    now: number,
    mid: number,
    note: string,
  ): void {
    this.events.push({
      type,
      side: level.side,
      price: level.price,
      timestamp: now,
      quantity,
      notional: quantity * level.price,
      distanceBps: distanceBpsOf(level.side, level.price, mid),
      note,
    });
  }

  private toPublic(level: TrackedLevel, now: number, mid: number): PassiveLiquidityLevel {
    const reference = mid || this.lastMid || level.price;
    const distanceFromMid = Math.max(0, level.side === 'ASK' ? level.price - reference : reference - level.price);
    const distanceBps = reference > 0 ? (distanceFromMid / reference) * 10_000 : 0;
    const ageMs = Math.max(0, now - level.firstSeenAt);
    const unresolved = level.unresolved.reduce((sum, u) => sum + u.quantity, 0);

    const scoreInput: LevelScoreInput = {
      ageMs,
      presentMs: level.presentMs,
      distanceBps,
      quantity: level.quantity,
      maxQuantity: level.maxQuantity,
      consumedQuantity: level.consumedQuantity,
      cancelledQuantity: level.cancelledQuantity,
      replenishedQuantity: level.replenishedQuantity,
      attackCount: level.attackCount,
      defendedCount: level.defendedCount,
      replenishmentCount: level.replenishmentCount,
    };

    const persistence = persistenceScore(scoreInput, this.config);
    const replenishment = replenishmentScoreOf(scoreInput);
    const withdrawal = withdrawalScoreOf(scoreInput, this.config);
    const absorption = absorptionScoreOf(scoreInput);
    const isWall =
      level.sizePercentile >= this.config.wallMinPercentile && level.quantity > 0;

    return {
      side: level.side,
      price: level.price,
      quantity: level.quantity,
      notionalValue: level.quantity * level.price,
      distanceFromMid,
      distanceBps,
      distancePercent: distanceBps / 100,
      firstSeenAt: level.firstSeenAt,
      lastUpdatedAt: level.lastUpdatedAt,
      ageMs,
      presentMs: level.presentMs,
      initialQuantity: level.initialQuantity,
      initialNotional: level.initialQuantity * level.price,
      addedQuantity: level.addedQuantity,
      addedNotional: level.addedQuantity * level.price,
      consumedQuantity: level.consumedQuantity,
      consumedNotional: level.consumedQuantity * level.price,
      cancelledQuantity: level.cancelledQuantity,
      cancelledNotional: level.cancelledQuantity * level.price,
      replenishedQuantity: level.replenishedQuantity,
      replenishedNotional: level.replenishedQuantity * level.price,
      unresolvedQuantity: unresolved,
      maxQuantity: level.maxQuantity,
      maxNotional: level.maxNotional,
      executionCount: level.executionCount,
      updateCount: level.updateCount,
      replenishmentCount: level.replenishmentCount,
      attackCount: level.attackCount,
      defendedCount: level.defendedCount,
      replenishmentRatio: replenishmentRatio(level.replenishedQuantity, level.consumedQuantity),
      persistenceScore: persistence,
      replenishmentScore: replenishment,
      withdrawalScore: withdrawal,
      absorptionScore: absorption,
      sizePercentile: level.sizePercentile,
      isWall,
      closestApproachBps: level.closestApproachBps,
      notionalAtClosestApproach: level.quantityAtClosestApproach * level.price,
      approachWithdrawal: level.approachWithdrawal,
      visible: level.visible,
      outOfView: level.outOfView,
      state: classifyLevelState(level, {
        persistence,
        replenishment,
        withdrawal,
        absorption,
        ageMs,
        isWall,
      }, this.config),
    };
  }
}

export function distanceBpsOf(side: PassiveSide, price: number, mid: number): number {
  if (mid <= 0) return Number.POSITIVE_INFINITY;
  const distance = side === 'ASK' ? price - mid : mid - price;
  return (Math.max(0, distance) / mid) * 10_000;
}

interface LevelStateInput {
  persistence: number;
  replenishment: number;
  withdrawal: number;
  absorption: number;
  ageMs: number;
  isWall: boolean;
}

/**
 * Evidence-ordered classification. Structural outcomes (broken, withdrawn,
 * unreliable) win over descriptive ones so a level cannot read as DEFENDING
 * while it is actually being pulled.
 */
function classifyLevelState(
  level: TrackedLevel,
  scores: LevelStateInput,
  config: PassiveLiquidityConfig,
): PassiveLiquidityState {
  if (level.outOfView) return 'PERSISTENT';
  if (level.quantity <= 0) {
    return level.consumedQuantity > level.cancelledQuantity ? 'BROKEN' : 'VACUUM';
  }
  if (level.brokenCount > 0 && level.quantity < level.maxQuantity * 0.2) return 'BROKEN';
  if (level.approachWithdrawal) return 'WITHDRAWING';
  if (scores.isWall && scores.ageMs < config.wallYoungMs) return 'UNRELIABLE';
  if (scores.withdrawal >= 60 && scores.withdrawal > scores.replenishment) return 'WITHDRAWING';
  if (scores.absorption >= config.minAbsorptionScore) return 'ABSORBING';
  if (level.defendedCount >= 2 && scores.replenishment >= 50) return 'DEFENDING';
  if (level.episode && scores.replenishment >= 50) return 'REPLENISHING';
  if (level.episode) return 'BEING_CONSUMED';
  if (level.quantity > level.maxQuantity * 0.95 && level.addedQuantity > level.initialQuantity) {
    return 'BUILDING';
  }
  if (level.quantity < level.maxQuantity * 0.5) return 'WEAKENING';
  if (scores.persistence >= 55) return 'PERSISTENT';
  return 'NEW';
}

function eventNote(event: PassiveLiquidityEventType): string {
  switch (event) {
    case 'LIQUIDITY_ADDED':
      return 'resting size increased';
    case 'LIQUIDITY_CONSUMED':
      return 'size removed by matching aggressive execution';
    case 'LIQUIDITY_REPLENISHED':
      return 'size restored after execution';
    case 'LIQUIDITY_MOVED':
      return 'size reduced, awaiting trade reconciliation';
    default:
      return 'resting size changed';
  }
}
