/**
 * Builds the compact payload an LLM sees.
 *
 * The engines already decided what the market is doing. This module only
 * selects, rounds, and names those conclusions so they survive a prompt without
 * burning tokens on raw depth profiles and per-trade detail.
 *
 * Nothing here interprets the market. If a field looks like a judgement call,
 * it came from `src/analysis`, `src/liquidity-response`, or `src/passive-liquidity`.
 */
import type { MultiWindowSnapshot, WindowSnapshot } from '../models/signals.js';
import type { WindowId } from '../models/trade.js';
import type { WhyFact } from '../models/liquidity-response.js';
import type {
  LiquidityZone,
  PassiveLiquiditySnapshot,
  PassiveLiquidityWall,
  VacuumAssessment,
} from '../models/passive-liquidity.js';
import type { DailySignal } from '../models/daily-signal.js';
import type { FootprintBar, FootprintLevel } from '../footprint/types.js';
import { tickSize } from '../footprint/tick-size.js';
import { readThreeCandleFootprint, type ThreeCandleRead } from '../footprint/structure.js';
import {
  BRIEFING_SCHEMA,
  type AgentBriefing,
  type BriefingBar,
  type BriefingBattle,
  type BriefingBattleSide,
  type BriefingDaily,
  type BriefingGate,
  type BriefingLiquidity,
  type BriefingOptions,
  type BriefingRead,
  type BriefingStructure,
  type BriefingTarget,
  type BriefingTargets,
  type BriefingThreeCandle,
  type BriefingVacuum,
  type BriefingWall,
  type BriefingWindowFlow,
  type BriefingZone,
} from './types.js';

export interface BriefingInput {
  snapshot: MultiWindowSnapshot;
  /** Most recent last. Pass the same bars the chart is showing. */
  footprint?: FootprintBar[];
  footprintTimeframeMinutes?: number;
  daily?: DailySignal | null;
  now?: number;
  options?: BriefingOptions;
}

const DEFAULT_WINDOWS: WindowId[] = ['10s', '1m', '5m', '15m'];

interface ResolvedOptions {
  windows: WindowId[];
  primaryWindow: WindowId;
  maxWalls: number;
  maxTargets: number;
  maxBars: number;
  maxLevelsPerBar: number;
  maxLast3Levels: number;
  staleTradeMs: number;
  minConfidence: number;
  minDataQuality: number;
}

function resolve(options: BriefingOptions = {}): ResolvedOptions {
  return {
    windows: options.windows ?? DEFAULT_WINDOWS,
    primaryWindow: options.primaryWindow ?? '1m',
    maxWalls: options.maxWalls ?? 3,
    maxTargets: options.maxTargets ?? 3,
    maxBars: options.maxBars ?? 12,
    maxLevelsPerBar: options.maxLevelsPerBar ?? 2,
    maxLast3Levels: options.maxLast3Levels ?? 32,
    staleTradeMs: options.staleTradeMs ?? 15_000,
    minConfidence: options.minConfidence ?? 0.35,
    minDataQuality: options.minDataQuality ?? 40,
  };
}

export function buildBriefing(input: BriefingInput): AgentBriefing {
  const opts = resolve(input.options);
  const { windows } = input.snapshot;

  const primary = windows[opts.primaryWindow] ?? firstWindow(windows);
  if (!primary) {
    throw new Error(`buildBriefing: ${input.snapshot.symbol} has no window snapshots yet`);
  }

  const passive = primary.passiveLiquidity;
  const now = input.now ?? input.snapshot.timestamp;

  return {
    schema: BRIEFING_SCHEMA,
    symbol: input.snapshot.symbol,
    market: input.snapshot.marketType,
    at: new Date(now).toISOString(),
    price: price(input.snapshot.price),
    gate: buildGate(primary, opts),
    read: buildRead(primary),
    flow: opts.windows.flatMap((id) => {
      const w = windows[id];
      return w ? [buildFlow(id, w)] : [];
    }),
    battle: buildBattle(primary),
    liquidity: buildLiquidity(passive, opts),
    targets: buildTargets(primary, opts),
    structure: buildStructure(primary),
    footprint: buildFootprint(input.footprint, input.footprintTimeframeMinutes ?? 1, opts),
    daily: buildDaily(input.daily ?? null),
    notes: buildNotes(primary, passive),
  };
}

function firstWindow(windows: MultiWindowSnapshot['windows']): WindowSnapshot | undefined {
  for (const id of DEFAULT_WINDOWS) {
    const w = windows[id];
    if (w) return w;
  }
  return Object.values(windows).find((w): w is WindowSnapshot => w != null);
}

function buildGate(w: WindowSnapshot, opts: ResolvedOptions): BriefingGate {
  const health = w.marketBattle.dataHealth;
  const quality = w.passiveLiquidity.dataQuality;
  const tradeAgeMs = Math.round(health.tradeAgeMs);
  // The battle engine adapts staleness to each symbol's own cadence; fall back
  // to the caller's fixed budget only when it has no cadence estimate yet.
  const staleAfter = health.staleAfterMs > 0 ? health.staleAfterMs : opts.staleTradeMs;
  const tradesFresh = health.status !== 'NO_TRADES' && tradeAgeMs <= staleAfter;
  const bookReliable = health.bookReliable && quality.trustworthy && !quality.crossedBook;

  const blockers: string[] = [];
  if (!tradesFresh) blockers.push(health.detail || `No trade for ${tradeAgeMs}ms`);
  if (!bookReliable) blockers.push(`Order book unreliable: ${quality.reasons.join(', ') || 'low data quality'}`);
  if (w.confidence < opts.minConfidence) blockers.push(`Window confidence ${num(w.confidence, 2)} below ${opts.minConfidence}`);
  if (quality.score < opts.minDataQuality) blockers.push(`Liquidity data quality ${Math.round(quality.score)} below ${opts.minDataQuality}`);

  return {
    usable: blockers.length === 0,
    confidence: num(w.confidence, 2),
    dataQuality: Math.round(quality.score),
    bookReliable,
    tradesFresh,
    tradeAgeMs,
    blockers,
  };
}

function buildRead(w: WindowSnapshot): BriefingRead {
  const lr = w.liquidityResponse;
  const reversal = lr.reversal;
  return {
    state: w.state,
    microstructure: lr.state,
    passiveState: w.passiveLiquidity.state,
    entryContext: lr.entryContext,
    effort: lr.effort,
    aggression: lr.aggression,
    absorption:
      w.absorption.detected && w.absorption.type && w.absorption.absorbingSide
        ? {
            type: w.absorption.type,
            absorbingSide: w.absorption.absorbingSide,
            strength: num(w.absorption.strength, 2),
          }
        : null,
    reversal:
      reversal?.detected && reversal.kind ? { kind: reversal.kind, reasons: reversal.reasons.slice(0, 4) } : null,
    pathOfLeastResistance: w.movePotential.pathOfLeastResistance,
    directionalScore: Math.round(w.largeFlowDirectionalScore),
    priceImpactEfficiency: w.priceImpactEfficiency,
    impactFaded: lr.impact.faded,
  };
}

function buildFlow(window: WindowId, w: WindowSnapshot): BriefingWindowFlow {
  const net = w.netAggression;
  return {
    window,
    buy: money(w.aggressiveBuyVolume),
    sell: money(w.aggressiveSellVolume),
    delta: money(w.delta),
    imbalance: num(net?.imbalance ?? w.deltaPercent, 3),
    netPercentile: Math.round(net?.netPercentile ?? 50),
    largestBuy: money(w.largestBuy),
    largestSell: money(w.largestSell),
    priceChangePercent: num(w.priceChangePercent, 3),
    state: w.state,
  };
}

function buildBattle(w: WindowSnapshot): BriefingBattle {
  const b = w.marketBattle;
  return {
    window: b.window,
    summary: b.summary.state,
    summaryWhy: b.summary.why,
    upside: battleSide(b.upside.state, b.upside.battleScore, b.upside.aggressive.power, b.upside.passive, b.upside.why),
    downside: battleSide(
      b.downside.state,
      b.downside.battleScore,
      b.downside.aggressive.power,
      b.downside.passive,
      b.downside.why,
    ),
  };
}

function battleSide(
  state: BriefingBattleSide['state'],
  score: number,
  aggressivePower: number,
  passive: WindowSnapshot['marketBattle']['upside']['passive'],
  why: string[],
): BriefingBattleSide {
  return {
    state,
    score: Math.round(score),
    aggressivePower: Math.round(aggressivePower),
    defensePower: Math.round(passive.defensePower),
    survival: passive.survivalLabel,
    consumption: passive.consumption,
    replenishment: passive.replenishment,
    why: why.slice(0, 3),
  };
}

function buildLiquidity(p: PassiveLiquiditySnapshot, opts: ResolvedOptions): BriefingLiquidity {
  const byDistance = [...p.walls].sort((a, b) => a.distanceBps - b.distanceBps);
  return {
    spreadBps: num(p.spreadBps, 2),
    bidDepth: money(p.bid.depthNotional),
    askDepth: money(p.ask.depthNotional),
    nearBidDepth: money(p.bid.nearDepthNotional),
    nearAskDepth: money(p.ask.nearDepthNotional),
    passiveBuyerStrength: Math.round(p.passiveBuyerStrength),
    passiveSellerStrength: Math.round(p.passiveSellerStrength),
    bidWalls: byDistance.filter((w) => w.side === 'BID').slice(0, opts.maxWalls).map(wall),
    askWalls: byDistance.filter((w) => w.side === 'ASK').slice(0, opts.maxWalls).map(wall),
    upsideVacuum: vacuum(p.upsideVacuum),
    downsideVacuum: vacuum(p.downsideVacuum),
    floor: zone(p.potentialFloor),
    ceiling: zone(p.potentialCeiling),
  };
}

function wall(w: PassiveLiquidityWall): BriefingWall {
  return {
    side: w.side,
    price: price(w.price),
    distanceBps: num(w.distanceBps, 1),
    notional: money(w.notional),
    strength: Math.round(w.strength),
    reliability: Math.round(w.reliability),
    lifecycle: w.lifecycle,
    attacks: w.attackCount,
    defended: w.defendedCount,
    labels: w.labels,
  };
}

function vacuum(v: VacuumAssessment): BriefingVacuum {
  return {
    direction: v.direction,
    detected: v.detected,
    score: Math.round(v.score),
    distanceToNextWallBps: num(v.distanceToNextWallBps, 1),
  };
}

function zone(z: LiquidityZone | null): BriefingZone | null {
  if (!z) return null;
  return {
    side: z.side,
    priceMin: price(z.priceMin),
    priceMax: price(z.priceMax),
    state: z.state,
    tests: z.testCount,
    defended: z.defendedTests,
    strength: Math.round(z.strength),
  };
}

function buildTargets(w: WindowSnapshot, opts: ResolvedOptions): BriefingTargets {
  const mp = w.movePotential;
  const map = (t: (typeof mp.targets.upside)[number]): BriefingTarget => ({
    price: price(t.price),
    distancePercent: num(t.distancePercent, 3),
    reachability: Math.round(t.reachabilityScore),
    difficulty: t.difficulty,
  });
  return {
    atr: price(mp.atr),
    upside: mp.targets.upside.slice(0, opts.maxTargets).map(map),
    downside: mp.targets.downside.slice(0, opts.maxTargets).map(map),
  };
}

function buildStructure(w: WindowSnapshot): BriefingStructure {
  const s = w.liquidityResponse.structure;
  return {
    bias: s.bias,
    shift: s.shift,
    swingHigh: s.swingHigh == null ? null : price(s.swingHigh),
    swingLow: s.swingLow == null ? null : price(s.swingLow),
  };
}

function buildFootprint(
  bars: FootprintBar[] | undefined,
  timeframeMinutes: number,
  opts: ResolvedOptions,
): AgentBriefing['footprint'] {
  if (!bars?.length) return null;
  const last3 = readThreeCandleFootprint(bars, { maxLevels: opts.maxLast3Levels });
  return {
    timeframeMinutes,
    bars: bars.slice(-opts.maxBars).map((b) => summarizeBar(b, opts.maxLevelsPerBar)),
    last3: last3 ? roundLast3(last3) : null,
  };
}

function roundLast3(read: ThreeCandleRead): BriefingThreeCandle {
  return {
    candles: read.candles.map((c) => ({
      t: c.t,
      delta: money(c.delta),
      levels: c.levels.map(([p, bid, ask]) => [price(p), money(bid), money(ask)]),
    })),
    askCluster: read.askCluster
      ? {
          price: price(read.askCluster.price),
          t: read.askCluster.t,
          ask: money(read.askCluster.ask),
          bid: money(read.askCluster.bid),
        }
      : null,
    subsequentBid: money(read.subsequentBid),
    subsequentAsk: money(read.subsequentAsk),
    defense: read.defense,
    structure: read.structure,
    why: read.why,
    momentum: {
      scores: read.momentum.scores,
      priceFrom: read.momentum.priceFrom == null ? null : price(read.momentum.priceFrom),
      priceTo: read.momentum.priceTo == null ? null : price(read.momentum.priceTo),
      priceChangePercent: read.momentum.priceChangePercent,
      state: read.momentum.state,
      implies: read.momentum.implies,
    },
  };
}

function summarizeBar(bar: FootprintBar, maxLevels: number): BriefingBar {
  const levels = bar.levels;
  let poc = bar.close;
  let pocVolume = -1;
  for (const l of levels) {
    const total = l.buy + l.sell;
    if (total > pocVolume) {
      pocVolume = total;
      poc = l.price;
    }
  }

  const buyDominant = levels
    .filter((l) => l.buy > l.sell)
    .sort((a, b) => b.buy - b.sell - (a.buy - a.sell))
    .slice(0, maxLevels);
  const sellDominant = levels
    .filter((l) => l.sell > l.buy)
    .sort((a, b) => b.sell - b.buy - (a.sell - a.buy))
    .slice(0, maxLevels);

  return {
    t: bar.time,
    o: price(bar.open),
    h: price(bar.high),
    l: price(bar.low),
    c: price(bar.close),
    buy: money(bar.totalBuy),
    sell: money(bar.totalSell),
    delta: money(bar.totalBuy - bar.totalSell),
    poc: price(poc),
    topBuyLevels: buyDominant.map(levelTriple),
    topSellLevels: sellDominant.map(levelTriple),
  };
}

function levelTriple(l: FootprintLevel): [number, number, number] {
  return [price(l.price), money(l.buy), money(l.sell)];
}

function buildDaily(d: DailySignal | null): BriefingDaily | null {
  if (!d) return null;
  return {
    timeframe: d.timeframe,
    bias: d.bias,
    setup: d.setup,
    location: d.location,
    confidence: num(d.confidence, 2),
    support: d.levels.support == null ? null : price(d.levels.support),
    resistance: d.levels.resistance == null ? null : price(d.levels.resistance),
    poc: d.levels.poc == null ? null : price(d.levels.poc),
    plan: {
      entry: d.plan.entry == null ? null : price(d.plan.entry),
      sl: d.plan.sl == null ? null : price(d.plan.sl),
      tp1: d.plan.tp1 == null ? null : price(d.plan.tp1),
      tp2: d.plan.tp2 == null ? null : price(d.plan.tp2),
      entryMode: d.plan.entryMode,
      why: d.plan.entryWhy,
    },
    reason: d.reason,
  };
}

/**
 * Percentile-backed facts beat raw numbers in a prompt: "consumption 94th
 * percentile" is actionable, "consumption 1840000" is not.
 */
function buildNotes(w: WindowSnapshot, p: PassiveLiquiditySnapshot): string[] {
  const facts = [...w.liquidityResponse.why, ...p.why].map(factToLine);
  const warnings = w.movePotential.warnings;
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const line of [...facts, ...warnings]) {
    if (!line || seen.has(line)) continue;
    seen.add(line);
    notes.push(line);
    if (notes.length >= 10) break;
  }
  return notes;
}

function factToLine(f: WhyFact): string {
  const pct = f.percentile == null ? '' : ` (p${Math.round(f.percentile)})`;
  return `${f.label}: ${f.value}${pct}`;
}

function num(n: number, decimals: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(decimals));
}

/** Quote notional. Sub-dollar precision is noise at these sizes. */
function money(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Rounded to the footprint grid's resolution so prices match the chart. */
function price(p: number): number {
  if (!Number.isFinite(p)) return 0;
  const tick = tickSize(Math.abs(p));
  const decimals = tick >= 1 ? 2 : tick >= 0.01 ? 3 : 5;
  return Number(p.toFixed(decimals));
}
