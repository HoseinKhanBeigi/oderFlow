import type { DeltaAnalysis } from '../models/liquidity-response.js';

export function analyzeDelta(delta: number, absoluteDeltaPercentile: number): DeltaAnalysis {
  const direction: DeltaAnalysis['direction'] =
    Math.abs(delta) < 1e-9 ? 'BALANCED' : delta > 0 ? 'BUY' : 'SELL';
  return {
    delta,
    direction,
    absoluteDeltaPercentile,
    directionalMagnitudePercentile: absoluteDeltaPercentile,
  };
}
