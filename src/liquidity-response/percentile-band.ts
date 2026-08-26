import type { PercentileBand, PercentileBandConfig } from '../models/liquidity-response.js';

const DEFAULT_BANDS: PercentileBandConfig = {
  veryLow: 20,
  low: 40,
  normal: 60,
  elevated: 80,
  high: 95,
};

export function percentileBand(percentile: number, bands: PercentileBandConfig = DEFAULT_BANDS): PercentileBand {
  if (percentile < bands.veryLow) return 'VERY_LOW';
  if (percentile < bands.low) return 'LOW';
  if (percentile < bands.normal) return 'NORMAL';
  if (percentile < bands.elevated) return 'ELEVATED';
  if (percentile < bands.high) return 'HIGH';
  return 'EXTREME';
}

export function percentileTooltip(percentile: number): string {
  const p = Math.round(Math.max(0, Math.min(100, percentile)));
  return `This value is higher than ${p}% and lower than ${100 - p}% of comparable historical observations.`;
}

export function bandToIntensity(band: PercentileBand): 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME' {
  if (band === 'VERY_LOW' || band === 'LOW') return 'LOW';
  if (band === 'NORMAL') return 'NORMAL';
  if (band === 'ELEVATED' || band === 'HIGH') return 'HIGH';
  return 'EXTREME';
}
