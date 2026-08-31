import { RingBuffer } from '../core/ring-buffer.js';
import type { PassiveLiquidityVelocity, PassiveSide } from '../models/passive-liquidity.js';
import type { SideFlowDelta } from './level-tracker.js';

interface VelocitySample extends SideFlowDelta {
  at: number;
}

function zeroVelocity(): PassiveLiquidityVelocity {
  return {
    addedQuantityPerSec: 0,
    addedNotionalPerSec: 0,
    cancelledQuantityPerSec: 0,
    cancelledNotionalPerSec: 0,
    consumedQuantityPerSec: 0,
    consumedNotionalPerSec: 0,
    replenishedQuantityPerSec: 0,
    replenishedNotionalPerSec: 0,
  };
}

/**
 * Per-side rates of change in resting liquidity. Speed matters independently of
 * size: $15M consumed in 20 seconds is a different event from $15M in 20 minutes.
 */
export class LiquidityVelocityTracker {
  private readonly samples: Record<PassiveSide, RingBuffer<VelocitySample>>;

  constructor(capacity = 4_096) {
    this.samples = {
      BID: new RingBuffer<VelocitySample>(capacity),
      ASK: new RingBuffer<VelocitySample>(capacity),
    };
  }

  record(side: PassiveSide, at: number, flow: SideFlowDelta): void {
    this.samples[side].push({ at, ...flow });
  }

  velocity(side: PassiveSide, now: number, windowMs: number): PassiveLiquidityVelocity {
    if (windowMs <= 0) return zeroVelocity();
    const from = now - windowMs;
    const totals = this.totals(side, now, windowMs);
    const seconds = Math.max(0.001, (now - Math.max(from, 0)) / 1_000);
    return {
      addedQuantityPerSec: totals.addedQuantity / seconds,
      addedNotionalPerSec: totals.addedNotional / seconds,
      cancelledQuantityPerSec: totals.cancelledQuantity / seconds,
      cancelledNotionalPerSec: totals.cancelledNotional / seconds,
      consumedQuantityPerSec: totals.consumedQuantity / seconds,
      consumedNotionalPerSec: totals.consumedNotional / seconds,
      replenishedQuantityPerSec: totals.replenishedQuantity / seconds,
      replenishedNotionalPerSec: totals.replenishedNotional / seconds,
    };
  }

  totals(side: PassiveSide, now: number, windowMs: number): SideFlowDelta {
    const from = now - windowMs;
    const out: SideFlowDelta = {
      addedQuantity: 0,
      addedNotional: 0,
      consumedQuantity: 0,
      consumedNotional: 0,
      cancelledQuantity: 0,
      cancelledNotional: 0,
      replenishedQuantity: 0,
      replenishedNotional: 0,
    };
    for (const sample of this.samples[side].values()) {
      if (sample.at < from || sample.at > now) continue;
      out.addedQuantity += sample.addedQuantity;
      out.addedNotional += sample.addedNotional;
      out.consumedQuantity += sample.consumedQuantity;
      out.consumedNotional += sample.consumedNotional;
      out.cancelledQuantity += sample.cancelledQuantity;
      out.cancelledNotional += sample.cancelledNotional;
      out.replenishedQuantity += sample.replenishedQuantity;
      out.replenishedNotional += sample.replenishedNotional;
    }
    return out;
  }

  reset(): void {
    this.samples.BID.clear();
    this.samples.ASK.clear();
  }
}
