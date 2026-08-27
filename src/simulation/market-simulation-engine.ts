import { RingBuffer } from '../core/ring-buffer.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import { CalibrationStore, defaultCalibration } from './calibration.js';
import {
  classifyEffort,
  classifyMarketState,
  mechanicsLine,
  priceEfficiencyLabel,
  whyFacts,
  whyHeadline,
  type ClassifyInput,
} from './classify.js';
import { SimulationClock } from './clock.js';
import {
  compareEvents,
  EventSequencer,
  type SimulationEvent,
  type TradeSimEvent,
} from './events.js';
import { LiquidationCascadeEngine, type CascadeImpulse } from './liquidation-cascade-engine.js';
import { LiquidityResponseSimulationEngine } from './liquidity-response-engine.js';
import { clamp, logScale, roundToTick } from './math.js';
import { FundingEngine, OpenInterestEngine } from './oi-funding.js';
import { OrderBookSimulationEngine } from './order-book-engine.js';
import { OrderFlowSimulationEngine } from './order-flow-engine.js';
import { PriceImpactEngine } from './price-impact-engine.js';
import { ReplayEngine } from './replay-engine.js';
import {
  DISCLAIMER,
  EPSILON,
  TRAIL_WINDOW_MS,
  type CalibrationParams,
  type LiquidationZone,
  type MarketSimulationState,
  type PricePoint,
  type SimulationMarketType,
  type SimulationMode,
  type TrailWindowId,
  type VisualHints,
  type VisualImpulse,
} from './types.js';

export interface MarketSimulationOptions {
  symbol?: string;
  marketType?: SimulationMarketType;
  tickSize?: number;
  tickMs?: number;
  calibration?: CalibrationParams;
  calibrationStore?: CalibrationStore;
  trailWindow?: TrailWindowId;
  fillMode?: 'walk' | 'print';
  nearbyLevels?: number;
}

interface QueuedAggression {
  side: 'BUY' | 'SELL';
  quoteValue: number;
  forced: boolean;
  timestamp: number;
}

/**
 * Orchestrates microstructure engines. Phaser must never call these
 * methods — it only reads `snapshot()`.
 *
 * Price is not incremented by a random value. It moves because aggressive
 * orders consume (or vacuum) passive levels.
 */
export class MarketSimulationEngine {
  readonly symbol: string;
  readonly marketType: SimulationMarketType;
  readonly book: OrderBookSimulationEngine;
  readonly flow: OrderFlowSimulationEngine;
  readonly liquidity: LiquidityResponseSimulationEngine;
  readonly impact: PriceImpactEngine;
  readonly liquidations: LiquidationCascadeEngine;
  readonly oi: OpenInterestEngine;
  readonly funding: FundingEngine;
  readonly replay: ReplayEngine;
  readonly clock: SimulationClock;
  readonly sequencer = new EventSequencer();

  fillMode: 'walk' | 'print';
  trailWindow: TrailWindowId;
  mode: SimulationMode = 'synthetic';

  private readonly queue: SimulationEvent[] = [];
  private readonly aggression: QueuedAggression[] = [];
  private readonly trailBuf: RingBuffer<PricePoint>;
  private readonly returns = new RollingDistribution(1_024);
  private readonly impulseBuf: RingBuffer<VisualImpulse>;
  private readonly calibrationStore: CalibrationStore;
  private params: CalibrationParams;
  private leftoverBuy = 0;
  private leftoverSell = 0;
  private levelsUp = 0;
  private levelsDown = 0;
  private lastState: MarketSimulationState | null = null;
  private lastSnapshotAt = 0;
  private typicalLevel = 40_000_000;
  private tickNow = 0;
  private pendingWithdraw: Array<{ side: 'bid' | 'ask'; quote: number }> = [];
  private pendingReplenish: Array<{ side: 'bid' | 'ask'; quote: number; aroundPrice?: number }> = [];

  constructor(opts: MarketSimulationOptions = {}) {
    this.symbol = opts.symbol ?? 'BTCUSDT';
    this.marketType = opts.marketType ?? 'perp';
    this.fillMode = opts.fillMode ?? 'walk';
    this.trailWindow = opts.trailWindow ?? '30s';
    this.calibrationStore = opts.calibrationStore ?? new CalibrationStore();
    this.params = opts.calibration ?? this.calibrationStore.get({
      symbol: this.symbol,
      marketType: this.marketType,
    });
    this.book = new OrderBookSimulationEngine({ tickSize: opts.tickSize ?? 0.1, price: 0 });
    this.flow = new OrderFlowSimulationEngine();
    this.liquidity = new LiquidityResponseSimulationEngine();
    this.impact = new PriceImpactEngine(this.params);
    this.liquidations = new LiquidationCascadeEngine();
    this.oi = new OpenInterestEngine();
    this.funding = new FundingEngine();
    this.replay = new ReplayEngine();
    this.clock = new SimulationClock({ tickMs: opts.tickMs });
    this.trailBuf = new RingBuffer(6_000);
    this.impulseBuf = new RingBuffer(256);
  }

  setCalibration(params: CalibrationParams): void {
    this.params = params;
    this.impact.setParams(params);
  }

  setTrailWindow(id: TrailWindowId): void {
    this.trailWindow = id;
  }

  setFillMode(mode: 'walk' | 'print'): void {
    this.fillMode = mode;
  }

  setZones(zones: Array<Omit<LiquidationZone, 'triggered' | 'triggeredAt'>>): void {
    this.liquidations.setZones(zones);
  }

  reset(price = 0): void {
    this.queue.length = 0;
    this.aggression.length = 0;
    this.book.reset(price);
    this.flow.reset();
    this.liquidity.reset();
    this.impact.reset();
    this.liquidations.reset();
    this.oi.reset();
    this.funding.reset();
    this.replay.clear();
    this.sequencer.reset();
    this.trailBuf.clear();
    this.impulseBuf.clear();
    this.pendingWithdraw.length = 0;
    this.pendingReplenish.length = 0;
    this.leftoverBuy = 0;
    this.leftoverSell = 0;
    this.levelsUp = 0;
    this.levelsDown = 0;
    this.lastState = null;
    this.lastSnapshotAt = 0;
    this.tickNow = 0;
    this.clock.reset();
  }

  ingest(event: SimulationEvent): void {
    const copy = { ...event, seq: event.seq || this.sequencer.next() };
    this.queue.push(copy);
    this.replay.record(copy);
  }

  queueAggression(side: 'BUY' | 'SELL', quoteValue: number, timestamp: number, forced = false): void {
    if (quoteValue <= 0) return;
    this.aggression.push({ side, quoteValue, forced, timestamp });
  }

  queueReplenish(side: 'bid' | 'ask', quote: number, aroundPrice?: number): void {
    if (quote <= 0) return;
    this.pendingReplenish.push({ side, quote, aroundPrice });
  }

  queueWithdraw(side: 'bid' | 'ask', quote: number): void {
    if (quote <= 0) return;
    this.pendingWithdraw.push({ side, quote });
  }

  seedBook(opts: {
    price: number;
    bids: Array<{ price: number; quote: number }>;
    asks: Array<{ price: number; quote: number }>;
  }): void {
    this.book.seedLadder(opts);
    this.typicalLevel = typical(opts.bids, opts.asks);
    this.trailBuf.push({ timestamp: 0, price: opts.price });
  }

  /**
   * Apply queued events up to `now`, walk queued aggression, run cascades,
   * then freeze a snapshot. Safe to call from a worker or a test.
   */
  tick(now: number): MarketSimulationState {
    this.tickNow = now;
    this.book.beginTick();
    this.flow.beginTick();
    this.liquidity.beginTick();
    this.liquidations.beginTick();
    this.leftoverBuy = 0;
    this.leftoverSell = 0;
    this.levelsUp = 0;
    this.levelsDown = 0;
    const prevPrice = this.book.price || this.book.mid();

    this.queue.sort(compareEvents);
    while (this.queue.length && this.queue[0]!.timestamp <= now) {
      this.applyEvent(this.queue.shift()!);
    }

    for (const pull of this.pendingWithdraw.splice(0)) {
      this.withdraw(pull.side, pull.quote);
    }

    for (const agg of this.aggression.splice(0)) {
      this.applyAggression(agg);
    }

    for (const add of this.pendingReplenish.splice(0)) {
      this.replenish(add.side, add.quote, add.aroundPrice);
    }

    this.runCascade(now);

    const tickFlow = this.flow.endTick(now);
    const flow = this.flow.window(now, TRAIL_WINDOW_MS[this.trailWindow]);
    const priceAfterWalk = this.book.price || prevPrice;
    let realizedBps = prevPrice > 0 ? ((priceAfterWalk - prevPrice) / prevPrice) * 10_000 : 0;

    const nearbyAsk = this.book.nearbyDepth('ask');
    const nearbyBid = this.book.nearbyDepth('bid');

    const liq = this.liquidity.endTick({
      aggressiveBuy: tickFlow.aggressiveBuy,
      aggressiveSell: tickFlow.aggressiveSell,
      priceChangeBps: realizedBps,
      nearbyAsk,
      nearbyBid,
    });

    const ofi = this.flow.imbalance(flow.aggressiveBuy, flow.aggressiveSell);
    const vol = this.volatility();
    const diagnostics = this.impact.measure({
      aggressiveBuy: flow.aggressiveBuy,
      aggressiveSell: flow.aggressiveSell,
      nearbyAsk,
      nearbyBid,
      askConsumption: liq.askConsumption,
      bidConsumption: liq.bidConsumption,
      askReplenishment: liq.askReplenishment,
      bidReplenishment: liq.bidReplenishment,
      askWithdrawal: liq.askWithdrawal,
      bidWithdrawal: liq.bidWithdrawal,
      buyerAbsorption: liq.buyerAbsorption,
      sellerAbsorption: liq.sellerAbsorption,
      volatility: vol,
      spreadBps: this.book.spreadBps(),
      levelsClearedUp: this.levelsUp,
      levelsClearedDown: this.levelsDown,
      leftoverBuy: this.leftoverBuy,
      leftoverSell: this.leftoverSell,
      ofi,
      realizedBps,
      typicalLevel: this.typicalLevel,
    });

    if (Math.abs(diagnostics.leftoverGapBps) > 0.01 && (nearbyAsk <= EPSILON || nearbyBid <= EPSILON)) {
      const gapped = this.impact.applyLeftoverGap(priceAfterWalk, diagnostics.leftoverGapBps);
      this.book.price = roundToTick(gapped, this.book.tickSize);
      realizedBps = prevPrice > 0 ? ((this.book.price - prevPrice) / prevPrice) * 10_000 : realizedBps;
    }

    const price = this.book.price || this.book.mid();
    if (prevPrice > 0 && price > 0) {
      this.returns.add((price - prevPrice) / prevPrice);
    }
    this.trailBuf.push({ timestamp: now, price });
    const origin = this.priceAt(now - TRAIL_WINDOW_MS[this.trailWindow]) ?? prevPrice;
    const windowBps = origin > 0 ? ((price - origin) / origin) * 10_000 : realizedBps;

    const liqSnap = this.liquidations.current();
    const oiSnap = this.oi.snapshot();
    const oiClass = this.marketType === 'perp'
      ? this.oi.classify({
          priceChange: price - prevPrice,
          aggressiveBuy: flow.aggressiveBuy,
          aggressiveSell: flow.aggressiveSell,
          shortLiquidations: liqSnap.shortLiquidations,
          longLiquidations: liqSnap.longLiquidations,
        })
      : undefined;

    const classifyInput: ClassifyInput = {
      aggressiveBuy: flow.aggressiveBuy,
      aggressiveSell: flow.aggressiveSell,
      delta: flow.delta,
      priceChangeBps: windowBps,
      levelsConsumedUp: this.levelsUp,
      levelsConsumedDown: this.levelsDown,
      askConsumption: liq.askConsumption,
      bidConsumption: liq.bidConsumption,
      askReplenishment: liq.askReplenishment,
      bidReplenishment: liq.bidReplenishment,
      askWithdrawal: liq.askWithdrawal,
      bidWithdrawal: liq.bidWithdrawal,
      buyerAbsorption: liq.buyerAbsorption,
      sellerAbsorption: liq.sellerAbsorption,
      upsideVacuum: liq.upsideVacuum,
      downsideVacuum: liq.downsideVacuum,
      askDefense: liq.askDefense,
      bidDefense: liq.bidDefense,
      buyPercentile: this.flow.buyPercentile(flow.aggressiveBuy),
      sellPercentile: this.flow.sellPercentile(flow.aggressiveSell),
      impactPercentile: this.impact.impactDist.percentileRank(diagnostics.impactPerMillion),
      shortLiquidations: liqSnap.shortLiquidations,
      longLiquidations: liqSnap.longLiquidations,
      oiClassification: oiClass,
    };

    const effort = classifyEffort(classifyInput);
    const marketState = classifyMarketState(classifyInput);
    const why = whyFacts(classifyInput);
    const pressureNet = clamp(
      0.45 * Math.tanh(diagnostics.netPressure)
        + 0.2 * ofi
        + 0.15 * Math.tanh(realizedBps / 20)
        + 0.1 * (liq.upsideVacuum ? 0.6 : 0)
        - 0.1 * (liq.downsideVacuum ? 0.6 : 0)
        + 0.1 * (liq.buyerAbsorption - liq.sellerAbsorption) * -1,
      -1,
      1,
    );

    const visual = this.visualHints(tickFlow, liq, now);
    const trail = this.trailSince(now);

    const state: MarketSimulationState = {
      timestamp: now,
      symbol: this.symbol,
      marketType: this.marketType,
      price,
      previousPrice: prevPrice,
      priceChange: price - origin,
      priceChangeBps: windowBps,
      spread: this.book.spread(),
      spreadBps: this.book.spreadBps(),
      aggressiveBuy: flow.aggressiveBuy,
      aggressiveSell: flow.aggressiveSell,
      delta: flow.delta,
      cvd: this.flow.cvd,
      bids: this.book.snapshotLevels('bid'),
      asks: this.book.snapshotLevels('ask'),
      bidDepth: this.book.depth('bid'),
      askDepth: this.book.depth('ask'),
      nearbyBidDepth: nearbyBid,
      nearbyAskDepth: nearbyAsk,
      bidConsumption: liq.bidConsumption,
      askConsumption: liq.askConsumption,
      bidReplenishment: liq.bidReplenishment,
      askReplenishment: liq.askReplenishment,
      bidWithdrawal: liq.bidWithdrawal,
      askWithdrawal: liq.askWithdrawal,
      buyerAbsorption: liq.buyerAbsorption,
      sellerAbsorption: liq.sellerAbsorption,
      openInterest: this.marketType === 'perp' ? oiSnap.openInterest : undefined,
      oiChange: this.marketType === 'perp' ? oiSnap.oiChange : undefined,
      oiChangePercent: this.marketType === 'perp' ? oiSnap.oiChangePercent : undefined,
      oiClassification: oiClass,
      fundingRate: this.marketType === 'perp' ? this.funding.rateValue() : undefined,
      fundingClassification: this.marketType === 'perp' ? this.funding.classify() : undefined,
      longLiquidations: this.marketType === 'perp' ? liqSnap.longLiquidations : undefined,
      shortLiquidations: this.marketType === 'perp' ? liqSnap.shortLiquidations : undefined,
      volatility: vol,
      priceEfficiency: priceEfficiencyLabel(classifyInput),
      effortVsResult: effort,
      marketState,
      mechanics: mechanicsLine(marketState, effort),
      levelsConsumedUp: this.levelsUp,
      levelsConsumedDown: this.levelsDown,
      upsidePressure: diagnostics.upsidePressure,
      downsidePressure: diagnostics.downsidePressure,
      netPressure: diagnostics.netPressure,
      pressure: {
        net: pressureNet,
        buy: clamp((pressureNet + 1) / 2, 0, 1),
        sell: clamp((1 - pressureNet) / 2, 0, 1),
      },
      why,
      whyHeadline: whyHeadline(marketState, realizedBps),
      trail,
      visual,
      disclaimer: DISCLAIMER,
    };

    this.lastState = state;
    this.lastSnapshotAt = now;
    return state;
  }

  snapshot(): MarketSimulationState {
    if (this.lastState) return this.lastState;
    return this.tick(this.tickNow || this.lastSnapshotAt);
  }

  replenish(side: 'bid' | 'ask', quote: number, aroundPrice?: number, levels = 3): number {
    if (quote <= 0) return 0;
    const start = aroundPrice ?? (side === 'ask' ? this.book.bestAsk()?.price : this.book.bestBid()?.price) ?? this.book.price;
    if (!start) return 0;
    const step = this.book.tickSize || 1;
    const each = quote / levels;
    let added = 0;
    for (let i = 0; i < levels; i++) {
      const px = side === 'ask' ? start + i * step : start - i * step;
      added += this.book.addLiquidity(side, px, each, true);
    }
    if (side === 'ask') this.liquidity.noteAskReplenishment(added);
    else this.liquidity.noteBidReplenishment(added);
    this.recordBookDelta(side, added > 0);
    return added;
  }

  withdraw(side: 'bid' | 'ask', quote: number): number {
    if (quote <= 0) return 0;
    const levels = this.book.allLevels(side);
    let remaining = quote;
    let pulled = 0;
    for (const level of levels) {
      if (remaining <= EPSILON) break;
      const take = Math.min(level.restingLiquidity * 0.85, remaining);
      pulled += this.book.withdrawLiquidity(side, level.price, take);
      remaining -= take;
    }
    if (side === 'ask') this.liquidity.noteAskWithdrawal(pulled);
    else this.liquidity.noteBidWithdrawal(pulled);
    this.recordBookDelta(side, pulled > 0);
    return pulled;
  }

  private recordBookDelta(side: 'bid' | 'ask', dirty: boolean): void {
    if (!dirty) return;
    const levels = this.book.allLevels(side).map((l) => ({ price: l.price, quoteValue: l.restingLiquidity }));
    this.replay.record({
      kind: 'book_delta',
      seq: this.sequencer.next(),
      timestamp: this.tickNow,
      symbol: this.symbol,
      marketType: this.marketType,
      bids: side === 'bid' ? levels : [],
      asks: side === 'ask' ? levels : [],
    });
  }

  private applyEvent(event: SimulationEvent): void {
    switch (event.kind) {
      case 'trade':
        this.applyTrade(event);
        break;
      case 'book_snapshot': {
        const diff = this.book.applySnapshot(event);
        this.liquidity.noteBidReplenishment(diff.added.bid);
        this.liquidity.noteAskReplenishment(diff.added.ask);
        this.liquidity.noteBidWithdrawal(diff.cancelled.bid);
        this.liquidity.noteAskWithdrawal(diff.cancelled.ask);
        break;
      }
      case 'book_delta': {
        const diff = this.book.applyDelta(event);
        this.liquidity.noteBidReplenishment(diff.added.bid);
        this.liquidity.noteAskReplenishment(diff.added.ask);
        this.liquidity.noteBidWithdrawal(diff.cancelled.bid);
        this.liquidity.noteAskWithdrawal(diff.cancelled.ask);
        break;
      }
      case 'oi':
        this.oi.ingest(event);
        break;
      case 'funding':
        this.funding.ingest(event);
        break;
      case 'liquidation': {
        const impulse = this.liquidations.ingestLive(event);
        this.applyAggression({
          side: impulse.side,
          quoteValue: impulse.quoteValue,
          forced: true,
          timestamp: event.timestamp,
        });
        break;
      }
    }
  }

  private applyTrade(event: TradeSimEvent): void {
    this.noteImpulse(event.side, event.quoteValue, Boolean(event.isForced), event.timestamp);
    this.flow.ingestTrade(event);
    if (this.fillMode === 'print') {
      const side = event.side === 'BUY' ? 'ask' : 'bid';
      const fill = this.book.consumeAtPrice(side, event.price, event.quoteValue);
      if (!fill) return;
      if (event.side === 'BUY') {
        this.liquidity.noteAskWalk({
          filled: fill.consumed,
          leftover: Math.max(0, event.quoteValue - fill.consumed),
          lastFillPrice: fill.price,
          levelsCleared: fill.cleared ? 1 : 0,
          fills: [fill],
        });
        if (fill.cleared) this.levelsUp += 1;
        this.leftoverBuy += Math.max(0, event.quoteValue - fill.consumed);
      } else {
        this.liquidity.noteBidWalk({
          filled: fill.consumed,
          leftover: Math.max(0, event.quoteValue - fill.consumed),
          lastFillPrice: fill.price,
          levelsCleared: fill.cleared ? 1 : 0,
          fills: [fill],
        });
        if (fill.cleared) this.levelsDown += 1;
        this.leftoverSell += Math.max(0, event.quoteValue - fill.consumed);
      }
      return;
    }
    this.walkAggression(event.side, event.quoteValue);
  }

  private applyAggression(agg: QueuedAggression): void {
    if (agg.quoteValue <= EPSILON) return;
    const trade: TradeSimEvent = {
      kind: 'trade',
      seq: this.sequencer.next(),
      timestamp: agg.timestamp,
      symbol: this.symbol,
      marketType: this.marketType,
      price: this.book.price || this.book.mid(),
      quantity: 0,
      quoteValue: agg.quoteValue,
      side: agg.side,
      isForced: agg.forced,
    };
    this.replay.record(trade);
    this.noteImpulse(agg.side, agg.quoteValue, agg.forced, agg.timestamp);
    this.flow.ingestTrade(trade);
    this.walkAggression(agg.side, agg.quoteValue);
  }

  private walkAggression(side: 'BUY' | 'SELL', quoteValue: number): void {
    if (side === 'BUY') {
      const walk = this.book.consumeAsks(quoteValue);
      this.liquidity.noteAskWalk(walk);
      this.leftoverBuy += walk.leftover;
      this.levelsUp += walk.levelsCleared;
    } else {
      const walk = this.book.consumeBids(quoteValue);
      this.liquidity.noteBidWalk(walk);
      this.leftoverSell += walk.leftover;
      this.levelsDown += walk.levelsCleared;
    }
  }

  private noteImpulse(side: 'BUY' | 'SELL', quoteValue: number, forced: boolean, timestamp: number): void {
    this.impulseBuf.push({ side, magnitude: quoteValue, forced, timestamp });
  }

  private runCascade(now: number): void {
    for (let i = 0; i < 8; i++) {
      const impulses: CascadeImpulse[] = this.liquidations.trigger(this.book.price || this.book.mid(), now);
      if (!impulses.length) break;
      for (const impulse of impulses) this.applyAggression({
        side: impulse.side,
        quoteValue: impulse.quoteValue,
        forced: true,
        timestamp: now,
      });
    }
  }

  private volatility(): number {
    if (this.returns.size < 4) return 0.2;
    return Math.min(3, this.returns.std() * Math.sqrt(1_000 / Math.max(this.clock.tickMs, 1)) * 100);
  }

  private trailSince(now: number): PricePoint[] {
    const from = now - TRAIL_WINDOW_MS[this.trailWindow];
    const out: PricePoint[] = [];
    for (const p of this.trailBuf.values()) {
      if (p.timestamp >= from) out.push(p);
    }
    return out;
  }

  private priceAt(from: number): number | null {
    let found: number | null = null;
    for (const p of this.trailBuf.values()) {
      if (p.timestamp >= from) return p.price;
      found = p.price;
    }
    return found;
  }

  private visualHints(
    flow: { aggressiveBuy: number; aggressiveSell: number; forcedBuy: number; forcedSell: number },
    liq: { askDefense: boolean; bidDefense: boolean; upsideVacuum: boolean; downsideVacuum: boolean; askWithdrawal: number; bidWithdrawal: number },
    now: number,
  ): VisualHints {
    const scale = Math.max(this.typicalLevel, 1_000_000);
    const wallHits = [];
    const fades = [];
    const ask = this.book.bestAsk();
    const bid = this.book.bestBid();
    if (flow.aggressiveBuy > 0 && ask) {
      wallHits.push({ side: 'ask' as const, price: ask.price, magnitude: flow.aggressiveBuy });
    }
    if (flow.aggressiveSell > 0 && bid) {
      wallHits.push({ side: 'bid' as const, price: bid.price, magnitude: flow.aggressiveSell });
    }
    if (liq.askWithdrawal > 0 && ask) fades.push({ side: 'ask' as const, price: ask.price, cancelled: liq.askWithdrawal });
    if (liq.bidWithdrawal > 0 && bid) fades.push({ side: 'bid' as const, price: bid.price, cancelled: liq.bidWithdrawal });

    const impulses: VisualImpulse[] = [];
    for (const imp of this.impulseBuf.values()) {
      if (now - imp.timestamp <= this.clock.tickMs * 3) impulses.push(imp);
    }

    return {
      buyImpulse: logScale(flow.aggressiveBuy, scale),
      sellImpulse: logScale(flow.aggressiveSell, scale),
      forcedBuyImpulse: logScale(flow.forcedBuy, scale),
      forcedSellImpulse: logScale(flow.forcedSell, scale),
      wallHits,
      fades,
      impulses,
      absorptionAsk: liq.askDefense,
      absorptionBid: liq.bidDefense,
      upsideVacuum: liq.upsideVacuum,
      downsideVacuum: liq.downsideVacuum,
    };
  }
}

function typical(
  bids: Array<{ quote: number }>,
  asks: Array<{ quote: number }>,
): number {
  const all = [...bids, ...asks].map((l) => l.quote).filter((q) => q > 0);
  if (!all.length) return 40_000_000;
  return all.reduce((s, q) => s + q, 0) / all.length;
}
