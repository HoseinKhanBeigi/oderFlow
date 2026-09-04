import type { EngineConfig } from '../config/types.js';
import { IntegrityMonitor } from '../core/integrity.js';
import { AbsorptionEngine } from '../analysis/absorption-engine.js';
import { buildAlerts } from '../analysis/alerts.js';
import { ConfidenceEngine } from '../analysis/confidence-engine.js';
import { FlowScoreEngine } from '../analysis/flow-score-engine.js';
import { LargeParticipantFlowEngine } from '../analysis/large-participant-flow-engine.js';
import { PriceImpactEngine } from '../analysis/price-impact-engine.js';
import { StateClassifier } from '../analysis/state-classifier.js';
import { BurstDetector } from '../flow/burst-detector.js';
import { FlowClusterDetector } from '../flow/cluster-detector.js';
import { CVDEngine } from '../flow/cvd-engine.js';
import { LargeTradeDetector } from '../flow/large-trade-detector.js';
import { detectPersistentFlow } from '../flow/persistent-flow.js';
import { buildNetAggression } from '../flow/net-aggression.js';
import { RollingFlowEngine } from '../flow/rolling-flow-engine.js';
import { LargeTradeTape } from '../flow/tape.js';
import { ConsumptionEngine } from '../liquidity/consumption-engine.js';
import { DefenseEngine } from '../liquidity/defense-engine.js';
import { IcebergLikeDetector } from '../liquidity/iceberg-detector.js';
import { LiquidityEngine } from '../liquidity/liquidity-engine.js';
import { LocalOrderBook } from '../liquidity/local-order-book.js';
import { MovePotentialEngine } from '../movement/move-potential-engine.js';
import { PassiveFlowEngine } from '../passive-flow/passive-flow-engine.js';
import { FlowWinnerEngine } from '../flow-battle/flow-winner-engine.js';
import { MarketBattleEngine } from '../market-battle/engine.js';
import { emptyPassiveMetrics } from '../models/passive.js';
import { LiquidityResponseEngine } from '../liquidity-response/engine.js';
import { PassiveLiquidityEngine } from '../passive-liquidity/engine.js';
import type { PassiveLiquiditySnapshot } from '../models/passive-liquidity.js';
import type {
  AlertEvent,
  MultiWindowSnapshot,
  WindowSnapshot,
} from '../models/signals.js';
import type { LargeAggressiveTradeEvent, LargeTradeCluster, TapeFilter, TapeEntry } from '../models/flow.js';
import type { FlowBurst } from '../models/flow.js';
import type { IcebergLikeFlag, MovePotentialEventType } from '../models/liquidity.js';
import type {
  AccelerationLabel,
  LiquidationEvent,
  MarketTrade,
  MarketType,
  OrderBookDelta,
  OrderBookSnapshot,
  WindowId,
} from '../models/trade.js';
import { WINDOW_MS } from '../models/trade.js';

export type EngineListener = (event: EngineEvent) => void;

export type EngineEvent =
  | { kind: 'large_trade'; event: LargeAggressiveTradeEvent }
  | { kind: 'burst'; burst: FlowBurst; symbol: string }
  | { kind: 'cluster'; cluster: LargeTradeCluster; symbol: string }
  | { kind: 'iceberg_like'; flag: IcebergLikeFlag; symbol: string }
  | { kind: 'alert'; alert: AlertEvent }
  | { kind: 'snapshot'; snapshot: WindowSnapshot }
  | { kind: 'move_potential'; symbol: string; events: MovePotentialEventType[] };

interface SamePriceBuf {
  side: 'BUY' | 'SELL';
  prices: number[];
  notionals: number[];
}

export class SymbolEngine {
  readonly book = new LocalOrderBook();
  readonly integrity: IntegrityMonitor;
  readonly rolling: RollingFlowEngine;
  readonly largeTrades: LargeTradeDetector;
  readonly bursts: BurstDetector;
  readonly clusters: FlowClusterDetector;
  readonly cvd: CVDEngine;
  readonly tape: LargeTradeTape;
  readonly liquidity: LiquidityEngine;
  readonly consumption: ConsumptionEngine;
  readonly iceberg: IcebergLikeDetector;
  readonly priceImpact: PriceImpactEngine;
  readonly absorption: AbsorptionEngine;
  readonly participant: LargeParticipantFlowEngine;
  readonly directional: FlowScoreEngine;
  readonly confidence: ConfidenceEngine;
  readonly states: StateClassifier;
  readonly movePotential: MovePotentialEngine;
  readonly passive: PassiveFlowEngine;
  readonly defense: DefenseEngine;
  readonly flowWinner: FlowWinnerEngine;
  readonly liquidityResponse: LiquidityResponseEngine;
  readonly passiveLiquidity: PassiveLiquidityEngine;
  readonly marketBattle: MarketBattleEngine;

  private readonly listeners = new Set<EngineListener>();
  /**
   * The passive liquidity snapshot is window-independent, so it is computed once
   * per timestamp and shared across every window in a multi-window emit.
   */
  private passiveCache: { at: number; snapshot: PassiveLiquiditySnapshot } | null = null;
  private sequenceGaps = 0;
  private reconnects = 0;
  private lastBuyVolume = 0;
  private lastSellVolume = 0;
  private lastDeltaSign = 0;
  private recentFlip = false;
  private priorAccelBuy: AccelerationLabel = 'NONE';
  private priorAccelSell: AccelerationLabel = 'NONE';
  private readonly samePrice: SamePriceBuf = { side: 'BUY', prices: [], notionals: [] };
  private lastIceberg: IcebergLikeFlag | null = null;
  private lastBurst: FlowBurst | null = null;
  private lastNow = 0;
  private lastLargeBuyCount = 0;
  private lastLargeSellCount = 0;
  private readonly lastVolatile = new Map<WindowId, boolean>();

  constructor(
    readonly symbol: string,
    readonly marketType: MarketType,
    readonly config: EngineConfig,
  ) {
    this.integrity = new IntegrityMonitor(
      config.integrity.duplicateWindow,
      config.integrity.maxOutOfOrderMs,
    );
    this.rolling = new RollingFlowEngine(config);
    this.largeTrades = new LargeTradeDetector(config);
    this.bursts = new BurstDetector(config.burst);
    this.clusters = new FlowClusterDetector(config.cluster);
    this.cvd = new CVDEngine(config.cvdSlopeMs);
    this.tape = new LargeTradeTape(config.tapeCapacity);
    this.liquidity = new LiquidityEngine(config.pressure);
    this.consumption = new ConsumptionEngine(60_000);
    this.iceberg = new IcebergLikeDetector(config.iceberg);
    this.priceImpact = new PriceImpactEngine(config.priceImpact);
    this.absorption = new AbsorptionEngine(config.absorption, config.samePrice);
    this.participant = new LargeParticipantFlowEngine(config.participantWeights);
    this.directional = new FlowScoreEngine(config.directionalWeights);
    this.confidence = new ConfidenceEngine(config.confidence);
    this.states = new StateClassifier(config.vacuum, config.exhaustion);
    this.movePotential = new MovePotentialEngine(config);
    this.passive = new PassiveFlowEngine();
    this.defense = new DefenseEngine(config.flowBattle);
    this.flowWinner = new FlowWinnerEngine(config.flowBattle, this.defense);
    this.liquidityResponse = new LiquidityResponseEngine(config.liquidityResponse);
    this.passiveLiquidity = new PassiveLiquidityEngine(
      symbol,
      config.passiveLiquidity,
      config.liquidityResponse.percentileBands,
    );
    this.marketBattle = new MarketBattleEngine();
  }

  on(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ingestTrade(trade: MarketTrade): void {
    if (trade.symbol !== this.symbol) return;
    this.integrity.clearTransient();
    if (!this.integrity.acceptTradeId(trade.tradeId, trade.timestamp)) return;

    this.lastNow = trade.timestamp;

    const relative = this.largeTrades.relativeSize(trade.quoteValue);
    this.largeTrades.observe(trade);
    const isLarge = this.largeTrades.isLarge(trade, relative);

    if (isLarge) {
      if (trade.isAggressiveBuy) this.lastLargeBuyCount += 1;
      else this.lastLargeSellCount += 1;
      this.tape.push({
        timestamp: trade.timestamp,
        side: trade.side,
        price: trade.price,
        quoteValue: trade.quoteValue,
        relativeClass: relative.classification,
        symbol: trade.symbol,
      });
      const event = this.largeTrades.maybeEvent(trade, relative);
      if (event) this.emit({ kind: 'large_trade', event });
    }

    this.rolling.onTrade(
      trade.timestamp,
      trade.side,
      trade.quoteValue,
      trade.price,
      isLarge,
      Boolean(trade.isForced),
    );
    this.cvd.onTrade(
      trade.timestamp,
      trade.isAggressiveBuy ? trade.quoteValue : 0,
      trade.isAggressiveSell ? trade.quoteValue : 0,
      trade.price,
    );

    const burst = this.bursts.onTrade(trade, relative.vsMedian);
    if (burst) {
      this.lastBurst = burst;
      this.emit({ kind: 'burst', burst, symbol: this.symbol });
    }
    const cluster = this.clusters.onTrade(trade, isLarge);
    if (cluster) this.emit({ kind: 'cluster', cluster, symbol: this.symbol });

    this.trackSamePrice(trade);

    this.liquidityResponse.onTrade(trade, isLarge);
    this.passiveLiquidity.onTrade(trade);

    if (!this.book.empty()) {
      const flag = this.iceberg.onTrade(trade, this.book);
      if (flag) {
        this.lastIceberg = flag;
        this.emit({ kind: 'iceberg_like', flag, symbol: this.symbol });
      }
    }

    this.updateLiquidityPath(trade.timestamp);
    this.updateFlip(trade.timestamp);
  }

  ingestBookSnapshot(snapshot: OrderBookSnapshot): void {
    this.book.applySnapshot(snapshot);
    this.integrity.lastBookTimestamp = snapshot.timestamp;
    this.integrity.flags.delete('staleBook');
    this.integrity.flags.delete('missingData');
    this.checkSpread();
    this.rolling.touchPrice(snapshot.timestamp, this.book.mid());
    this.updateLiquidityPath(snapshot.timestamp);
  }

  ingestBookDelta(delta: OrderBookDelta): void {
    const result = this.book.applyDelta(delta);
    this.integrity.lastBookTimestamp = delta.timestamp;
    if (result.gap) {
      this.integrity.noteSequenceGap(delta.timestamp);
      // Incremental state is no longer trustworthy: stop attributing book
      // changes until a fresh snapshot restores continuity.
      this.sequenceGaps += 1;
      this.passiveLiquidity.noteReset(delta.timestamp);
    }
    this.checkSpread();
    this.rolling.touchPrice(delta.timestamp, this.book.mid());
    this.updateLiquidityPath(delta.timestamp);
  }

  ingestLiquidation(liq: LiquidationEvent): void {
    this.ingestTrade({
      symbol: liq.symbol,
      marketType: liq.marketType,
      timestamp: liq.timestamp,
      price: liq.price,
      quantity: liq.quantity,
      quoteValue: liq.quoteValue,
      side: liq.side,
      isAggressiveBuy: liq.side === 'BUY',
      isAggressiveSell: liq.side === 'SELL',
      isForced: true,
    });
  }

  noteReconnect(now: number): void {
    this.integrity.noteReconnect(now);
    this.liquidityResponse.noteReset(now);
    this.reconnects += 1;
    this.passiveLiquidity.noteReset(now);
  }

  snapshot(window: WindowId, now = this.lastNow): WindowSnapshot {
    this.refreshIntegrity(now);
    const view = this.rolling.view(window, now);
    const agg = view.agg;
    const priceEnd = agg.priceClose || this.book.mid() || 0;
    const priceStart = agg.priceOpen || priceEnd;
    const impact = this.priceImpact.measure(priceStart, priceEnd, view.delta.delta);
    const pressure = this.liquidity.pressure(agg.buyVolume, agg.sellVolume, this.book);
    const rates = this.consumption.rates();
    const burstNow = this.bursts.current(now);
    const buyBurst = Boolean(burstNow && burstNow.side === 'BUY');
    const sellBurst = Boolean(burstNow && burstNow.side === 'SELL');
    const persistent = detectPersistentFlow(
      agg,
      view.windowMs,
      view.flowMultipleBuy,
      view.flowMultipleSell,
      this.config.persistent,
    );

    const sameBuy = this.samePrice.side === 'BUY' && this.absorption.samePriceHit(
      'BUY',
      this.samePrice.prices,
      this.samePrice.notionals,
      priceStart,
      priceEnd,
    );
    const sameSell = this.samePrice.side === 'SELL' && this.absorption.samePriceHit(
      'SELL',
      this.samePrice.prices,
      this.samePrice.notionals,
      priceStart,
      priceEnd,
    );

    const absorption = this.absorption.detect({
      delta: view.delta.delta,
      deltaPercent: view.delta.deltaPercent,
      flowMultipleBuy: Number.isFinite(view.flowMultipleBuy) ? view.flowMultipleBuy : 99,
      flowMultipleSell: Number.isFinite(view.flowMultipleSell) ? view.flowMultipleSell : 99,
      priceChangePercent: impact.percentagePriceChange,
      impactEfficiency: impact.efficiency,
      buyBurst,
      sellBurst,
      persistentBuy: persistent.persistentBuyFlow,
      persistentSell: persistent.persistentSellFlow,
      askReplenishmentRatio: this.consumption.replenishmentRatio('ask'),
      bidReplenishmentRatio: this.consumption.replenishmentRatio('bid'),
      samePriceBuy: sameBuy,
      samePriceSell: sameSell,
      icebergSellAbsorption: this.lastIceberg?.type === 'ICEBERG_LIKE_SELL_ABSORPTION',
      icebergBuyAbsorption: this.lastIceberg?.type === 'ICEBERG_LIKE_BUY_ABSORPTION',
    });

    const largeBuy = this.isUnusualLarge(
      view.flowMultipleBuy,
      view.buyFlowPercentile,
      agg.largeBuyVolume,
      agg.largestBuy,
    );
    const largeSell = this.isUnusualLarge(
      view.flowMultipleSell,
      view.sellFlowPercentile,
      agg.largeSellVolume,
      agg.largestSell,
    );

    const cvd = this.cvd.snapshot(now);
    const participant = this.participant.score({
      largeBuyCount: this.lastLargeBuyCount,
      largeSellCount: this.lastLargeSellCount,
      largeBuyVolume: agg.largeBuyVolume,
      largeSellVolume: agg.largeSellVolume,
      buyVolume: agg.buyVolume,
      sellVolume: agg.sellVolume,
      largeBuyShare: view.shares.largeBuyFlowShare,
      largeSellShare: view.shares.largeSellFlowShare,
      maxPercentileRank: Math.max(view.buyFlowPercentile, view.sellFlowPercentile),
      buyBurstStrength: buyBurst ? burstNow?.strength ?? 0.6 : 0,
      sellBurstStrength: sellBurst ? burstNow?.strength ?? 0.6 : 0,
      persistentBuy: persistent.persistentBuyFlow,
      persistentSell: persistent.persistentSellFlow,
      deltaPercent: view.delta.deltaPercent,
      impactEfficiency: impact.efficiency,
      askConsumption: rates.askConsumptionRate,
      bidConsumption: rates.bidConsumptionRate,
      buyPressure: pressure.buyPressure,
      sellPressure: pressure.sellPressure,
    });

    const directional = this.directional.score({
      deltaPercent: view.delta.deltaPercent,
      largeBuyShare: view.shares.largeBuyFlowShare,
      largeSellShare: view.shares.largeSellFlowShare,
      buyBurstStrength: buyBurst ? burstNow?.strength ?? 0.6 : 0,
      sellBurstStrength: sellBurst ? burstNow?.strength ?? 0.6 : 0,
      persistentBuy: persistent.persistentBuyFlow,
      persistentSell: persistent.persistentSellFlow,
      cvdSlopeSign: Math.sign(cvd.slope),
      askConsumption: rates.askConsumptionRate,
      bidConsumption: rates.bidConsumptionRate,
      priceChangePercent: impact.percentagePriceChange,
      impactEfficiency: impact.efficiency,
      accelerationBuy: view.largeBuyFlowAcceleration,
      accelerationSell: view.largeSellFlowAcceleration,
    });

    const conf = this.confidence.score({
      flags: this.integrity.flags,
      tradeCount: agg.buyCount + agg.sellCount,
      bookEmpty: this.book.empty(),
      spreadBps: this.book.spreadBps(),
      maxSpreadBps: this.config.integrity.maxSpreadBps,
      deltaPercent: view.delta.deltaPercent,
      priceChangePercent: impact.percentagePriceChange,
      impactEfficiency: impact.efficiency,
      recentFlip: this.recentFlip,
    });

    const state = this.states.classify({
      window,
      absorption,
      buyBurst,
      sellBurst,
      persistentBuy: persistent.persistentBuyFlow,
      persistentSell: persistent.persistentSellFlow,
      largeBuy,
      largeSell,
      flowMultipleBuy: view.flowMultipleBuy,
      flowMultipleSell: view.flowMultipleSell,
      buyPressure: pressure.buyPressure,
      sellPressure: pressure.sellPressure,
      priceChangePercent: impact.percentagePriceChange,
      impactEfficiency: impact.efficiency,
      accelerationBuy: view.largeBuyFlowAcceleration,
      accelerationSell: view.largeSellFlowAcceleration,
      priorAccelerationBuy: this.priorAccelBuy,
      priorAccelerationSell: this.priorAccelSell,
    });

    this.priorAccelBuy = view.largeBuyFlowAcceleration;
    this.priorAccelSell = view.largeSellFlowAcceleration;

    const band = this.config.pressure.nearBandPct;
    const mid = this.book.mid() || priceEnd;
    const visibleAsk = this.book.notionalWithin('ask', mid, band);
    const visibleBid = this.book.notionalWithin('bid', mid, band);
    const liqWin = this.passive.window(now, WINDOW_MS[window]);
    const metrics = {
      ...emptyPassiveMetrics(),
      passiveBuyExecutedVolume: agg.sellVolume,
      passiveSellExecutedVolume: agg.buyVolume,
      bidLiquidityAdded: liqWin.bidLiquidityAdded,
      askLiquidityAdded: liqWin.askLiquidityAdded,
      bidLiquidityRemoved: liqWin.bidLiquidityRemoved,
      askLiquidityRemoved: liqWin.askLiquidityRemoved,
      bidLiquidityConsumed: rates.bidConsumptionRate,
      askLiquidityConsumed: rates.askConsumptionRate,
      bidLiquidityReplenished: rates.bidReplenishmentRate,
      askLiquidityReplenished: rates.askReplenishmentRate,
      bidLiquidityInitial: liqWin.bidLiquidityInitial,
      askLiquidityInitial: liqWin.askLiquidityInitial,
      bidLiquidityFinal: liqWin.bidLiquidityFinal || visibleBid,
      askLiquidityFinal: liqWin.askLiquidityFinal || visibleAsk,
    };
    const flowBattle = this.flowWinner.analyze({
      price: priceEnd,
      aggressiveBuy: agg.buyVolume,
      aggressiveSell: agg.sellVolume,
      delta: view.delta.delta,
      priceChangePercent: impact.percentagePriceChange,
      impact: impact.efficiency,
      flowMultipleBuy: Number.isFinite(view.flowMultipleBuy) ? view.flowMultipleBuy : 1,
      flowMultipleSell: Number.isFinite(view.flowMultipleSell) ? view.flowMultipleSell : 1,
      buyBurst,
      sellBurst,
      persistentBuy: persistent.persistentBuyFlow,
      persistentSell: persistent.persistentSellFlow,
      windowMs: WINDOW_MS[window],
      absorption,
      iceberg: this.lastIceberg,
      visibleAsk,
      visibleBid,
      metrics,
    });

    const liquidityResponse = this.liquidityResponse.snapshot({
      now,
      windowMs: WINDOW_MS[window],
      buy: agg.buyVolume,
      sell: agg.sellVolume,
      buyCount: agg.buyCount,
      sellCount: agg.sellCount,
      largeBuyCount: this.lastLargeBuyCount,
      largeSellCount: this.lastLargeSellCount,
      priceStart,
      priceEnd,
      priceHigh: agg.priceHigh || Math.max(priceStart, priceEnd),
      priceLow: agg.priceLow || Math.min(priceStart, priceEnd),
      cvdDirection: cvd.direction,
      shortLiquidationUsd: agg.forcedBuyVolume,
      longLiquidationUsd: agg.forcedSellVolume,
      flags: this.integrity.flags,
      bookEmpty: this.book.empty(),
      lastTradeAgeMs: this.integrity.lastTradeTimestamp
        ? Math.max(0, now - this.integrity.lastTradeTimestamp)
        : 0,
      lastBookAgeMs: this.integrity.lastBookTimestamp
        ? Math.max(0, now - this.integrity.lastBookTimestamp)
        : 0,
      exchangeCount: 1,
      oiExpected: this.marketType === 'perp',
      liquidationExpected: this.marketType === 'perp',
    });

    const netAggression = buildNetAggression({
      window,
      buyVolume: agg.buyVolume,
      sellVolume: agg.sellVolume,
      buyCount: agg.buyCount,
      sellCount: agg.sellCount,
      largeBuyVolume: agg.largeBuyVolume,
      largeSellVolume: agg.largeSellVolume,
      buyPercentile: view.buyFlowPercentile,
      sellPercentile: view.sellFlowPercentile,
      netMagnitudePercentile: liquidityResponse.norms.delta.percentile,
    });

    const passiveLiquidity = this.passiveLiquiditySnapshot(now);
    const tradeDataMissing =
      this.integrity.lastTradeTimestamp === 0 ||
      this.integrity.flags.has('missingData');

    const marketBattle = this.marketBattle.analyze({
      window,
      aggressiveBuyVolume: agg.buyVolume,
      aggressiveSellVolume: agg.sellVolume,
      buyTradeCount: agg.buyCount,
      sellTradeCount: agg.sellCount,
      largeBuyVolume: agg.largeBuyVolume,
      largeSellVolume: agg.largeSellVolume,
      priceChangePercent: impact.percentagePriceChange,
      priceImpactEfficiency: impact.efficiency,
      confidence: conf,
      tradeDataMissing,
      flowBattle,
      liquidityResponse,
      passiveLiquidity,
      netAggression,
    });

    const snap: WindowSnapshot = {
      symbol: this.symbol,
      marketType: this.marketType,
      price: priceEnd,
      window,
      aggressiveBuyVolume: agg.buyVolume,
      aggressiveSellVolume: agg.sellVolume,
      buyTradeCount: agg.buyCount,
      sellTradeCount: agg.sellCount,
      averageBuySize: view.shares.averageBuySize,
      averageSellSize: view.shares.averageSellSize,
      delta: view.delta.delta,
      deltaPercent: view.delta.deltaPercent,
      largeBuyVolume: agg.largeBuyVolume,
      largeSellVolume: agg.largeSellVolume,
      largeBuyFlowShare: view.shares.largeBuyFlowShare,
      largeSellFlowShare: view.shares.largeSellFlowShare,
      largestBuy: agg.largestBuy,
      largestSell: agg.largestSell,
      buyBurstDetected: buyBurst,
      sellBurstDetected: sellBurst,
      persistentBuyFlow: persistent.persistentBuyFlow,
      persistentSellFlow: persistent.persistentSellFlow,
      priceStart,
      priceEnd,
      absolutePriceChange: impact.absolutePriceChange,
      priceChangePercent: impact.percentagePriceChange,
      priceImpactEfficiency: impact.efficiency,
      flowMultipleBuy: view.flowMultipleBuy,
      flowMultipleSell: view.flowMultipleSell,
      forcedBuyVolume: agg.forcedBuyVolume,
      forcedSellVolume: agg.forcedSellVolume,
      buyPressure: pressure.buyPressure,
      sellPressure: pressure.sellPressure,
      askReplenishmentRate: rates.askReplenishmentRate,
      bidReplenishmentRate: rates.bidReplenishmentRate,
      askConsumptionRate: rates.askConsumptionRate,
      bidConsumptionRate: rates.bidConsumptionRate,
      largeBuyFlowAcceleration: view.largeBuyFlowAcceleration,
      largeSellFlowAcceleration: view.largeSellFlowAcceleration,
      absorption,
      largeFlowDirectionalScore: directional,
      largeParticipantFlowScore: participant.largeParticipantFlowScore,
      confidence: conf,
      state,
      flowBattle,
      liquidityResponse,
      passiveLiquidity,
      netAggression,
      marketBattle,
      movePotential: this.movePotential.evaluate({
        symbol: this.symbol,
        book: this.book,
        buyVolume: agg.buyVolume,
        sellVolume: agg.sellVolume,
        priceHigh: agg.priceHigh,
        priceLow: agg.priceLow,
        impactEfficiency: impact.efficiency,
        absorption,
        dataQualityScore: conf,
      }),
    };

    const alerts = buildAlerts(snap, this.config.alerts, now);
    const volatile = alerts.length > 0;
    const wasVolatile = this.lastVolatile.get(window) ?? false;
    this.lastVolatile.set(window, volatile);
    if (volatile && !wasVolatile) {
      for (const alert of alerts) this.emit({ kind: 'alert', alert });
    }
    if (snap.movePotential.liquidity.events.length) {
      this.emit({
        kind: 'move_potential',
        symbol: this.symbol,
        events: snap.movePotential.liquidity.events,
      });
    }
    return snap;
  }

  multiWindow(now = this.lastNow): MultiWindowSnapshot {
    const windows: MultiWindowSnapshot['windows'] = {};
    let price = 0;
    for (const id of this.config.windows) {
      windows[id] = this.snapshot(id, now);
      price = windows[id]!.price;
    }
    return {
      symbol: this.symbol,
      marketType: this.marketType,
      price,
      timestamp: now,
      windows,
    };
  }

  queryTape(filter: TapeFilter = {}): TapeEntry[] {
    return this.tape.query({ ...filter, symbol: filter.symbol ?? this.symbol });
  }

  formatTape(filter: TapeFilter = {}): string {
    return this.tape.format({ ...filter, symbol: filter.symbol ?? this.symbol });
  }

  seedTradeSizeBaseline(values: number[]): void {
    for (const v of values) this.largeTrades.distribution.add(v);
  }

  seedFlowBaseline(side: 'BUY' | 'SELL', perSecondVolumes: number[]): void {
    this.rolling.seedBaseline(side, perSecondVolumes);
  }

  seedImpactBaseline(impactsPerMillion: number[]): void {
    this.priceImpact.seed(impactsPerMillion);
  }

  private passiveLiquiditySnapshot(now: number): PassiveLiquiditySnapshot {
    if (this.passiveCache && this.passiveCache.at === now) return this.passiveCache.snapshot;
    const snapshot = this.passiveLiquidity.snapshot({
      now,
      reconnects: this.reconnects,
      sequenceGaps: this.sequenceGaps,
      sequenceContinuous: !this.integrity.flags.has('sequenceGap'),
      bookEmpty: this.book.empty(),
      exchangeTimestamp: this.book.timestamp,
    });
    this.passiveCache = { at: now, snapshot };
    return snapshot;
  }

  private isUnusualLarge(
    flowMultiple: number,
    percentile: number,
    largeVolume: number,
    largest: number,
  ): boolean {
    const absTier = this.largeTrades.absoluteTier(largest) !== null;
    const rel = this.largeTrades.classifyPercentile(percentile);
    const multiple = Number.isFinite(flowMultiple) && flowMultiple >= 3;
    return (absTier && largeVolume > 0) || rel === 'LARGE' || rel === 'VERY_LARGE' || rel === 'EXTREME' || multiple;
  }

  private trackSamePrice(trade: MarketTrade): void {
    if (this.samePrice.side !== trade.side) {
      this.samePrice.side = trade.side;
      this.samePrice.prices = [];
      this.samePrice.notionals = [];
    }
    const last = this.samePrice.prices[this.samePrice.prices.length - 1];
    if (last !== undefined) {
      const bps = (Math.abs(trade.price - last) / last) * 10_000;
      if (bps > this.config.samePrice.maxPriceDeviationBps) {
        this.samePrice.prices = [];
        this.samePrice.notionals = [];
      }
    }
    this.samePrice.prices.push(trade.price);
    this.samePrice.notionals.push(trade.quoteValue);
    if (this.samePrice.prices.length > 64) {
      this.samePrice.prices.shift();
      this.samePrice.notionals.shift();
    }
  }

  private updateLiquidityPath(now: number): void {
    if (this.book.empty()) {
      this.integrity.noteMissingData();
      return;
    }
    const mid = this.book.mid();
    const band = this.config.pressure.nearBandPct;
    const ask = this.book.notionalWithin('ask', mid, band);
    const bid = this.book.notionalWithin('bid', mid, band);
    const view = this.rolling.view('1s', now || this.lastNow);
    const buyDelta = Math.max(0, view.agg.buyVolume - this.lastBuyVolume);
    const sellDelta = Math.max(0, view.agg.sellVolume - this.lastSellVolume);
    this.lastBuyVolume = view.agg.buyVolume;
    this.lastSellVolume = view.agg.sellVolume;
    this.consumption.observe(now, bid, ask, buyDelta, sellDelta);
    this.passive.observe(now, bid, ask);
    this.passiveLiquidity.onBook(now, this.book);
    this.movePotential.observe(now, this.book, buyDelta, sellDelta);
    this.liquidityResponse.onBook(now, this.book, buyDelta, sellDelta);
  }

  private updateFlip(now: number): void {
    const view = this.rolling.view('5s', now);
    const sign = Math.sign(view.delta.deltaPercent);
    if (sign !== 0 && this.lastDeltaSign !== 0 && sign !== this.lastDeltaSign) {
      this.recentFlip = true;
    } else if (sign !== 0) {
      this.recentFlip = false;
    }
    if (sign !== 0) this.lastDeltaSign = sign;
  }

  private refreshIntegrity(now: number): void {
    if (!this.book.empty() && now - this.book.timestamp > this.config.integrity.bookStaleMs) {
      this.integrity.noteStaleBook();
    }
    this.checkSpread();
  }

  private checkSpread(): void {
    const spread = this.book.spreadBps();
    if (Number.isFinite(spread) && spread > this.config.integrity.maxSpreadBps) {
      this.integrity.noteWideSpread();
    }
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
