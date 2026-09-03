import { RollingDistribution } from '../core/rolling-stats.js';
import { RingBuffer } from '../core/ring-buffer.js';
import type {
  NetLiquidityBand,
  NetLiquidityCause,
  NetLiquiditySide,
  NetLiquiditySnapshot,
  PassiveLiquidityLevel,
  PassiveSide,
} from '../models/passive-liquidity.js';
import { NET_LIQUIDITY_WINDOWS_MS } from '../models/passive-liquidity.js';
import type { ObservationDelta, SideFlowDelta } from './level-tracker.js';

export { NET_LIQUIDITY_WINDOWS_MS };

const EPSILON = 1e-9;
const SMALL_BASE = 1;
const MIN_NORMALIZATION_SAMPLES = 8;

interface Amounts {
  quantity: number;
  notional: number;
}

export interface NetLiquiditySideInput {
  side: PassiveSide;
  elapsedMs: number;
  starting: Amounts;
  current: Amounts;
  /** All increases, including replenishment; replenishment is removed to obtain genuinely new liquidity. */
  added: Amounts;
  replenished: Amounts;
  cancelled: Amounts;
  consumed: Amounts;
  trustworthy: boolean;
  reconciliationTolerance?: number;
  percentile?: number;
  zScore?: number;
  velocityPercentile?: number;
  velocityZScore?: number;
  /** For moving bands, classify behavior rather than levels crossing the band boundary. */
  classificationNetChange?: number;
}

export function calculateNetLiquiditySide(input: NetLiquiditySideInput): NetLiquiditySide {
  const newAddedQuantity = Math.max(0, input.added.quantity - input.replenished.quantity);
  const newAdded = Math.max(0, input.added.notional - input.replenished.notional);
  const totalAddedQuantity = newAddedQuantity + input.replenished.quantity;
  const totalAdded = newAdded + input.replenished.notional;
  const behavioralNetQuantity = totalAddedQuantity - input.cancelled.quantity - input.consumed.quantity;
  const behavioralNetChange = totalAdded - input.cancelled.notional - input.consumed.notional;
  const bookNetQuantity = input.current.quantity - input.starting.quantity;
  const bookNetChange = input.current.notional - input.starting.notional;
  const expected = input.starting.notional + behavioralNetChange;
  const reconciliationError = input.current.notional - expected;
  const reconciliationErrorPercent = Math.abs(reconciliationError)
    / Math.max(Math.abs(input.current.notional), Math.abs(expected), EPSILON);
  const classificationNetChange = input.classificationNetChange ?? bookNetChange;
  const percentageReliable = input.starting.notional >= SMALL_BASE;
  const netChangePercent = percentageReliable
    ? (classificationNetChange / input.starting.notional) * 100
    : null;
  const removed = input.cancelled.notional + input.consumed.notional;
  const additions = newAdded + input.replenished.notional;
  const cancellationShare = removed > 0 ? input.cancelled.notional / removed : 0;
  const consumptionShare = removed > 0 ? input.consumed.notional / removed : 0;
  const withdrawalPressure = input.cancelled.notional
    / Math.max(input.cancelled.notional + additions, EPSILON);
  const tolerance = input.reconciliationTolerance ?? 0.05;
  const dataConsistency = reconciliationErrorPercent <= tolerance ? 'HIGH' : 'LOW';
  const primaryCause = causeOf(
    behavioralNetChange,
    newAdded,
    input.replenished.notional,
    input.cancelled.notional,
    input.consumed.notional,
  );
  const state = classifyNetLiquidity(
    classificationNetChange,
    netChangePercent,
    input.percentile ?? 50,
    input.trustworthy && dataConsistency === 'HIGH',
  );

  return {
    side: input.side,
    startingQuantity: input.starting.quantity,
    currentQuantity: input.current.quantity,
    newAddedQuantity,
    replenishedQuantity: input.replenished.quantity,
    cancelledQuantity: input.cancelled.quantity,
    consumedQuantity: input.consumed.quantity,
    bookNetQuantity,
    behavioralNetQuantity,
    startingDepth: input.starting.notional,
    currentDepth: input.current.notional,
    newAdded,
    replenished: input.replenished.notional,
    totalAdded,
    cancelled: input.cancelled.notional,
    consumed: input.consumed.notional,
    bookNetChange,
    behavioralNetChange,
    netChangePercent,
    percentageReliable,
    velocityPerSec: behavioralNetChange / Math.max(0.001, input.elapsedMs / 1_000),
    velocityPercentile: input.velocityPercentile ?? 50,
    velocityZScore: input.velocityZScore ?? 0,
    percentile: input.percentile ?? 50,
    zScore: input.zScore ?? 0,
    withdrawalPressure,
    cancellationShare,
    consumptionShare,
    reconciliationError,
    reconciliationErrorPercent,
    dataConsistency,
    state,
    primaryCause,
  };
}

function causeOf(
  net: number,
  newAdded: number,
  replenished: number,
  cancelled: number,
  consumed: number,
): NetLiquidityCause {
  if (Math.abs(net) <= EPSILON) return 'NONE';
  if (net > 0) {
    const total = newAdded + replenished;
    if (total <= 0) return 'MIXED';
    if (replenished / total >= 0.6) return 'REPLENISHMENT';
    if (newAdded / total >= 0.6) return 'NEW_LIQUIDITY';
    return 'MIXED';
  }
  const removed = cancelled + consumed;
  if (removed <= 0) return 'MIXED';
  if (cancelled / removed >= 0.6) return 'WITHDRAWAL';
  if (consumed / removed >= 0.6) return 'CONSUMPTION';
  return 'MIXED';
}

function classifyNetLiquidity(
  net: number,
  percent: number | null,
  percentile: number,
  trustworthy: boolean,
): NetLiquiditySide['state'] {
  if (!trustworthy || percent == null) return 'LOW_CONFIDENCE';
  const magnitude = Math.abs(percent);
  if (magnitude <= 5) return 'STABLE';
  if (net > 0) return magnitude >= 30 || percentile >= 90 ? 'STRONGLY_GROWING' : 'GROWING';
  return magnitude >= 30 || percentile <= 10 ? 'STRONGLY_SHRINKING' : 'SHRINKING';
}

interface DepthPoint {
  at: number;
  mid: number;
  depth: Record<PassiveSide, Amounts[]>;
  flow: Record<PassiveSide, SideFlowDelta[]>;
}

interface DistributionSet {
  net: RollingDistribution;
  velocity: RollingDistribution;
}

/** Rolling, causal accounting over book observations. */
export class NetLiquidityTracker {
  /** One depth point per second retains an hour without storing every 100ms book snapshot. */
  private readonly points = new RingBuffer<DepthPoint>(3_601);
  private readonly distributions: Record<PassiveSide, DistributionSet>;
  private readonly imbalance: RollingDistribution;
  private pendingPoint: DepthPoint | null = null;
  private lastStoredAt = 0;

  constructor(
    sampleSize: number,
    private readonly bandEdgesBps: number[],
    private readonly reconciliationTolerance = 0.05,
  ) {
    const capacity = Math.max(32, sampleSize);
    this.distributions = {
      BID: { net: new RollingDistribution(capacity), velocity: new RollingDistribution(capacity) },
      ASK: { net: new RollingDistribution(capacity), velocity: new RollingDistribution(capacity) },
    };
    this.imbalance = new RollingDistribution(capacity);
  }

  observe(at: number, mid: number, levels: PassiveLiquidityLevel[], flow: ObservationDelta): void {
    const depth = { BID: this.emptyAmounts(), ASK: this.emptyAmounts() };
    const flows = { BID: this.emptyFlows(), ASK: this.emptyFlows() };
    for (const level of levels) {
      if (level.outOfView || level.quantity <= 0) continue;
      const index = this.bandIndex(level.distanceBps);
      if (index < 0) continue;
      depth[level.side][index]!.quantity += level.quantity;
      depth[level.side][index]!.notional += level.notionalValue;
    }
    for (const level of flow.levels) {
      const index = this.bandIndex(level.distanceBps);
      if (index < 0) continue;
      addFlow(flows[level.side][index]!, level);
    }
    const point = { at, mid, depth, flow: flows };
    if (this.points.length === 0) {
      // The first observation establishes starting depth; its initial population
      // is not new liquidity activity within the measurement window.
      point.flow = { BID: this.emptyFlows(), ASK: this.emptyFlows() };
      this.points.push(point);
      this.lastStoredAt = at;
      return;
    }
    if (!this.pendingPoint) {
      this.pendingPoint = point;
    } else {
      this.pendingPoint.at = at;
      this.pendingPoint.mid = mid;
      this.pendingPoint.depth = depth;
      for (const side of ['BID', 'ASK'] as PassiveSide[]) {
        for (let i = 0; i < flows[side].length; i++) {
          addFlow(this.pendingPoint.flow[side][i]!, flows[side][i]!);
        }
      }
    }
    if (at - this.lastStoredAt >= 1_000) {
      this.points.push(this.pendingPoint);
      this.lastStoredAt = at;
      this.pendingPoint = null;
    }
  }

  sample(now: number, windowMs: number): void {
    const raw = this.build(now, windowMs, true, false);
    this.distributions.BID.net.add(raw.bid.bookNetChange);
    this.distributions.ASK.net.add(raw.ask.bookNetChange);
    this.distributions.BID.velocity.add(raw.bid.velocityPerSec);
    this.distributions.ASK.velocity.add(raw.ask.velocityPerSec);
    this.imbalance.add(raw.liquidityChangeImbalance);
  }

  snapshot(now: number, windowMs: number, trustworthy: boolean): NetLiquiditySnapshot {
    return this.build(now, windowMs, trustworthy, true);
  }

  reset(): void {
    this.points.clear();
    this.pendingPoint = null;
    this.lastStoredAt = 0;
  }

  private emptyAmounts(): Amounts[] {
    return Array.from({ length: Math.max(0, this.bandEdgesBps.length - 1) }, () => ({ quantity: 0, notional: 0 }));
  }

  private emptyFlows(): SideFlowDelta[] {
    return Array.from({ length: Math.max(0, this.bandEdgesBps.length - 1) }, zeroFlow);
  }

  private bandIndex(distanceBps: number): number {
    for (let i = 0; i < this.bandEdgesBps.length - 1; i++) {
      const lo = this.bandEdgesBps[i];
      const hi = this.bandEdgesBps[i + 1];
      if (lo != null && hi != null && distanceBps >= lo && distanceBps < hi) return i;
    }
    return -1;
  }

  private build(now: number, windowMs: number, trustworthy: boolean, normalized: boolean): NetLiquiditySnapshot {
    const points = this.points.toArray();
    if (this.pendingPoint && this.pendingPoint.at <= now) points.push(this.pendingPoint);
    const eligible = points.filter((point) => point.at <= now);
    const empty = emptyPoint(now);
    const current = eligible[eligible.length - 1] ?? empty;
    const from = now - windowMs;
    const starting = [...eligible].reverse().find((point) => point.at <= from) ?? eligible[0] ?? empty;
    const active = eligible.filter((point) => point.at > starting.at && point.at <= now);
    const elapsedMs = Math.max(1, current.at - starting.at);
    const availableMs = Math.min(windowMs, elapsedMs);
    const coverageComplete = eligible.length > 0 && starting.at <= from;

    const total = (side: PassiveSide) => this.sideFor(
      side, starting, current, active, elapsedMs, trustworthy, normalized,
    );
    const within = (side: PassiveSide, bps: number) => this.sideFor(
      side, starting, current, active, elapsedMs, trustworthy, normalized, 0, bps, true,
    );
    const bid = total('BID');
    const ask = total('ASK');
    const near5Bps = { bid: within('BID', 5), ask: within('ASK', 5) };
    const near10Bps = { bid: within('BID', 10), ask: within('ASK', 10) };
    const bands: NetLiquidityBand[] = [];
    for (let i = 0; i < this.bandEdgesBps.length - 1; i++) {
      const lo = this.bandEdgesBps[i];
      const hi = this.bandEdgesBps[i + 1];
      if (lo == null || hi == null) continue;
      const bandBid = this.sideFor('BID', starting, current, active, elapsedMs, trustworthy, normalized, lo, hi, true);
      const bandAsk = this.sideFor('ASK', starting, current, active, elapsedMs, trustworthy, normalized, lo, hi, true);
      bands.push({
        fromBps: lo,
        toBps: hi,
        label: `${lo}-${hi}bps`,
        bid: bandBid,
        ask: bandAsk,
        rangeMigration: {
          bid: bandBid.bookNetChange - bandBid.behavioralNetChange,
          ask: bandAsk.bookNetChange - bandAsk.behavioralNetChange,
        },
      });
    }
    const liquidityChangeImbalance = bid.bookNetChange - ask.bookNetChange;
    const imbalanceWarm = normalized && this.imbalance.size >= MIN_NORMALIZATION_SAMPLES;
    const imbalancePercentile = imbalanceWarm ? this.imbalance.midRank(liquidityChangeImbalance) : 50;
    const imbalanceZScore = imbalanceWarm ? this.imbalance.zScore(liquidityChangeImbalance, EPSILON) : 0;
    const flags: NetLiquiditySnapshot['flags'] = [];
    if (bid.dataConsistency === 'LOW' || ask.dataConsistency === 'LOW') flags.push('LIQUIDITY_ACCOUNTING_MISMATCH');
    if (!bid.percentageReliable || !ask.percentageReliable) flags.push('SMALL_BASE_UNRELIABLE_PERCENTAGE');

    return {
      windowMs,
      availableMs,
      coverageComplete,
      bid,
      ask,
      near5Bps,
      near10Bps,
      bands,
      liquidityChangeImbalance,
      liquidityChangeImbalancePercentile: imbalancePercentile,
      liquidityChangeImbalanceZScore: imbalanceZScore,
      interpretation: interpretationOf(bid, ask, near10Bps.bid, near10Bps.ask),
      flags,
    };
  }

  private sideFor(
    side: PassiveSide,
    starting: DepthPoint,
    current: DepthPoint,
    active: DepthPoint[],
    elapsedMs: number,
    trustworthy: boolean,
    normalized: boolean,
    fromBps = 0,
    toBps = Number.POSITIVE_INFINITY,
    allowRangeMigration = false,
  ): NetLiquiditySide {
    const start = this.depthAt(starting, side, fromBps, toBps);
    const end = this.depthAt(current, side, fromBps, toBps);
    const flow = this.sumFlows(active, side, fromBps, toBps);
    const rawNet = end.notional - start.notional;
    const velocity = (flow.addedNotional - flow.cancelledNotional - flow.consumedNotional)
      / Math.max(0.001, elapsedMs / 1_000);
    const dist = this.distributions[side];
    const warm = normalized && dist.net.size >= MIN_NORMALIZATION_SAMPLES;
    const velocityWarm = normalized && dist.velocity.size >= MIN_NORMALIZATION_SAMPLES;
    return calculateNetLiquiditySide({
      side,
      elapsedMs,
      starting: start,
      current: end,
      added: { quantity: flow.addedQuantity, notional: flow.addedNotional },
      replenished: { quantity: flow.replenishedQuantity, notional: flow.replenishedNotional },
      cancelled: { quantity: flow.cancelledQuantity, notional: flow.cancelledNotional },
      consumed: { quantity: flow.consumedQuantity, notional: flow.consumedNotional },
      trustworthy,
      reconciliationTolerance: allowRangeMigration ? Number.POSITIVE_INFINITY : this.reconciliationTolerance,
      percentile: warm ? dist.net.midRank(rawNet) : 50,
      zScore: warm ? dist.net.zScore(rawNet, EPSILON) : 0,
      velocityPercentile: velocityWarm ? dist.velocity.midRank(velocity) : 50,
      velocityZScore: velocityWarm ? dist.velocity.zScore(velocity, EPSILON) : 0,
      classificationNetChange: allowRangeMigration
        ? flow.addedNotional - flow.cancelledNotional - flow.consumedNotional
        : undefined,
    });
  }

  private depthAt(point: DepthPoint, side: PassiveSide, from: number, to: number): Amounts {
    const out = { quantity: 0, notional: 0 };
    for (let i = 0; i < point.depth[side].length; i++) {
      const lo = this.bandEdgesBps[i];
      const hi = this.bandEdgesBps[i + 1];
      if (lo == null || hi == null || lo < from || hi > to) continue;
      out.quantity += point.depth[side][i]!.quantity;
      out.notional += point.depth[side][i]!.notional;
    }
    return out;
  }

  private sumFlows(points: DepthPoint[], side: PassiveSide, from: number, to: number): SideFlowDelta {
    const out = zeroFlow();
    for (const point of points) {
      for (let i = 0; i < point.flow[side].length; i++) {
        const lo = this.bandEdgesBps[i];
        const hi = this.bandEdgesBps[i + 1];
        if (lo == null || hi == null || lo < from || hi > to) continue;
        addFlow(out, point.flow[side][i]!);
      }
    }
    return out;
  }
}

export function emptyNetLiquiditySnapshot(windowMs = 0): NetLiquiditySnapshot {
  const side = (value: PassiveSide) => calculateNetLiquiditySide({
    side: value,
    elapsedMs: Math.max(1, windowMs),
    starting: { quantity: 0, notional: 0 },
    current: { quantity: 0, notional: 0 },
    added: { quantity: 0, notional: 0 },
    replenished: { quantity: 0, notional: 0 },
    cancelled: { quantity: 0, notional: 0 },
    consumed: { quantity: 0, notional: 0 },
    trustworthy: false,
  });
  return {
    windowMs,
    availableMs: 0,
    coverageComplete: false,
    bid: side('BID'),
    ask: side('ASK'),
    near5Bps: { bid: side('BID'), ask: side('ASK') },
    near10Bps: { bid: side('BID'), ask: side('ASK') },
    bands: [],
    liquidityChangeImbalance: 0,
    liquidityChangeImbalancePercentile: 50,
    liquidityChangeImbalanceZScore: 0,
    interpretation: 'No order book data.',
    flags: ['SMALL_BASE_UNRELIABLE_PERCENTAGE'],
  };
}

function emptyPoint(at: number): DepthPoint {
  return {
    at,
    mid: 0,
    depth: { BID: [], ASK: [] },
    flow: { BID: [], ASK: [] },
  };
}

function zeroFlow(): SideFlowDelta {
  return {
    addedQuantity: 0, addedNotional: 0, consumedQuantity: 0, consumedNotional: 0,
    cancelledQuantity: 0, cancelledNotional: 0, replenishedQuantity: 0, replenishedNotional: 0,
  };
}

function addFlow(target: SideFlowDelta, source: SideFlowDelta): void {
  target.addedQuantity += source.addedQuantity;
  target.addedNotional += source.addedNotional;
  target.consumedQuantity += source.consumedQuantity;
  target.consumedNotional += source.consumedNotional;
  target.cancelledQuantity += source.cancelledQuantity;
  target.cancelledNotional += source.cancelledNotional;
  target.replenishedQuantity += source.replenishedQuantity;
  target.replenishedNotional += source.replenishedNotional;
}

function interpretationOf(
  bid: NetLiquiditySide,
  ask: NetLiquiditySide,
  nearBid: NetLiquiditySide,
  nearAsk: NetLiquiditySide,
): string {
  if (bid.state === 'LOW_CONFIDENCE' || ask.state === 'LOW_CONFIDENCE') {
    return 'Net liquidity is low confidence because the accounting or market-data sequence is incomplete.';
  }
  if (nearBid.behavioralNetChange > 0 && nearAsk.behavioralNetChange < 0) {
    return 'Near bids are building while near asks are withdrawing; upward movement may become easier if aggressive buyers confirm.';
  }
  if (nearBid.behavioralNetChange < 0 && nearAsk.behavioralNetChange > 0) {
    return 'Near bids are withdrawing while near asks are building; downward movement may become easier if aggressive sellers confirm.';
  }
  return `Bid liquidity is ${bid.state.toLowerCase().replace(/_/g, ' ')}; ask liquidity is ${ask.state.toLowerCase().replace(/_/g, ' ')}.`;
}
