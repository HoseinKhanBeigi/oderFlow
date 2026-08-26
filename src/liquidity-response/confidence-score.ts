import { clamp } from '../core/integrity.js';
import type { ConfidenceLabel, IntensityLabel, MicrostructureState } from '../models/liquidity-response.js';
import type { LiquidityResponseConfig } from '../config/types.js';
import type { ClassifyInput } from './classify.js';

export interface ConfidenceScoreInput {
  input: ClassifyInput;
  state: MicrostructureState;
  dataQuality: number;
  persisted: boolean;
  fadedImpact: boolean;
  cvdAligned: boolean;
  bookClear: boolean;
  crossAgree: boolean | null;
  dataConsistency?: number;
}

export function confidenceScore(
  cfg: LiquidityResponseConfig,
  src: ConfidenceScoreInput,
): { score: number; label: ConfidenceLabel } {
  const i = src.input;
  let s = 22;

  const sig = Math.max(i.buyPct, i.sellPct, i.deltaPct);
  s += clamp((sig - 50) * 0.45, 0, 22);
  if (src.bookClear) s += 12;
  else s -= 6;
  if (i.movePct >= 70) s += 12;
  else if (i.movePct <= 35 && (src.state === 'BUYERS_IN_CONTROL' || src.state === 'SELLERS_IN_CONTROL')) s -= 14;
  if (src.cvdAligned) s += 8;
  if (src.persisted) s += 10;
  s += (src.dataQuality - 55) * 0.25;
  if (src.crossAgree === true) s += 12;
  if (src.crossAgree === false) s -= 16;
  if (src.fadedImpact) s -= 10;
  if (i.buy + i.sell <= 0 || i.deltaPct < 40) s -= 12;
  if (quietBook(i)) s -= 8;
  if (src.state === 'NO_DIRECTIONAL_EDGE' || src.state === 'BALANCED') s = Math.min(s, 38);

  let score = Math.round(clamp(s, 0, 100));
  if (src.dataQuality < cfg.highConfidenceMinQuality && score >= 70) score = 69;
  if (src.dataConsistency != null && src.dataConsistency < cfg.minConsistencyForHigh && score >= 70) {
    score = 69;
  }
  const label: ConfidenceLabel = score >= 70 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW';
  return { score, label };
}

function quietBook(i: ClassifyInput): boolean {
  const n = (x: IntensityLabel) => x === 'NORMAL' || x === 'LOW';
  return (
    n(intensity(i.askConsPct)) &&
    n(intensity(i.askReplPct)) &&
    n(intensity(i.askPullPct)) &&
    n(intensity(i.bidConsPct)) &&
    n(intensity(i.bidReplPct)) &&
    n(intensity(i.bidPullPct))
  );
}

function intensity(p: number): IntensityLabel {
  if (p >= 92) return 'EXTREME';
  if (p >= 75) return 'HIGH';
  if (p <= 25) return 'LOW';
  return 'NORMAL';
}
