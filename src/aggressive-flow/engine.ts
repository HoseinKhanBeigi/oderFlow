import { clamp, safeDiv } from '../core/integrity.js';
import { RollingDistribution } from '../core/rolling-stats.js';
import { priceToTick } from '../footprint/tick-size.js';
import type { AggressivePowerWeights, MarketBattleConfig } from '../config/types.js';
import { WINDOW_MS, type WindowId } from '../models/trade.js';
import type {
  AggressiveFlowSnapshot,
  AggressivePowerContribution,
  AggressiveSideFlow,
  FootprintAggressionLevel,
} from '../models/aggressive-flow.js';
import { emptyAggressiveFlow, emptyAggressiveSideFlow } from '../models/aggressive-flow.js';

interface FlowEvent {
  timestamp: number;
  price: number;
  side: 'BUY' | 'SELL';
  quote: number;
  large: boolean;
}

interface LevelAgg {
  buy: number;
  sell: number;
}

/**
 * Footprint-derived aggressive flow for Market Battle.
 *
 * ASK-executed volume  → Aggressive Buy
 * BID-executed volume  → Aggressive Sell
 *
 * Uses the same aggressor classification as the FootprintAggregator
 * (trade.side BUY/SELL). Does not use resting book depth as aggression.
 */
export class AggressiveFlowEngine {
  private readonly events: FlowEvent[];
  private write = 0;
  private filled = 0;
  private oldest = 0;
  private lastTradeAt = 0;
  private readonly buyPowerBaseline: RollingDistribution;
  private readonly sellPowerBaseline: RollingDistribution;
  private readonly buyVolumeBaseline: RollingDistribution;
  private readonly sellVolumeBaseline: RollingDistribution;
  private lastBaselineSecond = -1;

  constructor(
    private readonly config: MarketBattleConfig,
    private readonly capacity = 60_000,
    baselineSamples = 1_024,
  ) {
    this.events = new Array(capacity);
    this.buyPowerBaseline = new RollingDistribution(baselineSamples);
    this.sellPowerBaseline = new RollingDistribution(baselineSamples);
    this.buyVolumeBaseline = new RollingDistribution(baselineSamples);
    this.sellVolumeBaseline = new RollingDistribution(baselineSamples);
  }

  onTrade(
    timestamp: number,
    side: 'BUY' | 'SELL',
    quoteValue: number,
    price: number,
    isLarge: boolean,
  ): void {
    if (!(quoteValue > 0) || !(price > 0)) return;
    const tick = priceToTick(price);
    const slot = this.write;
    this.events[slot] = { timestamp, price: tick, side, quote: quoteValue, large: isLarge };
    this.write = (this.write + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
    else this.oldest = (this.oldest + 1) % this.capacity;
    this.lastTradeAt = timestamp;
    this.maybeBaseline(timestamp);
  }

  snapshot(window: WindowId, now: number, opts?: {
    tradeDataMissing?: boolean;
    tradeStale?: boolean;
  }): AggressiveFlowSnapshot {
    const windowMs = WINDOW_MS[window];
    const tradeMissing = Boolean(opts?.tradeDataMissing) || this.filled === 0 || this.lastTradeAt === 0;
    if (tradeMissing) {
      const empty = emptyAggressiveFlow(window, windowMs);
      empty.buy.lowConfidence = true;
      empty.sell.lowConfidence = true;
      return empty;
    }

    const from = now - windowMs;
    const levels = new Map<number, LevelAgg>();
    let buyVol = 0;
    let sellVol = 0;
    let buyCount = 0;
    let sellCount = 0;
    let largeBuy = 0;
    let largeSell = 0;

    for (let i = 0; i < this.filled; i++) {
      const idx = (this.oldest + i) % this.capacity;
      const e = this.events[idx];
      if (!e || e.timestamp < from || e.timestamp > now) continue;
      let lv = levels.get(e.price);
      if (!lv) {
        lv = { buy: 0, sell: 0 };
        levels.set(e.price, lv);
      }
      if (e.side === 'BUY') {
        lv.buy += e.quote;
        buyVol += e.quote;
        buyCount += 1;
        if (e.large) largeBuy += e.quote;
      } else {
        lv.sell += e.quote;
        sellVol += e.quote;
        sellCount += 1;
        if (e.large) largeSell += e.quote;
      }
    }

    const seconds = Math.max(windowMs / 1000, 1e-6);
    const imbalance = detectImbalances(levels, this.config.imbalanceRatio, this.config.minImbalanceQuote);
    const delta = buyVol - sellVol;
    const lowConfidence = Boolean(opts?.tradeStale);

    const buy = scoreSide({
      executedVolume: buyVol,
      tradeCount: buyCount,
      velocityPerSec: buyVol / seconds,
      largeVolume: largeBuy,
      imbalanceCount: imbalance.buyCount,
      stackedImbalanceCount: imbalance.buyStacked,
      imbalanceNotional: imbalance.buyNotional,
      imbalanceStrength: imbalance.buyStrength,
      deltaContribution: Math.max(0, delta),
      cvdContribution: Math.max(0, delta),
      consecutiveImbalances: imbalance.buyConsecutive,
      activityPercentile: this.buyVolumeBaseline.percentileRank(buyVol / seconds),
      weights: this.config.aggressiveWeights,
      opposingVolume: sellVol,
      topLevels: imbalance.buyLevels,
      hasData: true,
      lowConfidence,
      powerBaseline: this.buyPowerBaseline,
    });

    const sell = scoreSide({
      executedVolume: sellVol,
      tradeCount: sellCount,
      velocityPerSec: sellVol / seconds,
      largeVolume: largeSell,
      imbalanceCount: imbalance.sellCount,
      stackedImbalanceCount: imbalance.sellStacked,
      imbalanceNotional: imbalance.sellNotional,
      imbalanceStrength: imbalance.sellStrength,
      deltaContribution: Math.min(0, delta),
      cvdContribution: Math.min(0, delta),
      consecutiveImbalances: imbalance.sellConsecutive,
      activityPercentile: this.sellVolumeBaseline.percentileRank(sellVol / seconds),
      weights: this.config.aggressiveWeights,
      opposingVolume: buyVol,
      topLevels: imbalance.sellLevels,
      hasData: true,
      lowConfidence,
      powerBaseline: this.sellPowerBaseline,
    });

    return {
      window,
      windowMs,
      buy,
      sell,
      aggressiveBuyPower: buy.power,
      aggressiveSellPower: sell.power,
      source: 'FOOTPRINT_EXECUTED',
    };
  }

  private maybeBaseline(timestamp: number): void {
    const second = Math.floor(timestamp / 1000);
    if (this.lastBaselineSecond < 0) {
      this.lastBaselineSecond = second;
      return;
    }
    if (second === this.lastBaselineSecond) return;
    // Record per-second rates from the last completed second of events.
    const from = this.lastBaselineSecond * 1000;
    const to = from + 1000;
    let buy = 0;
    let sell = 0;
    for (let i = 0; i < this.filled; i++) {
      const idx = (this.oldest + i) % this.capacity;
      const e = this.events[idx];
      if (!e || e.timestamp < from || e.timestamp >= to) continue;
      if (e.side === 'BUY') buy += e.quote;
      else sell += e.quote;
    }
    this.buyVolumeBaseline.add(buy);
    this.sellVolumeBaseline.add(sell);
    this.lastBaselineSecond = second;
  }
}

function scoreSide(p: {
  executedVolume: number;
  tradeCount: number;
  velocityPerSec: number;
  largeVolume: number;
  imbalanceCount: number;
  stackedImbalanceCount: number;
  imbalanceNotional: number;
  imbalanceStrength: number;
  deltaContribution: number;
  cvdContribution: number;
  consecutiveImbalances: number;
  activityPercentile: number;
  weights: AggressivePowerWeights;
  opposingVolume: number;
  topLevels: FootprintAggressionLevel[];
  hasData: boolean;
  lowConfidence: boolean;
  powerBaseline: RollingDistribution;
}): AggressiveSideFlow {
  if (!p.hasData) return emptyAggressiveSideFlow();

  const w = normalizeWeights(p.weights);
  const volumeN = clamp(p.activityPercentile, 0, 100);
  const velocityN = clamp(Math.log10(1 + p.velocityPerSec / 25_000) * 45, 0, 100);
  const imbalanceN = clamp(
    0.55 * clamp(p.imbalanceStrength * 20, 0, 100) +
      0.25 * clamp(p.imbalanceCount * 6, 0, 100) +
      0.2 * clamp(p.consecutiveImbalances * 12, 0, 100),
    0,
    100,
  );
  const largeN = clamp(safeDiv(p.largeVolume, Math.max(p.executedVolume, 1e-9)) * 100, 0, 100);
  const countN = clamp(Math.log10(1 + p.tradeCount) * 28, 0, 100);
  // Delta/CVD are correlated with volume — use share of total tape, not raw size again.
  const deltaShare = clamp(
    safeDiv(Math.abs(p.deltaContribution), Math.max(p.executedVolume + p.opposingVolume, 1e-9)) * 100,
    0,
    100,
  );

  const contributions: AggressivePowerContribution[] = [
    { label: 'Executed Volume', normalized: volumeN, weight: w.executedVolume, points: 0 },
    { label: 'Execution Velocity', normalized: velocityN, weight: w.executionVelocity, points: 0 },
    { label: 'Imbalance Strength', normalized: imbalanceN, weight: w.imbalanceStrength, points: 0 },
    { label: 'Large Trade Activity', normalized: largeN, weight: w.largeTradeActivity, points: 0 },
    { label: 'Trade Count Intensity', normalized: countN, weight: w.tradeCountIntensity, points: 0 },
    { label: 'Delta / CVD', normalized: deltaShare, weight: w.deltaCvdContribution, points: 0 },
  ];
  for (const c of contributions) {
    c.points = c.normalized * c.weight;
  }
  const rawPower = contributions.reduce((s, c) => s + c.points, 0);
  const power = clamp(rawPower, 0, 100);
  p.powerBaseline.add(power);

  return {
    executedVolume: p.executedVolume,
    tradeCount: p.tradeCount,
    velocityPerSec: p.velocityPerSec,
    averageTradeSize: safeDiv(p.executedVolume, Math.max(p.tradeCount, 1)),
    largeVolume: p.largeVolume,
    imbalanceCount: p.imbalanceCount,
    stackedImbalanceCount: p.stackedImbalanceCount,
    imbalanceNotional: p.imbalanceNotional,
    imbalanceStrength: p.imbalanceStrength,
    deltaContribution: p.deltaContribution,
    cvdContribution: p.cvdContribution,
    consecutiveImbalances: p.consecutiveImbalances,
    activityPercentile: clamp(p.activityPercentile, 0, 100),
    power,
    contributions,
    topLevels: p.topLevels.slice(0, 12),
    hasData: true,
    lowConfidence: p.lowConfidence,
  };
}

function normalizeWeights(w: AggressivePowerWeights): AggressivePowerWeights {
  const sum =
    w.executedVolume +
    w.executionVelocity +
    w.imbalanceStrength +
    w.largeTradeActivity +
    w.tradeCountIntensity +
    w.deltaCvdContribution;
  if (!(sum > 0)) {
    return {
      executedVolume: 0.25,
      executionVelocity: 0.2,
      imbalanceStrength: 0.2,
      largeTradeActivity: 0.15,
      tradeCountIntensity: 0.1,
      deltaCvdContribution: 0.1,
    };
  }
  return {
    executedVolume: w.executedVolume / sum,
    executionVelocity: w.executionVelocity / sum,
    imbalanceStrength: w.imbalanceStrength / sum,
    largeTradeActivity: w.largeTradeActivity / sum,
    tradeCountIntensity: w.tradeCountIntensity / sum,
    deltaCvdContribution: w.deltaCvdContribution / sum,
  };
}

function detectImbalances(
  levels: Map<number, LevelAgg>,
  ratio: number,
  minQuote: number,
): {
  buyCount: number;
  sellCount: number;
  buyStacked: number;
  sellStacked: number;
  buyNotional: number;
  sellNotional: number;
  buyStrength: number;
  sellStrength: number;
  buyConsecutive: number;
  sellConsecutive: number;
  buyLevels: FootprintAggressionLevel[];
  sellLevels: FootprintAggressionLevel[];
} {
  const prices = [...levels.keys()].sort((a, b) => a - b);
  const buyLevels: FootprintAggressionLevel[] = [];
  const sellLevels: FootprintAggressionLevel[] = [];
  let buyCount = 0;
  let sellCount = 0;
  let buyNotional = 0;
  let sellNotional = 0;
  let buyStrengthSum = 0;
  let sellStrengthSum = 0;
  let buyRun = 0;
  let sellRun = 0;
  let buyConsecutive = 0;
  let sellConsecutive = 0;
  let buyStacked = 0;
  let sellStacked = 0;

  for (const price of prices) {
    const lv = levels.get(price)!;
    const buy = lv.buy;
    const sell = lv.sell;
    const hi = Math.max(buy, sell);
    const lo = Math.min(buy, sell);
    let side: FootprintAggressionLevel['side'] = 'BALANCED';
    let imbRatio = 0;

    if (hi >= minQuote) {
      if (lo <= 0) {
        side = buy > sell ? 'BUY' : sell > buy ? 'SELL' : 'BALANCED';
        imbRatio = side === 'BALANCED' ? 0 : 99;
      } else if (hi / lo >= ratio) {
        side = buy > sell ? 'BUY' : 'SELL';
        imbRatio = hi / lo;
      }
    }

    if (side === 'BUY') {
      buyCount += 1;
      buyNotional += buy;
      buyStrengthSum += imbRatio;
      buyRun += 1;
      sellRun = 0;
      buyConsecutive = Math.max(buyConsecutive, buyRun);
      if (buyRun >= 2) buyStacked += 1;
      buyLevels.push({ price, buyExecuted: buy, sellExecuted: sell, imbalanceRatio: imbRatio, side });
    } else if (side === 'SELL') {
      sellCount += 1;
      sellNotional += sell;
      sellStrengthSum += imbRatio;
      sellRun += 1;
      buyRun = 0;
      sellConsecutive = Math.max(sellConsecutive, sellRun);
      if (sellRun >= 2) sellStacked += 1;
      sellLevels.push({ price, buyExecuted: buy, sellExecuted: sell, imbalanceRatio: imbRatio, side });
    } else {
      buyRun = 0;
      sellRun = 0;
    }
  }

  buyLevels.sort((a, b) => b.buyExecuted - a.buyExecuted);
  sellLevels.sort((a, b) => b.sellExecuted - a.sellExecuted);

  return {
    buyCount,
    sellCount,
    buyStacked,
    sellStacked,
    buyNotional,
    sellNotional,
    buyStrength: buyCount ? buyStrengthSum / buyCount : 0,
    sellStrength: sellCount ? sellStrengthSum / sellCount : 0,
    buyConsecutive,
    sellConsecutive,
    buyLevels,
    sellLevels,
  };
}
