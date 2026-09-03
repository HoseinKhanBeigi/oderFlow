import type { PassiveLiquidityConfig } from '../config/types.js';
import { clamp, safeDiv } from '../core/integrity.js';
import { RingBuffer } from '../core/ring-buffer.js';
import type { LocalOrderBook } from '../liquidity/local-order-book.js';
import type { PercentileBandConfig } from '../models/liquidity-response.js';
import type { MarketTrade } from '../models/trade.js';
import type {
  AggressionVsLiquidityPanel,
  EffortVsPassiveResult,
  HeatmapFrame,
  LiquidityLevelDetail,
  PassiveLiquidityContext,
  PassiveLiquidityEvent,
  PassiveLiquidityFeatures,
  PassiveLiquidityLevel,
  PassiveLiquiditySnapshot,
  PassiveSide,
  PassiveSideMetrics,
  PriceLevelMemory,
} from '../models/passive-liquidity.js';
import { aggregateDepth, buildBands, buildImbalanceCuts, imbalanceOf } from './bands.js';
import { assessAbsorption } from './absorption.js';
import { assessDataQuality } from './data-quality.js';
import { emptyPassiveLiquiditySnapshot } from './empty.js';
import { HeatmapRecorder } from './heatmap.js';
import { PriceLevelMemoryStore } from './level-memory.js';
import { LevelTracker, type SideFlowDelta } from './level-tracker.js';
import { PassiveMetricNormalizer, type RelativeContext } from './normalize.js';
import { classifyState } from './state.js';
import { passiveStrength } from './strength.js';
import { buildZones, pickCeiling, pickFloor } from './structure.js';
import { TradeMatcher } from './trade-matcher.js';
import { assessVacuum } from './vacuum.js';
import { LiquidityVelocityTracker } from './velocity.js';
import { distanceToNextWallBps, nearestWall, WallTracker } from './walls.js';
import { buildWhy } from './why.js';
import { NetLiquidityTracker } from './net-liquidity.js';

export interface PassiveLiquiditySnapshotInput {
  now: number;
  /**
   * Window for the reported raw totals. Defaults to `metricWindowMs` so the raw
   * numbers and their percentiles always describe the same span.
   */
  windowMs?: number;
  reconnects?: number;
  sequenceGaps?: number;
  sequenceContinuous?: boolean;
  bookEmpty?: boolean;
  /** Executed volume over the session, for relative normalization. */
  dailyVolume?: number;
  /** Exchange-supplied time of the latest book, for drift detection. */
  exchangeTimestamp?: number;
}

interface PriceSample {
  at: number;
  mid: number;
}

/**
 * Passive Liquidity Engine.
 *
 * Measures what resting bid and ask liquidity actually does: where it sits, how
 * long it has been there, whether it is consumed, cancelled or replenished, how
 * it behaves as price approaches, and how price responds.
 *
 * The engine deliberately keeps executed order flow and resting liquidity as
 * separate inputs. The order book is displayed passive intent; trades are
 * completed aggressive flow. Conflating them is what produces false absorption
 * and false spoofing calls.
 */
export class PassiveLiquidityEngine {
  private readonly matcher: TradeMatcher;
  private readonly tracker: LevelTracker;
  private readonly velocity = new LiquidityVelocityTracker();
  private readonly normalizer: PassiveMetricNormalizer;
  private readonly walls: WallTracker;
  private readonly memory: PriceLevelMemoryStore;
  private readonly heatmapRecorder: HeatmapRecorder;
  private readonly prices: RingBuffer<PriceSample>;
  private readonly pendingEvents: RingBuffer<PassiveLiquidityEvent>;
  private readonly netLiquidityTracker: NetLiquidityTracker;

  private lastHeatmapAt = 0;
  private lastBookAt = 0;
  private lastBookTimestamp = 0;
  private lastBestBid = 0;
  private lastBestAsk = 0;
  private lastSpreadBps = 0;
  private baselineSpreadBps = 0;
  private observations = 0;
  private lastSampleAt = 0;
  private invalidLevels = 0;
  private crossedBook = false;
  private truncatedLevels = 0;
  private resets = 0;

  constructor(
    readonly symbol: string,
    private readonly config: PassiveLiquidityConfig,
    private readonly bands: PercentileBandConfig,
  ) {
    this.matcher = new TradeMatcher(config);
    this.tracker = new LevelTracker(config, this.matcher);
    this.normalizer = new PassiveMetricNormalizer(config.metricSampleSize);
    this.walls = new WallTracker(config);
    this.memory = new PriceLevelMemoryStore(config);
    this.heatmapRecorder = new HeatmapRecorder(config);
    this.prices = new RingBuffer<PriceSample>(4_096);
    this.pendingEvents = new RingBuffer<PassiveLiquidityEvent>(config.eventCapacity);
    this.netLiquidityTracker = new NetLiquidityTracker(config.metricSampleSize, config.bandEdgesBps);
  }

  onTrade(trade: MarketTrade): void {
    if (trade.symbol && trade.symbol !== this.symbol) return;
    this.matcher.onTrade(trade);
    this.memory.onTrade(trade);
  }

  onBook(now: number, book: LocalOrderBook): void {
    const delta = this.tracker.observe(now, book);
    if (!delta) return;

    const observedLevels = this.tracker.snapshotLevels(now, delta.mid);
    this.netLiquidityTracker.observe(now, delta.mid, observedLevels, delta);

    this.velocity.record('BID', now, delta.bid);
    this.velocity.record('ASK', now, delta.ask);
    this.invalidLevels += delta.invalidLevels;
    this.truncatedLevels = delta.truncatedLevels;
    this.crossedBook = delta.crossedBook;

    this.lastBookAt = now;
    this.lastBookTimestamp = book.timestamp;
    this.lastBestBid = book.bestBid()?.price ?? 0;
    this.lastBestAsk = book.bestAsk()?.price ?? 0;
    const spread = book.spreadBps();
    if (Number.isFinite(spread)) {
      this.lastSpreadBps = spread;
      this.baselineSpreadBps = this.baselineSpreadBps === 0
        ? spread
        : this.baselineSpreadBps * 0.99 + spread * 0.01;
    }
    this.prices.push({ at: now, mid: delta.mid });
    this.observations += 1;

    // Events are drained on the book cadence so the heatmap sees every one of
    // them, and held here until the next snapshot reports them.
    for (const event of this.tracker.drainEvents()) this.pendingEvents.push(event);

    if (now - this.lastSampleAt >= this.config.metricSampleMs) {
      this.lastSampleAt = now;
      this.sampleMetrics(now);
    }

    /*
     * The heatmap is a time series of the book, so it has to be driven by book
     * updates rather than by whoever happens to ask for a snapshot. Building
     * public levels is the expensive part, so it runs on the frame interval
     * instead of on every update.
     */
    if (now - this.lastHeatmapAt >= this.config.heatmapFrameMs) {
      this.lastHeatmapAt = now;
      this.heatmapRecorder.record(now, delta.mid, this.tracker.snapshotLevels(now, delta.mid), this.pendingEvents.toArray());
    }

    this.tracker.prune(now);
  }

  /**
   * Sequence continuity is gone, so incremental lifecycle state is discarded.
   * Consumption and cancellation are not calculated across the discontinuity.
   */
  noteReset(now: number): void {
    this.tracker.reset();
    this.velocity.reset();
    this.heatmapRecorder.reset();
    this.pendingEvents.clear();
    this.netLiquidityTracker.reset();
    this.observations = 0;
    this.lastHeatmapAt = 0;
    this.lastSampleAt = 0;
    this.invalidLevels = 0;
    this.crossedBook = false;
    this.lastBookAt = 0;
    this.resets += 1;
    void now;
  }

  snapshot(input: PassiveLiquiditySnapshotInput): PassiveLiquiditySnapshot {
    const now = input.now;
    const mid = this.tracker.mid;
    if (mid <= 0 || input.bookEmpty) return emptyPassiveLiquiditySnapshot(this.symbol, now);

    const levels = this.tracker.snapshotLevels(now, mid);
    const depth = aggregateDepth(levels, this.config);
    const bands = buildBands(levels, this.config);
    const imbalanceCuts = buildImbalanceCuts(levels, this.config);

    const metricWindow = this.config.metricWindowMs;
    const reportWindow = input.windowMs ?? metricWindow;
    const bidWindow = this.velocity.totals('BID', now, reportWindow);
    const askWindow = this.velocity.totals('ASK', now, reportWindow);
    const bidMetric = this.velocity.totals('BID', now, metricWindow);
    const askMetric = this.velocity.totals('ASK', now, metricWindow);

    const aggressiveBuy = this.matcher.executedNotional('BUY', now, metricWindow);
    const aggressiveSell = this.matcher.executedNotional('SELL', now, metricWindow);
    const displacement = this.displacement(now, metricWindow);
    const dailyVolume = input.dailyVolume
      ?? this.matcher.cumulativeNotional('BUY') + this.matcher.cumulativeNotional('SELL');

    const quality = assessDataQuality(
      {
        now,
        lastBookAt: this.lastBookAt,
        lastTradeAt: this.matcher.lastTradeTimestamp,
        observations: this.observations,
        reconnects: input.reconnects ?? this.resets,
        sequenceGaps: input.sequenceGaps ?? 0,
        sequenceContinuous: input.sequenceContinuous ?? true,
        crossedBook: this.crossedBook,
        invalidLevels: this.invalidLevels,
        bookEmpty: Boolean(input.bookEmpty),
        timestampDriftMs: input.exchangeTimestamp
          ? input.exchangeTimestamp - this.lastBookTimestamp
          : 0,
        visibleDepthBps: this.tracker.truncationBps,
      },
      this.config,
    );

    const netLiquidity = this.netLiquidityTracker.snapshot(now, reportWindow, quality.trustworthy);

    const relative: RelativeContext = {
      nearbyDepth: depth.nearBidNotional + depth.nearAskNotional,
      recentExecutedVolume: aggressiveBuy + aggressiveSell,
      dailyVolume,
    };

    const bidMetrics = this.sideMetrics('BID', levels, depth, bidWindow, bidMetric);
    const askMetrics = this.sideMetrics('ASK', levels, depth, askWindow, askMetric);

    const aggressiveBuyPercentile = this.normalizer.percentile('aggressiveBuy', aggressiveBuy);
    const aggressiveSellPercentile = this.normalizer.percentile('aggressiveSell', aggressiveSell);
    const upsideDisplacementPercentile = this.normalizer.percentile(
      'upsideDisplacement',
      displacement.upsideBps,
    );
    const downsideDisplacementPercentile = this.normalizer.percentile(
      'downsideDisplacement',
      displacement.downsideBps,
    );
    const upsideEfficiencyPercentile = this.normalizer.percentile(
      'upsideEfficiency',
      efficiency(displacement.upsideBps, aggressiveBuy),
    );
    const downsideEfficiencyPercentile = this.normalizer.percentile(
      'downsideEfficiency',
      efficiency(displacement.downsideBps, aggressiveSell),
    );

    const wallList = this.walls.detect(levels, now, {
      bid: 1 - downsideEfficiencyPercentile / 100,
      ask: 1 - upsideEfficiencyPercentile / 100,
    });

    this.memory.fold(levels, now, mid);
    const memory = this.memory.all();
    const zones = buildZones(memory, this.config, mid);
    const floor = pickFloor(zones, mid);
    const ceiling = pickCeiling(zones, mid);

    const defendedBidTests = floor?.defendedTests ?? defendedTests(memory, 'BID');
    const defendedAskTests = ceiling?.defendedTests ?? defendedTests(memory, 'ASK');

    const passiveBuyerStrength = passiveStrength(
      {
        depthPercentile: this.normalizer.percentile('bidDepth', depth.bidNotional),
        nearDepthPercentile: bidMetrics.nearDepthPercentile,
        persistenceScore: bidMetrics.persistenceScore,
        replenishmentPercentile: bidMetrics.replenishedPercentile,
        withdrawalPercentile: bidMetrics.cancelledPercentile,
        absorbedAggressionPercentile: aggressiveSellPercentile,
        priceInefficiency: 100 - downsideEfficiencyPercentile,
        defendedTests: defendedBidTests,
        confirmedTestCount: this.config.confirmedTestCount,
      },
      this.config.strengthWeights,
    );

    const passiveSellerStrength = passiveStrength(
      {
        depthPercentile: this.normalizer.percentile('askDepth', depth.askNotional),
        nearDepthPercentile: askMetrics.nearDepthPercentile,
        persistenceScore: askMetrics.persistenceScore,
        replenishmentPercentile: askMetrics.replenishedPercentile,
        withdrawalPercentile: askMetrics.cancelledPercentile,
        absorbedAggressionPercentile: aggressiveBuyPercentile,
        priceInefficiency: 100 - upsideEfficiencyPercentile,
        defendedTests: defendedAskTests,
        confirmedTestCount: this.config.confirmedTestCount,
      },
      this.config.strengthWeights,
    );

    // Passive sellers absorbing aggressive buyers is an ASK-side event.
    const sellerAbsorption = assessAbsorption(
      'SELLER_ABSORPTION',
      {
        aggressionPercentile: aggressiveBuyPercentile,
        consumptionPercentile: askMetrics.consumedPercentile,
        replenishmentPercentile: askMetrics.replenishedPercentile,
        displacementPercentile: upsideDisplacementPercentile,
        replenishmentRatio: askMetrics.replenishmentRatio,
        aggressionNotional: aggressiveBuy,
        consumedNotional: askMetric.consumedNotional,
      },
      this.config,
      quality.trustworthy,
    );

    const buyerAbsorption = assessAbsorption(
      'BUYER_ABSORPTION',
      {
        aggressionPercentile: aggressiveSellPercentile,
        consumptionPercentile: bidMetrics.consumedPercentile,
        replenishmentPercentile: bidMetrics.replenishedPercentile,
        displacementPercentile: downsideDisplacementPercentile,
        replenishmentRatio: bidMetrics.replenishmentRatio,
        aggressionNotional: aggressiveSell,
        consumedNotional: bidMetric.consumedNotional,
      },
      this.config,
      quality.trustworthy,
    );

    const spreadExpansion = Math.max(0, this.lastSpreadBps - this.baselineSpreadBps);
    const upsideVacuum = assessVacuum(
      'UP',
      {
        nearDepthPercentile: askMetrics.nearDepthPercentile,
        withdrawalPercentile: askMetrics.cancelledPercentile,
        replenishmentPercentile: askMetrics.replenishedPercentile,
        distanceToNextWallBps: distanceToNextWallBps(wallList, 'ASK', 50),
        priceEfficiencyPercentile: upsideEfficiencyPercentile,
        spreadExpansionBps: spreadExpansion,
      },
      this.config,
      quality.trustworthy,
    );

    const downsideVacuum = assessVacuum(
      'DOWN',
      {
        nearDepthPercentile: bidMetrics.nearDepthPercentile,
        withdrawalPercentile: bidMetrics.cancelledPercentile,
        replenishmentPercentile: bidMetrics.replenishedPercentile,
        distanceToNextWallBps: distanceToNextWallBps(wallList, 'BID', 50),
        priceEfficiencyPercentile: downsideEfficiencyPercentile,
        spreadExpansionBps: spreadExpansion,
      },
      this.config,
      quality.trustworthy,
    );

    const nearImbalance = imbalanceOf(depth.nearBidNotional, depth.nearAskNotional);
    const bookImbalance = imbalanceOf(depth.bidNotional, depth.askNotional);

    const { state, confidence } = classifyState(
      {
        trustworthy: quality.trustworthy,
        dataQuality: quality.score,
        sellerAbsorption,
        buyerAbsorption,
        upsideVacuum,
        downsideVacuum,
        passiveBuyerStrength,
        passiveSellerStrength,
        nearImbalance,
        aggressiveBuyPercentile,
        aggressiveSellPercentile,
        upsideDisplacementPercentile,
        downsideDisplacementPercentile,
        askConsumedPercentile: askMetrics.consumedPercentile,
        bidConsumedPercentile: bidMetrics.consumedPercentile,
        askReplenishedPercentile: askMetrics.replenishedPercentile,
        bidReplenishedPercentile: bidMetrics.replenishedPercentile,
        askCancelledPercentile: askMetrics.cancelledPercentile,
        bidCancelledPercentile: bidMetrics.cancelledPercentile,
        floor,
        ceiling,
      },
      this.config,
    );

    const why = buildWhy({
      state,
      bid: bidMetrics,
      ask: askMetrics,
      aggressiveBuyNotional: aggressiveBuy,
      aggressiveSellNotional: aggressiveSell,
      aggressiveBuyPercentile,
      aggressiveSellPercentile,
      upsideDisplacementPercentile,
      downsideDisplacementPercentile,
      priceChangePercent: displacement.netPercent,
      nearImbalance,
      floor,
      ceiling,
      passiveBuyerStrength,
      passiveSellerStrength,
      dataQuality: quality.score,
      dataTrustworthy: quality.trustworthy,
      dataQualityReasons: quality.reasons,
      bands: this.bands,
    });

    const events = this.pendingEvents.toArray();
    this.pendingEvents.clear();
    this.appendDerivedEvents(events, now, mid, {
      sellerAbsorption,
      buyerAbsorption,
      upsideVacuum,
      downsideVacuum,
      wallList,
    });

    const profile = this.buildProfile(levels);
    this.heatmapRecorder.annotate(events);

    const nearestBidWall = nearestWall(wallList, 'BID');
    const nearestAskWall = nearestWall(wallList, 'ASK');

    const context: PassiveLiquidityContext = {
      askDepth: depth.askNotional,
      bidDepth: depth.bidNotional,
      nearAskDepth: depth.nearAskNotional,
      nearBidDepth: depth.nearBidNotional,
      weightedAskDepth: depth.weightedAskNotional,
      weightedBidDepth: depth.weightedBidNotional,
      askConsumption: askMetric.consumedNotional,
      bidConsumption: bidMetric.consumedNotional,
      askReplenishment: askMetric.replenishedNotional,
      bidReplenishment: bidMetric.replenishedNotional,
      askWithdrawal: askMetric.cancelledNotional,
      bidWithdrawal: bidMetric.cancelledNotional,
      askPersistence: askMetrics.persistenceScore,
      bidPersistence: bidMetrics.persistenceScore,
      passiveSellerStrength,
      passiveBuyerStrength,
      upsideVacuumScore: upsideVacuum.score,
      downsideVacuumScore: downsideVacuum.score,
      sellerAbsorptionScore: sellerAbsorption.score,
      buyerAbsorptionScore: buyerAbsorption.score,
      bookImbalance,
      nearBookImbalance: nearImbalance,
      askNetLiquidityChange: netLiquidity.ask.bookNetChange,
      bidNetLiquidityChange: netLiquidity.bid.bookNetChange,
      nearAskNetLiquidityChange: netLiquidity.near10Bps.ask.behavioralNetChange,
      nearBidNetLiquidityChange: netLiquidity.near10Bps.bid.behavioralNetChange,
      askNetLiquidityVelocity: netLiquidity.ask.velocityPerSec,
      bidNetLiquidityVelocity: netLiquidity.bid.velocityPerSec,
      askWithdrawalPressure: netLiquidity.ask.withdrawalPressure,
      bidWithdrawalPressure: netLiquidity.bid.withdrawalPressure,
      askCancellationShare: netLiquidity.ask.cancellationShare,
      bidCancellationShare: netLiquidity.bid.cancellationShare,
      askConsumptionShare: netLiquidity.ask.consumptionShare,
      bidConsumptionShare: netLiquidity.bid.consumptionShare,
      liquidityChangeImbalance: netLiquidity.liquidityChangeImbalance,
      dataQuality: quality.score,
    };
    if (nearestAskWall) context.nearestAskWall = nearestAskWall;
    if (nearestBidWall) context.nearestBidWall = nearestBidWall;
    if (floor) context.potentialFloor = floor;
    if (ceiling) context.potentialCeiling = ceiling;

    const features: PassiveLiquidityFeatures = {
      bidDepth: depth.bidNotional,
      askDepth: depth.askNotional,
      nearBidDepth: depth.nearBidNotional,
      nearAskDepth: depth.nearAskNotional,
      weightedBidDepth: depth.weightedBidNotional,
      weightedAskDepth: depth.weightedAskNotional,
      bookImbalance,
      nearBookImbalance: nearImbalance,
      askNetLiquidityChange: netLiquidity.ask.bookNetChange,
      bidNetLiquidityChange: netLiquidity.bid.bookNetChange,
      nearAskNetLiquidityChange: netLiquidity.near10Bps.ask.behavioralNetChange,
      nearBidNetLiquidityChange: netLiquidity.near10Bps.bid.behavioralNetChange,
      askNetLiquidityVelocity: netLiquidity.ask.velocityPerSec,
      bidNetLiquidityVelocity: netLiquidity.bid.velocityPerSec,
      askWithdrawalPressure: netLiquidity.ask.withdrawalPressure,
      bidWithdrawalPressure: netLiquidity.bid.withdrawalPressure,
      askCancellationShare: netLiquidity.ask.cancellationShare,
      bidCancellationShare: netLiquidity.bid.cancellationShare,
      askConsumptionShare: netLiquidity.ask.consumptionShare,
      bidConsumptionShare: netLiquidity.bid.consumptionShare,
      liquidityChangeImbalance: netLiquidity.liquidityChangeImbalance,
      bidConsumption: bidMetric.consumedNotional,
      askConsumption: askMetric.consumedNotional,
      bidReplenishment: bidMetric.replenishedNotional,
      askReplenishment: askMetric.replenishedNotional,
      bidWithdrawal: bidMetric.cancelledNotional,
      askWithdrawal: askMetric.cancelledNotional,
      bidReplenishmentRatio: bidMetrics.replenishmentRatio,
      askReplenishmentRatio: askMetrics.replenishmentRatio,
      bidPersistence: bidMetrics.persistenceScore,
      askPersistence: askMetrics.persistenceScore,
      passiveBuyerStrength,
      passiveSellerStrength,
      buyerAbsorptionScore: buyerAbsorption.score,
      sellerAbsorptionScore: sellerAbsorption.score,
      upsideVacuumScore: upsideVacuum.score,
      downsideVacuumScore: downsideVacuum.score,
      bidWithdrawalPercentile: bidMetrics.cancelledPercentile,
      askWithdrawalPercentile: askMetrics.cancelledPercentile,
      bidReplenishmentPercentile: bidMetrics.replenishedPercentile,
      askReplenishmentPercentile: askMetrics.replenishedPercentile,
      aggressiveBuyPercentile,
      aggressiveSellPercentile,
      downsideEfficiencyPercentile,
      upsideEfficiencyPercentile,
      defendedBidTests,
      defendedAskTests,
      dataQuality: quality.score,
    };

    return {
      symbol: this.symbol,
      timestamp: now,
      mid,
      bestBid: this.lastBestBid,
      bestAsk: this.lastBestAsk,
      spreadBps: this.lastSpreadBps,
      bid: bidMetrics,
      ask: askMetrics,
      bands,
      imbalanceCuts,
      netLiquidity,
      profile,
      walls: wallList,
      nearestBidWall,
      nearestAskWall,
      passiveBuyerStrength,
      passiveSellerStrength,
      sellerAbsorption,
      buyerAbsorption,
      upsideVacuum,
      downsideVacuum,
      zones,
      potentialFloor: floor,
      potentialCeiling: ceiling,
      aggressionVsLiquidity: this.buildAggressionPanel(
        {
          aggressiveBuy,
          aggressiveSell,
          aggressiveBuyPercentile,
          aggressiveSellPercentile,
          upsideDisplacementPercentile,
          downsideDisplacementPercentile,
        },
        bidMetrics,
        askMetrics,
        bidMetric,
        askMetric,
        relative,
        displacement,
        state,
      ),
      effortVsResult: buildEffortVsResult(
        {
          aggressiveBuyPercentile,
          aggressiveSellPercentile,
          upsideDisplacementPercentile,
          downsideDisplacementPercentile,
        },
        passiveBuyerStrength,
        passiveSellerStrength,
      ),
      state,
      stateConfidence: confidence,
      why,
      events,
      dataQuality: quality,
      context,
      features,
    };
  }

  levelDetail(side: PassiveSide, price: number, now: number): LiquidityLevelDetail | null {
    const mid = this.tracker.mid;
    const level = this.tracker.levelAt(side, price, now, mid);
    if (!level) return null;
    return {
      level,
      timeline: this.tracker.timelineAt(side, price, mid),
      wall: null,
      memory: this.memory.get(side, price, mid),
    };
  }

  heatmap(): HeatmapFrame[] {
    return this.heatmapRecorder.snapshot();
  }

  priceLevelMemory(): PriceLevelMemory[] {
    return this.memory.all();
  }

  /** One sample per `metricSampleMs` keeps distributions from over-weighting bursts. */
  private sampleMetrics(now: number): void {
    const window = this.config.metricWindowMs;
    const bid = this.velocity.totals('BID', now, window);
    const ask = this.velocity.totals('ASK', now, window);
    const levels = this.tracker.snapshotLevels(now, this.tracker.mid);
    const depth = aggregateDepth(levels, this.config);

    this.normalizer.observe('bidDepth', depth.bidNotional);
    this.normalizer.observe('askDepth', depth.askNotional);
    this.normalizer.observe('nearBidDepth', depth.nearBidNotional);
    this.normalizer.observe('nearAskDepth', depth.nearAskNotional);
    this.normalizer.observe('bidConsumed', bid.consumedNotional);
    this.normalizer.observe('askConsumed', ask.consumedNotional);
    this.normalizer.observe('bidCancelled', bid.cancelledNotional);
    this.normalizer.observe('askCancelled', ask.cancelledNotional);
    this.normalizer.observe('bidReplenished', bid.replenishedNotional);
    this.normalizer.observe('askReplenished', ask.replenishedNotional);
    this.normalizer.observe('bidAdded', bid.addedNotional);
    this.normalizer.observe('askAdded', ask.addedNotional);

    const buy = this.matcher.executedNotional('BUY', now, window);
    const sell = this.matcher.executedNotional('SELL', now, window);
    this.normalizer.observe('aggressiveBuy', buy);
    this.normalizer.observe('aggressiveSell', sell);

    const displacement = this.displacement(now, window);
    this.normalizer.observe('upsideDisplacement', displacement.upsideBps);
    this.normalizer.observe('downsideDisplacement', displacement.downsideBps);
    this.normalizer.observe('upsideEfficiency', efficiency(displacement.upsideBps, buy));
    this.normalizer.observe('downsideEfficiency', efficiency(displacement.downsideBps, sell));
    this.normalizer.observe('spreadBps', this.lastSpreadBps);
    this.netLiquidityTracker.sample(now, window);
  }

  /**
   * Displacement is measured as the excursion achieved in each direction, not
   * the net change. Net change is zero-inflated: a market that is usually flat
   * would rank a flat window at the top of its own history, which would invert
   * every "price failed to move" test.
   */
  private displacement(
    now: number,
    windowMs: number,
  ): { upsideBps: number; downsideBps: number; netPercent: number } {
    const from = now - windowMs;
    let open = 0;
    let close = 0;
    let high = 0;
    let low = Number.POSITIVE_INFINITY;
    for (const sample of this.prices.values()) {
      if (sample.at < from || sample.at > now) continue;
      if (open === 0) open = sample.mid;
      close = sample.mid;
      high = Math.max(high, sample.mid);
      low = Math.min(low, sample.mid);
    }
    if (open <= 0 || close <= 0 || !Number.isFinite(low)) {
      return { upsideBps: 0, downsideBps: 0, netPercent: 0 };
    }
    return {
      upsideBps: ((high - open) / open) * 10_000,
      downsideBps: ((open - low) / open) * 10_000,
      netPercent: ((close - open) / open) * 100,
    };
  }

  private sideMetrics(
    side: PassiveSide,
    levels: PassiveLiquidityLevel[],
    depth: ReturnType<typeof aggregateDepth>,
    windowFlow: SideFlowDelta,
    metricFlow: SideFlowDelta,
  ): PassiveSideMetrics {
    const isBid = side === 'BID';
    const depthNotional = isBid ? depth.bidNotional : depth.askNotional;
    const nearDepth = isBid ? depth.nearBidNotional : depth.nearAskNotional;

    let persistenceWeighted = 0;
    let withdrawalWeighted = 0;
    let weight = 0;
    let count = 0;
    for (const level of levels) {
      if (level.side !== side || level.outOfView || level.quantity <= 0) continue;
      persistenceWeighted += level.persistenceScore * level.notionalValue;
      withdrawalWeighted += level.withdrawalScore * level.notionalValue;
      weight += level.notionalValue;
      count += 1;
    }

    const ratio = metricFlow.consumedNotional > 0
      ? metricFlow.replenishedNotional / metricFlow.consumedNotional
      : metricFlow.replenishedNotional > 0 ? 1 : 0;

    return {
      side,
      depthNotional,
      depthQuantity: isBid ? depth.bidQuantity : depth.askQuantity,
      nearDepthNotional: nearDepth,
      weightedDepthNotional: isBid ? depth.weightedBidNotional : depth.weightedAskNotional,
      addedNotional: windowFlow.addedNotional,
      consumedNotional: windowFlow.consumedNotional,
      cancelledNotional: windowFlow.cancelledNotional,
      replenishedNotional: windowFlow.replenishedNotional,
      replenishmentRatio: ratio,
      persistenceScore: weight > 0 ? persistenceWeighted / weight : 0,
      withdrawalScore: weight > 0 ? withdrawalWeighted / weight : 0,
      levelCount: count,
      velocity: this.velocity.velocity(side, this.lastBookAt, this.config.metricWindowMs),
      consumedPercentile: this.normalizer.percentile(
        isBid ? 'bidConsumed' : 'askConsumed',
        metricFlow.consumedNotional,
      ),
      cancelledPercentile: this.normalizer.percentile(
        isBid ? 'bidCancelled' : 'askCancelled',
        metricFlow.cancelledNotional,
      ),
      replenishedPercentile: this.normalizer.percentile(
        isBid ? 'bidReplenished' : 'askReplenished',
        metricFlow.replenishedNotional,
      ),
      nearDepthPercentile: this.normalizer.percentile(
        isBid ? 'nearBidDepth' : 'nearAskDepth',
        nearDepth,
      ),
    };
  }

  /** Asks above mid then bids below, nearest to the touch first on each side. */
  private buildProfile(levels: PassiveLiquidityLevel[]): PassiveLiquidityLevel[] {
    const limit = this.config.profileLevelsPerSide;
    const asks = levels
      .filter((l) => l.side === 'ASK' && l.quantity > 0)
      .sort((a, b) => a.distanceBps - b.distanceBps)
      .slice(0, limit);
    const bids = levels
      .filter((l) => l.side === 'BID' && l.quantity > 0)
      .sort((a, b) => a.distanceBps - b.distanceBps)
      .slice(0, limit);
    return [...asks.sort((a, b) => b.price - a.price), ...bids.sort((a, b) => b.price - a.price)];
  }

  private buildAggressionPanel(
    flow: {
      aggressiveBuy: number;
      aggressiveSell: number;
      aggressiveBuyPercentile: number;
      aggressiveSellPercentile: number;
      upsideDisplacementPercentile: number;
      downsideDisplacementPercentile: number;
    },
    bid: PassiveSideMetrics,
    ask: PassiveSideMetrics,
    bidFlow: SideFlowDelta,
    askFlow: SideFlowDelta,
    relative: RelativeContext,
    displacement: { upsideBps: number; downsideBps: number; netPercent: number },
    state: PassiveLiquiditySnapshot['state'],
  ): AggressionVsLiquidityPanel {
    const sellLed = flow.aggressiveSellPercentile > flow.aggressiveBuyPercentile;
    const balanced = Math.abs(flow.aggressiveSellPercentile - flow.aggressiveBuyPercentile) < 5;
    const aggressiveSide = balanced ? 'BALANCED' : sellLed ? 'SELL' : 'BUY';
    const passive = sellLed ? bid : ask;
    const passiveFlow = sellLed ? bidFlow : askFlow;

    return {
      aggressiveSide,
      aggression: this.normalizer.measure(
        sellLed ? 'aggressiveSell' : 'aggressiveBuy',
        sellLed ? flow.aggressiveSell : flow.aggressiveBuy,
        relative,
      ),
      consumption: this.normalizer.measure(
        sellLed ? 'bidConsumed' : 'askConsumed',
        passiveFlow.consumedNotional,
        relative,
      ),
      replenishment: this.normalizer.measure(
        sellLed ? 'bidReplenished' : 'askReplenished',
        passiveFlow.replenishedNotional,
        relative,
      ),
      withdrawal: this.normalizer.measure(
        sellLed ? 'bidCancelled' : 'askCancelled',
        passiveFlow.cancelledNotional,
        relative,
      ),
      displacementBps: this.normalizer.measure(
        sellLed ? 'downsideDisplacement' : 'upsideDisplacement',
        sellLed ? displacement.downsideBps : displacement.upsideBps,
        relative,
      ),
      interpretation: `${state} · passive ${passive.side} replenishment ratio ${passive.replenishmentRatio.toFixed(2)}`,
    };
  }

  private appendDerivedEvents(
    events: PassiveLiquidityEvent[],
    now: number,
    mid: number,
    parts: {
      sellerAbsorption: PassiveLiquiditySnapshot['sellerAbsorption'];
      buyerAbsorption: PassiveLiquiditySnapshot['buyerAbsorption'];
      upsideVacuum: PassiveLiquiditySnapshot['upsideVacuum'];
      downsideVacuum: PassiveLiquiditySnapshot['downsideVacuum'];
      wallList: PassiveLiquiditySnapshot['walls'];
    },
  ): void {
    const push = (
      type: PassiveLiquidityEvent['type'],
      side: PassiveSide,
      price: number,
      notional: number,
      note: string,
    ): void => {
      events.push({
        type,
        side,
        price,
        timestamp: now,
        quantity: price > 0 ? notional / price : 0,
        notional,
        distanceBps: mid > 0 ? (Math.abs(price - mid) / mid) * 10_000 : 0,
        note,
      });
    };

    if (parts.sellerAbsorption.detected) {
      push('ABSORPTION_DETECTED', 'ASK', mid, 0, 'passive sellers absorbing aggressive buyers');
    }
    if (parts.buyerAbsorption.detected) {
      push('ABSORPTION_DETECTED', 'BID', mid, 0, 'passive buyers absorbing aggressive sellers');
    }
    if (parts.upsideVacuum.detected) {
      push('VACUUM_DETECTED', 'ASK', mid, 0, 'thin, withdrawing ask liquidity above');
    }
    if (parts.downsideVacuum.detected) {
      push('VACUUM_DETECTED', 'BID', mid, 0, 'thin, withdrawing bid liquidity below');
    }
    for (const wall of parts.wallList) {
      if (wall.lifecycle === 'FORMING') {
        push('WALL_APPEARED', wall.side, wall.price, wall.notional, 'unusually large level posted');
      }
      if (wall.lifecycle === 'ATTACKED') {
        push('WALL_ATTACKED', wall.side, wall.price, wall.consumedNotional, 'aggressive flow executing into wall');
      }
    }
  }
}

function efficiency(displacementBps: number, aggressionNotional: number): number {
  return safeDiv(displacementBps, Math.max(1, aggressionNotional / 1_000_000));
}

function defendedTests(memory: PriceLevelMemory[], side: PassiveSide): number {
  let total = 0;
  for (const entry of memory) {
    if (entry.side === side) total += entry.defendedTests;
  }
  return total;
}

function buildEffortVsResult(
  flow: {
    aggressiveBuyPercentile: number;
    aggressiveSellPercentile: number;
    upsideDisplacementPercentile: number;
    downsideDisplacementPercentile: number;
  },
  passiveBuyerStrength: number,
  passiveSellerStrength: number,
): EffortVsPassiveResult {
  const sellLed = flow.aggressiveSellPercentile > flow.aggressiveBuyPercentile;
  const effortScore = sellLed ? flow.aggressiveSellPercentile : flow.aggressiveBuyPercentile;
  const resultScore = sellLed
    ? flow.downsideDisplacementPercentile
    : flow.upsideDisplacementPercentile;
  const passiveDefenseScore = sellLed ? passiveBuyerStrength : passiveSellerStrength;

  const labels: string[] = [];
  if (effortScore >= 70 && resultScore <= 35) {
    labels.push(sellLed ? 'SELLERS_INEFFICIENT' : 'BUYERS_INEFFICIENT');
    if (passiveDefenseScore >= 60) {
      labels.push(sellLed ? 'PASSIVE_BUYERS_ABSORBING' : 'PASSIVE_SELLERS_ABSORBING');
    }
  } else if (effortScore >= 70 && resultScore >= 70) {
    labels.push(sellLed ? 'SELLERS_EFFICIENT' : 'BUYERS_EFFICIENT');
  }

  return {
    effortScore: clamp(effortScore, 0, 100),
    resultScore: clamp(resultScore, 0, 100),
    passiveDefenseScore: clamp(passiveDefenseScore, 0, 100),
    labels,
  };
}
