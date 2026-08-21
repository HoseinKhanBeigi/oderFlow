import type { MovePotentialConfig } from '../config/types.js';
import { roundToTick, tickSizeForPrice } from './math.js';

/**
 * Builds upside/downside price grids from percent steps and ATR multiples.
 * Distances are relative to this asset's price and volatility — never hardcoded BTC dollars.
 */
export class LiquidityTargetGenerator {
  constructor(private readonly config: MovePotentialConfig) {}

  prices(currentPrice: number, atr: number, side: 'UP' | 'DOWN'): number[] {
    if (currentPrice <= 0) return [];
    const tick = tickSizeForPrice(currentPrice);
    const seen = new Set<string>();
    const out: number[] = [];

    const push = (raw: number) => {
      const price = roundToTick(raw, tick);
      if (side === 'UP' && price <= currentPrice) return;
      if (side === 'DOWN' && price >= currentPrice) return;
      if (price <= 0) return;
      const key = price.toFixed(8);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(price);
    };

    for (const pct of this.config.percentSteps) {
      const delta = currentPrice * (pct / 100);
      push(side === 'UP' ? currentPrice + delta : currentPrice - delta);
    }
    for (const mult of this.config.atrMultiples) {
      const delta = atr * mult;
      if (delta <= 0) continue;
      push(side === 'UP' ? currentPrice + delta : currentPrice - delta);
    }

    out.sort((a, b) => (side === 'UP' ? a - b : b - a));
    return out.slice(0, this.config.maxTargetsPerSide);
  }
}
