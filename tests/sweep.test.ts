import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SWEEP_CONFIG,
  detectLiquiditySweep,
  formatSweepAlert,
  type SweepCandle,
} from '../src/footprint/sweep.js';

const T0 = 1_700_000_000;

function candle(
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 800_000,
): SweepCandle {
  return {
    time: T0 + i * 300,
    open,
    high,
    low,
    close,
    volume,
    totalBuy: volume * 0.5,
    totalSell: volume * 0.5,
  };
}

/** Resistance 101.50, support 99.80, typical range 0.40 so a 0.8+ range expands. */
function priorLevels(n = 16): SweepCandle[] {
  const out: SweepCandle[] = [];
  out.push(candle(0, 101.35, 101.5, 101.2, 101.28));
  out.push(candle(1, 100.0, 100.1, 99.8, 99.95));
  for (let i = 2; i < n; i++) {
    out.push(candle(i, 100.45, 100.7, 100.3, 100.5));
  }
  return out;
}

function nowFor(bars: SweepCandle[]): number {
  const last = bars[bars.length - 1]!;
  return last.time * 1000 + 60_000;
}

function detect(bars: SweepCandle[], tf = 5) {
  return detectLiquiditySweep(bars, { timeframeMinutes: tf, nowMs: nowFor(bars) });
}

describe('liquidity sweep detector', () => {
  it('needs 16 completed bars before classifying', () => {
    const bars = [...priorLevels(10), candle(10, 101.4, 101.82, 100.9, 101.2, 2_000_000)];
    const read = detect(bars);
    expect(read.state).toBe('NO_DATA');
    expect(read.alertable).toBe(false);
  });

  it('does not include the current candle in resistance / support', () => {
    const bars = [...priorLevels(16), candle(16, 101.4, 102.4, 100.9, 101.2, 2_000_000)];
    const read = detect(bars);
    expect(read.resistance).toBeCloseTo(101.5, 6);
    expect(read.support).toBeCloseTo(99.8, 6);
    expect(read.high).toBeCloseTo(102.4, 6);
  });

  it('detects a high sweep / bearish rejection without labeling SHORT', () => {
    const bars = [...priorLevels(16), candle(16, 101.4, 101.82, 100.9, 101.2, 2_000_000)];
    const read = detect(bars, 15);
    expect(read.state).toBe('HIGH_SWEEP');
    expect(read.bias).toBe('BEARISH_REJECTION');
    expect(read.closePosition!).toBeLessThanOrEqual(0.4);
    expect(read.highSweepPenetrationBps!).toBeGreaterThan(5);
    expect(read.sweepQuality!).toBeGreaterThanOrEqual(DEFAULT_SWEEP_CONFIG.minQualityForAlert);
    expect(read.alertable).toBe(true);
    const alert = formatSweepAlert(read, 'ZAMA');
    expect(alert?.title).toBe('ZAMA · High sweep');
    expect(alert?.detail).toContain('bearish rejection');
    expect(alert?.detail).not.toMatch(/SHORT|LONG|BUY|SELL/i);
  });

  it('detects a low sweep / bullish rejection without labeling LONG', () => {
    const bars = [...priorLevels(16), candle(16, 100.1, 100.4, 99.52, 100.05, 2_000_000)];
    const read = detect(bars, 5);
    expect(read.state).toBe('LOW_SWEEP');
    expect(read.bias).toBe('BULLISH_REJECTION');
    expect(read.closePosition!).toBeGreaterThanOrEqual(0.6);
    expect(read.lowSweepPenetrationBps!).toBeGreaterThan(5);
    expect(read.alertable).toBe(true);
    const alert = formatSweepAlert(read, 'ZAMA');
    expect(alert?.title).toBe('ZAMA · Low sweep');
    expect(alert?.detail).not.toMatch(/SHORT|LONG/i);
  });

  it('does not label a quiet wick as a sweep', () => {
    const bars = [...priorLevels(16), candle(16, 101.42, 101.56, 101.38, 101.41, 900_000)];
    const read = detect(bars);
    expect(read.state).toBe('NO_EVENT');
    expect(read.alertable).toBe(false);
  });

  it('does not treat a tiny poke beyond the level as a meaningful sweep', () => {
    const bars = [...priorLevels(16), candle(16, 101.2, 101.51, 100.4, 100.55, 2_000_000)];
    const read = detect(bars);
    expect(read.state).toBe('LOW_CONFIDENCE');
    expect(read.alertable).toBe(false);
  });

  it('classifies upside acceptance instead of a guaranteed breakout', () => {
    const bars = [...priorLevels(16), candle(16, 101.3, 101.85, 101.15, 101.7, 2_000_000)];
    const read = detect(bars);
    expect(read.state).toBe('UPSIDE_ACCEPTANCE');
    expect(read.bias).toBe('UPSIDE_ACCEPTANCE');
    expect(read.close).toBeGreaterThan(read.resistance!);
    expect(read.alertable).toBe(true);
    expect(formatSweepAlert(read, 'BTC')?.title).toBe('BTC · Upside acceptance');
  });

  it('classifies downside acceptance instead of a guaranteed breakdown', () => {
    const bars = [...priorLevels(16), candle(16, 100.1, 100.35, 99.4, 99.55, 2_000_000)];
    const read = detect(bars);
    expect(read.state).toBe('DOWNSIDE_ACCEPTANCE');
    expect(read.bias).toBe('DOWNSIDE_ACCEPTANCE');
    expect(read.close).toBeLessThan(read.support!);
  });

  it('ignores a tiny close beyond resistance as acceptance', () => {
    const bars = [...priorLevels(16), candle(16, 101.3, 101.7, 101.1, 101.52, 2_000_000)];
    const read = detect(bars);
    expect(read.state).not.toBe('UPSIDE_ACCEPTANCE');
  });

  it('marks stale candles', () => {
    const bars = [...priorLevels(16), candle(16, 101.4, 101.82, 100.9, 101.2, 2_000_000)];
    const read = detectLiquiditySweep(bars, {
      timeframeMinutes: 5,
      nowMs: bars[bars.length - 1]!.time * 1000 + 20 * 60_000,
    });
    expect(read.state).toBe('STALE');
    expect(read.alertable).toBe(false);
  });

  it('confirms a high sweep when the next candle does not reclaim resistance', () => {
    const sweep = candle(16, 101.4, 101.82, 100.9, 101.2, 2_000_000);
    const hold = candle(17, 101.15, 101.35, 100.7, 100.95, 1_500_000);
    const read = detect([...priorLevels(16), sweep, hold], 15);
    expect(read.state).toBe('HIGH_SWEEP_CONFIRMED');
    expect(read.bias).toBe('BEARISH_REJECTION');
    expect(read.alertable).toBe(true);
  });

  it('marks a failed high sweep when the next candle reclaims resistance', () => {
    const sweep = candle(16, 101.4, 101.82, 100.9, 101.2, 2_000_000);
    const reclaim = candle(17, 101.25, 101.9, 101.1, 101.72, 1_800_000);
    const read = detect([...priorLevels(16), sweep, reclaim], 15);
    expect(read.state).toBe('FAILED_HIGH_SWEEP');
    expect(read.alertable).toBe(false);
  });

  it('confirms a low sweep when the next candle holds above support', () => {
    const sweep = candle(16, 100.1, 100.4, 99.52, 100.05, 2_000_000);
    const hold = candle(17, 100.1, 100.55, 99.9, 100.35, 1_500_000);
    const read = detect([...priorLevels(16), sweep, hold], 5);
    expect(read.state).toBe('LOW_SWEEP_CONFIRMED');
    expect(read.alertable).toBe(true);
  });
});
