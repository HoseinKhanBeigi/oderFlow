import type {
  NetAggressionSide,
  NetAggressionSnapshot,
  NetAggressionState,
} from '../models/net-aggression.js';
import type { WindowId } from '../models/trade.js';
import { WINDOW_MS } from '../models/trade.js';

const EPSILON = 1e-9;

export interface NetAggressionInput {
  window: WindowId;
  buyVolume: number;
  sellVolume: number;
  buyCount: number;
  sellCount: number;
  largeBuyVolume: number;
  largeSellVolume: number;
  /** Historical percentile of buy execution rate (per-second baseline). */
  buyPercentile: number;
  /** Historical percentile of sell execution rate (per-second baseline). */
  sellPercentile: number;
  /** Historical percentile of |net| aggression (from liquidity-response norms). */
  netMagnitudePercentile: number;
}

function side(
  executed: number,
  tradeCount: number,
  largeVolume: number,
  windowMs: number,
  percentile: number,
): NetAggressionSide {
  const seconds = Math.max(windowMs / 1000, EPSILON);
  const count = Math.max(0, tradeCount);
  return {
    executed: Math.max(0, executed),
    tradeCount: count,
    velocityPerSec: Math.max(0, executed) / seconds,
    averageTradeSize: count > 0 ? Math.max(0, executed) / count : 0,
    largeVolume: Math.max(0, largeVolume),
    percentile: clampPct(percentile),
  };
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(100, value));
}

/**
 * Classify from imbalance ∈ [-1,1] with percentile confirmation for "strong".
 * Percentiles are historical — never fixed dollar cutoffs.
 */
export function classifyNetAggression(
  imbalance: number,
  buyPercentile: number,
  sellPercentile: number,
): NetAggressionState {
  const buyPct = clampPct(buyPercentile);
  const sellPct = clampPct(sellPercentile);

  if (imbalance >= 0.35 && buyPct >= 70) return 'STRONG_BUY_AGGRESSION';
  if (imbalance <= -0.35 && sellPct >= 70) return 'STRONG_SELL_AGGRESSION';
  if (imbalance >= 0.12 || (imbalance >= 0.06 && buyPct >= 65)) return 'BUY_AGGRESSION';
  if (imbalance <= -0.12 || (imbalance <= -0.06 && sellPct >= 65)) return 'SELL_AGGRESSION';
  return 'BALANCED';
}

export function interpretNetAggression(
  state: NetAggressionState,
  net: number,
  imbalance: number,
): string {
  const signed = `${net >= 0 ? '+' : ''}${net.toFixed(0)}`;
  const imb = `${imbalance >= 0 ? '+' : ''}${imbalance.toFixed(2)}`;
  switch (state) {
    case 'STRONG_BUY_AGGRESSION':
      return `Buy aggression dominant (net ${signed}, imbalance ${imb}). Not automatically bullish — check ask replenishment and upward displacement for seller absorption.`;
    case 'BUY_AGGRESSION':
      return `Buyers are the more aggressive side (net ${signed}, imbalance ${imb}). Confirm with liquidity response before treating as directional.`;
    case 'STRONG_SELL_AGGRESSION':
      return `Sell aggression dominant (net ${signed}, imbalance ${imb}). Not automatically bearish — check bid replenishment and downward displacement for buyer absorption.`;
    case 'SELL_AGGRESSION':
      return `Sellers are the more aggressive side (net ${signed}, imbalance ${imb}). Confirm with liquidity response before treating as directional.`;
    default:
      return `Aggressive buying and selling are roughly balanced (net ${signed}, imbalance ${imb}).`;
  }
}

export function buildNetAggression(input: NetAggressionInput): NetAggressionSnapshot {
  const windowMs = WINDOW_MS[input.window];
  const buy = side(
    input.buyVolume,
    input.buyCount,
    input.largeBuyVolume,
    windowMs,
    input.buyPercentile,
  );
  const sell = side(
    input.sellVolume,
    input.sellCount,
    input.largeSellVolume,
    windowMs,
    input.sellPercentile,
  );
  const net = buy.executed - sell.executed;
  const total = buy.executed + sell.executed;
  const imbalance = total > 0 ? net / total : 0;
  const seconds = Math.max(windowMs / 1000, EPSILON);
  const state = classifyNetAggression(imbalance, buy.percentile, sell.percentile);

  return {
    window: input.window,
    windowMs,
    buy,
    sell,
    net,
    imbalance,
    netVelocityPerSec: net / seconds,
    buyPercentile: buy.percentile,
    sellPercentile: sell.percentile,
    netPercentile: clampPct(input.netMagnitudePercentile),
    state,
    interpretation: interpretNetAggression(state, net, imbalance),
  };
}

export function emptyNetAggression(window: WindowId = '10s'): NetAggressionSnapshot {
  return buildNetAggression({
    window,
    buyVolume: 0,
    sellVolume: 0,
    buyCount: 0,
    sellCount: 0,
    largeBuyVolume: 0,
    largeSellVolume: 0,
    buyPercentile: 50,
    sellPercentile: 50,
    netMagnitudePercentile: 50,
  });
}
