import { RollingDistribution } from '../core/rolling-stats.js';
import { safeDiv } from '../core/integrity.js';
import { CausalStructure, emptyStructure } from './structure.js';
import type {
  CvdDivergence,
  EffortVsResult,
  FeatureSnapshot,
  MarketBar,
  PercentileWindowId,
  StructureState,
} from './types.js';

const ATR_PERIOD = 14;
const CVD_SLOPE_BARS = 5;
const DIVERGENCE_BARS = 8;
const STACK_BARS = 3;

export function windowBars(id: PercentileWindowId, tfMinutes: number): number {
  if (id === '100') return 100;
  if (id === '500') return 500;
  if (id === '1000') return 1000;
  const perDay = Math.max(1, Math.floor((24 * 60) / tfMinutes));
  if (id === '1d') return perDay;
  if (id === '7d') return perDay * 7;
  return perDay * 30;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function rankThenAdd(dist: RollingDistribution, value: number): number {
  const rank = dist.size === 0 ? 50 : dist.percentileRank(value);
  dist.add(value);
  return rank;
}

/**
 * Sequential feature builder. Percentiles, CVD, ATR, and structure use only
 * bars already ingested — never the rest of the test dataset.
 */
export class FeatureBuilder {
  private readonly buyDist: RollingDistribution;
  private readonly sellDist: RollingDistribution;
  private readonly deltaDist: RollingDistribution;
  private readonly dispDist: RollingDistribution;
  private readonly absDist: RollingDistribution;
  private readonly structure = new CausalStructure();
  private readonly closed: MarketBar[] = [];
  private cvd = 0;
  private spotCvd = 0;
  private futuresCvd = 0;
  private atr = 0;
  private prevClose: number | null = null;
  private buyStreak = 0;
  private sellStreak = 0;
  private absorbBuyBars = 0;
  private absorbSellBars = 0;

  constructor(capacity: number) {
    const cap = Math.max(50, capacity);
    this.buyDist = new RollingDistribution(cap);
    this.sellDist = new RollingDistribution(cap);
    this.deltaDist = new RollingDistribution(cap);
    this.dispDist = new RollingDistribution(cap);
    this.absDist = new RollingDistribution(cap);
  }

  reset(): void {
    this.structure.reset();
    this.closed.length = 0;
    this.cvd = 0;
    this.spotCvd = 0;
    this.futuresCvd = 0;
    this.atr = 0;
    this.prevClose = null;
    this.buyStreak = 0;
    this.sellStreak = 0;
    this.absorbBuyBars = 0;
    this.absorbSellBars = 0;
  }

  push(bar: MarketBar): FeatureSnapshot {
    this.closed.push(bar);
    const buy = bar.aggressiveBuy;
    const sell = bar.aggressiveSell;
    const delta = buy - sell;
    const executed = buy + sell;
    const buyPct = bar.hasFootprint ? rankThenAdd(this.buyDist, buy) : 50;
    const sellPct = bar.hasFootprint ? rankThenAdd(this.sellDist, sell) : 50;
    const deltaPctile = bar.hasFootprint ? rankThenAdd(this.deltaDist, delta) : 50;
    this.cvd += delta;
    this.spotCvd += bar.spotBuy - bar.spotSell;
    this.futuresCvd += bar.futuresBuy - bar.futuresSell;

    const prev = this.prevClose ?? bar.open;
    const priceMovePct = prev === 0 ? 0 : ((bar.close - prev) / prev) * 100;
    const displacement = Math.abs(bar.close - bar.open);
    const dispPct = rankThenAdd(this.dispDist, displacement);
    this.updateAtr(bar);

    const upsideEff = efficiency(Math.max(0, bar.close - bar.open), buy);
    const downsideEff = efficiency(Math.max(0, bar.open - bar.close), sell);
    const priceEff = efficiency(displacement, executed);

    const impliedBidDefense = clamp(sellPct - (100 - dispPct) * (bar.close <= bar.open ? 1 : 0.3), 0, 100);
    const impliedAskDefense = clamp(buyPct - (100 - dispPct) * (bar.close >= bar.open ? 1 : 0.3), 0, 100);
    const impliedAskWd = clamp(dispPct - buyPct * 0.5, 0, 100);
    const impliedBidWd = clamp(dispPct - sellPct * 0.5, 0, 100);
    // Measured book behaviour always wins over the trade-derived proxy.
    const pl = bar.passive;
    const bidRepl = pl?.bidReplenishment ?? bar.bidReplenishment ?? impliedBidDefense;
    const askRepl = pl?.askReplenishment ?? bar.askReplenishment ?? impliedAskDefense;
    const askWd = pl?.askWithdrawal ?? bar.askWithdrawal ?? impliedAskWd;
    const bidWd = pl?.bidWithdrawal ?? bar.bidWithdrawal ?? impliedBidWd;

    const sellerAbs =
      bar.hasFootprint && sellPct >= 80 && dispPct <= 40 && priceMovePct >= -0.12 && bidRepl >= 55 ? 1 : 0;
    const buyerAbs =
      bar.hasFootprint && buyPct >= 80 && dispPct <= 40 && priceMovePct <= 0.12 && askRepl >= 55 ? 1 : 0;
    this.absorbSellBars = sellerAbs ? this.absorbSellBars + 1 : 0;
    this.absorbBuyBars = buyerAbs ? this.absorbBuyBars + 1 : 0;
    const absStrength = sellerAbs
      ? clamp((sellPct - 70 + (100 - dispPct) + bidRepl) / 3, 0, 100)
      : buyerAbs
        ? clamp((buyPct - 70 + (100 - dispPct) + askRepl) / 3, 0, 100)
        : 0;
    const absPct = rankThenAdd(this.absDist, absStrength);

    const upsideVacuum = bar.hasFootprint && askWd >= 60 && dispPct >= 50 && priceMovePct > 0.04 ? 1 : 0;
    const downsideVacuum = bar.hasFootprint && bidWd >= 60 && dispPct >= 50 && priceMovePct < -0.04 ? 1 : 0;

    const effort = classifyEffort(buy, sell, priceMovePct, dispPct, buyerAbs, sellerAbs);
    const structure = this.structure.ingestClosed(this.closed);
    const cvdSlope = this.slopeCvd();
    const cvdDivergence = this.divergence(structure);

    if (delta > 0) {
      this.buyStreak += 1;
      this.sellStreak = 0;
    } else if (delta < 0) {
      this.sellStreak += 1;
      this.buyStreak = 0;
    } else {
      this.buyStreak = 0;
      this.sellStreak = 0;
    }

    const poc = footprintPoc(bar);
    const avgTrade = safeDiv(executed, Math.max(1, bar.trades));
    const large = (bar.largestBuy + bar.largestSell);
    const whale = large >= avgTrade * 8 ? large : 0;
    const imbalance = safeDiv(delta, executed || 1);

    const spotDelta = bar.spotBuy - bar.spotSell;
    const futDelta = bar.futuresBuy - bar.futuresSell;
    const hasSpot = bar.spotBuy + bar.spotSell > 0;
    const hasFut = bar.futuresBuy + bar.futuresSell > 0;
    const spotLed = hasSpot && hasFut && Math.abs(spotDelta) > Math.abs(futDelta) * 1.25 && priceMovePct * spotDelta > 0 ? 1 : 0;
    const futuresLed = hasSpot && hasFut && Math.abs(futDelta) > Math.abs(spotDelta) * 1.25 && priceMovePct * futDelta > 0 ? 1 : 0;
    const broadBuying = spotDelta > 0 && futDelta > 0 && priceMovePct > 0 ? 1 : 0;
    const broadSelling = spotDelta < 0 && futDelta < 0 && priceMovePct < 0 ? 1 : 0;
    const levRally =
      priceMovePct > 0 && futDelta > 0 && Math.abs(spotDelta) < Math.abs(futDelta) * 0.4 && (bar.oiChange ?? 0) > 0 ? 1 : 0;
    const levSell =
      priceMovePct < 0 && futDelta < 0 && Math.abs(spotDelta) < Math.abs(futDelta) * 0.4 && (bar.oiChange ?? 0) > 0 ? 1 : 0;

    let quality = 40;
    if (bar.hasFootprint) quality += 40;
    if (hasSpot && hasFut) quality += 10;
    if (bar.hasBook) quality += 10;
    if (bar.oi != null) quality += 5;
    if (bar.funding != null) quality += 5;
    quality = clamp(quality, 0, 100);

    this.prevClose = bar.close;
    const logRet = prev > 0 ? Math.log(bar.close / prev) : 0;
    const realizedVol = Math.abs(logRet) * 100;

    return {
      timestamp: bar.time,
      barTime: bar.time,
      price: bar.close,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      aggressiveBuy: buy,
      aggressiveSell: sell,
      buyPercentile: buyPct,
      sellPercentile: sellPct,
      delta,
      deltaPercent: imbalance * 100,
      absDelta: Math.abs(delta),
      deltaPercentile: deltaPctile,
      cvd: this.cvd,
      cvdSlope,
      cvdDivergence,
      executedVolume: executed,
      tradeCount: bar.trades,
      avgTradeSize: avgTrade,
      largeTradeVolume: large,
      whaleTradeVolume: whale,
      buySellImbalance: imbalance,
      stackedBuyImbalance: this.buyStreak >= STACK_BARS ? this.buyStreak : 0,
      stackedSellImbalance: this.sellStreak >= STACK_BARS ? this.sellStreak : 0,
      footprintPoc: poc,
      spotDelta,
      spotCvd: this.spotCvd,
      spotCvdSlope: 0,
      futuresDelta: futDelta,
      futuresCvd: this.futuresCvd,
      askDepth: bar.askDepth ?? 0,
      bidDepth: bar.bidDepth ?? 0,
      askConsumption: buy,
      bidConsumption: sell,
      askReplenishment: askRepl,
      bidReplenishment: bidRepl,
      askWithdrawal: askWd,
      bidWithdrawal: bidWd,
      buyerAbsorption: buyerAbs,
      sellerAbsorption: sellerAbs,
      absorptionStrength: absStrength,
      absorbedVolume: sellerAbs ? sell : buyerAbs ? buy : 0,
      absorptionDuration: Math.max(this.absorbBuyBars, this.absorbSellBars),
      absorptionPercentile: absPct,
      priceMovePct,
      priceDisplacement: displacement,
      displacementPercentile: dispPct,
      upsideEfficiency: upsideEff,
      downsideEfficiency: downsideEff,
      priceEfficiency: priceEff,
      effortVsResult: effort,
      atr: this.atr,
      realizedVol,
      upsideVacuum,
      downsideVacuum,
      vacuumStrength: upsideVacuum || downsideVacuum ? clamp(dispPct * 0.6 + Math.max(askWd, bidWd) * 0.4, 0, 100) : 0,
      spotLed,
      futuresLed,
      broadBuying,
      broadSelling,
      leverageDrivenRally: levRally,
      leverageDrivenSelloff: levSell,
      oi: bar.oi ?? 0,
      oiChange: bar.oiChange ?? 0,
      funding: bar.funding ?? 0,
      longLiquidations: bar.longLiquidations ?? 0,
      shortLiquidations: bar.shortLiquidations ?? 0,
      nearBidDepth: pl?.nearBidDepth ?? 0,
      nearAskDepth: pl?.nearAskDepth ?? 0,
      weightedBidDepth: pl?.weightedBidDepth ?? 0,
      weightedAskDepth: pl?.weightedAskDepth ?? 0,
      nearBookImbalance: pl?.nearBookImbalance ?? 0,
      bidReplenishmentRatio: pl?.bidReplenishmentRatio ?? 0,
      askReplenishmentRatio: pl?.askReplenishmentRatio ?? 0,
      bidPersistence: pl?.bidPersistence ?? 0,
      askPersistence: pl?.askPersistence ?? 0,
      passiveBuyerStrength: pl?.passiveBuyerStrength ?? 0,
      passiveSellerStrength: pl?.passiveSellerStrength ?? 0,
      defendedBidTests: pl?.defendedBidTests ?? 0,
      defendedAskTests: pl?.defendedAskTests ?? 0,
      hasPassiveLiquidity: pl ? 1 : 0,
      volatility: realizedVol,
      structure,
      dataQuality: quality,
      hasFootprint: bar.hasFootprint,
      hasBook: bar.hasBook,
    };
  }

  private updateAtr(bar: MarketBar): void {
    const prev = this.prevClose ?? bar.open;
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev));
    if (this.atr === 0) this.atr = tr;
    else this.atr = (this.atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
  }

  private slopeCvd(): number {
    const n = this.closed.length;
    if (n < 2) return 0;
    const from = Math.max(0, n - CVD_SLOPE_BARS);
    let first = 0;
    let acc = 0;
    for (let i = from; i < n; i++) {
      const b = this.closed[i]!;
      const d = b.aggressiveBuy - b.aggressiveSell;
      if (i === from) first = this.cvd - d * (n - from - 1) - d;
      acc += d;
    }
    void first;
    return acc;
  }

  private divergence(structure: StructureState): CvdDivergence {
    const n = this.closed.length;
    if (n < DIVERGENCE_BARS) return 'NONE';
    const last = this.closed[n - 1]!;
    let minLow = Infinity;
    let maxHigh = -Infinity;
    let minLowI = n - 1;
    let maxHighI = n - 1;
    for (let i = n - DIVERGENCE_BARS; i < n; i++) {
      const b = this.closed[i]!;
      if (b.low <= minLow) {
        minLow = b.low;
        minLowI = i;
      }
      if (b.high >= maxHigh) {
        maxHigh = b.high;
        maxHighI = i;
      }
    }
    const lastDelta = last.aggressiveBuy - last.aggressiveSell;
    if (minLowI === n - 1 && lastDelta > 0 && structure.shift !== 'BEARISH_BOS') return 'BULLISH';
    if (maxHighI === n - 1 && lastDelta < 0 && structure.shift !== 'BULLISH_BOS') return 'BEARISH';
    return 'NONE';
  }
}

function efficiency(move: number, effort: number): number {
  if (effort <= 0) return 50;
  const raw = move / effort;
  return clamp(Math.log10(1 + raw * 1e6) * 20, 0, 100);
}

function footprintPoc(bar: MarketBar): number {
  let best = bar.close;
  let vol = -1;
  for (const lvl of bar.levels) {
    const v = lvl.buy + lvl.sell;
    if (v > vol) {
      vol = v;
      best = lvl.price;
    }
  }
  return best;
}

function classifyEffort(
  buy: number,
  sell: number,
  movePct: number,
  dispPct: number,
  buyerAbs: number,
  sellerAbs: number,
): EffortVsResult {
  const total = buy + sell;
  if (total <= 0) return 'INSUFFICIENT';
  if (buyerAbs) return 'BUYER_ABSORPTION';
  if (sellerAbs) return 'SELLER_ABSORPTION';
  const buyDom = buy >= sell * 1.25;
  const sellDom = sell >= buy * 1.25;
  if (buyDom && movePct > 0.05 && dispPct >= 55) return 'EFFICIENT_BUYING';
  if (sellDom && movePct < -0.05 && dispPct >= 55) return 'EFFICIENT_SELLING';
  if (buyDom) return 'INEFFICIENT_BUYING';
  if (sellDom) return 'INEFFICIENT_SELLING';
  return 'BALANCED';
}

export function metricValue(snap: FeatureSnapshot, metric: import('./types.js').MetricId): number {
  const s = snap.structure;
  switch (metric) {
    case 'price':
    case 'close':
      return snap.close;
    case 'open':
      return snap.open;
    case 'high':
      return snap.high;
    case 'low':
      return snap.low;
    case 'aggressiveBuy':
      return snap.aggressiveBuy;
    case 'aggressiveSell':
      return snap.aggressiveSell;
    case 'aggressiveBuyPercentile':
      return snap.buyPercentile;
    case 'aggressiveSellPercentile':
      return snap.sellPercentile;
    case 'delta':
      return snap.delta;
    case 'deltaPercent':
      return snap.deltaPercent;
    case 'absDelta':
      return snap.absDelta;
    case 'deltaPercentile':
      return snap.deltaPercentile;
    case 'cvd':
      return snap.cvd;
    case 'cvdSlope':
      return snap.cvdSlope;
    case 'cvdDivergence':
      return snap.cvdDivergence === 'BULLISH' ? 1 : snap.cvdDivergence === 'BEARISH' ? -1 : 0;
    case 'executedVolume':
      return snap.executedVolume;
    case 'tradeCount':
      return snap.tradeCount;
    case 'avgTradeSize':
      return snap.avgTradeSize;
    case 'largeTradeVolume':
      return snap.largeTradeVolume;
    case 'whaleTradeVolume':
      return snap.whaleTradeVolume;
    case 'buySellImbalance':
      return snap.buySellImbalance;
    case 'stackedBuyImbalance':
      return snap.stackedBuyImbalance;
    case 'stackedSellImbalance':
      return snap.stackedSellImbalance;
    case 'footprintPoc':
      return snap.footprintPoc;
    case 'spotAggressiveBuy':
      return snap.spotDelta > 0 ? snap.spotDelta : 0;
    case 'spotAggressiveSell':
      return snap.spotDelta < 0 ? -snap.spotDelta : 0;
    case 'spotDelta':
      return snap.spotDelta;
    case 'spotDeltaPercent':
      return snap.spotDelta;
    case 'spotCvd':
      return snap.spotCvd;
    case 'spotCvdSlope':
      return snap.spotCvdSlope;
    case 'spotVolume':
      return Math.abs(snap.spotDelta);
    case 'spotBuySellImbalance':
      return snap.spotDelta;
    case 'spotPriceEfficiency':
      return snap.priceEfficiency;
    case 'spotAbsorption':
      return snap.sellerAbsorption || snap.buyerAbsorption;
    case 'futuresAggressiveBuy':
      return snap.futuresDelta > 0 ? snap.futuresDelta : 0;
    case 'futuresAggressiveSell':
      return snap.futuresDelta < 0 ? -snap.futuresDelta : 0;
    case 'futuresDelta':
      return snap.futuresDelta;
    case 'futuresCvd':
      return snap.futuresCvd;
    case 'bidDepth':
      return snap.bidDepth;
    case 'askDepth':
      return snap.askDepth;
    case 'bidDepthPercentile':
      return snap.bidDepth;
    case 'askDepthPercentile':
      return snap.askDepth;
    case 'depthImbalance':
      return safeDiv(snap.bidDepth - snap.askDepth, snap.bidDepth + snap.askDepth || 1);
    case 'askConsumption':
      return snap.askConsumption;
    case 'bidConsumption':
      return snap.bidConsumption;
    case 'askConsumptionRatio':
      return safeDiv(snap.askConsumption, snap.askDepth || 1);
    case 'bidConsumptionRatio':
      return safeDiv(snap.bidConsumption, snap.bidDepth || 1);
    case 'askReplenishment':
      return snap.askReplenishment;
    case 'bidReplenishment':
      return snap.bidReplenishment;
    case 'askWithdrawal':
      return snap.askWithdrawal;
    case 'bidWithdrawal':
      return snap.bidWithdrawal;
    case 'buyerAbsorption':
      return snap.buyerAbsorption;
    case 'sellerAbsorption':
      return snap.sellerAbsorption;
    case 'absorptionStrength':
      return snap.absorptionStrength;
    case 'absorbedVolume':
      return snap.absorbedVolume;
    case 'absorptionDuration':
      return snap.absorptionDuration;
    case 'absorptionPercentile':
      return snap.absorptionPercentile;
    case 'priceMovePct':
      return snap.priceMovePct;
    case 'priceDisplacement':
      return snap.priceDisplacement;
    case 'displacementPercentile':
      return snap.displacementPercentile;
    case 'upsideEfficiency':
      return snap.upsideEfficiency;
    case 'downsideEfficiency':
      return snap.downsideEfficiency;
    case 'priceEfficiency':
      return snap.priceEfficiency;
    case 'atr':
      return snap.atr;
    case 'realizedVol':
      return snap.realizedVol;
    case 'upsideVacuum':
      return snap.upsideVacuum;
    case 'downsideVacuum':
      return snap.downsideVacuum;
    case 'vacuumStrength':
      return snap.vacuumStrength;
    case 'nearBidDepth':
      return snap.nearBidDepth;
    case 'nearAskDepth':
      return snap.nearAskDepth;
    case 'weightedBidDepth':
      return snap.weightedBidDepth;
    case 'weightedAskDepth':
      return snap.weightedAskDepth;
    case 'nearBookImbalance':
      return snap.nearBookImbalance;
    case 'bidReplenishmentRatio':
      return snap.bidReplenishmentRatio;
    case 'askReplenishmentRatio':
      return snap.askReplenishmentRatio;
    case 'bidPersistence':
      return snap.bidPersistence;
    case 'askPersistence':
      return snap.askPersistence;
    case 'passiveBuyerStrength':
      return snap.passiveBuyerStrength;
    case 'passiveSellerStrength':
      return snap.passiveSellerStrength;
    case 'defendedBidTests':
      return snap.defendedBidTests;
    case 'defendedAskTests':
      return snap.defendedAskTests;
    case 'hasPassiveLiquidity':
      return snap.hasPassiveLiquidity;
    case 'spotFuturesDeltaDiv':
      return snap.spotDelta - snap.futuresDelta;
    case 'spotLed':
      return snap.spotLed;
    case 'futuresLed':
      return snap.futuresLed;
    case 'broadBuying':
      return snap.broadBuying;
    case 'broadSelling':
      return snap.broadSelling;
    case 'leverageDrivenRally':
      return snap.leverageDrivenRally;
    case 'leverageDrivenSelloff':
      return snap.leverageDrivenSelloff;
    case 'swingHigh':
      return s.swingHigh ?? 0;
    case 'swingLow':
      return s.swingLow ?? 0;
    case 'higherHigh':
      return s.higherHigh ? 1 : 0;
    case 'higherLow':
      return s.higherLow ? 1 : 0;
    case 'lowerHigh':
      return s.lowerHigh ? 1 : 0;
    case 'lowerLow':
      return s.lowerLow ? 1 : 0;
    case 'bosBullish':
      return s.shift === 'BULLISH_BOS' ? 1 : 0;
    case 'bosBearish':
      return s.shift === 'BEARISH_BOS' ? 1 : 0;
    case 'chochBullish':
      return s.shift === 'BULLISH_CHOCH' ? 1 : 0;
    case 'chochBearish':
      return s.shift === 'BEARISH_CHOCH' ? 1 : 0;
    case 'distanceFromSupport':
      return distSupSafe(snap);
    case 'distanceFromResistance':
      return distResSafe(snap);
    case 'failedBreakout':
      return failed(snap);
    case 'dataQuality':
      return snap.dataQuality;
    case 'oi':
      return snap.oi;
    case 'oiChange':
      return snap.oiChange;
    case 'funding':
      return snap.funding;
    case 'longLiquidations':
      return snap.longLiquidations;
    case 'shortLiquidations':
      return snap.shortLiquidations;
    default:
      return 0;
  }
}

function distSupSafe(snap: FeatureSnapshot): number {
  const support = snap.structure.swingLow;
  if (support == null || snap.close === 0) return 0;
  return ((snap.close - support) / snap.close) * 100;
}

function distResSafe(snap: FeatureSnapshot): number {
  const resist = snap.structure.swingHigh;
  if (resist == null || snap.close === 0) return 0;
  return ((resist - snap.close) / snap.close) * 100;
}

function failed(snap: FeatureSnapshot): number {
  const shift = snap.structure.shift;
  if (shift === 'BULLISH_BOS' && snap.close < snap.open && snap.displacementPercentile <= 45) return 1;
  if (shift === 'BEARISH_BOS' && snap.close > snap.open && snap.displacementPercentile <= 45) return 1;
  return 0;
}

export { emptyStructure };
