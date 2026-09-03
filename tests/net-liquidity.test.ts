import { describe, expect, it } from 'vitest';
import type { PassiveLiquidityLevel } from '../src/models/passive-liquidity.js';
import {
  calculateNetLiquiditySide,
  NetLiquidityTracker,
} from '../src/passive-liquidity/net-liquidity.js';
import type { ObservationDelta, SideFlowDelta } from '../src/passive-liquidity/level-tracker.js';

const amount = (notional: number) => ({ quantity: notional / 100, notional });

function calculate(values: {
  start: number;
  current: number;
  newAdded?: number;
  replenished?: number;
  cancelled?: number;
  consumed?: number;
}) {
  const replenished = values.replenished ?? 0;
  return calculateNetLiquiditySide({
    side: 'ASK',
    elapsedMs: 10_000,
    starting: amount(values.start),
    current: amount(values.current),
    // Existing engine accounting includes replenishment inside added.
    added: amount((values.newAdded ?? 0) + replenished),
    replenished: amount(replenished),
    cancelled: amount(values.cancelled ?? 0),
    consumed: amount(values.consumed ?? 0),
    trustworthy: true,
  });
}

describe('net liquidity change', () => {
  it('reconciles new additions, replenishment, cancellation, and consumption', () => {
    const result = calculate({
      start: 20_000_000,
      current: 16_000_000,
      newAdded: 5_000_000,
      replenished: 3_000_000,
      cancelled: 10_000_000,
      consumed: 2_000_000,
    });
    expect(result.newAdded).toBe(5_000_000);
    expect(result.behavioralNetChange).toBe(-4_000_000);
    expect(result.bookNetChange).toBe(-4_000_000);
    expect(result.reconciliationError).toBe(0);
  });

  it('stays stable when cancellation is fully replaced', () => {
    const result = calculate({
      start: 20_000_000,
      current: 20_000_000,
      replenished: 15_000_000,
      cancelled: 15_000_000,
    });
    expect(result.bookNetChange).toBe(0);
    expect(result.state).toBe('STABLE');
  });

  it('identifies consumption-dominated strong shrinkage', () => {
    const result = calculate({
      start: 20_000_000,
      current: 3_000_000,
      cancelled: 2_000_000,
      consumed: 15_000_000,
    });
    expect(result.bookNetChange).toBe(-17_000_000);
    expect(result.state).toBe('STRONGLY_SHRINKING');
    expect(result.primaryCause).toBe('CONSUMPTION');
  });

  it('identifies withdrawal-dominated shrinkage', () => {
    const result = calculate({
      start: 20_000_000,
      current: 5_000_000,
      newAdded: 1_000_000,
      replenished: 1_000_000,
      cancelled: 15_000_000,
      consumed: 2_000_000,
    });
    expect(result.bookNetChange).toBe(-15_000_000);
    expect(result.primaryCause).toBe('WITHDRAWAL');
  });

  it('reports moving-band migration without calling it cancellation', () => {
    const tracker = new NetLiquidityTracker(32, [0, 5, 10]);
    const zero = (): SideFlowDelta => ({
      addedQuantity: 0, addedNotional: 0, consumedQuantity: 0, consumedNotional: 0,
      cancelledQuantity: 0, cancelledNotional: 0, replenishedQuantity: 0, replenishedNotional: 0,
    });
    const delta = (at: number, mid: number): ObservationDelta => ({
      at, mid, bid: zero(), ask: zero(), levels: [], truncatedLevels: 0, invalidLevels: 0, crossedBook: false,
    });
    const level = (distanceBps: number) => [{
      side: 'ASK', price: 100, quantity: 100, notionalValue: 10_000, distanceBps, outOfView: false,
    }] as PassiveLiquidityLevel[];

    tracker.observe(1_000, 99.95, level(5.1), delta(1_000, 99.95));
    tracker.observe(2_000, 99.96, level(4.0), delta(2_000, 99.96));
    const result = tracker.snapshot(2_000, 1_000, true);

    expect(result.near5Bps.ask.bookNetChange).toBe(10_000);
    expect(result.near5Bps.ask.behavioralNetChange).toBe(0);
    expect(result.near5Bps.ask.cancelled).toBe(0);
    expect(result.near5Bps.ask.state).toBe('LOW_CONFIDENCE');
    expect(result.bands[0]?.rangeMigration.ask).toBe(10_000);
  });
});
