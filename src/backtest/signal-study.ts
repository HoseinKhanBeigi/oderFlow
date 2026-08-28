import { attachForwardReturns, horizonKey } from './stats.js';
import { evalRule } from './conditions.js';
import { FeatureBuilder, windowBars } from './features.js';
import { FORWARD_HORIZONS_MIN, type Condition, type FeatureSnapshot, type LabSignal, type MarketBar, type PercentileWindowId } from './types.js';

export type StudyBias = 'UP' | 'DOWN' | 'EITHER';

export interface StudyPreset {
  id: string;
  label: string;
  condition: Condition;
  bias: StudyBias;
}

export const STUDY_PRESETS: StudyPreset[] = [
  { id: 'seller_abs', label: 'Seller Absorption', condition: { type: 'cond', metric: 'sellerAbsorption', op: '>=', value: 1 }, bias: 'UP' },
  { id: 'buyer_abs', label: 'Buyer Absorption', condition: { type: 'cond', metric: 'buyerAbsorption', op: '>=', value: 1 }, bias: 'DOWN' },
  { id: 'up_vac', label: 'Upside Liquidity Vacuum', condition: { type: 'cond', metric: 'upsideVacuum', op: '>=', value: 1 }, bias: 'UP' },
  { id: 'down_vac', label: 'Downside Liquidity Vacuum', condition: { type: 'cond', metric: 'downsideVacuum', op: '>=', value: 1 }, bias: 'DOWN' },
  { id: 'choch_bull', label: 'Bullish micro CHoCH', condition: { type: 'cond', metric: 'chochBullish', op: '=', value: 1 }, bias: 'UP' },
  { id: 'choch_bear', label: 'Bearish micro CHoCH', condition: { type: 'cond', metric: 'chochBearish', op: '=', value: 1 }, bias: 'DOWN' },
  { id: 'cvd_div', label: 'CVD bullish divergence', condition: { type: 'cond', metric: 'cvdDivergence', op: '=', value: 1 }, bias: 'UP' },
  { id: 'spot_led', label: 'Spot-led movement', condition: { type: 'cond', metric: 'spotLed', op: '=', value: 1 }, bias: 'UP' },
  { id: 'lev_rally', label: 'Leverage-driven rally', condition: { type: 'cond', metric: 'leverageDrivenRally', op: '=', value: 1 }, bias: 'EITHER' },
];

export interface HorizonStudy {
  horizon: string;
  minutes: number;
  count: number;
  avg: number;
  median: number;
  posPct: number;
  negPct: number;
  baselinePosPct: number;
  edge: number;
  avgMae: number;
  avgMfe: number;
}

export interface SignalStudyResult {
  conditionId: string;
  label: string;
  occurrences: number;
  insufficientSample: boolean;
  horizons: HorizonStudy[];
}

export function runSignalStudy(
  bars: MarketBar[],
  preset: StudyPreset,
  tfMinutes: number,
  window: PercentileWindowId,
  fromSec: number,
): SignalStudyResult {
  const builder = new FeatureBuilder(windowBars(window, tfMinutes));
  const snaps: FeatureSnapshot[] = [];
  const hits: LabSignal[] = [];
  for (const bar of bars) {
    const snap = builder.push(bar);
    snaps.push(snap);
    if (bar.time < fromSec) continue;
    if (!evalRule(preset.condition, snaps)) continue;
    hits.push({
      id: `st_${bar.time}`,
      kind: 'CONTEXT',
      strategy: preset.label,
      strategyVersion: 1,
      timestamp: snap.timestamp,
      barTime: snap.barTime,
      price: snap.price,
      score: snap.absorptionStrength,
      confidence: snap.dataQuality,
      snapshot: snap,
      evidence: [],
      traded: false,
      forwardReturns: {},
    });
  }
  attachForwardReturns(hits, bars, tfMinutes);
  const horizons: HorizonStudy[] = [];
  for (const mins of FORWARD_HORIZONS_MIN) {
    const key = horizonKey(mins);
    const vals = hits.map((h) => h.forwardReturns[key]).filter((n): n is number => n != null);
    const base = baselinePos(bars, tfMinutes, mins, fromSec);
    const pos = vals.filter((v) => v > 0).length;
    const neg = vals.filter((v) => v < 0).length;
    const posPct = vals.length ? (pos / vals.length) * 100 : 0;
    const maeMfe = excursion(hits, bars, mins, preset.bias);
    horizons.push({
      horizon: key,
      minutes: mins,
      count: vals.length,
      avg: avg(vals),
      median: median(vals),
      posPct,
      negPct: vals.length ? (neg / vals.length) * 100 : 0,
      baselinePosPct: base,
      edge: vals.length ? posPct - base : 0,
      avgMae: maeMfe.mae,
      avgMfe: maeMfe.mfe,
    });
  }
  return {
    conditionId: preset.id,
    label: preset.label,
    occurrences: hits.length,
    insufficientSample: hits.length < 20,
    horizons,
  };
}

function baselinePos(bars: MarketBar[], tfMinutes: number, horizonMin: number, fromSec: number): number {
  const need = Math.max(1, Math.round(horizonMin / tfMinutes));
  let n = 0;
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.time < fromSec) continue;
    const later = bars[i + need];
    if (!later) continue;
    n += 1;
    if (later.close > b.close) pos += 1;
  }
  return n ? (pos / n) * 100 : 50;
}

function excursion(
  hits: LabSignal[],
  bars: MarketBar[],
  horizonMin: number,
  bias: StudyBias,
): { mae: number; mfe: number } {
  const times = bars.map((b) => b.time);
  const needSec = horizonMin * 60;
  const maes: number[] = [];
  const mfes: number[] = [];
  for (const h of hits) {
    const i = times.indexOf(h.barTime);
    if (i < 0) continue;
    const start = bars[i]!;
    const endT = start.time + needSec;
    let hi = start.high;
    let lo = start.low;
    for (let j = i; j < bars.length && bars[j]!.time <= endT; j++) {
      hi = Math.max(hi, bars[j]!.high);
      lo = Math.min(lo, bars[j]!.low);
    }
    const up = ((hi - start.close) / start.close) * 100;
    const down = ((start.close - lo) / start.close) * 100;
    if (bias === 'DOWN') {
      mfes.push(down);
      maes.push(up);
    } else {
      mfes.push(up);
      maes.push(down);
    }
  }
  return { mae: avg(maes), mfe: avg(mfes) };
}

function avg(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export function getStudyPreset(id: string): StudyPreset {
  return STUDY_PRESETS.find((p) => p.id === id) ?? STUDY_PRESETS[0]!;
}
