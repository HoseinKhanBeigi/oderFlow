import { RollingDistribution } from '../core/rolling-stats.js';
import { clamp, safeDiv } from '../core/integrity.js';
import type { FlowBias, SpotFlowFlag, SpotFlowState } from './types.js';

export interface FlowClassifyInput {
  delta: number;
  deltaPercent: number;
  totalVolume: number;
  priceChangePercent: number;
  cvdDivergence: 'BULLISH' | 'BEARISH' | 'NONE';
  cvdAcceleration: number;
  priorAbsDelta: number;
  absorption: 'PASSIVE_SELL_ABSORPTION' | 'PASSIVE_BUY_ABSORPTION' | null;
}

export class SpotFlowClassifier {
  readonly delta = new RollingDistribution(256);
  readonly absDelta = new RollingDistribution(256);
  readonly volume = new RollingDistribution(256);
  private lastAbsDelta = 0;
  private lastAccel = 0;

  observe(delta: number, totalVolume: number): void {
    this.delta.add(delta);
    this.absDelta.add(Math.abs(delta));
    if (totalVolume > 0) this.volume.add(totalVolume);
  }

  classify(input: FlowClassifyInput, commit = false): { flow: SpotFlowState; flags: SpotFlowFlag[]; bias: FlowBias } {
    const z = this.delta.size >= 8 ? this.delta.zScore(input.delta, 1) : this.bootstrapZ(input.deltaPercent);
    const dp = input.deltaPercent;

    let flow: SpotFlowState = 'BALANCED';
    if (z >= 1.5 && dp >= 0.2) flow = 'STRONG_SPOT_BUYING';
    else if (z >= 0.55 && dp >= 0.08) flow = 'SPOT_BUYING';
    else if (z <= -1.5 && dp <= -0.2) flow = 'STRONG_SPOT_SELLING';
    else if (z <= -0.55 && dp <= -0.08) flow = 'SPOT_SELLING';

    const flags: SpotFlowFlag[] = [];
    if (input.absorption === 'PASSIVE_SELL_ABSORPTION') flags.push('BUY_ABSORPTION');
    if (input.absorption === 'PASSIVE_BUY_ABSORPTION') flags.push('SELL_ABSORPTION');
    if (input.cvdDivergence === 'BULLISH') flags.push('BULLISH_CVD_DIVERGENCE');
    if (input.cvdDivergence === 'BEARISH') flags.push('BEARISH_CVD_DIVERGENCE');

    const absNow = Math.abs(input.delta);
    const dropped = this.lastAbsDelta > 0 && absNow < this.lastAbsDelta * 0.5;
    const decelerating = input.cvdAcceleration < this.lastAccel && Math.abs(input.cvdAcceleration) < Math.abs(this.lastAccel);
    if (dropped && decelerating && this.lastAbsDelta > 0) {
      if (this.lastAbsDelta > 0 && input.priorAbsDelta >= 0) flags.push('BUYER_EXHAUSTION');
      if (this.lastAbsDelta < 0 || input.priorAbsDelta < 0) flags.push('SELLER_EXHAUSTION');
    }
    // Directional exhaustion: strong prior same-side delta collapsing while price still ticking that way.
    if (this.absDelta.size >= 8 && this.absDelta.percentileRank(this.lastAbsDelta) >= 70 && dropped) {
      if (input.priorAbsDelta > 0 && input.priceChangePercent >= 0) {
        if (!flags.includes('BUYER_EXHAUSTION')) flags.push('BUYER_EXHAUSTION');
      }
      if (input.priorAbsDelta < 0 && input.priceChangePercent <= 0) {
        if (!flags.includes('SELLER_EXHAUSTION')) flags.push('SELLER_EXHAUSTION');
      }
    }

    if (commit) {
      this.observe(input.delta, input.totalVolume);
      this.lastAbsDelta = input.delta;
      this.lastAccel = input.cvdAcceleration;
    }

    const bias: FlowBias = flow.includes('BUYING') ? 'BUY' : flow.includes('SELLING') ? 'SELL' : 'NEUTRAL';
    return { flow, flags, bias };
  }

  private bootstrapZ(deltaPercent: number): number {
    return clamp(deltaPercent * 4, -3, 3);
  }
}

export function deltaPercent(buy: number, sell: number): number {
  return safeDiv(buy - sell, buy + sell);
}
