import type { MarketType } from '../models/trade.js';

/**
 * Price bucketing for footprint levels.
 *
 * Must stay identical to `tickSize()` / `priceToTick()` in `public/app.js`,
 * otherwise stored bars and browser-rendered bars land on different buckets
 * and the chart shows two incompatible grids stitched together.
 *
 * Stocks use the official penny tick so names like NVDA do not collapse into
 * a $0.50 crypto bucket.
 */
export function tickSize(price: number, market: MarketType = 'perp'): number {
  if (market === 'stock') {
    return price >= 1 ? 0.01 : 0.0001;
  }
  if (price >= 10_000) return 10;
  if (price >= 1_000) return 1;
  if (price >= 100) return 0.5;
  if (price >= 10) return 0.1;
  if (price >= 1) return 0.01;
  return 0.001;
}

export function priceToTick(price: number, tick = tickSize(price)): number {
  // Rounded to 6dp because `Math.round(p / 0.001) * 0.001` yields values like
  // 0.30000000000000004, which would split one bucket into several keys.
  return Number((Math.round(price / tick) * tick).toFixed(6));
}

/** Bar open time in unix seconds for a millisecond timestamp. */
export function barTime(timestampMs: number, intervalMinutes = 1): number {
  const seconds = Math.floor(timestampMs / 1000);
  const bucket = intervalMinutes * 60;
  return seconds - (seconds % bucket);
}
