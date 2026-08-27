import { clamp, formatQuote, pctChange, safeDiv } from '../core/integrity.js';
import type { FootprintBar } from '../footprint/types.js';
import type { ExchangeId } from '../exchange/venues.js';
import type { WindowSnapshot } from '../models/signals.js';
import type {
  DailyBias,
  DailyFlowSnapshot,
  DailyLiquidityContext,
  DailySetup,
  DailySignal,
} from '../models/daily-signal.js';
import { buildDailyLevels } from './daily-levels.js';

const MIN_BARS = 6;
const RECENT_DAYS = 5;

export function emptyDailySignal(
  symbol: string,
  market: DailySignal['market'],
  extras: Partial<DailySignal> = {},
): DailySignal {
  return {
    timeframe: '1D',
    symbol,
    market,
    price: 0,
    bias: 'WAIT',
    setup: 'INSUFFICIENT',
    location: 'UNKNOWN',
    score: 0,
    confidence: 0,
    reason: 'Need more daily footprint history before a setup can form.',
    evidence: [],
    levels: { support: null, resistance: null, poc: null, hvns: [], all: [] },
    flow: {
      todayBuy: 0,
      todaySell: 0,
      todayDelta: 0,
      todayDeltaPercent: 0,
      todayChangePercent: 0,
      recentDelta: 0,
      recentDeltaPercent: 0,
      efficient: false,
      absorbed: null,
    },
    structureBias: 'NONE',
    structureShift: 'NONE',
    pathOfLeastResistance: 'BALANCED',
    footprintComplete: false,
    ...extras,
  };
}

export function evaluateDailySignal(input: {
  symbol: string;
  market: DailySignal['market'];
  bars: FootprintBar[];
  price?: number;
  liquidity?: DailyLiquidityContext | null;
  footprintComplete?: boolean;
}): DailySignal {
  const bars = [...input.bars].sort((a, b) => a.time - b.time);
  const last = bars[bars.length - 1];
  const price = input.price && input.price > 0 ? input.price : (last?.close ?? 0);
  if (!last || bars.length < MIN_BARS || price <= 0) {
    return emptyDailySignal(input.symbol, input.market, {
      price,
      footprintComplete: Boolean(input.footprintComplete),
    });
  }

  const levels = buildDailyLevels(bars, price);
  const flow = dailyFlow(bars, last);
  const liq = input.liquidity ?? null;
  const evidence: string[] = [];
  let score = 0;

  score += flowScore(flow, evidence);
  score += locationScore(levels.location, levels.support, levels.resistance, price, evidence);
  score += structureScore(levels.structure.bias, levels.structure.shift, evidence);
  score += liquidityScore(liq, levels.support, levels.resistance, evidence);

  score = clamp(score, -100, 100);
  const setup = classifySetup(levels.location, flow, score);
  const aligned = evidence.length;
  const conflicts = conflictCount(score, flow, levels.location, liq);
  const confidence = clamp(0.28 + aligned * 0.1 - conflicts * 0.12, 0.15, 0.92);
  const strong = Math.abs(score) >= 35 && confidence >= 0.48;
  const bias: DailyBias = !strong ? 'WAIT' : score > 0 ? 'LONG' : 'SHORT';

  return {
    timeframe: '1D',
    symbol: input.symbol,
    market: input.market,
    price,
    bias,
    setup: bias === 'WAIT' && setup !== 'INSUFFICIENT' ? (Math.abs(score) < 18 ? 'MID_RANGE' : setup) : setup,
    location: levels.location,
    score: Math.round(score),
    confidence: Number(confidence.toFixed(2)),
    reason: primaryReason(bias, setup, levels.location, flow),
    evidence: evidence.slice(0, 6),
    levels: {
      support: levels.support,
      resistance: levels.resistance,
      poc: levels.poc,
      hvns: levels.hvns,
      all: levels.all,
    },
    flow,
    structureBias: levels.structure.bias,
    structureShift: levels.structure.shift,
    pathOfLeastResistance: liq?.pathOfLeastResistance ?? 'BALANCED',
    footprintComplete: Boolean(input.footprintComplete && last.totalBuy + last.totalSell > 0),
  };
}

function dailyFlow(bars: FootprintBar[], today: FootprintBar): DailyFlowSnapshot {
  const recent = bars.slice(-RECENT_DAYS);
  const todayVol = today.totalBuy + today.totalSell;
  const recentBuy = recent.reduce((s, b) => s + b.totalBuy, 0);
  const recentSell = recent.reduce((s, b) => s + b.totalSell, 0);
  const recentVol = recentBuy + recentSell;
  const todayDelta = today.totalBuy - today.totalSell;
  const change = pctChange(today.open, today.close);
  const range = Math.max(today.high - today.low, 1e-9);
  const closePos = safeDiv(today.close - today.low, range);
  const dominated = todayVol > 0 && Math.abs(todayDelta / todayVol) >= 0.25;
  let absorbed: DailyFlowSnapshot['absorbed'] = null;
  if (dominated && todayDelta < 0 && closePos >= 0.55) absorbed = 'SELLERS';
  if (dominated && todayDelta > 0 && closePos <= 0.45) absorbed = 'BUYERS';
  const efficient =
    (todayDelta > 0 && change > 0.12 && closePos >= 0.6) || (todayDelta < 0 && change < -0.12 && closePos <= 0.4);
  return {
    todayBuy: today.totalBuy,
    todaySell: today.totalSell,
    todayDelta,
    todayDeltaPercent: todayVol > 0 ? todayDelta / todayVol : 0,
    todayChangePercent: change,
    recentDelta: recentBuy - recentSell,
    recentDeltaPercent: recentVol > 0 ? (recentBuy - recentSell) / recentVol : 0,
    efficient,
    absorbed,
  };
}

function flowScore(flow: DailyFlowSnapshot, evidence: string[]): number {
  let score = 0;
  score += clamp(flow.recentDeltaPercent * 30, -18, 18);
  if (flow.absorbed === 'SELLERS') {
    score += 20;
    evidence.push('Aggressive selling absorbed — daily low is holding');
  } else if (flow.absorbed === 'BUYERS') {
    score -= 20;
    evidence.push('Aggressive buying absorbed — daily high is capping price');
  } else {
    score += clamp(flow.todayDeltaPercent * 40, -28, 28);
  }
  if (flow.efficient && flow.todayDelta > 0) {
    score += 12;
    evidence.push(`Daily buying is moving price (+${flow.todayChangePercent.toFixed(2)}%)`);
  } else if (flow.efficient && flow.todayDelta < 0) {
    score -= 12;
    evidence.push(`Daily selling is moving price (${flow.todayChangePercent.toFixed(2)}%)`);
  }
  if (Math.abs(flow.todayDelta) > 0) {
    evidence.push(
      `Today Δ ${flow.todayDelta >= 0 ? '+' : ''}${formatQuote(flow.todayDelta)} (${(flow.todayDeltaPercent * 100).toFixed(0)}%)`,
    );
  }
  return score;
}

function locationScore(
  location: DailySignal['location'],
  support: number | null,
  resistance: number | null,
  price: number,
  evidence: string[],
): number {
  switch (location) {
    case 'AT_SUPPORT':
      evidence.push(`Price is defending support ${fmtPx(support ?? price)}`);
      return 18;
    case 'AT_RESISTANCE':
      evidence.push(`Price is testing resistance ${fmtPx(resistance ?? price)}`);
      return -18;
    case 'ABOVE_RESISTANCE':
      evidence.push(`Price is holding above resistance ${fmtPx(resistance ?? price)}`);
      return 14;
    case 'BELOW_SUPPORT':
      evidence.push(`Price is trading below support ${fmtPx(support ?? price)}`);
      return -14;
    case 'MID_RANGE':
      if (support != null && resistance != null) {
        evidence.push(`Mid-range between ${fmtPx(support)} and ${fmtPx(resistance)}`);
      }
      return 0;
    default:
      return 0;
  }
}

function structureScore(bias: string, shift: string, evidence: string[]): number {
  let score = 0;
  if (bias === 'HH_HL') {
    score += 10;
    evidence.push('Daily structure: higher highs and higher lows');
  } else if (bias === 'LH_LL') {
    score -= 10;
    evidence.push('Daily structure: lower highs and lower lows');
  }
  if (shift === 'BULLISH_BOS' || shift === 'BULLISH_CHOCH') {
    score += 10;
    evidence.push(`Daily ${shift.replace(/_/g, ' ').toLowerCase()}`);
  } else if (shift === 'BEARISH_BOS' || shift === 'BEARISH_CHOCH') {
    score -= 10;
    evidence.push(`Daily ${shift.replace(/_/g, ' ').toLowerCase()}`);
  }
  return score;
}

function liquidityScore(
  liq: DailyLiquidityContext | null,
  support: number | null,
  resistance: number | null,
  evidence: string[],
): number {
  if (!liq) return 0;
  let score = 0;
  if (liq.pathOfLeastResistance === 'UP') {
    score += 10;
    evidence.push('Live path of least resistance is up');
  } else if (liq.pathOfLeastResistance === 'DOWN') {
    score -= 10;
    evidence.push('Live path of least resistance is down');
  }

  const band = liq.price * 0.004;
  const bidWall = liq.walls.find(
    (w) => w.kind === 'BID_LIQUIDITY_WALL' && w.status === 'ACTIVE' && support != null && Math.abs(w.price - support) <= band,
  );
  const askWall = liq.walls.find(
    (w) => w.kind === 'ASK_LIQUIDITY_WALL' && w.status === 'ACTIVE' && resistance != null && Math.abs(w.price - resistance) <= band,
  );
  if (bidWall) {
    score += 12;
    evidence.push(`Bid wall defending ${fmtPx(bidWall.price)}`);
  }
  if (askWall) {
    score -= 12;
    evidence.push(`Ask wall defending ${fmtPx(askWall.price)}`);
  }

  const upVac = liq.vacuums.some((v) => v.kind === 'UPSIDE_LIQUIDITY_VACUUM');
  const downVac = liq.vacuums.some((v) => v.kind === 'DOWNSIDE_LIQUIDITY_VACUUM');
  if (upVac) score += 6;
  if (downVac) score -= 6;

  if (liq.absorptionType === 'SELLER_ABSORPTION') {
    score += 8;
    evidence.push('Live seller absorption at the bid');
  } else if (liq.absorptionType === 'BUYER_ABSORPTION') {
    score -= 8;
    evidence.push('Live buyer absorption at the ask');
  }
  return score;
}

function classifySetup(
  location: DailySignal['location'],
  flow: DailyFlowSnapshot,
  score: number,
): DailySetup {
  if (location === 'AT_SUPPORT' && (flow.absorbed === 'SELLERS' || score > 0)) return 'SUPPORT_HOLD';
  if (location === 'AT_RESISTANCE' && (flow.absorbed === 'BUYERS' || score < 0)) return 'RESISTANCE_REJECT';
  if (location === 'ABOVE_RESISTANCE' && score > 0) return 'BREAKOUT_UP';
  if (location === 'BELOW_SUPPORT' && score < 0) return 'BREAKDOWN';
  if (location === 'MID_RANGE' && Math.abs(score) >= 28) return 'FLOW_CONTINUATION';
  if (location === 'UNKNOWN') return 'INSUFFICIENT';
  return 'MID_RANGE';
}

function conflictCount(
  score: number,
  flow: DailyFlowSnapshot,
  location: DailySignal['location'],
  liq: DailyLiquidityContext | null,
): number {
  let n = 0;
  if (score > 0 && flow.todayDelta < 0) n += 1;
  if (score < 0 && flow.todayDelta > 0) n += 1;
  if (location === 'AT_SUPPORT' && flow.absorbed === 'BUYERS') n += 1;
  if (location === 'AT_RESISTANCE' && flow.absorbed === 'SELLERS') n += 1;
  if (liq && score > 0 && liq.pathOfLeastResistance === 'DOWN') n += 1;
  if (liq && score < 0 && liq.pathOfLeastResistance === 'UP') n += 1;
  return n;
}

function primaryReason(
  bias: DailyBias,
  setup: DailySetup,
  location: DailySignal['location'],
  flow: DailyFlowSnapshot,
): string {
  if (bias === 'WAIT' && setup === 'MID_RANGE') {
    return 'Daily location is mid-range and footprint is not aligned enough for a directional setup.';
  }
  if (setup === 'SUPPORT_HOLD') {
    return 'Daily support is holding: selling is being absorbed and aggressive buyers still have a location edge.';
  }
  if (setup === 'RESISTANCE_REJECT') {
    return 'Daily resistance is capping price: buying is being absorbed and sellers control the level.';
  }
  if (setup === 'BREAKOUT_UP') {
    return 'Price is holding above daily resistance with buy-side footprint confirming the break.';
  }
  if (setup === 'BREAKDOWN') {
    return 'Price is trading below daily support with sell-side footprint confirming the break.';
  }
  if (setup === 'FLOW_CONTINUATION') {
    return flow.todayDelta >= 0
      ? 'No nearby level in play — daily buy flow is still the stronger force.'
      : 'No nearby level in play — daily sell flow is still the stronger force.';
  }
  if (bias === 'LONG') return `Daily bias leans long from ${location.replace(/_/g, ' ').toLowerCase()}.`;
  if (bias === 'SHORT') return `Daily bias leans short from ${location.replace(/_/g, ' ').toLowerCase()}.`;
  return 'Daily footprint, liquidity, and support/resistance are not aligned.';
}

function fmtPx(price: number): string {
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(3);
  return price.toFixed(5);
}

export function liquidityContextFromWindow(snap: WindowSnapshot): DailyLiquidityContext {
  const mp = snap.movePotential;
  return {
    price: snap.price,
    pathOfLeastResistance: mp.pathOfLeastResistance,
    nearbyAsk: mp.liquidity.nearbyAskLiquidity,
    nearbyBid: mp.liquidity.nearbyBidLiquidity,
    askConsumption: mp.liquidity.askConsumptionRate,
    bidConsumption: mp.liquidity.bidConsumptionRate,
    walls: mp.liquidity.walls,
    vacuums: mp.liquidity.vacuums,
    absorptionType: snap.absorption.type,
  };
}

/** OHLC-only bars used when footprint history is missing. */
export function barsFromKlines(
  rows: Array<[number, string, string, string, string, string]>,
  meta: { symbol: string; exchange: ExchangeId; market: DailySignal['market'] },
): FootprintBar[] {
  return rows.map((row) => ({
    symbol: meta.symbol,
    exchange: meta.exchange,
    market: meta.market === 'stock' ? 'perp' : meta.market,
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    totalBuy: 0,
    totalSell: 0,
    trades: 0,
    levels: [],
  }));
}
