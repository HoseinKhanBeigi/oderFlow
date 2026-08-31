import type { PassiveLiquidityFeatures } from '../models/passive-liquidity.js';

/**
 * Keeps bar-aligned passive-liquidity features for the current process session
 * so the Backtest Lab can read measured book behaviour instead of trade-derived
 * proxies over the recent past.
 *
 * Order book history is not persisted, so this only covers the window since the
 * process started. Everything older keeps using the proxies, which is why every
 * passive metric in the Lab is gated on `hasPassiveLiquidity`.
 *
 * The stored value is the last sample seen inside the bar. The engine's
 * consumption/replenishment figures are already rolling sums over its metric
 * window, so for the 1-minute bars recorded here the final sample is a close
 * approximation of the bar's own activity rather than a point-in-time reading.
 */
export class PassiveFeatureRecorder {
  private readonly bars = new Map<string, Map<number, PassiveLiquidityFeatures>>();

  constructor(
    private readonly barSeconds = 60,
    private readonly maxBarsPerSymbol = 1440,
  ) {}

  record(symbol: string, atMs: number, features: PassiveLiquidityFeatures): void {
    const sec = Math.floor(atMs / 1000);
    const barTime = sec - (sec % this.barSeconds);
    let series = this.bars.get(symbol);
    if (!series) {
      series = new Map();
      this.bars.set(symbol, series);
    }
    series.set(barTime, features);
    if (series.size > this.maxBarsPerSymbol) {
      const oldest = Math.min(...series.keys());
      series.delete(oldest);
    }
  }

  /**
   * Features re-aligned to the requested timeframe. When several 1-minute
   * samples fall into one bar the last one wins, matching how a bar's closing
   * state is what a rule evaluated at bar close would have seen.
   */
  range(symbol: string, tfMinutes: number, fromSec: number, toSec: number): Map<number, PassiveLiquidityFeatures> {
    const out = new Map<number, PassiveLiquidityFeatures>();
    const series = this.bars.get(symbol);
    if (!series) return out;
    const bucket = Math.max(1, Math.round(tfMinutes)) * 60;
    const times = [...series.keys()].sort((a, b) => a - b);
    for (const t of times) {
      if (t < fromSec || t >= toSec) continue;
      const features = series.get(t);
      if (features) out.set(t - (t % bucket), features);
    }
    return out;
  }

  coveredBars(symbol: string): number {
    return this.bars.get(symbol)?.size ?? 0;
  }
}
