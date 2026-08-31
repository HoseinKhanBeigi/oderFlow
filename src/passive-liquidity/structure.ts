import type { PassiveLiquidityConfig } from '../config/types.js';
import { clamp, safeDiv } from '../core/integrity.js';
import type {
  LiquidityStructureState,
  LiquidityZone,
  PassiveSide,
  PriceLevelMemory,
} from '../models/passive-liquidity.js';
import { replenishmentRatio } from './level-scores.js';

interface ZoneAccumulator {
  side: PassiveSide;
  priceMin: number;
  priceMax: number;
  testCount: number;
  defendedTests: number;
  brokenTests: number;
  aggressionAbsorbed: number;
  consumedNotional: number;
  replenishedNotional: number;
  cancelledNotional: number;
  firstSeenAt: number;
  lastTestAt: number;
  extendedThrough: boolean;
  defenseScores: number[];
}

/**
 * Groups defended prices into support/resistance zones.
 *
 * A single defended test is never a confirmed floor. Confirmation requires
 * repeated tests where liquidity kept coming back, cancellations stayed low and
 * price failed to extend through.
 */
export function buildZones(
  memory: PriceLevelMemory[],
  config: PassiveLiquidityConfig,
  mid: number,
): LiquidityZone[] {
  if (mid <= 0) return [];
  const tolerance = mid * (config.zoneBps / 10_000);
  const zones: ZoneAccumulator[] = [];

  const ordered = [...memory]
    .filter((m) => m.attacks > 0)
    .sort((a, b) => a.price - b.price);

  for (const entry of ordered) {
    const existing = zones.find(
      (z) => z.side === entry.side && entry.price >= z.priceMin - tolerance && entry.price <= z.priceMax + tolerance,
    );
    if (existing) {
      existing.priceMin = Math.min(existing.priceMin, entry.price);
      existing.priceMax = Math.max(existing.priceMax, entry.price);
      existing.testCount += entry.attacks;
      existing.defendedTests += entry.defendedTests;
      existing.brokenTests += entry.brokenTests;
      existing.aggressionAbsorbed += entry.totalAggressionAbsorbed;
      existing.consumedNotional += entry.totalConsumed;
      existing.replenishedNotional += entry.totalReplenished;
      existing.cancelledNotional += entry.totalCancelled;
      existing.firstSeenAt = Math.min(existing.firstSeenAt, entry.firstSeenAt);
      existing.lastTestAt = Math.max(existing.lastTestAt, entry.lastTestAt);
      existing.extendedThrough = existing.extendedThrough || entry.extendedThrough;
      existing.defenseScores.push(entry.defenseScore);
      continue;
    }
    zones.push({
      side: entry.side,
      priceMin: entry.price,
      priceMax: entry.price,
      testCount: entry.attacks,
      defendedTests: entry.defendedTests,
      brokenTests: entry.brokenTests,
      aggressionAbsorbed: entry.totalAggressionAbsorbed,
      consumedNotional: entry.totalConsumed,
      replenishedNotional: entry.totalReplenished,
      cancelledNotional: entry.totalCancelled,
      firstSeenAt: entry.firstSeenAt,
      lastTestAt: entry.lastTestAt,
      extendedThrough: entry.extendedThrough,
      defenseScores: [entry.defenseScore],
    });
  }

  return zones.map((zone) => finalize(zone, config, mid)).sort((a, b) => b.strength - a.strength);
}

function finalize(
  zone: ZoneAccumulator,
  config: PassiveLiquidityConfig,
  mid: number,
): LiquidityZone {
  const ratio = replenishmentRatio(zone.replenishedNotional, zone.consumedNotional);
  const pulled = clamp(
    safeDiv(zone.cancelledNotional, zone.cancelledNotional + zone.consumedNotional),
    0,
    1,
  );
  const held = clamp(safeDiv(zone.defendedTests, zone.testCount), 0, 1);
  const meanDefense = zone.defenseScores.length
    ? zone.defenseScores.reduce((s, v) => s + v, 0) / zone.defenseScores.length
    : 0;

  const centre = (zone.priceMin + zone.priceMax) / 2;
  const displacementBps = centre > 0
    ? (Math.abs(mid - centre) / centre) * 10_000
    : 0;

  const strength = clamp(
    0.35 * (meanDefense / 100) +
      0.25 * held +
      0.2 * clamp(ratio, 0, 1) +
      0.2 * clamp(zone.testCount / config.confirmedTestCount, 0, 1) -
      0.3 * pulled -
      (zone.extendedThrough ? 0.25 : 0),
    0,
    1,
  ) * 100;

  const state = classify(zone, ratio, pulled, held, config);
  const confidence = clamp(
    0.5 * clamp(zone.testCount / config.confirmedTestCount, 0, 1) + 0.5 * (strength / 100),
    0,
    1,
  ) * 100;

  return {
    side: zone.side,
    priceMin: zone.priceMin,
    priceMax: zone.priceMax,
    state,
    testCount: zone.testCount,
    defendedTests: zone.defendedTests,
    aggressionAbsorbed: zone.aggressionAbsorbed,
    consumedNotional: zone.consumedNotional,
    replenishedNotional: zone.replenishedNotional,
    cancelledNotional: zone.cancelledNotional,
    replenishmentRatio: ratio,
    displacementBps,
    strength,
    confidence,
    firstSeenAt: zone.firstSeenAt,
    lastTestAt: zone.lastTestAt,
  };
}

function classify(
  zone: ZoneAccumulator,
  ratio: number,
  pulled: number,
  held: number,
  config: PassiveLiquidityConfig,
): LiquidityStructureState {
  const floor = zone.side === 'BID';

  if (zone.extendedThrough && zone.brokenTests > 0 && ratio < 0.4) {
    return floor ? 'BROKEN_SUPPORT' : 'BROKEN_RESISTANCE';
  }
  if (zone.defendedTests >= config.confirmedTestCount && ratio >= 0.6 && pulled <= 0.4) {
    return floor ? 'CONFIRMED_SUPPORT' : 'CONFIRMED_RESISTANCE';
  }
  if (zone.defendedTests >= config.buildingTestCount && held >= 0.5 && ratio >= 0.4) {
    return floor ? 'BUILDING_FLOOR' : 'BUILDING_CEILING';
  }
  if (zone.defendedTests >= config.buildingTestCount && (pulled > 0.5 || ratio < 0.3)) {
    return floor ? 'WEAKENING_SUPPORT' : 'WEAKENING_RESISTANCE';
  }
  return floor ? 'POTENTIAL_FLOOR' : 'POTENTIAL_CEILING';
}

const FLOOR_STATES: LiquidityStructureState[] = [
  'CONFIRMED_SUPPORT',
  'BUILDING_FLOOR',
  'POTENTIAL_FLOOR',
];
const CEILING_STATES: LiquidityStructureState[] = [
  'CONFIRMED_RESISTANCE',
  'BUILDING_CEILING',
  'POTENTIAL_CEILING',
];

/** Strongest live floor below mid, ignoring broken and weakening zones. */
export function pickFloor(zones: LiquidityZone[], mid: number): LiquidityZone | null {
  return pick(zones, 'BID', FLOOR_STATES, (zone) => zone.priceMax <= mid);
}

export function pickCeiling(zones: LiquidityZone[], mid: number): LiquidityZone | null {
  return pick(zones, 'ASK', CEILING_STATES, (zone) => zone.priceMin >= mid);
}

function pick(
  zones: LiquidityZone[],
  side: PassiveSide,
  states: LiquidityStructureState[],
  positional: (zone: LiquidityZone) => boolean,
): LiquidityZone | null {
  let best: LiquidityZone | null = null;
  for (const zone of zones) {
    if (zone.side !== side || !states.includes(zone.state) || !positional(zone)) continue;
    if (!best || zone.strength > best.strength) best = zone;
  }
  return best;
}
