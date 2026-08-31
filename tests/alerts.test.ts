import { describe, expect, it } from 'vitest';
import { buildAlerts, isVolatileWindow } from '../src/analysis/alerts.js';
import type { WindowSnapshot } from '../src/models/signals.js';

function snap(over: Partial<WindowSnapshot>): WindowSnapshot {
  return {
    symbol: 'BTCUSDT',
    window: '1m',
    priceChangePercent: 0,
    priceImpactEfficiency: 'NORMAL',
    state: 'NO_SIGNAL',
    buyBurstDetected: false,
    sellBurstDetected: false,
    absolutePriceChange: 0,
    ...over,
  } as WindowSnapshot;
}

const thresholds = { extremeBurstQuote: 1, netFlow10sQuote: 1 };

describe('volatility alerts', () => {
  it('does not notify a quiet 1m bar', () => {
    const s = snap({
      window: '1m',
      priceChangePercent: 0.04,
      priceImpactEfficiency: 'LOW',
      state: 'BUYER_ABSORPTION',
    });
    expect(isVolatileWindow(s)).toBe(false);
    expect(buildAlerts(s, thresholds, 1)).toEqual([]);
  });

  it('does not notify 10s spikes', () => {
    const s = snap({
      window: '10s',
      priceChangePercent: 0.8,
      priceImpactEfficiency: 'EXTREME',
      state: 'LIQUIDITY_VACUUM_UP',
    });
    expect(isVolatileWindow(s)).toBe(false);
    expect(buildAlerts(s, thresholds, 1)).toEqual([]);
  });

  it('notifies when 1m range expands with high impact', () => {
    const s = snap({
      window: '1m',
      priceChangePercent: 0.35,
      absolutePriceChange: 0.35,
      priceImpactEfficiency: 'HIGH',
      buyBurstDetected: true,
    });
    expect(isVolatileWindow(s)).toBe(true);
    const alerts = buildAlerts(s, thresholds, 1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.type).toBe('VOLATILITY UP');
    expect(alerts[0]!.message).toMatch(/expanding \+0\.35%/);
    expect(alerts[0]!.message).toMatch(/buy burst/);
  });

  it('notifies a 5m vacuum expansion down', () => {
    const s = snap({
      window: '5m',
      priceChangePercent: -0.5,
      priceImpactEfficiency: 'NORMAL',
      state: 'LIQUIDITY_VACUUM_DOWN',
    });
    const alerts = buildAlerts(s, thresholds, 1);
    expect(alerts[0]!.type).toBe('VOLATILITY DOWN');
  });
});
