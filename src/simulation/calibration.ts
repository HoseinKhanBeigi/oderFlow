import { clamp, pearson, safeDiv } from './math.js';
import type {
  CalibrationParams,
  LiquidityRegime,
  SimulationMarketType,
  ValidationMetrics,
} from './types.js';

export function calibrationKey(p: Pick<CalibrationParams, 'symbol' | 'marketType' | 'exchange' | 'timeframeMs' | 'liquidityRegime'>): string {
  return `${p.symbol}|${p.marketType}|${p.exchange}|${p.timeframeMs}|${p.liquidityRegime}`;
}

export function defaultCalibration(opts: {
  symbol?: string;
  marketType?: SimulationMarketType;
  exchange?: string;
  timeframeMs?: number;
  liquidityRegime?: LiquidityRegime;
} = {}): CalibrationParams {
  const symbol = opts.symbol ?? 'BTCUSDT';
  const thin = symbol.startsWith('BTC') ? 0 : symbol.startsWith('ETH') ? 0.15 : 0.3;
  return {
    symbol,
    marketType: opts.marketType ?? 'perp',
    exchange: opts.exchange ?? 'binance',
    timeframeMs: opts.timeframeMs ?? 1_000,
    liquidityRegime: opts.liquidityRegime ?? 'normal',
    sampleCount: 0,
    nearbyDepthWeight: 1,
    replenishmentDamp: 0.85 + thin * 0.05,
    withdrawalAmplify: 1.1 + thin * 0.2,
    absorptionDamp: 0.9,
    vacuumGapCoeff: (symbol.startsWith('BTC') ? 0.35 : symbol.startsWith('ETH') ? 0.45 : 0.55),
    volatilityScale: 0.8,
    imbalanceMemory: 0.35,
    impactDecay: 0.55,
    leftoverPressureCoeff: 2.5,
    updatedAt: 0,
  };
}

export interface CalibrationSample {
  ofi: number;
  invDepth: number;
  consumption: number;
  replenishment: number;
  withdrawal: number;
  volatility: number;
  realizedBps: number;
}

/**
 * Moment-based estimator. Fits how OFI, depth, replenishment, withdrawal,
 * and volatility relate to realized impact. Does not maximize direction
 * accuracy — MAE of bps is the primary residual.
 */
export class CalibrationStore {
  private readonly byKey = new Map<string, CalibrationParams>();
  private readonly samples = new Map<string, CalibrationSample[]>();
  private readonly maxSamples = 4_096;

  get(partial: Parameters<typeof defaultCalibration>[0] = {}): CalibrationParams {
    const base = defaultCalibration(partial);
    return this.byKey.get(calibrationKey(base)) ?? base;
  }

  set(params: CalibrationParams): void {
    this.byKey.set(calibrationKey(params), { ...params, updatedAt: Date.now() });
  }

  addSample(params: CalibrationParams, sample: CalibrationSample): CalibrationParams {
    const key = calibrationKey(params);
    const list = this.samples.get(key) ?? [];
    list.push(sample);
    if (list.length > this.maxSamples) list.shift();
    this.samples.set(key, list);
    const fitted = fit(params, list);
    this.byKey.set(key, fitted);
    return fitted;
  }

  samplesFor(params: CalibrationParams): CalibrationSample[] {
    return [...(this.samples.get(calibrationKey(params)) ?? [])];
  }
}

function fit(base: CalibrationParams, samples: CalibrationSample[]): CalibrationParams {
  if (samples.length < 12) return { ...base, sampleCount: samples.length };

  const y = samples.map((s) => s.realizedBps);
  const absY = y.map((v) => Math.abs(v));
  const invDepth = samples.map((s) => s.invDepth);
  const repl = samples.map((s) => s.replenishment);
  const pull = samples.map((s) => s.withdrawal);
  const vol = samples.map((s) => s.volatility);

  const ofiCorr = Math.abs(pearson(samples.map((s) => s.ofi), y));
  const depthCorr = Math.abs(pearson(invDepth, absY));
  const replCorr = pearson(repl, absY);
  const pullCorr = pearson(pull, absY);
  const volCorr = pearson(vol, absY);

  return {
    ...base,
    sampleCount: samples.length,
    nearbyDepthWeight: clamp(0.5 + depthCorr, 0.4, 1.8),
    replenishmentDamp: clamp(0.6 + Math.max(0, -replCorr) * 0.5, 0.4, 1.2),
    withdrawalAmplify: clamp(0.8 + Math.max(0, pullCorr) * 0.8, 0.5, 2),
    vacuumGapCoeff: clamp(base.vacuumGapCoeff * (0.8 + depthCorr), 0.1, 1.4),
    volatilityScale: clamp(0.4 + Math.max(0, volCorr) * 0.8, 0.2, 1.6),
    leftoverPressureCoeff: clamp(1.5 + ofiCorr * 2, 0.8, 5),
    updatedAt: Date.now(),
  };
}

export function validateImpact(predictedBps: number[], actualBps: number[]): ValidationMetrics {
  const n = Math.min(predictedBps.length, actualBps.length);
  if (n === 0) return { n: 0, mae: 0, rmse: 0, directionAccuracy: 0, impactCorrelation: 0 };
  let abs = 0;
  let sq = 0;
  let dir = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = predictedBps[i] ?? 0;
    const a = actualBps[i] ?? 0;
    const err = p - a;
    abs += Math.abs(err);
    sq += err * err;
    if (Math.sign(p) === Math.sign(a) || (p === 0 && a === 0)) dir += 1;
    xs.push(p);
    ys.push(a);
  }
  return {
    n,
    mae: abs / n,
    rmse: Math.sqrt(sq / n),
    directionAccuracy: dir / n,
    impactCorrelation: pearson(xs, ys),
  };
}
