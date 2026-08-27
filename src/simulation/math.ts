import { EPSILON } from './types.js';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function safeDiv(num: number, den: number, fallback = 0): number {
  if (!Number.isFinite(num) || !Number.isFinite(den) || Math.abs(den) < EPSILON) return fallback;
  return num / den;
}

export function bpsChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) return 0;
  return ((to - from) / from) * 10_000;
}

export function pctChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) return 0;
  return ((to - from) / from) * 100;
}

export function logScale(value: number, maxValue: number): number {
  const v = Math.max(0, value);
  const m = Math.max(EPSILON, maxValue);
  return Math.log1p(v) / Math.log1p(m);
}

export function intensityFromRatio(ratio: number): 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME' {
  if (ratio >= 3) return 'EXTREME';
  if (ratio >= 1.6) return 'HIGH';
  if (ratio <= 0.45) return 'LOW';
  return 'NORMAL';
}

export function intensityFromPercentile(p: number): 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME' {
  if (p >= 92) return 'EXTREME';
  if (p >= 75) return 'HIGH';
  if (p <= 25) return 'LOW';
  return 'NORMAL';
}

export function roundToTick(price: number, tickSize: number): number {
  if (tickSize <= 0) return price;
  return Math.round(price / tickSize) * tickSize;
}

export function almostEqual(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] ?? 0;
    const y = ys[i] ?? 0;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (vx <= 0 || vy <= 0) return 0;
  return clamp(cov / Math.sqrt(vx * vy), -1, 1);
}

export function formatUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
