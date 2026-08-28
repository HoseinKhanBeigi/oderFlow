import type { MarketBar } from '../src/backtest/types.js';
import { getPreset } from '../src/simulation/presets.js';
import type { ScenarioIntensity, ScenarioPresetId } from '../src/simulation/types.js';

export interface PredictedPath {
  id: string;
  label: string;
  color: string;
  presetId: ScenarioPresetId;
  intensity: ScenarioIntensity;
  seed: number;
}

export interface FlowRead {
  buyShare: number;
  sellShare: number;
  bidShare: number;
  hasFootprint: boolean;
  hasBook: boolean;
}

const LOW = 0.12;
const NORMAL = 0.4;
const HIGH = 0.72;
const EXTREME = 1;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function readFlow(bars: MarketBar[]): FlowRead {
  const window = bars.slice(-8);
  let buy = 0;
  let sell = 0;
  let bid = 0;
  let ask = 0;
  let fp = 0;
  let book = 0;
  for (const b of window) {
    buy += b.aggressiveBuy;
    sell += b.aggressiveSell;
    if (b.hasFootprint && b.aggressiveBuy + b.aggressiveSell > 0) fp += 1;
    if (b.bidDepth != null && b.askDepth != null) {
      bid += b.bidDepth;
      ask += b.askDepth;
      book += 1;
    }
  }
  const tot = buy + sell;
  const depth = bid + ask;
  return {
    buyShare: tot > 0 ? buy / tot : 0.5,
    sellShare: tot > 0 ? sell / tot : 0.5,
    bidShare: depth > 0 ? bid / depth : 0.5,
    hasFootprint: fp >= 2,
    hasBook: book >= 2,
  };
}

function mix(base: ScenarioIntensity, extra: Partial<ScenarioIntensity>): ScenarioIntensity {
  return { ...base, ...extra };
}

/**
 * Four next-bar paths from recent aggressive flow and book liquidity:
 * continue, absorb, vacuum, fade.
 */
export function pathsFromFlow(bars: MarketBar[], slider?: Partial<ScenarioIntensity>): PredictedPath[] {
  const flow = readFlow(bars);
  const buy = clamp01(flow.buyShare);
  const sell = clamp01(flow.sellShare);
  const bid = clamp01(flow.bidShare);
  const ask = clamp01(1 - flow.bidShare);
  const bull = buy >= sell;
  const extra = slider ?? {};

  const continueId: ScenarioPresetId = bull ? 'STRONG_BUY_BREAKOUT' : 'DOWNSIDE_LIQUIDITY_VACUUM';
  const absorbId: ScenarioPresetId = bull ? 'BUYER_ABSORPTION' : 'SELLER_ABSORPTION';
  const vacuumId: ScenarioPresetId = bull ? 'UPSIDE_LIQUIDITY_VACUUM' : 'DOWNSIDE_LIQUIDITY_VACUUM';

  const continueI = mix(getPreset(continueId).intensity, {
    aggressiveBuy: bull ? Math.max(HIGH, buy) : LOW,
    aggressiveSell: bull ? LOW : Math.max(HIGH, sell),
    askDepth: bull ? LOW : Math.max(NORMAL, ask),
    bidDepth: bull ? Math.max(NORMAL, bid) : LOW,
    askWithdrawal: bull ? HIGH : LOW,
    bidWithdrawal: bull ? LOW : HIGH,
    ...extra,
  });

  const absorbI = mix(getPreset(absorbId).intensity, {
    aggressiveBuy: bull ? Math.max(HIGH, buy) : LOW,
    aggressiveSell: bull ? LOW : Math.max(HIGH, sell),
    askDepth: bull ? HIGH : NORMAL,
    bidDepth: bull ? NORMAL : HIGH,
    askReplenishment: bull ? EXTREME : NORMAL,
    bidReplenishment: bull ? NORMAL : EXTREME,
    askWithdrawal: LOW,
    bidWithdrawal: LOW,
    ...extra,
  });

  const vacuumI = mix(getPreset(vacuumId).intensity, {
    aggressiveBuy: bull ? NORMAL : LOW,
    aggressiveSell: bull ? LOW : NORMAL,
    askDepth: bull ? LOW : NORMAL,
    bidDepth: bull ? NORMAL : LOW,
    askReplenishment: LOW,
    bidReplenishment: LOW,
    askWithdrawal: bull ? EXTREME : LOW,
    bidWithdrawal: bull ? LOW : EXTREME,
    volatility: HIGH,
    ...extra,
  });

  const fadeI = mix(getPreset('FAKE_BREAKOUT').intensity, {
    aggressiveBuy: bull ? HIGH : LOW,
    aggressiveSell: bull ? LOW : HIGH,
    askReplenishment: HIGH,
    bidReplenishment: HIGH,
    ...extra,
  });

  return [
    { id: 'continue', label: bull ? 'Buy continue' : 'Sell continue', color: bull ? '#22c55e' : '#ef5350', presetId: continueId, intensity: continueI, seed: 11 },
    { id: 'absorb', label: bull ? 'Buy absorb' : 'Sell absorb', color: '#d4a84b', presetId: absorbId, intensity: absorbI, seed: 23 },
    { id: 'vacuum', label: bull ? 'Upside vacuum' : 'Downside vacuum', color: '#22d3ee', presetId: vacuumId, intensity: vacuumI, seed: 37 },
    { id: 'fade', label: 'Fade / fake', color: '#c084fc', presetId: 'FAKE_BREAKOUT', intensity: fadeI, seed: 41 },
  ];
}
