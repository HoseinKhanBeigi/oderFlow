import { clamp } from '../core/integrity.js';

/** Tick used to snap generated liquidity targets — scale-aware, not BTC-specific. */
export function tickSizeForPrice(price: number): number {
  if (price >= 10_000) return 0.1;
  if (price >= 1_000) return 0.1;
  if (price >= 100) return 0.01;
  if (price >= 10) return 0.001;
  if (price >= 1) return 0.0001;
  return 0.00001;
}

export function roundToTick(price: number, tick = tickSizeForPrice(price)): number {
  if (tick <= 0) return price;
  return Math.round(price / tick) * tick;
}

/**
 * ATR proxy: window high-low, floored at a minimum percent of price so quiet books still get a grid.
 */
export function atrFromRange(price: number, high: number, low: number, minPctOfPrice: number): number {
  const range = high > 0 && low > 0 ? Math.abs(high - low) : 0;
  const floor = price * (minPctOfPrice / 100);
  return Math.max(range, floor, tickSizeForPrice(price));
}

export function distancePercent(from: number, to: number): number {
  if (from <= 0) return 0;
  return ((to - from) / from) * 100;
}

export function efficiencyFactor(efficiency: 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME'): number {
  if (efficiency === 'LOW') return 0.25;
  if (efficiency === 'EXTREME') return 1;
  if (efficiency === 'HIGH') return 0.85;
  return 0.55;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
