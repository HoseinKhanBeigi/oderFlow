import type { LocalOrderBook } from '../liquidity/local-order-book.js';
import type { BookLevel } from '../models/trade.js';

/**
 * Price-increment estimator for passive liquidity tracking.
 *
 * The footprint chart buckets prices coarsely on purpose — a $10 grid keeps a
 * BTC chart readable. This engine needs the opposite: individual resting levels
 * must stay distinct, because "the bid at 50,000.3 refilled four times" is the
 * observation, and bucketing it together with 50,000.9 destroys it.
 *
 * The venue's real increment is not published on the depth stream, so it is
 * inferred from the smallest gap between adjacent quoted prices. The estimate
 * only ever ratchets down: a temporarily sparse book (gaps at several ticks)
 * must not coarsen a grid that was already observed to be finer.
 */
export class BookTickEstimator {
  private estimate = 0;

  get tick(): number {
    return this.estimate;
  }

  observe(book: LocalOrderBook): number {
    const gap = Math.min(
      smallestGap(book.sortedLevels('bid')),
      smallestGap(book.sortedLevels('ask')),
    );
    if (Number.isFinite(gap) && gap > 0) {
      const clean = cleanTick(gap);
      this.estimate = this.estimate === 0 ? clean : Math.min(this.estimate, clean);
    }
    if (this.estimate === 0) {
      const mid = book.mid();
      if (Number.isFinite(mid) && mid > 0) this.estimate = fallbackTick(mid);
    }
    return this.estimate;
  }

  /** A single-level book never reveals a gap, so fall back on magnitude. */
  tickFor(price: number): number {
    if (this.estimate > 0) return this.estimate;
    return fallbackTick(price);
  }

  reset(): void {
    this.estimate = 0;
  }
}

function smallestGap(levels: BookLevel[]): number {
  let min = Infinity;
  for (let i = 1; i < levels.length; i++) {
    const gap = Math.abs(levels[i]!.price - levels[i - 1]!.price);
    // Sub-nano gaps are float noise, not a real increment.
    if (gap > 1e-9 && gap < min) min = gap;
  }
  return min;
}

/**
 * Snaps a measured gap onto the nearest 1/2/5 x 10^n increment.
 *
 * Subtracting quoted prices yields values like 0.09999999999854481, and using
 * that raw as the grid produces level keys such as 49999.89999927 — which are
 * unusable as display prices and drift apart across observations. Every venue
 * quotes on a 1, 2 or 5 significant-digit increment, so rounding to that family
 * recovers the true grid.
 */
export function cleanTick(gap: number): number {
  if (!Number.isFinite(gap) || gap <= 0) return 0;
  const exponent = Math.floor(Math.log10(gap));
  const scale = 10 ** exponent;
  const mantissa = gap / scale;
  const snapped = mantissa <= 1.5 ? 1 : mantissa <= 3.5 ? 2 : mantissa <= 7.5 ? 5 : 10;
  return Number((snapped * scale).toPrecision(12));
}

/** Conservative guess used only until the book reveals its real increment. */
function fallbackTick(price: number): number {
  if (price >= 10_000) return 0.1;
  if (price >= 1_000) return 0.01;
  if (price >= 100) return 0.01;
  if (price >= 10) return 0.001;
  if (price >= 1) return 0.0001;
  return 0.000001;
}

/**
 * Stable map key for a price on a given grid. Rounded because
 * `Math.round(p / 0.1) * 0.1` yields values like 50000.300000000004, which
 * would otherwise split one level across several keys.
 */
export function levelKey(price: number, tick: number): number {
  const size = tick > 0 ? tick : fallbackTick(price);
  return Number((Math.round(price / size) * size).toFixed(8));
}
