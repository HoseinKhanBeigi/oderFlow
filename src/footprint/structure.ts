/**
 * Last-3-candle footprint read.
 *
 * Finds the largest ask-side execution cluster, then asks one question of the
 * bars that follow: did bid volume defend that price, or did it collapse?
 *
 * Two judgements sit on the last 3 bars: `structure` (did bids defend the
 * largest ask cluster?) and `momentum` (is attack building into price or
 * diverging from it?). Everything else is a number the bars already contained.
 */
import { formatQuote } from '../core/integrity.js';
import { tickSize } from './tick-size.js';
import type { FootprintBar, FootprintLevel } from './types.js';

export type FootprintStructureKind = 'absorption' | 'breakout' | 'distribution' | 'indeterminate';
export type ClusterDefense = 'defended' | 'collapsed' | 'unobserved';
export type MomentumState = 'building' | 'flat' | 'diverging';

/** One candle reduced to timestamp, per-price bid×ask, and delta. */
export interface ThreeCandleBar {
  t: number;
  delta: number;
  /** `[price, bid_vol, ask_vol]`, high to low. */
  levels: [number, number, number][];
}

export interface AskCluster {
  price: number;
  t: number;
  ask: number;
  bid: number;
}

export interface AttackMomentum {
  /** Attack score 3 candles ago, 2 ago, current. Null when that bar is missing. Signed −100…+100 (buy positive). */
  scores: [number | null, number | null, number | null];
  priceFrom: number | null;
  priceTo: number | null;
  priceChangePercent: number;
  state: MomentumState;
  implies: string;
}

export interface ThreeCandleRead {
  candles: ThreeCandleBar[];
  askCluster: AskCluster | null;
  subsequentBid: number;
  subsequentAsk: number;
  defense: ClusterDefense;
  structure: FootprintStructureKind;
  why: string;
  momentum: AttackMomentum;
}

export interface ThreeCandleOptions {
  /** Price levels kept per candle, highest total volume first. Default 32. */
  maxLevels?: number;
}

const LAST_N = 3;
const DEFEND_RATIO = 0.45;
const CLUSTER_SHARE = 0.25;
const CLUSTER_LEAD = 1.2;

export function readThreeCandleFootprint(
  bars: FootprintBar[] | undefined,
  options: ThreeCandleOptions = {},
): ThreeCandleRead | null {
  if (!bars?.length) return null;
  const maxLevels = options.maxLevels ?? 32;
  const window = bars.slice(-LAST_N);
  const momentum = readAttackMomentum(window);
  const cluster = findAskCluster(window);

  const candles = window.map((bar) => ({
    t: bar.time,
    delta: bar.totalBuy - bar.totalSell,
    levels: selectLevels(bar.levels, maxLevels, cluster?.price),
  }));

  if (!cluster) {
    return {
      candles,
      askCluster: null,
      subsequentBid: 0,
      subsequentAsk: 0,
      defense: 'unobserved',
      structure: 'indeterminate',
      why: 'No sell-dominant ask cluster in the last 3 candles.',
      momentum,
    };
  }

  const later = window.slice(cluster.index + 1);
  if (!later.length) {
    return {
      candles,
      askCluster: toCluster(cluster),
      subsequentBid: 0,
      subsequentAsk: 0,
      defense: 'unobserved',
      structure: 'indeterminate',
      why:
        `Largest ask cluster ${formatQuote(cluster.ask)} at ${cluster.price} ` +
        `is on the latest candle — no subsequent bar to judge defense.`,
      momentum,
    };
  }

  const tick = tickSize(cluster.price);
  const near = volumeNear(later, cluster.price, tick);
  const last = window[window.length - 1]!;
  const clusterBar = window[cluster.index]!;
  const laterHigh = maxOf(later, (b) => b.high);
  const laterLow = minOf(later, (b) => b.low);
  const threeHigh = maxOf(window, (b) => b.high);
  const laterDelta = later.reduce((s, b) => s + (b.totalBuy - b.totalSell), 0);

  const acceptedBelow = last.close < cluster.price - tick;
  const held = last.close >= cluster.price - tick;
  const gappedDown = laterHigh < cluster.price - tick;
  const gappedUp = laterLow > cluster.price + tick;
  const atHigh = cluster.price >= threeHigh - 2 * tick;
  const madeNewHigh = laterHigh > clusterBar.high + tick;

  const bidRatio = cluster.ask > 0 ? near.buy / cluster.ask : 0;
  const volumeDefended = near.buy >= near.sell && bidRatio >= DEFEND_RATIO;
  const volumeCollapsed = near.buy < near.sell && bidRatio < DEFEND_RATIO;

  const defense = resolveDefense({
    volumeDefended,
    volumeCollapsed,
    gappedUp,
    gappedDown,
    acceptedBelow,
    held,
  });

  const structure = resolveStructure({
    defense,
    held,
    acceptedBelow,
    atHigh,
    madeNewHigh,
    gappedDown,
    laterDelta,
  });

  return {
    candles,
    askCluster: toCluster(cluster),
    subsequentBid: near.buy,
    subsequentAsk: near.sell,
    defense,
    structure,
    why: explain({
      cluster,
      near,
      defense,
      structure,
      laterCount: later.length,
      lastClose: last.close,
    }),
    momentum,
  };
}

interface FoundCluster {
  index: number;
  price: number;
  ask: number;
  bid: number;
  t: number;
}

const FLAT_ATTACK = 10;

export function readAttackMomentum(bars: FootprintBar[]): AttackMomentum {
  const window = bars.slice(-LAST_N);
  const raw = window.map(attackScore);
  const scores: [number | null, number | null, number | null] = [
    raw.length >= 3 ? raw[raw.length - 3]! : null,
    raw.length >= 2 ? raw[raw.length - 2]! : null,
    raw.length >= 1 ? raw[raw.length - 1]! : null,
  ];
  const first = window[0];
  const last = window[window.length - 1];
  const priceFrom = first ? first.open : null;
  const priceTo = last ? last.close : null;
  const priceChangePercent =
    priceFrom != null && priceTo != null && priceFrom > 0 ? ((priceTo - priceFrom) / priceFrom) * 100 : 0;

  if (scores[0] == null || scores[2] == null || priceFrom == null || priceTo == null) {
    return {
      scores,
      priceFrom,
      priceTo,
      priceChangePercent: Number(priceChangePercent.toFixed(3)),
      state: 'flat',
      implies: 'Need 3 candles to judge whether attack is building into price.',
    };
  }

  const a = scores[0];
  const b = scores[1] ?? a;
  const c = scores[2];
  const attackChange = c - a;
  const tick = tickSize(priceFrom);
  const priceUp = priceTo > priceFrom + tick;
  const priceDown = priceTo < priceFrom - tick;
  const attackQuiet = Math.abs(attackChange) < FLAT_ATTACK && Math.abs(c - b) < FLAT_ATTACK;
  const priceQuiet = !priceUp && !priceDown;

  let state: MomentumState;
  if (attackQuiet && priceQuiet) state = 'flat';
  else if (!attackQuiet && ((attackChange > 0 && priceUp) || (attackChange < 0 && priceDown))) state = 'building';
  else state = 'diverging';

  return {
    scores,
    priceFrom,
    priceTo,
    priceChangePercent: Number(priceChangePercent.toFixed(3)),
    state,
    implies: implyMomentum({ a, b, c, priceFrom, priceTo, priceChangePercent, state, attackChange }),
  };
}

function attackScore(bar: FootprintBar): number {
  const total = bar.totalBuy + bar.totalSell;
  if (!(total > 0)) return 0;
  return Math.round(((bar.totalBuy - bar.totalSell) / total) * 100);
}

function implyMomentum(input: {
  a: number;
  b: number;
  c: number;
  priceFrom: number;
  priceTo: number;
  priceChangePercent: number;
  state: MomentumState;
  attackChange: number;
}): string {
  const scores = `Attack 3 ago ${fmtScore(input.a)}, 2 ago ${fmtScore(input.b)}, current ${fmtScore(input.c)}.`;
  const price =
    `Price ${input.priceFrom} → ${input.priceTo} (${input.priceChangePercent >= 0 ? '+' : ''}${input.priceChangePercent.toFixed(3)}%).`;
  const label = `momentum_state = ${input.state}.`;
  const side = input.attackChange > 0 || (input.attackChange === 0 && input.c >= 0) ? 'Buy' : 'Sell';
  if (input.state === 'building') {
    return `${scores} ${price} ${label} ${side} attack is expanding with price — continuation; fading this fights the tape.`;
  }
  if (input.state === 'diverging') {
    return `${scores} ${price} ${label} Attack and price disagree — effort without result (absorption) or a move without follow-through; wait.`;
  }
  return `${scores} ${price} ${label} Attack is not trending — no momentum edge on this setup.`;
}

function fmtScore(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function findAskCluster(bars: FootprintBar[]): FoundCluster | null {
  const candidates: FoundCluster[] = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    for (const level of bar.levels) {
      if (level.sell <= 0 || level.sell <= level.buy) continue;
      candidates.push({ index: i, price: level.price, ask: level.sell, bid: level.buy, t: bar.time });
    }
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => b.ask - a.ask || a.bid - b.bid || a.index - b.index);
  const best = candidates[0]!;
  const secondAsk = candidates[1]?.ask ?? 0;
  const candleSell = bars[best.index]!.totalSell;
  const clustered = best.ask >= candleSell * CLUSTER_SHARE || best.ask >= secondAsk * CLUSTER_LEAD;
  return clustered ? best : null;
}

function selectLevels(
  levels: FootprintLevel[],
  maxLevels: number,
  clusterPrice: number | undefined,
): [number, number, number][] {
  const withVolume = levels.filter((l) => l.buy > 0 || l.sell > 0);
  const kept =
    withVolume.length <= maxLevels
      ? withVolume
      : keepTop(withVolume, maxLevels, clusterPrice);
  return [...kept]
    .sort((a, b) => b.price - a.price)
    .map((l) => [l.price, l.buy, l.sell]);
}

function keepTop(
  levels: FootprintLevel[],
  maxLevels: number,
  clusterPrice: number | undefined,
): FootprintLevel[] {
  const ranked = [...levels].sort((a, b) => b.buy + b.sell - (a.buy + a.sell));
  const top = ranked.slice(0, maxLevels);
  if (clusterPrice == null) return top;
  if (top.some((l) => l.price === clusterPrice)) return top;
  const cluster = levels.find((l) => l.price === clusterPrice);
  if (!cluster) return top;
  top[top.length - 1] = cluster;
  return top;
}

function volumeNear(bars: FootprintBar[], price: number, tick: number): { buy: number; sell: number } {
  let buy = 0;
  let sell = 0;
  for (const bar of bars) {
    for (const level of bar.levels) {
      if (Math.abs(level.price - price) <= tick + 1e-9) {
        buy += level.buy;
        sell += level.sell;
      }
    }
  }
  return { buy, sell };
}

function resolveDefense(input: {
  volumeDefended: boolean;
  volumeCollapsed: boolean;
  gappedUp: boolean;
  gappedDown: boolean;
  acceptedBelow: boolean;
  held: boolean;
}): ClusterDefense {
  if (input.gappedDown || (input.acceptedBelow && !input.volumeDefended)) return 'collapsed';
  if (input.volumeDefended || input.gappedUp) return 'defended';
  if (input.held && !input.volumeCollapsed) return 'defended';
  if (input.volumeCollapsed) return 'collapsed';
  return 'unobserved';
}

function resolveStructure(input: {
  defense: ClusterDefense;
  held: boolean;
  acceptedBelow: boolean;
  atHigh: boolean;
  madeNewHigh: boolean;
  gappedDown: boolean;
  laterDelta: number;
}): FootprintStructureKind {
  if (input.defense === 'defended' && input.held) return 'absorption';

  // Still overlapping the high: supply at the top, not a clean leave.
  if (input.atHigh && !input.madeNewHigh && !input.held && input.laterDelta <= 0 && !input.gappedDown) {
    return 'distribution';
  }

  if (input.acceptedBelow && input.defense === 'collapsed') return 'breakout';

  if (input.atHigh && !input.madeNewHigh && input.laterDelta < 0 && input.defense !== 'defended') {
    return 'distribution';
  }

  return 'indeterminate';
}

function explain(input: {
  cluster: FoundCluster;
  near: { buy: number; sell: number };
  defense: ClusterDefense;
  structure: FootprintStructureKind;
  laterCount: number;
  lastClose: number;
}): string {
  const later = input.laterCount === 1 ? 'next candle' : `next ${input.laterCount} candles`;
  const cluster =
    `Largest ask cluster ${formatQuote(input.cluster.ask)} at ${input.cluster.price} ` +
    `(bid ${formatQuote(input.cluster.bid)}).`;
  const follow =
    `${later} printed ${formatQuote(input.near.buy)} bid × ${formatQuote(input.near.sell)} ask there ` +
    `and closed ${input.lastClose}.`;
  return `${cluster} ${follow} Defense ${input.defense} → ${input.structure}.`;
}

function toCluster(cluster: FoundCluster): AskCluster {
  return { price: cluster.price, t: cluster.t, ask: cluster.ask, bid: cluster.bid };
}

function maxOf(bars: FootprintBar[], pick: (b: FootprintBar) => number): number {
  let max = -Infinity;
  for (const bar of bars) max = Math.max(max, pick(bar));
  return max;
}

function minOf(bars: FootprintBar[], pick: (b: FootprintBar) => number): number {
  let min = Infinity;
  for (const bar of bars) min = Math.min(min, pick(bar));
  return min;
}
