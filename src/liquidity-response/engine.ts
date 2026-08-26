import { pctChange, safeDiv } from '../core/integrity.js';
import type { LiquidityResponseConfig } from '../config/types.js';
import type { LocalOrderBook } from '../liquidity/local-order-book.js';
import type { MarketTrade } from '../models/trade.js';
import type {
  LiquidityResponseSnapshot,
  LiquidityTf,
  LiquidityTfView,
} from '../models/liquidity-response.js';
import { LIQUIDITY_TF_MINUTES } from '../models/liquidity-response.js';
import { BookAccountant } from './book-accountant.js';
import {
  aggressionSide,
  classifyConfidence,
  classifyEffort,
  classifyState,
  detectAbsorption,
  detectReversal,
  detectVacuum,
  efficiencyMetrics,
  intensityFromPercentile,
  responseIntensity,
  whyFacts,
  type ClassifyInput,
} from './classify.js';
import { compareLiquidityMarkets, type OtherMarketContext } from './compare.js';
import { emptyLiquidityResponse } from './empty.js';
import { ImpactHorizonTracker } from './impact-horizons.js';
import { MinuteRing } from './minute-ring.js';
import { MetricNormalizer } from './normalizer.js';

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
}

export class LiquidityResponseEngine {
  readonly book: BookAccountant;
  readonly minutes: MinuteRing;
  readonly impact: ImpactHorizonTracker;
  readonly norms: MetricNormalizer;
  private lastTradePrice = 0;
  private lastTradeSide: 'BUY' | 'SELL' | undefined;
  private bookTicks = 0;
  private hasBook = false;
  private lastAsk: number | null = null;
  private lastBid: number | null = null;

  constructor(private readonly config: LiquidityResponseConfig) {
    this.book = new BookAccountant(config);
    this.minutes = new MinuteRing(config.minuteCapacity);
    this.impact = new ImpactHorizonTracker(config);
    this.norms = new MetricNormalizer(config.normWindows, config.defaultNormWindow);
  }

  onTrade(trade: MarketTrade, large = false): void {
    const nearAsk = this.lastAsk != null && trade.isAggressiveBuy && trade.price >= this.lastAsk * 0.9995;
    const nearBid = this.lastBid != null && trade.isAggressiveSell && trade.price <= this.lastBid * 1.0005;
    const closed = this.minutes.ingest(trade, { large, nearAsk, nearBid });
    if (closed) this.observeClosed(closed);
    this.impact.onTrade(trade.timestamp, trade.price, trade.quoteValue);
    this.lastTradePrice = trade.price;
    this.lastTradeSide = trade.side;
  }

  onBook(timestamp: number, book: LocalOrderBook, buyDelta: number, sellDelta: number): void {
    if (book.empty()) return;
    this.hasBook = true;
    this.bookTicks += 1;
    this.lastAsk = book.bestAsk()?.price ?? this.lastAsk;
    this.lastBid = book.bestBid()?.price ?? this.lastBid;
    this.book.observe(
      timestamp,
      book,
      Math.max(0, buyDelta),
      Math.max(0, sellDelta),
      this.lastTradePrice,
      this.lastTradeSide,
    );
    this.impact.onPrice(timestamp, book.mid() || this.lastTradePrice);
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
      spotConfirms: other ? other.snapshot.aggression === aggressionSide(buyPct, sellPct, delta) : null,
      futuresConfirms: other ? other.snapshot.aggression === aggressionSide(buyPct, sellPct, delta) : null,
    };

    const absorption = detectAbsorption(this.config, input);
    const vacuum = detectVacuum(this.config, input);
    const effort = classifyEffort(this.config, input, absorption);
    const state = classifyState(effort, absorption, vacuum, bookWin);
    const confidence = classifyConfidence(input, absorption, vacuum, effort);
    const askI = responseIntensity(askReplPct, askPullPct, askConsPct);
    const bidI = responseIntensity(bidReplPct, bidPullPct, bidConsPct);
    const effClass = intensityFromPercentile(100 - Math.min(100, absEffPct));
    const metrics = efficiencyMetrics({
      buy: flow.buy,
      sell: flow.sell,
      priceStart: flow.priceStart,
      priceEnd: flow.priceEnd,
      priceHigh: flow.priceHigh,
      priceLow: flow.priceLow,
      atr,
      classification: effClass,
    });

    const snap = emptyLiquidityResponse();
    snap.aggression = aggressionSide(buyPct, sellPct, delta);
    snap.executed = total;
    snap.delta = delta;
    snap.priceMovePercent = movePctRaw;
    snap.priceMoveAbs = flow.priceEnd - flow.priceStart;
    snap.efficiency = effClass;
    snap.askConsumption = askI.consumption;
    snap.askReplenishment = askI.replenishment;
    snap.askWithdrawal = askI.withdrawal;
    snap.bidConsumption = bidI.consumption;
    snap.bidReplenishment = bidI.replenishment;
    snap.bidWithdrawal = bidI.withdrawal;
    snap.askResponse = bookWin.ask.response;
    snap.bidResponse = bookWin.bid.response;
    snap.state = state;
    snap.confidence = confidence;
    snap.effort = effort;
    snap.absorption = absorption;
    snap.vacuum = vacuum;
    snap.impact = this.impact.snapshot(flow.now, flow.priceEnd);
    snap.bands = this.book.bandAccounting();
    snap.levels = this.book.levels(
      flow.now,
      absorption.kind === 'SELL_ABSORPTION' ? 'ask' : absorption.kind === 'BUY_ABSORPTION' ? 'bid' : null,
    );
    snap.reversal = detectReversal(this.config, input, absorption);
    snap.repeatedAskReplenishment = input.repeatedAsk;
    snap.repeatedBidReplenishment = input.repeatedBid;
    snap.norms = {
      aggressiveBuy: this.norms.stats('aggressiveBuy', flow.buy, tf),
      aggressiveSell: this.norms.stats('aggressiveSell', flow.sell, tf),
      delta: this.norms.stats('deltaAbs', Math.abs(delta), tf),
      priceDisplacement: this.norms.stats('priceDisplacement', Math.abs(movePctRaw), tf),
      askDepthChange: this.norms.stats('askDepthChange', bookWin.askDepthChange, 1),
    };
    snap.compare = compareLiquidityMarkets(snap, other);
    snap.why = whyFacts(input, absorption, snap.compare ? snap.compare.confirmed : null);
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
