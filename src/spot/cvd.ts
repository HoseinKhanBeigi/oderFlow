import { CVDEngine, type CvdSnapshot } from '../flow/cvd-engine.js';
import type { SpotExchangeId } from './types.js';

const SLOPE_MS = 60_000;

/** Per-venue plus aggregated spot CVD. Never mixed with futures CVD. */
export class SpotCvdBook {
  private readonly venues = new Map<SpotExchangeId, CVDEngine>();
  readonly aggregated = new CVDEngine(SLOPE_MS);

  venue(exchange: SpotExchangeId): CVDEngine {
    let engine = this.venues.get(exchange);
    if (!engine) {
      engine = new CVDEngine(SLOPE_MS);
      this.venues.set(exchange, engine);
    }
    return engine;
  }

  onTrade(exchange: SpotExchangeId, timestamp: number, buyQuote: number, sellQuote: number, price: number): void {
    this.venue(exchange).onTrade(timestamp, buyQuote, sellQuote, price);
    this.aggregated.onTrade(timestamp, buyQuote, sellQuote, price);
  }

  snapshot(exchange: SpotExchangeId | 'all', now: number): CvdSnapshot {
    if (exchange === 'all') return this.aggregated.snapshot(now);
    return this.venue(exchange).snapshot(now);
  }

  value(exchange: SpotExchangeId | 'all'): number {
    if (exchange === 'all') return this.aggregated.value;
    return this.venue(exchange).value;
  }
}
