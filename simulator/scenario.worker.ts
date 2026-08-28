import { getPreset } from '../src/simulation/presets.js';
import { ScenarioEngine } from '../src/simulation/scenario-engine.js';
import type { ScenarioIntensity, ScenarioPresetId, ScenarioSpec } from '../src/simulation/types.js';
import { candlesFromStates } from './sim-candles.js';

interface RunMsg {
  type: 'run';
  presetId: ScenarioPresetId;
  intensity: ScenarioIntensity;
  startPrice: number;
  durationMs: number;
  symbol: string;
}

self.onmessage = (ev: MessageEvent<RunMsg>) => {
  const msg = ev.data;
  try {
    if (msg.type !== 'run') return;
    const base = getPreset(msg.presetId);
    const spec: ScenarioSpec = {
      ...base,
      symbol: msg.symbol || base.symbol,
      startPrice: msg.startPrice || base.startPrice,
      durationMs: msg.durationMs || base.durationMs,
      intensity: { ...msg.intensity },
    };
    const result = new ScenarioEngine().run(spec);
    const chart = candlesFromStates(result.states, spec.startPrice);
    self.postMessage({
      type: 'done',
      label: spec.label,
      startPrice: spec.startPrice,
      ...chart,
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
