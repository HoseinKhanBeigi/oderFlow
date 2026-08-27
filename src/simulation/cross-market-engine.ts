import type { CrossMarketSimulationState, CrossMarketState, WhyFact } from './types.js';
import { MarketSimulationEngine } from './market-simulation-engine.js';
import type { SimulationEvent } from './events.js';

/**
 * Two independent channels (spot, futures). Combined labels are
 * interpretations of both books — they do not sum notionals blindly.
 */
export class CrossMarketSimulationEngine {
  readonly spot: MarketSimulationEngine;
  readonly futures: MarketSimulationEngine;

  constructor(opts: { symbol?: string; tickSize?: number; spot?: MarketSimulationEngine; futures?: MarketSimulationEngine } = {}) {
    const symbol = opts.symbol ?? 'BTCUSDT';
    this.spot = opts.spot ?? new MarketSimulationEngine({
      symbol,
      marketType: 'spot',
      tickSize: opts.tickSize,
      fillMode: 'walk',
    });
    this.futures = opts.futures ?? new MarketSimulationEngine({
      symbol,
      marketType: 'perp',
      tickSize: opts.tickSize,
      fillMode: 'walk',
    });
  }

  reset(price = 0): void {
    this.spot.reset(price);
    this.futures.reset(price);
  }

  ingest(event: SimulationEvent): void {
    if (event.marketType === 'spot') this.spot.ingest(event);
    else this.futures.ingest(event);
  }

  tick(now: number): CrossMarketSimulationState {
    this.spot.tick(now);
    this.futures.tick(now);
    return this.snapshot();
  }

  snapshot(): CrossMarketSimulationState {
    const spot = this.spot.snapshot();
    const futures = this.futures.snapshot();
    const combined = classifyCross(spot, futures);
    return {
      timestamp: Math.max(spot.timestamp, futures.timestamp),
      symbol: futures.symbol,
      spot,
      futures,
      combined,
      why: whyCross(spot, futures, combined),
    };
  }
}

export function classifyCross(
  spot: { aggressiveBuy: number; aggressiveSell: number; delta: number; priceChangeBps: number } | null,
  futures: {
    aggressiveBuy: number;
    aggressiveSell: number;
    delta: number;
    priceChangeBps: number;
    shortLiquidations?: number;
    longLiquidations?: number;
    oiClassification?: string;
  } | null,
): CrossMarketState {
  if (!spot || !futures) return 'INSUFFICIENT';
  const sDelta = spot.delta;
  const fDelta = futures.delta;
  const sBuy = sDelta > 0 && spot.aggressiveBuy > spot.aggressiveSell * 1.2;
  const sSell = sDelta < 0 && spot.aggressiveSell > spot.aggressiveBuy * 1.2;
  const fBuy = fDelta > 0 && futures.aggressiveBuy > futures.aggressiveSell * 1.2;
  const fSell = fDelta < 0 && futures.aggressiveSell > futures.aggressiveBuy * 1.2;

  if ((futures.shortLiquidations ?? 0) > 0 && futures.oiClassification === 'SHORT_COVERING') {
    return 'SHORT_COVERING_DOMINATED';
  }
  if ((futures.longLiquidations ?? 0) > 0 && futures.oiClassification === 'LONG_UNWIND') {
    return 'LONG_LIQUIDATION_DOMINATED';
  }

  if (sBuy && fBuy) {
    if (Math.abs(sDelta) > Math.abs(fDelta) * 1.25) return 'SPOT_LED_BUYING';
    if (Math.abs(fDelta) > Math.abs(sDelta) * 1.25) return 'FUTURES_LED_BUYING';
    return 'BROAD_BUYING';
  }
  if (sSell && fSell) {
    if (Math.abs(sDelta) > Math.abs(fDelta) * 1.25) return 'SPOT_LED_SELLING';
    if (Math.abs(fDelta) > Math.abs(sDelta) * 1.25) return 'FUTURES_LED_SELLING';
    return 'BROAD_SELLING';
  }

  if ((sBuy && fSell) || (sSell && fBuy)) return 'SPOT_FUTURES_DIVERGENCE';

  if (sBuy && Math.abs(sDelta) > Math.abs(fDelta) * 1.25) return 'SPOT_LED_BUYING';
  if (sSell && Math.abs(sDelta) > Math.abs(fDelta) * 1.25) return 'SPOT_LED_SELLING';
  if (fBuy && Math.abs(fDelta) > Math.abs(sDelta) * 1.25) return 'FUTURES_LED_BUYING';
  if (fSell && Math.abs(fDelta) > Math.abs(sDelta) * 1.25) return 'FUTURES_LED_SELLING';

  if (sBuy || fBuy) return Math.abs(sDelta) >= Math.abs(fDelta) ? 'SPOT_LED_BUYING' : 'FUTURES_LED_BUYING';
  if (sSell || fSell) return Math.abs(sDelta) >= Math.abs(fDelta) ? 'SPOT_LED_SELLING' : 'FUTURES_LED_SELLING';
  return 'BALANCED';
}

function whyCross(
  spot: { delta: number; aggressiveBuy: number },
  futures: { delta: number; shortLiquidations?: number; oiClassification?: string },
  combined: CrossMarketState,
): WhyFact[] {
  const facts: WhyFact[] = [];
  facts.push({ text: `Combined state: ${combined.replace(/_/g, ' ')}`, weight: 1 });
  if (Math.abs(spot.delta) > Math.abs(futures.delta)) {
    facts.push({ text: 'Spot aggressive delta is larger than futures this tick', weight: 0.9 });
  } else if (Math.abs(futures.delta) > Math.abs(spot.delta)) {
    facts.push({ text: 'Futures aggressive delta is larger than spot this tick', weight: 0.9 });
  }
  if (futures.oiClassification && futures.oiClassification !== 'NEUTRAL') {
    facts.push({ text: `Open interest classification: ${futures.oiClassification.replace(/_/g, ' ')}`, weight: 0.8 });
  }
  if ((futures.shortLiquidations ?? 0) > 0) {
    facts.push({ text: 'Short liquidations are present on futures', weight: 0.85 });
  }
  return facts;
}
