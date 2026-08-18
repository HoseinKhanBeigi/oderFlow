import type { AlertThresholds } from '../config/types.js';
import type { AlertEvent, WindowSnapshot } from '../models/signals.js';
import { formatQuote } from '../core/integrity.js';

export function buildAlerts(
  snapshot: WindowSnapshot,
  thresholds: AlertThresholds,
  now: number,
): AlertEvent[] {
  const alerts: AlertEvent[] = [];
  const base = {
    symbol: snapshot.symbol,
    window: snapshot.window,
    timestamp: now,
  };

  if (snapshot.buyBurstDetected && snapshot.aggressiveBuyVolume >= thresholds.extremeBurstQuote) {
    alerts.push({
      ...base,
      type: 'EXTREME BUY BURST',
      message: `Extreme aggressive buy burst ${formatQuote(snapshot.aggressiveBuyVolume)}`,
      payload: { volume: snapshot.aggressiveBuyVolume },
    });
  }
  if (snapshot.sellBurstDetected && snapshot.aggressiveSellVolume >= thresholds.extremeBurstQuote) {
    alerts.push({
      ...base,
      type: 'EXTREME SELL BURST',
      message: `Extreme aggressive sell burst ${formatQuote(snapshot.aggressiveSellVolume)}`,
      payload: { volume: snapshot.aggressiveSellVolume },
    });
  }
  if (snapshot.window === '10s' && snapshot.delta >= thresholds.netFlow10sQuote) {
    alerts.push({
      ...base,
      type: `>${formatQuote(thresholds.netFlow10sQuote)} NET BUY FLOW IN 10S`,
      message: `Net aggressive buy flow ${formatQuote(snapshot.delta)} in 10s`,
      payload: { delta: snapshot.delta },
    });
  }
  if (snapshot.window === '10s' && snapshot.delta <= -thresholds.netFlow10sQuote) {
    alerts.push({
      ...base,
      type: `>${formatQuote(thresholds.netFlow10sQuote)} NET SELL FLOW IN 10S`,
      message: `Net aggressive sell flow ${formatQuote(snapshot.delta)} in 10s`,
      payload: { delta: snapshot.delta },
    });
  }
  if (snapshot.state === 'BUYER_ABSORPTION' || (snapshot.delta > 0 && snapshot.priceImpactEfficiency === 'LOW' && snapshot.flowMultipleBuy >= 3)) {
    alerts.push({
      ...base,
      type: snapshot.state === 'BUYER_ABSORPTION' ? 'POSSIBLE BUYER ABSORPTION' : 'LARGE BUY FLOW WITHOUT PRICE RESPONSE',
      message: 'Large aggressive buying with little upward price response',
      payload: { delta: snapshot.delta, priceChangePercent: snapshot.priceChangePercent },
    });
  }
  if (snapshot.state === 'SELLER_ABSORPTION' || (snapshot.delta < 0 && snapshot.priceImpactEfficiency === 'LOW' && snapshot.flowMultipleSell >= 3)) {
    alerts.push({
      ...base,
      type: snapshot.state === 'SELLER_ABSORPTION' ? 'POSSIBLE SELLER ABSORPTION' : 'LARGE SELL FLOW WITHOUT PRICE RESPONSE',
      message: 'Large aggressive selling with little downward price response',
      payload: { delta: snapshot.delta, priceChangePercent: snapshot.priceChangePercent },
    });
  }
  return alerts;
}
