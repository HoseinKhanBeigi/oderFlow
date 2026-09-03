import { describe, expect, it } from 'vitest';
import {
  buildNetAggression,
  classifyNetAggression,
} from '../src/flow/net-aggression.js';

describe('net aggression', () => {
  it('computes net, imbalance, and velocities from executed flow only', () => {
    const snap = buildNetAggression({
      window: '15m',
      buyVolume: 18_200_000,
      sellVolume: 11_700_000,
      buyCount: 4281,
      sellCount: 3604,
      largeBuyVolume: 5_800_000,
      largeSellVolume: 2_900_000,
      buyPercentile: 78,
      sellPercentile: 55,
      netMagnitudePercentile: 72,
    });

    expect(snap.net).toBeCloseTo(6_500_000);
    expect(snap.imbalance).toBeCloseTo(6_500_000 / (18_200_000 + 11_700_000));
    expect(snap.buy.velocityPerSec).toBeCloseTo(18_200_000 / 900);
    expect(snap.sell.averageTradeSize).toBeCloseTo(11_700_000 / 3604);
    expect(snap.state).toBe('BUY_AGGRESSION');
    expect(snap.netPercentile).toBe(72);
  });

  it('classifies strong buy only with imbalance and buy percentile', () => {
    expect(classifyNetAggression(0.4, 75, 40)).toBe('STRONG_BUY_AGGRESSION');
    expect(classifyNetAggression(0.4, 50, 40)).toBe('BUY_AGGRESSION');
    expect(classifyNetAggression(0.05, 50, 50)).toBe('BALANCED');
    expect(classifyNetAggression(-0.4, 40, 80)).toBe('STRONG_SELL_AGGRESSION');
  });

  it('stays balanced when volumes are equal', () => {
    const snap = buildNetAggression({
      window: '1m',
      buyVolume: 1_000_000,
      sellVolume: 1_000_000,
      buyCount: 100,
      sellCount: 100,
      largeBuyVolume: 0,
      largeSellVolume: 0,
      buyPercentile: 50,
      sellPercentile: 50,
      netMagnitudePercentile: 40,
    });
    expect(snap.net).toBe(0);
    expect(snap.imbalance).toBe(0);
    expect(snap.state).toBe('BALANCED');
  });
});
