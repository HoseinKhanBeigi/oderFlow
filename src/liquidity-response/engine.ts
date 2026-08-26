import { pctChange, safeDiv } from '../core/integrity.js';
import type { LiquidityResponseConfig } from '../config/types.js';
import type { LocalOrderBook } from '../liquidity/local-order-book.js';
import type { MarketTrade } from '../models/trade.js';
import type {
  CvdDirection,
  LiquidityResponseSnapshot,
  LiquidityTf,
  LiquidityTfView,
} from '../models/liquidity-response.js';
import { LIQUIDITY_TF_MINUTES } from '../models/liquidity-response.js';
import { BookAccountant } from './book-accountant.js';
import {
  aggressionSide,
  candidateStrength,
  classifyEffort,
  classifyState,
  detectAbsorption,
  detectReversal,
  detectVacuum,
  efficiencyMetrics,
  intensityFromPercentile,
  type ClassifyInput,
} from './classify.js';
import { compareLiquidityMarkets, type OtherMarketContext } from './compare.js';
import { confidenceScore } from './confidence-score.js';
import { displayedChangePercent, tradeBookReconciled, validateConsistency } from './consistency.js';
import { dataQualityScore } from './data-quality.js';
import { analyzeDelta } from './delta-analysis.js';
import { emptyLiquidityResponse } from './empty.js';
import { classifyEntry } from './entry-context.js';
import { ImpactHorizonTracker } from './impact-horizons.js';
import { classifyMarketMechanics } from './mechanics.js';
import { MinuteRing } from './minute-ring.js';
import { MetricNormalizer } from './normalizer.js';
import { interpretOi } from './oi-context.js';
import { StatePersistenceEngine } from './persistence.js';
import {
  classifyAskSide,
  classifyBidSide,
  intensityForComponent,
  toDepthView,
} from './side-response.js';
import { detectStructure } from './structure.js';
import { buildWhy } from './why.js';

export interface FlowSlice {
  now: number;
  windowMs: number;
  buy: number;
  sell: number;
  buyCount: number;
  sellCount: number;
  largeBuyCount: number;
  largeSellCount: number;
  priceStart: number;
  priceEnd: number;
  priceHigh: number;
  priceLow: number;
  cvdDirection?: CvdDirection;
  oiChangePercent?: number | null;
  shortLiquidationUsd?: number;
  longLiquidationUsd?: number;
  flags?: Iterable<string>;
  bookEmpty?: boolean;
  lastTradeAgeMs?: number;
  lastBookAgeMs?: number;
  exchangeCount?: number;
  oiExpected?: boolean;
  liquidationExpected?: boolean;
}

export class LiquidityResponseEngine {
  readonly book: BookAccountant;
  readonly minutes: MinuteRing;
  readonly impact: ImpactHorizonTracker;
  readonly norms: MetricNormalizer;
  readonly persistence: StatePersistenceEngine;
  private lastTradePrice = 0;
  private lastTradeSide: 'BUY' | 'SELL' | undefined;
  private bookTicks = 0;
  private hasBook = false;
  private lastAsk: number | null = null;
  private lastBid: number | null = null;
  private oiUsd: number | null = null;
  private prevOiUsd: number | null = null;
  private lastTradeTs = 0;
  private lastBookTs = 0;

  constructor(private readonly config: LiquidityResponseConfig) {
    this.book = new BookAccountant(config);
    this.minutes = new MinuteRing(config.minuteCapacity);
    this.impact = new ImpactHorizonTracker(config);
    this.norms = new MetricNormalizer(config.normWindows, config.defaultNormWindow);
    this.persistence = new StatePersistenceEngine(config);
  }

  noteOi(oiUsd: number): void {
    if (this.oiUsd != null && this.oiUsd > 0 && oiUsd !== this.oiUsd) this.prevOiUsd = this.oiUsd;
    this.oiUsd = oiUsd;
  }

  oiChangePercent(): number | null {
    if (this.oiUsd == null || this.prevOiUsd == null || this.prevOiUsd <= 0) return null;
    return ((this.oiUsd - this.prevOiUsd) / this.prevOiUsd) * 100;
  }

  onTrade(trade: MarketTrade, large = false): void {
    const nearAsk = this.lastAsk != null && trade.isAggressiveBuy && trade.price >= this.lastAsk * 0.9995;
    const nearBid = this.lastBid != null && trade.isAggressiveSell && trade.price <= this.lastBid * 1.0005;
    const closed = this.minutes.ingest(trade, { large, nearAsk, nearBid });
    if (closed) this.observeClosed(closed);
    this.impact.onTrade(trade.timestamp, trade.price, trade.quoteValue);
    this.lastTradePrice = trade.price;
    this.lastTradeSide = trade.side;
    this.lastTradeTs = trade.timestamp;
  }

  onBook(timestamp: number, book: LocalOrderBook, buyDelta: number, sellDelta: number): void {
    if (book.empty()) return;
    this.hasBook = true;
    this.bookTicks += 1;
    this.lastAsk = book.bestAsk()?.price ?? this.lastAsk;
    this.lastBid = book.bestBid()?.price ?? this.lastBid;
    this.lastBookTs = timestamp;
    this.book.observe(
      timestamp,
      book,
      Math.max(0, buyDelta),
      Math.max(0, sellDelta),
      this.lastTradePrice,
      this.lastTradeSide,
    );
    this.impact.onPrice(timestamp, book.mid() || this.lastTradePrice);
    this.norms.observe('askRemaining', this.book.currentAsk, 1);
    this.norms.observe('bidRemaining', this.book.currentBid, 1);
  }

  noteReset(timestamp = Date.now()): void {
    this.book.noteReset(timestamp);
    this.hasBook = false;
    this.bookTicks = 0;
  }

  /** Seed closed 1m history so percentiles are asset-relative from the first live bar. */
  seedHistory(bars: Array<{ buy: number; sell: number; open: number; close: number }>): void {
    for (const bar of bars) this.observeClosed({ ...bar, time: 0 });
  }

  snapshot(flow: FlowSlice, other: OtherMarketContext | null = null): LiquidityResponseSnapshot {
    this.minutes.closeStale(flow.now);
    const bookWin = this.book.window(flow.now, Math.min(flow.windowMs, 60_000));
    const atr = this.minutes.atr(this.config.atrPeriod);
    const total = flow.buy + flow.sell;
    const delta = flow.buy - flow.sell;
    const moveAbs = Math.abs(flow.priceEnd - flow.priceStart);
    const movePctRaw = pctChange(flow.priceStart, flow.priceEnd);
    const absEff = safeDiv(moveAbs, total);
    const tf = windowToTf(flow.windowMs);
    const oiPct = flow.oiChangePercent !== undefined ? flow.oiChangePercent : this.oiChangePercent();
    const shortLiq = flow.shortLiquidationUsd ?? 0;
    const longLiq = flow.longLiquidationUsd ?? 0;
    const cvdDirection: CvdDirection = flow.cvdDirection ?? (delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : 'FLAT');
    const oiInterp = interpretOi({
      priceChangePercent: movePctRaw,
      futuresDelta: delta,
      oiChangePercent: oiPct,
      threshold: this.config.oiThresholdPercent,
    });
    const structure = detectStructure(this.minutes.closed());

    const buyPct = this.norms.percentile('aggressiveBuy', flow.buy, tf);
    const sellPct = this.norms.percentile('aggressiveSell', flow.sell, tf);
    const deltaPct = this.norms.percentile('deltaAbs', Math.abs(delta), tf);
    const movePct = this.norms.percentile('priceDisplacement', Math.abs(movePctRaw), tf);
    const absEffPct = this.norms.percentile('absEfficiency', absEff, tf);
    const askConsPct = this.norms.percentile('askDepthChange', bookWin.ask.consumed, 1);
    const askReplPct = this.norms.percentile('askDepthChange', bookWin.ask.added, 1);
    const askPullPct = this.norms.percentile('askDepthChange', bookWin.ask.cancelled, 1);
    const bidConsPct = this.norms.percentile('bidDepthChange', bookWin.bid.consumed, 1);
    const bidReplPct = this.norms.percentile('bidDepthChange', bookWin.bid.added, 1);
    const bidPullPct = this.norms.percentile('bidDepthChange', bookWin.bid.cancelled, 1);

    const rolledNearAsk = this.minutes.roll(tf, flow.now);
    const nearAskShare = safeDiv(rolledNearAsk?.nearAsk ?? 0, flow.buy);
    const nearBidShare = safeDiv(rolledNearAsk?.nearBid ?? 0, flow.sell);

    const input: ClassifyInput = {
      buy: flow.buy,
      sell: flow.sell,
      delta,
      priceStart: flow.priceStart,
      priceEnd: flow.priceEnd,
      priceHigh: flow.priceHigh,
      priceLow: flow.priceLow,
      atr,
      nearAskShare,
      nearBidShare,
      book: bookWin,
      buyPct,
      sellPct,
      deltaPct,
      movePct,
      absEffPct,
      askConsPct,
      askReplPct,
      askPullPct,
      bidConsPct,
      bidReplPct,
      bidPullPct,
      repeatedAsk: this.book.repeatedAskReplenishment(),
      repeatedBid: this.book.repeatedBidReplenishment(),
      hasBook: this.hasBook,
      ticks: this.bookTicks,
      cvdDirection,
      oiChangePercent: oiPct,
      oiInterpretation: oiPct == null ? null : oiInterp,
      swingHigh: structure.swingHigh,
      swingLow: structure.swingLow,
    };

    const absorption = detectAbsorption(this.config, input);
    const vacuum = detectVacuum(this.config, input);
    const effort = classifyEffort(this.config, input, absorption);
    const candidate = classifyState(this.config, input, effort, absorption, vacuum);
    const quality = dataQualityScore({
      flags: flow.flags,
      bookEmpty: flow.bookEmpty ?? !this.hasBook,
      tradeCount: flow.buyCount + flow.sellCount,
      lastTradeAgeMs: flow.lastTradeAgeMs ?? (this.lastTradeTs > 0 ? Math.max(0, flow.now - this.lastTradeTs) : 0),
      lastBookAgeMs: flow.lastBookAgeMs ?? (this.lastBookTs > 0 ? Math.max(0, flow.now - this.lastBookTs) : 0),
      baselineSize: this.norms.sampleSize('aggressiveBuy', tf),
      oiExpected: flow.oiExpected ?? false,
      oiPresent: oiPct != null,
      liquidationExpected: flow.liquidationExpected ?? false,
      liquidationPresent: shortLiq + longLiq > 0,
      exchangeCount: flow.exchangeCount ?? 1,
    });
    const impact = this.impact.snapshot(flow.now, flow.priceEnd);
    const flags = new Set([...(flow.flags ?? [])].map(String));
    const bookEmpty = flow.bookEmpty ?? !this.hasBook;
    const lastBookAgeMs = flow.lastBookAgeMs ?? (this.lastBookTs > 0 ? Math.max(0, flow.now - this.lastBookTs) : 0);
    const lastTradeAgeMs = flow.lastTradeAgeMs ?? (this.lastTradeTs > 0 ? Math.max(0, flow.now - this.lastTradeTs) : 0);
    const askChange = displayedChangePercent({
      initial: bookWin.ask.initial,
      remaining: bookWin.ask.remaining,
      consumed: bookWin.ask.consumed,
      cancelled: bookWin.ask.cancelled,
      added: bookWin.ask.added,
      primed: bookWin.primed,
      hasValidPrevious: bookWin.hasValidPrevious,
      bookEmpty,
      bookSynchronized: !flags.has('staleBook'),
      sequenceContinuous: !flags.has('sequenceGap'),
      websocketHealthy: !flags.has('reconnect') && !flags.has('missingData'),
      recentlyReset: bookWin.resetRecent,
      bandValid: true,
    });
    const bidChange = displayedChangePercent({
      initial: bookWin.bid.initial,
      remaining: bookWin.bid.remaining,
      consumed: bookWin.bid.consumed,
      cancelled: bookWin.bid.cancelled,
      added: bookWin.bid.added,
      primed: bookWin.primed,
      hasValidPrevious: bookWin.hasValidPrevious,
      bookEmpty,
      bookSynchronized: !flags.has('staleBook'),
      sequenceContinuous: !flags.has('sequenceGap'),
      websocketHealthy: !flags.has('reconnect') && !flags.has('missingData'),
      recentlyReset: bookWin.resetRecent,
      bandValid: true,
    });
    const bookSample = this.norms.sampleSize('askRemaining', 1);
    const askConsumption = intensityForComponent(
      this.config, bookWin.ask.consumed, bookWin.ask.consumed + bookWin.ask.cancelled,
      bookWin.ask.initial, askConsPct, bookSample, askChange.percent,
    );
    const askWithdrawal = intensityForComponent(
      this.config, bookWin.ask.cancelled, bookWin.ask.consumed + bookWin.ask.cancelled,
      bookWin.ask.initial, askPullPct, bookSample, askChange.percent,
    );
    const askReplenishment = intensityForComponent(
      this.config, bookWin.ask.added, bookWin.ask.added + bookWin.ask.cancelled + bookWin.ask.consumed,
      bookWin.ask.initial, askReplPct, bookSample, askChange.percent,
    );
    const bidConsumption = intensityForComponent(
      this.config, bookWin.bid.consumed, bookWin.bid.consumed + bookWin.bid.cancelled,
      bookWin.bid.initial, bidConsPct, bookSample, bidChange.percent,
    );
    const bidWithdrawal = intensityForComponent(
      this.config, bookWin.bid.cancelled, bookWin.bid.consumed + bookWin.bid.cancelled,
      bookWin.bid.initial, bidPullPct, bookSample, bidChange.percent,
    );
    const bidReplenishment = intensityForComponent(
      this.config, bookWin.bid.added, bookWin.bid.added + bookWin.bid.cancelled + bookWin.bid.consumed,
      bookWin.bid.initial, bidReplPct, bookSample, bidChange.percent,
    );
    const consistency = validateConsistency(this.config, {
      flags: flow.flags,
      bookEmpty,
      lastBookAgeMs,
      lastTradeAgeMs,
      ask: { changePercent: askChange.percent, consumption: askConsumption, withdrawal: askWithdrawal },
      bid: { changePercent: bidChange.percent, consumption: bidConsumption, withdrawal: bidWithdrawal },
      snapshotContinuous: !bookWin.resetRecent && !flags.has('reconnect'),
      tradeBookReconciled: tradeBookReconciled(flow.buy, flow.sell, bookWin.ask, bookWin.bid),
    });
    if (!consistency.valid && askChange.percent != null && askChange.percent <= -this.config.unexplainedDropPercent) {
      askChange.percent = null;
      askChange.reason = consistency.reason ?? 'UNEXPLAINED_ASK_LIQUIDITY_DROP';
    }
    if (!consistency.valid && bidChange.percent != null && bidChange.percent <= -this.config.unexplainedDropPercent) {
      bidChange.percent = null;
      bidChange.reason = consistency.reason ?? 'UNEXPLAINED_ASK_LIQUIDITY_DROP';
    }
    const consistencyLow = consistency.score < this.config.minConsistencyForKnown;
    const askRemainPct = this.norms.percentile('askRemaining', bookWin.ask.remaining, 1);
    const bidRemainPct = this.norms.percentile('bidRemaining', bookWin.bid.remaining, 1);
    const askSideIn = {
      side: 'ask' as const,
      window: bookWin.ask,
      currentPercentile: askRemainPct,
      consumePct: askConsPct,
      replenishPct: askReplPct,
      withdrawPct: askPullPct,
      sampleSize: bookSample,
      aggressiveVolume: flow.buy,
      aggressivePct: buyPct,
      priceMovePercent: movePctRaw,
      movePct,
      changePercent: askChange.percent,
      changeReason: askChange.reason,
      consistencyLow,
    };
    const bidSideIn = {
      side: 'bid' as const,
      window: bookWin.bid,
      currentPercentile: bidRemainPct,
      consumePct: bidConsPct,
      replenishPct: bidReplPct,
      withdrawPct: bidPullPct,
      sampleSize: bookSample,
      aggressiveVolume: flow.sell,
      aggressivePct: sellPct,
      priceMovePercent: movePctRaw,
      movePct,
      changePercent: bidChange.percent,
      changeReason: bidChange.reason,
      consistencyLow,
    };
    const askSideState = classifyAskSide(askSideIn);
    const bidSideState = classifyBidSide(bidSideIn);
    const askDepth = toDepthView(this.config, askSideIn, askSideState);
    const bidDepth = toDepthView(this.config, bidSideIn, bidSideState);
    let mechanics = classifyMarketMechanics({
      buyPct,
      sellPct,
      delta,
      movePct,
      priceMovePercent: movePctRaw,
      ask: askDepth,
      bid: bidDepth,
      bands: this.config.percentileBands,
    });
    if (consistencyLow) mechanics = 'UNKNOWN';
    const bookClear =
      bookWin.ask.response === 'CONSUMPTION' ||
      bookWin.ask.response === 'WITHDRAWAL' ||
      bookWin.bid.response === 'CONSUMPTION' ||
      bookWin.bid.response === 'WITHDRAWAL' ||
      bookWin.ask.response === 'REPLENISHMENT' ||
      bookWin.bid.response === 'REPLENISHMENT';
    const conf = confidenceScore(this.config, {
      input,
      state: candidate,
      dataQuality: quality,
      persisted: this.persistence.current === candidate && candidate !== 'NO_DIRECTIONAL_EDGE',
      fadedImpact: impact.faded,
      cvdAligned:
        (cvdDirection === 'UP' && delta > 0) || (cvdDirection === 'DOWN' && delta < 0),
      bookClear,
      crossAgree: null,
      dataConsistency: consistency.score,
    });
    const state = this.persistence.stabilize(
      flow.now,
      this.persistence.escalateDefense(candidate),
      candidateStrength(input, candidate),
      conf.score,
    );
    const deltaAnalysis = analyzeDelta(delta, deltaPct);
    const effClass = intensityFromPercentile(100 - Math.min(100, absEffPct));

    const snap = emptyLiquidityResponse();
    snap.aggression = aggressionSide(buyPct, sellPct, delta);
    snap.executed = total;
    snap.delta = delta;
    snap.priceMovePercent = movePctRaw;
    snap.priceMoveAbs = flow.priceEnd - flow.priceStart;
    snap.efficiency = effClass;
    snap.askConsumption = askConsumption;
    snap.askReplenishment = askReplenishment;
    snap.askWithdrawal = askWithdrawal;
    snap.bidConsumption = bidConsumption;
    snap.bidReplenishment = bidReplenishment;
    snap.bidWithdrawal = bidWithdrawal;
    snap.askResponse = consistencyLow ? 'QUIET' : bookWin.ask.response;
    snap.bidResponse = consistencyLow ? 'QUIET' : bookWin.bid.response;
    snap.state = state;
    snap.confidence = conf.label;
    snap.confidenceScore = conf.score;
    snap.dataQuality = quality;
    snap.dataConsistency = consistency.score;
    snap.consistency = consistency;
    snap.effort = effort;
    snap.absorption = absorption;
    snap.vacuum = vacuum;
    snap.impact = impact;
    snap.bands = this.book.bandAccounting();
    snap.levels = this.book.levels(
      flow.now,
      absorption.kind === 'SELL_ABSORPTION' ? 'ask' : absorption.kind === 'BUY_ABSORPTION' ? 'bid' : null,
    );
    snap.reversal = detectReversal(this.config, input, absorption);
    snap.structure = structure;
    snap.cvdDirection = cvdDirection;
    snap.oiChangePercent = oiPct;
    snap.oiInterpretation = flow.oiExpected === false ? null : oiPct == null ? null : oiInterp;
    snap.shortLiquidationUsd = shortLiq;
    snap.longLiquidationUsd = longLiq;
    snap.repeatedAskReplenishment = input.repeatedAsk;
    snap.repeatedBidReplenishment = input.repeatedBid;
    snap.deltaAnalysis = deltaAnalysis;
    snap.askDepth = askDepth;
    snap.bidDepth = bidDepth;
    snap.marketMechanics = mechanics;
    snap.entryContext = classifyEntry({
      state,
      absorption,
      structure,
      effort,
      aggression: snap.aggression,
      delta,
      priceMovePercent: movePctRaw,
      efficiency: effClass,
      askReplenishment,
      bidReplenishment,
      cvdDirection,
      reversal: snap.reversal,
      spotDeltaTurnsPositive: delta > 0 && cvdDirection === 'UP',
      spotDeltaTurnsNegative: delta < 0 && cvdDirection === 'DOWN',
    });
    snap.norms = {
      aggressiveBuy: this.norms.stats('aggressiveBuy', flow.buy, tf),
      aggressiveSell: this.norms.stats('aggressiveSell', flow.sell, tf),
      delta: this.norms.stats('deltaAbs', Math.abs(delta), tf),
      priceDisplacement: this.norms.stats('priceDisplacement', Math.abs(movePctRaw), tf),
      askDepthChange: this.norms.stats('askDepthChange', bookWin.askDepthChange, 1),
    };
    snap.compare = compareLiquidityMarkets(snap, other, this.config.oiThresholdPercent);
    snap.why = buildWhy({
      buy: flow.buy,
      buyPct,
      sell: flow.sell,
      sellPct,
      delta: deltaAnalysis,
      ask: askDepth,
      bid: bidDepth,
      movePct,
      priceMovePercent: movePctRaw,
      mechanics,
      bands: this.config.percentileBands,
    });
    snap.byTf = this.buildTfViews(flow.now, bookWin);

    const primary = snap.byTf[tf];
    if (primary && flow.windowMs >= 60_000) {
      snap.aggression = primary.aggression;
      snap.executed = primary.executed;
      snap.delta = primary.delta;
      snap.priceMovePercent = primary.priceMovePercent;
      snap.priceMoveAbs = primary.priceMoveAbs;
      snap.efficiency = primary.efficiency;
      snap.effort = primary.effort;
      snap.absorption = primary.absorption;
    }

    return snap;
  }

  private buildTfViews(now: number, bookWin: ClassifyInput['book']): Partial<Record<LiquidityTf, LiquidityTfView>> {
    const out: Partial<Record<LiquidityTf, LiquidityTfView>> = {};
    for (const tf of LIQUIDITY_TF_MINUTES) {
      const rolled = this.minutes.roll(tf, now);
      if (!rolled) continue;
      const total = rolled.buy + rolled.sell;
      const delta = rolled.buy - rolled.sell;
      const movePctRaw = pctChange(rolled.open, rolled.close);
      const absEff = safeDiv(Math.abs(rolled.close - rolled.open), total);
      const buyPct = this.norms.percentile('aggressiveBuy', rolled.buy, tf);
      const sellPct = this.norms.percentile('aggressiveSell', rolled.sell, tf);
      const deltaPct = this.norms.percentile('deltaAbs', Math.abs(delta), tf);
      const movePct = this.norms.percentile('priceDisplacement', Math.abs(movePctRaw), tf);
      const absEffPct = this.norms.percentile('absEfficiency', absEff, tf);
      const input: ClassifyInput = {
        buy: rolled.buy,
        sell: rolled.sell,
        delta,
        priceStart: rolled.open,
        priceEnd: rolled.close,
        priceHigh: rolled.high,
        priceLow: rolled.low,
        atr: rolled.atr,
        nearAskShare: safeDiv(rolled.nearAsk, rolled.buy),
        nearBidShare: safeDiv(rolled.nearBid, rolled.sell),
        book: bookWin,
        buyPct,
        sellPct,
        deltaPct,
        movePct,
        absEffPct,
        askConsPct: this.norms.percentile('askDepthChange', bookWin.ask.consumed, 1),
        askReplPct: this.norms.percentile('askDepthChange', bookWin.ask.added, 1),
        askPullPct: this.norms.percentile('askDepthChange', bookWin.ask.cancelled, 1),
        bidConsPct: this.norms.percentile('bidDepthChange', bookWin.bid.consumed, 1),
        bidReplPct: this.norms.percentile('bidDepthChange', bookWin.bid.added, 1),
        bidPullPct: this.norms.percentile('bidDepthChange', bookWin.bid.cancelled, 1),
        repeatedAsk: this.book.repeatedAskReplenishment(),
        repeatedBid: this.book.repeatedBidReplenishment(),
        hasBook: this.hasBook,
        ticks: this.bookTicks,
      };
      const absorption = detectAbsorption(this.config, input);
      const effort = classifyEffort(this.config, input, absorption);
      const effClass = intensityFromPercentile(100 - Math.min(100, absEffPct));
      out[tf] = {
        tfMinutes: tf,
        aggression: aggressionSide(buyPct, sellPct, delta),
        executed: total,
        delta,
        priceMovePercent: movePctRaw,
        priceMoveAbs: rolled.close - rolled.open,
        efficiency: effClass,
        effort,
        absorption,
        metrics: efficiencyMetrics({
          buy: rolled.buy,
          sell: rolled.sell,
          priceStart: rolled.open,
          priceEnd: rolled.close,
          priceHigh: rolled.high,
          priceLow: rolled.low,
          atr: rolled.atr,
          classification: effClass,
        }),
      };
    }
    return out;
  }

  private observeClosed(bar: { buy: number; sell: number; open: number; close: number; time: number }): void {
    const tf = 1;
    this.norms.observe('aggressiveBuy', bar.buy, tf);
    this.norms.observe('aggressiveSell', bar.sell, tf);
    this.norms.observe('deltaAbs', Math.abs(bar.buy - bar.sell), tf);
    this.norms.observe('priceDisplacement', Math.abs(pctChange(bar.open, bar.close)), tf);
    const absEff = safeDiv(Math.abs(bar.close - bar.open), bar.buy + bar.sell);
    this.norms.observe('absEfficiency', absEff, tf);
    this.norms.observe('dirEfficiency', safeDiv(bar.close - bar.open, Math.abs(bar.buy - bar.sell)), tf);
  }
}

function windowToTf(windowMs: number): LiquidityTf {
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  const match = LIQUIDITY_TF_MINUTES.reduce((best, tf) =>
    Math.abs(tf - minutes) < Math.abs(best - minutes) ? tf : best,
  );
  return match;
}
