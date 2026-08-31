"use strict";
(() => {
  // src/core/rolling-stats.ts
  var RollingDistribution = class {
    constructor(capacity) {
      this.capacity = capacity;
      this.values = new Float64Array(capacity);
      this.sorted = new Float64Array(capacity);
    }
    values;
    sorted;
    write = 0;
    filled = 0;
    dirty = true;
    cachedMean = 0;
    cachedStd = 0;
    get size() {
      return this.filled;
    }
    add(value) {
      this.values[this.write] = value;
      this.write = (this.write + 1) % this.capacity;
      if (this.filled < this.capacity) this.filled += 1;
      this.dirty = true;
    }
    mean() {
      this.refresh();
      return this.cachedMean;
    }
    std() {
      this.refresh();
      return this.cachedStd;
    }
    median() {
      return this.percentile(50);
    }
    percentile(p) {
      if (this.filled === 0) return 0;
      this.refresh();
      const clamped = Math.min(100, Math.max(0, p));
      const idx = clamped / 100 * (this.filled - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      const a = this.sorted[lo] ?? 0;
      const b = this.sorted[hi] ?? a;
      const w = idx - lo;
      return a * (1 - w) + b * w;
    }
    percentileRank(value) {
      if (this.filled === 0) return 50;
      this.refresh();
      let lo = 0;
      let hi = this.filled;
      while (lo < hi) {
        const mid = lo + hi >> 1;
        if ((this.sorted[mid] ?? 0) <= value) lo = mid + 1;
        else hi = mid;
      }
      return lo / this.filled * 100;
    }
    /**
     * Tie-aware percentile rank: the midpoint between the share of samples below
     * `value` and the share at or below it.
     *
     * `percentileRank` counts ties as "below", so a value of 0 measured against a
     * history that is mostly zeros comes back as the 100th percentile — reading as
     * an extreme when it is really the most ordinary value in the series. Order
     * book activity is full of legitimate zeros (no consumption this second, no
     * displacement this second), so anything classifying that activity needs the
     * midrank instead.
     */
    midRank(value) {
      if (this.filled === 0) return 50;
      this.refresh();
      const below = this.countBelow(value);
      const atOrBelow = this.countAtOrBelow(value);
      return (below + atOrBelow) / 2 / this.filled * 100;
    }
    countBelow(value) {
      let lo = 0;
      let hi = this.filled;
      while (lo < hi) {
        const mid = lo + hi >> 1;
        if ((this.sorted[mid] ?? 0) < value) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }
    countAtOrBelow(value) {
      let lo = 0;
      let hi = this.filled;
      while (lo < hi) {
        const mid = lo + hi >> 1;
        if ((this.sorted[mid] ?? 0) <= value) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }
    zScore(value, minStd) {
      const std = Math.max(this.std(), minStd);
      if (std === 0) return 0;
      return (value - this.mean()) / std;
    }
    ratioToMedian(value) {
      const med = this.median();
      if (med === 0) return value === 0 ? 1 : Number.POSITIVE_INFINITY;
      return value / med;
    }
    refresh() {
      if (!this.dirty || this.filled === 0) return;
      this.sorted.set(this.values.subarray(0, this.filled));
      this.sorted.subarray(0, this.filled).sort();
      let sum = 0;
      for (let i = 0; i < this.filled; i++) sum += this.values[i] ?? 0;
      this.cachedMean = sum / this.filled;
      let varSum = 0;
      for (let i = 0; i < this.filled; i++) {
        const d = (this.values[i] ?? 0) - this.cachedMean;
        varSum += d * d;
      }
      this.cachedStd = Math.sqrt(varSum / this.filled);
      this.dirty = false;
    }
  };

  // src/core/integrity.ts
  function safeDiv(num, den) {
    if (den === 0) return 0;
    return num / den;
  }

  // src/backtest/structure.ts
  var EMPTY = {
    swingHigh: null,
    swingLow: null,
    lastSwingHigh: null,
    lastSwingLow: null,
    higherHigh: false,
    higherLow: false,
    lowerHigh: false,
    lowerLow: false,
    bias: "NONE",
    shift: "NONE",
    swingHighTime: null,
    swingLowTime: null
  };
  var CausalStructure = class {
    highs = [];
    lows = [];
    bars = 0;
    last = { ...EMPTY };
    reset() {
      this.highs.length = 0;
      this.lows.length = 0;
      this.bars = 0;
      this.last = { ...EMPTY };
    }
    /**
     * Ingest a newly closed bar (index = bars processed so far).
     * Returns structure known at this close — no future bars.
     */
    push(bar, index, prevClose) {
      this.bars = index + 1;
      const confirmAt = index - 2;
      if (confirmAt >= 2) {
      }
      void bar;
      void prevClose;
      return this.last;
    }
    /**
     * Confirm pivots using bars[i-2] against neighbors i-4..i.
     * `window` is [bar i-4, i-3, i-2, i-1, i] when i >= 4.
     */
    ingestClosed(bars) {
      const n = bars.length;
      if (n < 5) {
        this.last = { ...EMPTY, shift: "NONE" };
        return this.last;
      }
      const i = n - 3;
      const c = bars[i];
      const a = bars[i - 2];
      const b = bars[i - 1];
      const d = bars[i + 1];
      const e = bars[i + 2];
      if (!c || !a || !b || !d || !e) return this.last;
      if (c.high >= a.high && c.high >= b.high && c.high >= d.high && c.high >= e.high) {
        const last = this.highs[this.highs.length - 1];
        if (!last || last.index !== i) this.highs.push({ index: i, time: c.time, price: c.high });
      }
      if (c.low <= a.low && c.low <= b.low && c.low <= d.low && c.low <= e.low) {
        const last = this.lows[this.lows.length - 1];
        if (!last || last.index !== i) this.lows.push({ index: i, time: c.time, price: c.low });
      }
      const sh = this.highs[this.highs.length - 1];
      const prevSh = this.highs[this.highs.length - 2];
      const sl = this.lows[this.lows.length - 1];
      const prevSl = this.lows[this.lows.length - 2];
      const lastBar = bars[n - 1];
      const higherHigh = Boolean(sh && prevSh && sh.price > prevSh.price);
      const lowerHigh = Boolean(sh && prevSh && sh.price < prevSh.price);
      const higherLow = Boolean(sl && prevSl && sl.price > prevSl.price);
      const lowerLow = Boolean(sl && prevSl && sl.price < prevSl.price);
      let bias = "NONE";
      if (higherHigh && higherLow) bias = "HH_HL";
      else if (lowerHigh && lowerLow) bias = "LH_LL";
      else if (higherHigh && lowerLow) bias = "HH_LL";
      else if (lowerHigh && higherLow) bias = "LH_HL";
      const shift = microShift(lastBar, sh?.price ?? null, sl?.price ?? null, bias);
      this.last = {
        swingHigh: sh?.price ?? null,
        swingLow: sl?.price ?? null,
        lastSwingHigh: prevSh?.price ?? null,
        lastSwingLow: prevSl?.price ?? null,
        higherHigh,
        higherLow,
        lowerHigh,
        lowerLow,
        bias,
        shift,
        swingHighTime: sh?.time ?? null,
        swingLowTime: sl?.time ?? null
      };
      return this.last;
    }
    snapshot() {
      return this.last;
    }
  };
  function microShift(last, swingHigh, swingLow, bias) {
    if (swingHigh != null && last.close > swingHigh) {
      return bias === "LH_LL" ? "BULLISH_CHOCH" : "BULLISH_BOS";
    }
    if (swingLow != null && last.close < swingLow) {
      return bias === "HH_HL" ? "BEARISH_CHOCH" : "BEARISH_BOS";
    }
    return "NONE";
  }

  // src/backtest/features.ts
  var ATR_PERIOD = 14;
  var CVD_SLOPE_BARS = 5;
  var DIVERGENCE_BARS = 8;
  var STACK_BARS = 3;
  function windowBars(id, tfMinutes) {
    if (id === "100") return 100;
    if (id === "500") return 500;
    if (id === "1000") return 1e3;
    const perDay = Math.max(1, Math.floor(24 * 60 / tfMinutes));
    if (id === "1d") return perDay;
    if (id === "7d") return perDay * 7;
    return perDay * 30;
  }
  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }
  function rankThenAdd(dist, value) {
    const rank = dist.size === 0 ? 50 : dist.percentileRank(value);
    dist.add(value);
    return rank;
  }
  var FeatureBuilder = class {
    buyDist;
    sellDist;
    deltaDist;
    dispDist;
    absDist;
    structure = new CausalStructure();
    closed = [];
    cvd = 0;
    spotCvd = 0;
    futuresCvd = 0;
    atr = 0;
    prevClose = null;
    buyStreak = 0;
    sellStreak = 0;
    absorbBuyBars = 0;
    absorbSellBars = 0;
    constructor(capacity) {
      const cap = Math.max(50, capacity);
      this.buyDist = new RollingDistribution(cap);
      this.sellDist = new RollingDistribution(cap);
      this.deltaDist = new RollingDistribution(cap);
      this.dispDist = new RollingDistribution(cap);
      this.absDist = new RollingDistribution(cap);
    }
    reset() {
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
    push(bar) {
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
      const priceMovePct = prev === 0 ? 0 : (bar.close - prev) / prev * 100;
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
      const pl = bar.passive;
      const bidRepl = pl?.bidReplenishment ?? bar.bidReplenishment ?? impliedBidDefense;
      const askRepl = pl?.askReplenishment ?? bar.askReplenishment ?? impliedAskDefense;
      const askWd = pl?.askWithdrawal ?? bar.askWithdrawal ?? impliedAskWd;
      const bidWd = pl?.bidWithdrawal ?? bar.bidWithdrawal ?? impliedBidWd;
      const sellerAbs = bar.hasFootprint && sellPct >= 80 && dispPct <= 40 && priceMovePct >= -0.12 && bidRepl >= 55 ? 1 : 0;
      const buyerAbs = bar.hasFootprint && buyPct >= 80 && dispPct <= 40 && priceMovePct <= 0.12 && askRepl >= 55 ? 1 : 0;
      this.absorbSellBars = sellerAbs ? this.absorbSellBars + 1 : 0;
      this.absorbBuyBars = buyerAbs ? this.absorbBuyBars + 1 : 0;
      const absStrength = sellerAbs ? clamp((sellPct - 70 + (100 - dispPct) + bidRepl) / 3, 0, 100) : buyerAbs ? clamp((buyPct - 70 + (100 - dispPct) + askRepl) / 3, 0, 100) : 0;
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
      const large = bar.largestBuy + bar.largestSell;
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
      const levRally = priceMovePct > 0 && futDelta > 0 && Math.abs(spotDelta) < Math.abs(futDelta) * 0.4 && (bar.oiChange ?? 0) > 0 ? 1 : 0;
      const levSell = priceMovePct < 0 && futDelta < 0 && Math.abs(spotDelta) < Math.abs(futDelta) * 0.4 && (bar.oiChange ?? 0) > 0 ? 1 : 0;
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
        hasBook: bar.hasBook
      };
    }
    updateAtr(bar) {
      const prev = this.prevClose ?? bar.open;
      const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev));
      if (this.atr === 0) this.atr = tr;
      else this.atr = (this.atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
    }
    slopeCvd() {
      const n = this.closed.length;
      if (n < 2) return 0;
      const from = Math.max(0, n - CVD_SLOPE_BARS);
      let first = 0;
      let acc = 0;
      for (let i = from; i < n; i++) {
        const b = this.closed[i];
        const d = b.aggressiveBuy - b.aggressiveSell;
        if (i === from) first = this.cvd - d * (n - from - 1) - d;
        acc += d;
      }
      void first;
      return acc;
    }
    divergence(structure) {
      const n = this.closed.length;
      if (n < DIVERGENCE_BARS) return "NONE";
      const last = this.closed[n - 1];
      let minLow = Infinity;
      let maxHigh = -Infinity;
      let minLowI = n - 1;
      let maxHighI = n - 1;
      for (let i = n - DIVERGENCE_BARS; i < n; i++) {
        const b = this.closed[i];
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
      if (minLowI === n - 1 && lastDelta > 0 && structure.shift !== "BEARISH_BOS") return "BULLISH";
      if (maxHighI === n - 1 && lastDelta < 0 && structure.shift !== "BULLISH_BOS") return "BEARISH";
      return "NONE";
    }
  };
  function efficiency(move, effort) {
    if (effort <= 0) return 50;
    const raw = move / effort;
    return clamp(Math.log10(1 + raw * 1e6) * 20, 0, 100);
  }
  function footprintPoc(bar) {
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
  function classifyEffort(buy, sell, movePct, dispPct, buyerAbs, sellerAbs) {
    const total = buy + sell;
    if (total <= 0) return "INSUFFICIENT";
    if (buyerAbs) return "BUYER_ABSORPTION";
    if (sellerAbs) return "SELLER_ABSORPTION";
    const buyDom = buy >= sell * 1.25;
    const sellDom = sell >= buy * 1.25;
    if (buyDom && movePct > 0.05 && dispPct >= 55) return "EFFICIENT_BUYING";
    if (sellDom && movePct < -0.05 && dispPct >= 55) return "EFFICIENT_SELLING";
    if (buyDom) return "INEFFICIENT_BUYING";
    if (sellDom) return "INEFFICIENT_SELLING";
    return "BALANCED";
  }
  function metricValue(snap, metric) {
    const s = snap.structure;
    switch (metric) {
      case "price":
      case "close":
        return snap.close;
      case "open":
        return snap.open;
      case "high":
        return snap.high;
      case "low":
        return snap.low;
      case "aggressiveBuy":
        return snap.aggressiveBuy;
      case "aggressiveSell":
        return snap.aggressiveSell;
      case "aggressiveBuyPercentile":
        return snap.buyPercentile;
      case "aggressiveSellPercentile":
        return snap.sellPercentile;
      case "delta":
        return snap.delta;
      case "deltaPercent":
        return snap.deltaPercent;
      case "absDelta":
        return snap.absDelta;
      case "deltaPercentile":
        return snap.deltaPercentile;
      case "cvd":
        return snap.cvd;
      case "cvdSlope":
        return snap.cvdSlope;
      case "cvdDivergence":
        return snap.cvdDivergence === "BULLISH" ? 1 : snap.cvdDivergence === "BEARISH" ? -1 : 0;
      case "executedVolume":
        return snap.executedVolume;
      case "tradeCount":
        return snap.tradeCount;
      case "avgTradeSize":
        return snap.avgTradeSize;
      case "largeTradeVolume":
        return snap.largeTradeVolume;
      case "whaleTradeVolume":
        return snap.whaleTradeVolume;
      case "buySellImbalance":
        return snap.buySellImbalance;
      case "stackedBuyImbalance":
        return snap.stackedBuyImbalance;
      case "stackedSellImbalance":
        return snap.stackedSellImbalance;
      case "footprintPoc":
        return snap.footprintPoc;
      case "spotAggressiveBuy":
        return snap.spotDelta > 0 ? snap.spotDelta : 0;
      case "spotAggressiveSell":
        return snap.spotDelta < 0 ? -snap.spotDelta : 0;
      case "spotDelta":
        return snap.spotDelta;
      case "spotDeltaPercent":
        return snap.spotDelta;
      case "spotCvd":
        return snap.spotCvd;
      case "spotCvdSlope":
        return snap.spotCvdSlope;
      case "spotVolume":
        return Math.abs(snap.spotDelta);
      case "spotBuySellImbalance":
        return snap.spotDelta;
      case "spotPriceEfficiency":
        return snap.priceEfficiency;
      case "spotAbsorption":
        return snap.sellerAbsorption || snap.buyerAbsorption;
      case "futuresAggressiveBuy":
        return snap.futuresDelta > 0 ? snap.futuresDelta : 0;
      case "futuresAggressiveSell":
        return snap.futuresDelta < 0 ? -snap.futuresDelta : 0;
      case "futuresDelta":
        return snap.futuresDelta;
      case "futuresCvd":
        return snap.futuresCvd;
      case "bidDepth":
        return snap.bidDepth;
      case "askDepth":
        return snap.askDepth;
      case "bidDepthPercentile":
        return snap.bidDepth;
      case "askDepthPercentile":
        return snap.askDepth;
      case "depthImbalance":
        return safeDiv(snap.bidDepth - snap.askDepth, snap.bidDepth + snap.askDepth || 1);
      case "askConsumption":
        return snap.askConsumption;
      case "bidConsumption":
        return snap.bidConsumption;
      case "askConsumptionRatio":
        return safeDiv(snap.askConsumption, snap.askDepth || 1);
      case "bidConsumptionRatio":
        return safeDiv(snap.bidConsumption, snap.bidDepth || 1);
      case "askReplenishment":
        return snap.askReplenishment;
      case "bidReplenishment":
        return snap.bidReplenishment;
      case "askWithdrawal":
        return snap.askWithdrawal;
      case "bidWithdrawal":
        return snap.bidWithdrawal;
      case "buyerAbsorption":
        return snap.buyerAbsorption;
      case "sellerAbsorption":
        return snap.sellerAbsorption;
      case "absorptionStrength":
        return snap.absorptionStrength;
      case "absorbedVolume":
        return snap.absorbedVolume;
      case "absorptionDuration":
        return snap.absorptionDuration;
      case "absorptionPercentile":
        return snap.absorptionPercentile;
      case "priceMovePct":
        return snap.priceMovePct;
      case "priceDisplacement":
        return snap.priceDisplacement;
      case "displacementPercentile":
        return snap.displacementPercentile;
      case "upsideEfficiency":
        return snap.upsideEfficiency;
      case "downsideEfficiency":
        return snap.downsideEfficiency;
      case "priceEfficiency":
        return snap.priceEfficiency;
      case "atr":
        return snap.atr;
      case "realizedVol":
        return snap.realizedVol;
      case "upsideVacuum":
        return snap.upsideVacuum;
      case "downsideVacuum":
        return snap.downsideVacuum;
      case "vacuumStrength":
        return snap.vacuumStrength;
      case "nearBidDepth":
        return snap.nearBidDepth;
      case "nearAskDepth":
        return snap.nearAskDepth;
      case "weightedBidDepth":
        return snap.weightedBidDepth;
      case "weightedAskDepth":
        return snap.weightedAskDepth;
      case "nearBookImbalance":
        return snap.nearBookImbalance;
      case "bidReplenishmentRatio":
        return snap.bidReplenishmentRatio;
      case "askReplenishmentRatio":
        return snap.askReplenishmentRatio;
      case "bidPersistence":
        return snap.bidPersistence;
      case "askPersistence":
        return snap.askPersistence;
      case "passiveBuyerStrength":
        return snap.passiveBuyerStrength;
      case "passiveSellerStrength":
        return snap.passiveSellerStrength;
      case "defendedBidTests":
        return snap.defendedBidTests;
      case "defendedAskTests":
        return snap.defendedAskTests;
      case "hasPassiveLiquidity":
        return snap.hasPassiveLiquidity;
      case "spotFuturesDeltaDiv":
        return snap.spotDelta - snap.futuresDelta;
      case "spotLed":
        return snap.spotLed;
      case "futuresLed":
        return snap.futuresLed;
      case "broadBuying":
        return snap.broadBuying;
      case "broadSelling":
        return snap.broadSelling;
      case "leverageDrivenRally":
        return snap.leverageDrivenRally;
      case "leverageDrivenSelloff":
        return snap.leverageDrivenSelloff;
      case "swingHigh":
        return s.swingHigh ?? 0;
      case "swingLow":
        return s.swingLow ?? 0;
      case "higherHigh":
        return s.higherHigh ? 1 : 0;
      case "higherLow":
        return s.higherLow ? 1 : 0;
      case "lowerHigh":
        return s.lowerHigh ? 1 : 0;
      case "lowerLow":
        return s.lowerLow ? 1 : 0;
      case "bosBullish":
        return s.shift === "BULLISH_BOS" ? 1 : 0;
      case "bosBearish":
        return s.shift === "BEARISH_BOS" ? 1 : 0;
      case "chochBullish":
        return s.shift === "BULLISH_CHOCH" ? 1 : 0;
      case "chochBearish":
        return s.shift === "BEARISH_CHOCH" ? 1 : 0;
      case "distanceFromSupport":
        return distSupSafe(snap);
      case "distanceFromResistance":
        return distResSafe(snap);
      case "failedBreakout":
        return failed(snap);
      case "dataQuality":
        return snap.dataQuality;
      case "oi":
        return snap.oi;
      case "oiChange":
        return snap.oiChange;
      case "funding":
        return snap.funding;
      case "longLiquidations":
        return snap.longLiquidations;
      case "shortLiquidations":
        return snap.shortLiquidations;
      default:
        return 0;
    }
  }
  function distSupSafe(snap) {
    const support = snap.structure.swingLow;
    if (support == null || snap.close === 0) return 0;
    return (snap.close - support) / snap.close * 100;
  }
  function distResSafe(snap) {
    const resist = snap.structure.swingHigh;
    if (resist == null || snap.close === 0) return 0;
    return (resist - snap.close) / snap.close * 100;
  }
  function failed(snap) {
    const shift = snap.structure.shift;
    if (shift === "BULLISH_BOS" && snap.close < snap.open && snap.displacementPercentile <= 45) return 1;
    if (shift === "BEARISH_BOS" && snap.close > snap.open && snap.displacementPercentile <= 45) return 1;
    return 0;
  }

  // src/backtest/conditions.ts
  function evalRule(node, history) {
    if (!node) return false;
    const snap = history[history.length - 1];
    if (!snap) return false;
    return evalNode(node, history, snap);
  }
  function evalNode(node, history, snap) {
    if (node.type === "group") return evalGroup(node, history, snap);
    return evalCond(node, history, snap);
  }
  function evalGroup(group, history, snap) {
    if (!group.children.length) {
      const ok2 = false;
      return group.not ? !ok2 : ok2;
    }
    let ok;
    if (group.bool === "AND") {
      ok = group.children.every((c) => evalNode(c, history, snap));
    } else {
      ok = group.children.some((c) => evalNode(c, history, snap));
    }
    return group.not ? !ok : ok;
  }
  function evalCond(cond, history, snap) {
    const curr = metricValue(snap, cond.metric);
    const prevSnap = history[history.length - 2];
    const prev = prevSnap ? metricValue(prevSnap, cond.metric) : curr;
    const thr = cond.value;
    switch (cond.op) {
      case ">":
        return curr > thr;
      case ">=":
        return curr >= thr;
      case "<":
        return curr < thr;
      case "<=":
        return curr <= thr;
      case "=":
        return nearly(curr, thr);
      case "!=":
        return !nearly(curr, thr);
      case "crosses_above":
        return prev < thr && curr >= thr;
      case "crosses_below":
        return prev > thr && curr <= thr;
      case "increases":
        return curr > prev;
      case "decreases":
        return curr < prev;
      case "turns_positive":
        return prev <= 0 && curr > 0;
      case "turns_negative":
        return prev >= 0 && curr < 0;
      case "percentile_above":
        return percentileOf(snap, cond.metric) >= thr;
      case "percentile_below":
        return percentileOf(snap, cond.metric) <= thr;
      case "changes_by_pct": {
        if (prev === 0) return false;
        return Math.abs((curr - prev) / prev) * 100 >= Math.abs(thr);
      }
      case "persists_for": {
        const n = Math.max(1, Math.floor(cond.persistBars ?? thr));
        if (history.length < n) return false;
        const inner = { ...cond, op: persistInnerOp(cond) };
        return history.slice(-n).every((s, i) => {
          const h = history.slice(0, history.length - n + i + 1);
          return evalCond({ ...inner, persistBars: void 0 }, h, s);
        });
      }
      default:
        return false;
    }
  }
  function persistInnerOp(cond) {
    if (cond.metric === "sellerAbsorption" || cond.metric === "buyerAbsorption") return ">=";
    if (cond.value === 0 && (cond.metric === "chochBullish" || cond.metric === "chochBearish")) return ">=";
    return cond.op === "persists_for" ? ">=" : cond.op;
  }
  function percentileOf(snap, metric) {
    if (metric === "aggressiveBuy" || metric === "aggressiveBuyPercentile") return snap.buyPercentile;
    if (metric === "aggressiveSell" || metric === "aggressiveSellPercentile") return snap.sellPercentile;
    if (metric === "delta" || metric === "deltaPercentile") return snap.deltaPercentile;
    if (metric === "priceDisplacement" || metric === "displacementPercentile") return snap.displacementPercentile;
    if (metric === "absorptionStrength" || metric === "absorptionPercentile") return snap.absorptionPercentile;
    if (metric === "bidReplenishment") return snap.bidReplenishment;
    if (metric === "askReplenishment") return snap.askReplenishment;
    if (metric === "bidWithdrawal") return snap.bidWithdrawal;
    if (metric === "askWithdrawal") return snap.askWithdrawal;
    if (metric === "downsideEfficiency") return snap.downsideEfficiency;
    if (metric === "upsideEfficiency") return snap.upsideEfficiency;
    if (metric === "priceEfficiency") return snap.priceEfficiency;
    if (metric === "passiveBuyerStrength") return snap.passiveBuyerStrength;
    if (metric === "passiveSellerStrength") return snap.passiveSellerStrength;
    if (metric === "bidPersistence") return snap.bidPersistence;
    if (metric === "askPersistence") return snap.askPersistence;
    return metricValue(snap, metric);
  }
  function nearly(a, b) {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  }

  // src/backtest/execution.ts
  function planEntry(strategy, snap, direction, barIndex, signalId) {
    const exec = strategy.execution;
    const risk = strategy.risk;
    const signalPrice = snap.close;
    const atr = Math.max(snap.atr, signalPrice * 5e-4);
    const stopDist = stopDistance(risk, snap, direction, atr, signalPrice);
    const stopPrice = direction === "LONG" ? signalPrice - stopDist : signalPrice + stopDist;
    const rr = risk.takeProfits[0]?.kind === "FIXED_RR" ? risk.takeProfits[0].value : 2;
    const targetPrice = direction === "LONG" ? signalPrice + stopDist * rr : signalPrice - stopDist * rr;
    const size = positionSize(risk, signalPrice, stopDist);
    let limitPrice = signalPrice;
    if (exec.orderType === "LIMIT") {
      if (exec.limitPrice != null) limitPrice = exec.limitPrice;
      else {
        const off = signalPrice * (exec.limitOffsetBps / 1e4);
        limitPrice = direction === "LONG" ? signalPrice - off : signalPrice + off;
      }
    }
    return {
      signalId,
      direction,
      type: exec.orderType === "STOP" ? "STOP" : exec.orderType,
      limitPrice,
      stopPrice,
      targetPrice,
      size,
      createdBar: barIndex,
      evidence: [],
      confidence: snap.absorptionStrength || snap.dataQuality,
      snapshot: snap
    };
  }
  function tryFill(order, bar, exec) {
    if (order.type === "MARKET") {
      const slip = bar.open * (exec.slippageBps / 1e4);
      const price = order.direction === "LONG" ? bar.open + slip : bar.open - slip;
      return { price, slippage: slip * order.size };
    }
    if (order.type === "STOP") {
      if (order.direction === "LONG" && bar.high >= order.limitPrice) {
        return fillAt(order.limitPrice, exec, order, "taker");
      }
      if (order.direction === "SHORT" && bar.low <= order.limitPrice) {
        return fillAt(order.limitPrice, exec, order, "taker");
      }
      return null;
    }
    return tryLimitFill(order, bar, exec.fillModel, exec);
  }
  function fillAt(price, exec, order, _kind) {
    const slip = price * (exec.slippageBps / 1e4) * (exec.fillModel === "OPTIMISTIC" ? 0 : 0.5);
    const adj = order.direction === "LONG" ? price + slip : price - slip;
    return { price: adj, slippage: slip * order.size };
  }
  function tryLimitFill(order, bar, model, exec) {
    const px = order.limitPrice;
    const thru = exec.conservativeBps / 1e4;
    if (order.direction === "LONG") {
      if (model === "OPTIMISTIC" && bar.low <= px) return fillAt(px, exec, order, "maker");
      if (model === "REALISTIC") {
        const tradedThrough = bar.low < px;
        const volAtLevel = volumeNear(bar, px);
        if (tradedThrough || volAtLevel >= order.size * px * 0.25) return fillAt(px, exec, order, "maker");
        return null;
      }
      if (bar.low <= px * (1 - thru)) return fillAt(px, exec, order, "maker");
      return null;
    }
    if (model === "OPTIMISTIC" && bar.high >= px) return fillAt(px, exec, order, "maker");
    if (model === "REALISTIC") {
      const tradedThrough = bar.high > px;
      const volAtLevel = volumeNear(bar, px);
      if (tradedThrough || volAtLevel >= order.size * px * 0.25) return fillAt(px, exec, order, "maker");
      return null;
    }
    if (bar.high >= px * (1 + thru)) return fillAt(px, exec, order, "maker");
    return null;
  }
  function volumeNear(bar, price) {
    let v = 0;
    const tol = price * 5e-4;
    for (const lvl of bar.levels) {
      if (Math.abs(lvl.price - price) <= tol) v += lvl.buy + lvl.sell;
    }
    if (v > 0) return v;
    return bar.aggressiveBuy + bar.aggressiveSell;
  }
  function managePosition(pos, bar, risk, exec) {
    const t = pos.trade;
    const long = t.direction === "LONG";
    updateExcursion(t, bar);
    if (long && bar.low <= t.stopPrice && bar.high >= t.targetPrice) {
      return { closed: true, exitPrice: t.stopPrice, reason: "STOP" };
    }
    if (!long && bar.high >= t.stopPrice && bar.low <= t.targetPrice) {
      return { closed: true, exitPrice: t.stopPrice, reason: "STOP" };
    }
    if (long && bar.low <= t.stopPrice) return { closed: true, exitPrice: t.stopPrice, reason: "STOP" };
    if (!long && bar.high >= t.stopPrice) return { closed: true, exitPrice: t.stopPrice, reason: "STOP" };
    if (long && bar.high >= t.targetPrice) return { closed: true, exitPrice: t.targetPrice, reason: "TARGET" };
    if (!long && bar.low <= t.targetPrice) return { closed: true, exitPrice: t.targetPrice, reason: "TARGET" };
    if (risk.timeStopBars && t.durationBars + 1 >= risk.timeStopBars) {
      return { closed: true, exitPrice: bar.close, reason: "TIME" };
    }
    if (risk.stopKind === "TRAILING") {
      const trail = Math.max(t.stopPrice * 5e-4, t.entryPrice * risk.stopValue / 100);
      if (long) {
        pos.trailStop = Math.max(pos.trailStop, bar.close - trail);
        if (bar.low <= pos.trailStop) return { closed: true, exitPrice: pos.trailStop, reason: "TRAIL" };
      } else {
        pos.trailStop = Math.min(pos.trailStop, bar.close + trail);
        if (bar.high >= pos.trailStop) return { closed: true, exitPrice: pos.trailStop, reason: "TRAIL" };
      }
    }
    void exec;
    return { closed: false };
  }
  function updateExcursion(trade, bar) {
    const long = trade.direction === "LONG";
    const best = long ? bar.high : bar.low;
    const worst = long ? bar.low : bar.high;
    const mfe = long ? best - trade.entryPrice : trade.entryPrice - best;
    const mae = long ? trade.entryPrice - worst : worst - trade.entryPrice;
    if (mfe > trade.mfe) trade.mfe = mfe;
    if (mae > trade.mae) trade.mae = mae;
    trade.mfePct = trade.entryPrice ? trade.mfe / trade.entryPrice * 100 : 0;
    trade.maePct = trade.entryPrice ? trade.mae / trade.entryPrice * 100 : 0;
    trade.durationBars += 1;
  }
  function stopDistance(risk, snap, direction, atr, price) {
    switch (risk.stopKind) {
      case "FIXED_PCT":
        return price * (risk.stopValue / 100);
      case "ATR":
        return atr * risk.stopValue;
      case "SWING":
      case "STRUCTURE": {
        const lvl = direction === "LONG" ? snap.structure.swingLow : snap.structure.swingHigh;
        if (lvl == null) return atr * 1.5;
        return Math.max(Math.abs(price - lvl), atr * 0.5);
      }
      case "LIQUIDITY":
      case "ABSORPTION":
        return atr * Math.max(1, risk.stopValue);
      case "TRAILING":
        return price * (risk.stopValue / 100);
      case "TIME":
        return atr * 1.5;
      default:
        return atr * 1.5;
    }
  }
  function positionSize(risk, price, stopDist) {
    if (price <= 0) return 0;
    switch (risk.sizing) {
      case "FIXED_QTY":
        return risk.fixedQty;
      case "FIXED_DOLLAR":
        return risk.fixedDollar / price;
      case "PCT_EQUITY":
        return risk.accountEquity * (risk.riskPct / 100) / price;
      case "RISK": {
        const loss = risk.accountEquity * (risk.riskPct / 100);
        if (stopDist <= 0) return 0;
        return loss / stopDist;
      }
      default:
        return risk.fixedDollar / price;
    }
  }
  function applyPnl(trade, exitPrice, exec, maker) {
    const long = trade.direction === "LONG";
    const raw = long ? (exitPrice - trade.entryPrice) * trade.size : (trade.entryPrice - exitPrice) * trade.size;
    const feeBps = maker ? exec.makerFeeBps : exec.takerFeeBps;
    const exitFee = exitPrice * trade.size * (feeBps / 1e4);
    const entryFee = trade.entryPrice * trade.size * (feeBps / 1e4);
    trade.fees = entryFee + exitFee;
    trade.pnl = raw - trade.fees - trade.slippage;
    trade.pnlPct = trade.entryPrice ? (long ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice) / trade.entryPrice * 100 : 0;
    const stopDist = Math.abs(trade.entryPrice - trade.stopPrice);
    trade.r = stopDist > 0 ? (long ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice) / stopDist : 0;
    trade.exitPrice = exitPrice;
    trade.open = false;
  }

  // src/backtest/types.ts
  var FORWARD_HORIZONS_MIN = [1, 5, 15, 30, 60, 240, 720, 1440];

  // src/backtest/stats.ts
  var MIN_SAMPLE = 20;
  function summarizeTrades(trades, equity0, equity) {
    const closed = trades.filter((t) => !t.open && t.exitPrice != null);
    const pnls = closed.map((t) => t.pnl);
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl <= 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLossAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const net = pnls.reduce((s, n) => s + n, 0);
    const rs = closed.map((t) => t.r).sort((a, b) => a - b);
    const maxDd = equity.reduce((m, p) => Math.max(m, p.drawdownPct), 0);
    const rets = barReturns(equity);
    const sharpe = ratio(rets, 0);
    const sortino = ratio(rets, 0, true);
    const calmar = maxDd > 0 ? net / Math.max(equity0, 1) * 100 / maxDd : 0;
    return {
      netPnl: net,
      grossPnl: grossWin,
      returnPct: equity0 > 0 ? net / equity0 * 100 : 0,
      totalTrades: closed.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: closed.length ? wins.length / closed.length * 100 : 0,
      profitFactor: grossLossAbs > 0 ? grossWin / grossLossAbs : grossWin > 0 ? 99 : 0,
      expectancy: closed.length ? net / closed.length : 0,
      averageWin: wins.length ? grossWin / wins.length : 0,
      averageLoss: losses.length ? -grossLossAbs / losses.length : 0,
      largestWin: wins.reduce((m, t) => Math.max(m, t.pnl), 0),
      largestLoss: losses.reduce((m, t) => Math.min(m, t.pnl), 0),
      maxDrawdown: maxDd * (equity0 / 100),
      maxDrawdownPct: maxDd,
      sharpe,
      sortino,
      calmar,
      averageR: rs.length ? rs.reduce((s, n) => s + n, 0) / rs.length : 0,
      medianR: rs.length ? percentile(rs, 50) : 0,
      maxConsecWins: streak(closed, true),
      maxConsecLosses: streak(closed, false),
      feesPaid: closed.reduce((s, t) => s + t.fees, 0),
      estimatedSlippage: closed.reduce((s, t) => s + t.slippage, 0),
      sampleSize: closed.length,
      insufficientSample: closed.length < MIN_SAMPLE
    };
  }
  function equityCurve(trades, startEquity, bars) {
    const byTime = /* @__PURE__ */ new Map();
    for (const t of trades) {
      if (t.exitTime == null) continue;
      byTime.set(t.exitTime, (byTime.get(t.exitTime) ?? 0) + t.pnl);
    }
    let eq = startEquity;
    let peak = startEquity;
    const out = [];
    for (const bar of bars) {
      eq += byTime.get(bar.time) ?? 0;
      peak = Math.max(peak, eq);
      const dd = peak > 0 ? (peak - eq) / peak * 100 : 0;
      out.push({ time: bar.time, equity: eq, drawdownPct: dd });
    }
    return out;
  }
  function bySignalType(trades, signals) {
    const keys = /* @__PURE__ */ new Map();
    for (const t of trades) {
      const sig = signals.find((s) => s.id === t.signalId);
      const kind = sig?.kind.startsWith("LONG") || sig?.kind.startsWith("SHORT") ? contextLabel(sig) : t.strategy;
      const arr = keys.get(kind) ?? [];
      arr.push(t);
      keys.set(kind, arr);
    }
    return [...keys.entries()].map(([kind, list]) => {
      const closed = list.filter((t) => !t.open);
      const wins = closed.filter((t) => t.pnl > 0).length;
      return {
        kind,
        trades: closed.length,
        winRate: closed.length ? wins / closed.length * 100 : 0,
        avgR: closed.length ? closed.reduce((s, t) => s + t.r, 0) / closed.length : 0,
        netPnl: closed.reduce((s, t) => s + t.pnl, 0)
      };
    });
  }
  function contextLabel(sig) {
    const abs = sig.snapshot.sellerAbsorption ? "Seller Absorption" : sig.snapshot.buyerAbsorption ? "Buyer Absorption" : null;
    if (abs) return abs;
    if (sig.snapshot.upsideVacuum || sig.snapshot.downsideVacuum) return "Liquidity Vacuum";
    if (sig.snapshot.spotLed) return "Spot-led";
    if (sig.snapshot.futuresLed) return "Futures-led";
    return sig.strategy;
  }
  function attachForwardReturns(signals, bars, tfMinutes) {
    const times = bars.map((b) => b.time);
    const closes = bars.map((b) => b.close);
    for (const sig of signals) {
      const i = times.findIndex((t) => t === sig.barTime);
      const px = i >= 0 ? closes[i] : void 0;
      const out = {};
      for (const h of FORWARD_HORIZONS_MIN) {
        const key = horizonKey(h);
        if (px == null || i < 0) {
          out[key] = null;
          continue;
        }
        const need = Math.max(1, Math.round(h / tfMinutes));
        const j = i + need;
        const later = closes[j];
        out[key] = later == null ? null : (later - px) / px * 100;
      }
      sig.forwardReturns = out;
    }
  }
  function horizonKey(min) {
    if (min < 60) return `${min}m`;
    if (min < 1440) return `${min / 60}h`;
    return `${min / 1440}d`;
  }
  function streak(trades, win) {
    let best = 0;
    let cur = 0;
    for (const t of trades) {
      const ok = t.pnl > 0;
      if (ok === win) {
        cur += 1;
        best = Math.max(best, cur);
      } else cur = 0;
    }
    return best;
  }
  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = p / 100 * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const a = sorted[lo] ?? 0;
    const b = sorted[hi] ?? a;
    return a + (b - a) * (idx - lo);
  }
  function barReturns(equity) {
    const out = [];
    for (let i = 1; i < equity.length; i++) {
      const prev = equity[i - 1].equity;
      const cur = equity[i].equity;
      if (prev > 0) out.push((cur - prev) / prev);
    }
    return out;
  }
  function ratio(rets, rf, downside = false) {
    const sample = downside ? rets.filter((r) => r < rf) : rets;
    if (sample.length < 2) return 0;
    const mean = rets.reduce((s, n) => s + n, 0) / rets.length - rf;
    const varSum = sample.reduce((s, n) => s + (n - mean) * (n - mean), 0);
    const std = Math.sqrt(varSum / sample.length);
    if (std === 0) return 0;
    return mean / std * Math.sqrt(365);
  }

  // src/backtest/engine.ts
  var seq = 1;
  function nid(prefix) {
    seq += 1;
    return `${prefix}_${seq}`;
  }
  var MicrostructureBacktestEngine = class {
    run(bars, strategy, coverage, config, onProgress) {
      const t0 = Date.now();
      const mode = config.mode;
      const builder = new FeatureBuilder(windowBars(config.percentileWindow, config.tfMinutes));
      const snapshots = [];
      const signals = [];
      const trades = [];
      const pending = [];
      let position = null;
      let longArmed = false;
      let shortArmed = false;
      const equity0 = strategy.risk.accountEquity;
      const signalFrom = config.signalFromSec ?? bars[0]?.time ?? 0;
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        if (position) {
          const m = managePosition(position, bar, strategy.risk, strategy.execution);
          if (m.closed && m.exitPrice != null) {
            closeTrade(position.trade, bar, m.exitPrice, m.reason ?? "EXIT", strategy, signals, snapAt(snapshots, i));
            position = null;
          }
        }
        for (let p = pending.length - 1; p >= 0; p--) {
          const order = pending[p];
          if (i <= order.createdBar) continue;
          if (position) {
            pending.splice(p, 1);
            continue;
          }
          const fill = tryFill(order, bar, strategy.execution);
          if (!fill) continue;
          const trade = openTrade(order, bar, fill.price, fill.slippage, strategy);
          trades.push(trade);
          position = { trade, remainPct: 1, trailStop: trade.stopPrice };
          pending.splice(p, 1);
          longArmed = false;
          shortArmed = false;
          const sameBar = managePosition(position, bar, strategy.risk, strategy.execution);
          if (sameBar.closed && sameBar.exitPrice != null) {
            closeTrade(trade, bar, sameBar.exitPrice, sameBar.reason ?? "EXIT", strategy, signals, snapAt(snapshots, i));
            position = null;
          }
        }
        const snap = builder.push(bar);
        snapshots.push(snap);
        if (snap.dataQuality < config.minDataQuality) {
          if (onProgress && i % 250 === 0) onProgress({ eventsProcessed: i + 1, tradesFound: trades.length, pct: i / bars.length * 100 });
          continue;
        }
        const hist = snapshots;
        const allowTrade = bar.time >= signalFrom;
        if (snap.sellerAbsorption || snap.buyerAbsorption) {
          pushSignal(signals, strategy, snap, snap.sellerAbsorption ? "ABSORPTION" : "ABSORPTION", evidenceFrom(snap), false);
        }
        if (snap.upsideVacuum || snap.downsideVacuum) {
          pushSignal(signals, strategy, snap, "LIQUIDITY_VACUUM", evidenceFrom(snap), false);
        }
        if (snap.leverageDrivenRally) {
          pushSignal(signals, strategy, snap, "LEVERAGE_DRIVEN_RALLY", evidenceFrom(snap), false);
        }
        if (snap.leverageDrivenSelloff) {
          pushSignal(signals, strategy, snap, "LEVERAGE_DRIVEN_SELLOFF", evidenceFrom(snap), false);
        }
        if (strategy.context && evalRule(strategy.context, hist)) {
          pushSignal(signals, strategy, snap, "CONTEXT", evidenceFrom(snap), false);
        }
        if (allowTrade && !position) {
          if (strategy.longSetup && evalRule(strategy.longSetup, hist)) {
            longArmed = true;
            pushSignal(signals, strategy, snap, "LONG_SETUP", evidenceFrom(snap), false);
          }
          if (strategy.shortSetup && evalRule(strategy.shortSetup, hist)) {
            shortArmed = true;
            pushSignal(signals, strategy, snap, "SHORT_SETUP", evidenceFrom(snap), false);
          }
          const longOk = strategy.longEntry && evalRule(strategy.longEntry, hist) && (strategy.longSetup ? longArmed : true);
          const shortOk = strategy.shortEntry && evalRule(strategy.shortEntry, hist) && (strategy.shortSetup ? shortArmed : true);
          if (longOk) {
            const sig = pushSignal(signals, strategy, snap, "LONG_ENTRY", evidenceFrom(snap), true);
            pending.push(planEntry(strategy, snap, "LONG", i, sig.id));
          } else if (shortOk) {
            const sig = pushSignal(signals, strategy, snap, "SHORT_ENTRY", evidenceFrom(snap), true);
            pending.push(planEntry(strategy, snap, "SHORT", i, sig.id));
          }
        }
        if (onProgress && (i % 200 === 0 || i === bars.length - 1)) {
          onProgress({ eventsProcessed: i + 1, tradesFound: trades.length, pct: (i + 1) / bars.length * 100 });
        }
      }
      if (position) {
        const last = bars[bars.length - 1];
        closeTrade(position.trade, last, last.close, "EOD", strategy, signals, snapshots[snapshots.length - 1]);
      }
      attachForwardReturns(signals, bars, config.tfMinutes);
      const equity = equityCurve(trades, equity0, bars);
      const stats = summarizeTrades(trades, equity0, equity);
      let walkForward;
      if (mode === "WALK_FORWARD" && config.isFromSec != null && config.isToSec != null && config.oosFromSec != null) {
        const isTrades = trades.filter((t) => t.entryTime >= config.isFromSec && t.entryTime <= config.isToSec);
        const oosTrades = trades.filter((t) => t.entryTime >= config.oosFromSec);
        const isEq = equityCurve(isTrades, equity0, bars.filter((b) => b.time >= config.isFromSec && b.time <= config.isToSec));
        const oosEq = equityCurve(oosTrades, equity0, bars.filter((b) => b.time >= config.oosFromSec));
        const is = summarizeTrades(isTrades, equity0, isEq);
        const oos = summarizeTrades(oosTrades, equity0, oosEq);
        walkForward = {
          is,
          oos,
          overfitting: is.profitFactor > 1.4 && oos.profitFactor < 0.9 && oos.totalTrades >= 8
        };
      }
      return {
        mode,
        strategy,
        coverage,
        stats,
        bySignalType: bySignalType(trades, signals),
        trades,
        signals,
        equity,
        snapshots: snapshots.length > 8e3 ? snapshots.filter((_, i) => i % 4 === 0) : snapshots,
        walkForward,
        elapsedMs: Date.now() - t0,
        eventsProcessed: bars.length
      };
    }
  };
  function openTrade(order, bar, price, slippage, strategy) {
    return {
      id: nid("t"),
      signalId: order.signalId,
      strategy: strategy.name,
      strategyVersion: strategy.version,
      direction: order.direction,
      entryTime: bar.time,
      entryPrice: price,
      exitTime: null,
      exitPrice: null,
      stopPrice: order.stopPrice,
      targetPrice: order.targetPrice,
      size: order.size,
      pnl: 0,
      pnlPct: 0,
      r: 0,
      mae: 0,
      mfe: 0,
      maePct: 0,
      mfePct: 0,
      fees: 0,
      slippage,
      durationBars: 0,
      confidence: order.confidence,
      exitReason: null,
      evidence: evidenceFrom(order.snapshot),
      open: true
    };
  }
  function closeTrade(trade, bar, exitPrice, reason, strategy, signals, fallback) {
    const maker = strategy.execution.orderType === "LIMIT";
    applyPnl(trade, exitPrice, strategy.execution, maker);
    trade.exitTime = bar.time;
    trade.exitReason = reason;
    const kind = reason === "STOP" ? trade.direction === "LONG" ? "LONG_STOP" : "SHORT_STOP" : trade.direction === "LONG" ? "LONG_EXIT" : "SHORT_EXIT";
    const snapshot = signals.find((s) => s.id === trade.signalId)?.snapshot ?? fallback;
    if (!snapshot) return;
    signals.push({
      id: nid("x"),
      kind,
      strategy: strategy.name,
      strategyVersion: strategy.version,
      timestamp: bar.time,
      barTime: bar.time,
      price: exitPrice,
      score: trade.confidence,
      confidence: trade.confidence,
      snapshot,
      evidence: trade.evidence,
      traded: true,
      forwardReturns: {}
    });
  }
  function snapAt(snapshots, i) {
    return snapshots[Math.min(i, snapshots.length - 1)] ?? snapshots[snapshots.length - 1];
  }
  function pushSignal(signals, strategy, snap, kind, evidence, traded) {
    const last = signals[signals.length - 1];
    if (last && last.kind === kind && last.barTime === snap.barTime) return last;
    const sig = {
      id: nid("s"),
      kind,
      strategy: strategy.name,
      strategyVersion: strategy.version,
      timestamp: snap.timestamp,
      barTime: snap.barTime,
      price: snap.price,
      score: snap.absorptionStrength || snap.dataQuality,
      confidence: snap.dataQuality,
      snapshot: snap,
      evidence,
      traded,
      forwardReturns: {}
    };
    signals.push(sig);
    return sig;
  }
  function evidenceFrom(snap) {
    return [
      { label: "Aggressive buy", value: fmtUsd(snap.aggressiveBuy), percentile: snap.buyPercentile },
      { label: "Aggressive sell", value: fmtUsd(snap.aggressiveSell), percentile: snap.sellPercentile },
      { label: "Delta", value: fmtUsd(snap.delta), percentile: snap.deltaPercentile },
      { label: "CVD", value: fmtUsd(snap.cvd) },
      { label: "Bid replenishment", value: snap.bidReplenishment.toFixed(1) },
      { label: "Ask replenishment", value: snap.askReplenishment.toFixed(1) },
      { label: "Bid withdrawal", value: snap.bidWithdrawal.toFixed(1) },
      { label: "Ask withdrawal", value: snap.askWithdrawal.toFixed(1) },
      { label: "Seller absorption", value: snap.sellerAbsorption ? "TRUE" : "false", percentile: snap.absorptionPercentile },
      { label: "Buyer absorption", value: snap.buyerAbsorption ? "TRUE" : "false" },
      { label: "Downside efficiency", value: snap.downsideEfficiency.toFixed(1) },
      { label: "Upside efficiency", value: snap.upsideEfficiency.toFixed(1) },
      { label: "Spot delta", value: fmtUsd(snap.spotDelta) },
      { label: "Futures delta", value: fmtUsd(snap.futuresDelta) },
      { label: "OI change", value: `${snap.oiChange.toFixed(2)}%` },
      { label: "Structure", value: snap.structure.shift.replace(/_/g, " ") },
      { label: "Data quality", value: String(Math.round(snap.dataQuality)) }
    ];
  }
  function fmtUsd(n) {
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}k`;
    return `${sign}$${abs.toFixed(0)}`;
  }

  // src/backtest/signal-study.ts
  var STUDY_PRESETS = [
    { id: "seller_abs", label: "Seller Absorption", condition: { type: "cond", metric: "sellerAbsorption", op: ">=", value: 1 }, bias: "UP" },
    { id: "buyer_abs", label: "Buyer Absorption", condition: { type: "cond", metric: "buyerAbsorption", op: ">=", value: 1 }, bias: "DOWN" },
    { id: "up_vac", label: "Upside Liquidity Vacuum", condition: { type: "cond", metric: "upsideVacuum", op: ">=", value: 1 }, bias: "UP" },
    { id: "down_vac", label: "Downside Liquidity Vacuum", condition: { type: "cond", metric: "downsideVacuum", op: ">=", value: 1 }, bias: "DOWN" },
    { id: "choch_bull", label: "Bullish micro CHoCH", condition: { type: "cond", metric: "chochBullish", op: "=", value: 1 }, bias: "UP" },
    { id: "choch_bear", label: "Bearish micro CHoCH", condition: { type: "cond", metric: "chochBearish", op: "=", value: 1 }, bias: "DOWN" },
    { id: "cvd_div", label: "CVD bullish divergence", condition: { type: "cond", metric: "cvdDivergence", op: "=", value: 1 }, bias: "UP" },
    { id: "spot_led", label: "Spot-led movement", condition: { type: "cond", metric: "spotLed", op: "=", value: 1 }, bias: "UP" },
    { id: "lev_rally", label: "Leverage-driven rally", condition: { type: "cond", metric: "leverageDrivenRally", op: "=", value: 1 }, bias: "EITHER" },
    // Passive liquidity — only fire on datasets where the book was recorded.
    { id: "strong_pbid", label: "Strong passive buyers", condition: { type: "cond", metric: "passiveBuyerStrength", op: ">=", value: 70 }, bias: "UP" },
    { id: "strong_pask", label: "Strong passive sellers", condition: { type: "cond", metric: "passiveSellerStrength", op: ">=", value: 70 }, bias: "DOWN" },
    { id: "bid_persist", label: "Persistent bids", condition: { type: "cond", metric: "bidPersistence", op: ">=", value: 75 }, bias: "UP" },
    { id: "ask_persist", label: "Persistent asks", condition: { type: "cond", metric: "askPersistence", op: ">=", value: 75 }, bias: "DOWN" },
    { id: "bid_repl_ratio", label: "Bids refilling faster than consumed", condition: { type: "cond", metric: "bidReplenishmentRatio", op: ">=", value: 1 }, bias: "UP" },
    { id: "ask_repl_ratio", label: "Asks refilling faster than consumed", condition: { type: "cond", metric: "askReplenishmentRatio", op: ">=", value: 1 }, bias: "DOWN" },
    { id: "defended_bid", label: "Defended bid level", condition: { type: "cond", metric: "defendedBidTests", op: ">=", value: 2 }, bias: "UP" },
    { id: "defended_ask", label: "Defended ask level", condition: { type: "cond", metric: "defendedAskTests", op: ">=", value: 2 }, bias: "DOWN" },
    { id: "near_bid_skew", label: "Near-touch bid skew", condition: { type: "cond", metric: "nearBookImbalance", op: ">=", value: 0.3 }, bias: "UP" },
    { id: "near_ask_skew", label: "Near-touch ask skew", condition: { type: "cond", metric: "nearBookImbalance", op: "<=", value: -0.3 }, bias: "DOWN" }
  ];
  function runSignalStudy(bars, preset, tfMinutes, window, fromSec) {
    const builder = new FeatureBuilder(windowBars(window, tfMinutes));
    const snaps = [];
    const hits = [];
    for (const bar of bars) {
      const snap = builder.push(bar);
      snaps.push(snap);
      if (bar.time < fromSec) continue;
      if (!evalRule(preset.condition, snaps)) continue;
      hits.push({
        id: `st_${bar.time}`,
        kind: "CONTEXT",
        strategy: preset.label,
        strategyVersion: 1,
        timestamp: snap.timestamp,
        barTime: snap.barTime,
        price: snap.price,
        score: snap.absorptionStrength,
        confidence: snap.dataQuality,
        snapshot: snap,
        evidence: [],
        traded: false,
        forwardReturns: {}
      });
    }
    attachForwardReturns(hits, bars, tfMinutes);
    const horizons = [];
    for (const mins of FORWARD_HORIZONS_MIN) {
      const key = horizonKey(mins);
      const vals = hits.map((h) => h.forwardReturns[key]).filter((n) => n != null);
      const base = baselinePos(bars, tfMinutes, mins, fromSec);
      const pos = vals.filter((v) => v > 0).length;
      const neg = vals.filter((v) => v < 0).length;
      const posPct = vals.length ? pos / vals.length * 100 : 0;
      const maeMfe = excursion(hits, bars, mins, preset.bias);
      horizons.push({
        horizon: key,
        minutes: mins,
        count: vals.length,
        avg: avg(vals),
        median: median(vals),
        posPct,
        negPct: vals.length ? neg / vals.length * 100 : 0,
        baselinePosPct: base,
        edge: vals.length ? posPct - base : 0,
        avgMae: maeMfe.mae,
        avgMfe: maeMfe.mfe
      });
    }
    return {
      conditionId: preset.id,
      label: preset.label,
      occurrences: hits.length,
      insufficientSample: hits.length < 20,
      horizons
    };
  }
  function baselinePos(bars, tfMinutes, horizonMin, fromSec) {
    const need = Math.max(1, Math.round(horizonMin / tfMinutes));
    let n = 0;
    let pos = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.time < fromSec) continue;
      const later = bars[i + need];
      if (!later) continue;
      n += 1;
      if (later.close > b.close) pos += 1;
    }
    return n ? pos / n * 100 : 50;
  }
  function excursion(hits, bars, horizonMin, bias) {
    const times = bars.map((b) => b.time);
    const needSec = horizonMin * 60;
    const maes = [];
    const mfes = [];
    for (const h of hits) {
      const i = times.indexOf(h.barTime);
      if (i < 0) continue;
      const start = bars[i];
      const endT = start.time + needSec;
      let hi = start.high;
      let lo = start.low;
      for (let j = i; j < bars.length && bars[j].time <= endT; j++) {
        hi = Math.max(hi, bars[j].high);
        lo = Math.min(lo, bars[j].low);
      }
      const up = (hi - start.close) / start.close * 100;
      const down = (start.close - lo) / start.close * 100;
      if (bias === "DOWN") {
        mfes.push(down);
        maes.push(up);
      } else {
        mfes.push(up);
        maes.push(down);
      }
    }
    return { mae: avg(maes), mfe: avg(mfes) };
  }
  function avg(xs) {
    if (!xs.length) return 0;
    return xs.reduce((s, n) => s + n, 0) / xs.length;
  }
  function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] ?? 0 : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  }
  function getStudyPreset(id) {
    return STUDY_PRESETS.find((p) => p.id === id) ?? STUDY_PRESETS[0];
  }

  // simulator/backtest.worker.ts
  self.onmessage = (ev) => {
    const msg = ev.data;
    try {
      if (msg.type === "run") {
        const engine = new MicrostructureBacktestEngine();
        const result = engine.run(msg.bars, msg.strategy, msg.coverage, msg.config, (p) => {
          self.postMessage({ type: "progress", ...p });
        });
        self.postMessage({ type: "result", result });
        return;
      }
      if (msg.type === "study") {
        const preset = getStudyPreset(msg.presetId);
        const result = runSignalStudy(msg.bars, preset, msg.tfMinutes, msg.window, msg.signalFromSec);
        self.postMessage({ type: "study", result });
      }
    } catch (err) {
      self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };
})();
//# sourceMappingURL=backtest.worker.js.map
