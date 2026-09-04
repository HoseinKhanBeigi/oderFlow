import { describe, expect, it } from 'vitest';
import { IntegrityMonitor } from '../src/core/integrity.js';

/**
 * Trade liveness must be measured on the local receive clock. Exchange event
 * time comes from a different clock, so mixing the two reported ordinary skew
 * as a stale feed and blanked the Market Battle read.
 */
describe('IntegrityMonitor trade liveness', () => {
  it('measures trade age from receive time, not exchange event time', () => {
    const m = new IntegrityMonitor(64, 2_000);
    const now = 1_000_000;
    // Exchange event time lags the local clock by 30s (clock skew + latency),
    // but the trade arrives right now.
    m.acceptTradeId(1, now - 30_000, now);

    expect(m.tradeAgeMs(now)).toBe(0);
    // The old event-time maths would have said 30s stale.
    expect(now - m.lastTradeTimestamp).toBe(30_000);
  });

  it('reports Infinity age when no trade has ever arrived', () => {
    const m = new IntegrityMonitor(64, 2_000);
    expect(m.tradeAgeMs(1_000)).toBe(Infinity);
  });

  it('ages from the last arrival as the clock advances', () => {
    const m = new IntegrityMonitor(64, 2_000);
    m.acceptTradeId(1, 500, 1_000);
    expect(m.tradeAgeMs(9_000)).toBe(8_000);
  });

  it('needs enough samples before reporting a median gap', () => {
    const m = new IntegrityMonitor(64, 2_000);
    for (let i = 0; i < 4; i++) m.acceptTradeId(i, i * 100, i * 100);
    expect(m.medianTradeGapMs()).toBe(0);
  });

  it('learns a quiet symbol cadence from its own inter-trade gaps', () => {
    const m = new IntegrityMonitor(64, 2_000);
    // A thin book printing every 20s — legitimately quiet, not broken.
    for (let i = 0; i < 20; i++) m.acceptTradeId(i, i * 20_000, i * 20_000);
    expect(m.medianTradeGapMs()).toBe(20_000);
  });

  it('ignores duplicate trades when tracking liveness', () => {
    const m = new IntegrityMonitor(64, 2_000);
    m.acceptTradeId(7, 1_000, 1_000);
    expect(m.acceptTradeId(7, 1_000, 5_000)).toBe(false);
    // The duplicate must not refresh liveness, or a replayed message would
    // mask a dead feed.
    expect(m.tradeAgeMs(5_000)).toBe(4_000);
  });

  it('exposes both clocks in the snapshot', () => {
    const m = new IntegrityMonitor(64, 2_000);
    m.acceptTradeId(1, 111, 999);
    const s = m.snapshot();
    expect(s.lastTradeTimestamp).toBe(111);
    expect(s.lastTradeReceivedAt).toBe(999);
  });
});
