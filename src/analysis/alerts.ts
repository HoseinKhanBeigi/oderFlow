import type { AlertThresholds } from '../config/types.js';
import type { AlertEvent, WindowSnapshot } from '../models/signals.js';
import type { WindowId } from '../models/trade.js';

/** Windows noisy enough that a spike is not worth a ping. */
const SKIP_WINDOWS = new Set<WindowId>(['1s', '5s', '10s', '30s']);

/** Minimum |price change %| before a window counts as expanding. */
const MIN_MOVE_PCT: Partial<Record<WindowId, number>> = {
  '1m': 0.2,
  '5m': 0.35,
  '15m': 0.5,
};

/**
 * True when price is actually expanding in this window.
 * Large flow with no displacement (absorption / dead tape) is not volatility.
 */
export function isVolatileWindow(snapshot: WindowSnapshot): boolean {
  if (SKIP_WINDOWS.has(snapshot.window)) return false;
  const absPct = Math.abs(snapshot.priceChangePercent);
  const floor = MIN_MOVE_PCT[snapshot.window] ?? 0.25;
  if (absPct < floor) return false;

  const impact = snapshot.priceImpactEfficiency;
  if (impact === 'HIGH' || impact === 'EXTREME') return true;
  if (snapshot.state === 'LIQUIDITY_VACUUM_UP' || snapshot.state === 'LIQUIDITY_VACUUM_DOWN') return true;
  return absPct >= floor * 2;
}

export function buildAlerts(
  snapshot: WindowSnapshot,
  _thresholds: AlertThresholds,
  now: number,
): AlertEvent[] {
  if (!isVolatileWindow(snapshot)) return [];

  const dir = snapshot.priceChangePercent >= 0 ? 'UP' : 'DOWN';
  const pct = snapshot.priceChangePercent;
  const bits: string[] = [];
  if (snapshot.buyBurstDetected) bits.push('buy burst');
  if (snapshot.sellBurstDetected) bits.push('sell burst');
  if (snapshot.state === 'LIQUIDITY_VACUUM_UP' || snapshot.state === 'LIQUIDITY_VACUUM_DOWN') {
    bits.push('liquidity vacuum');
  }
  const extra = bits.length ? ` · ${bits.join(' · ')}` : '';

  return [
    {
      symbol: snapshot.symbol,
      window: snapshot.window,
      timestamp: now,
      type: `VOLATILITY ${dir}`,
      message: `Range expanding ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% in ${snapshot.window}${extra}`,
      payload: {
        priceChangePercent: pct,
        absolutePriceChange: snapshot.absolutePriceChange,
        impact: snapshot.priceImpactEfficiency,
      },
    },
  ];
}
