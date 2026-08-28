import { getPreset } from '../src/simulation/presets.js';
import { ScenarioEngine } from '../src/simulation/scenario-engine.js';
import type { ScenarioIntensity, ScenarioPresetId, ScenarioSpec } from '../src/simulation/types.js';
import { formingBarSnapshots } from './sim-candles.js';
import type { MarketBar } from '../src/backtest/types.js';

interface PathSpec {
  id: string;
  label: string;
  color: string;
  presetId: ScenarioPresetId;
  intensity: ScenarioIntensity;
  seed: number;
}

interface PathsMsg {
  type: 'paths';
  startPrice: number;
  durationMs: number;
  symbol: string;
  tickSize: number;
  levelStep: number;
  nextTime: number;
  gapSec: number;
  paths: PathSpec[];
}

self.onmessage = (ev: MessageEvent<PathsMsg>) => {
  const msg = ev.data;
  try {
    if (msg.type !== 'paths') return;
    const engine = new ScenarioEngine();
    const candles: Array<{ id: string; label: string; color: string; bar: MarketBar }> = [];
    for (let i = 0; i < msg.paths.length; i++) {
      const path = msg.paths[i]!;
      const base = getPreset(path.presetId);
      const shift = msg.startPrice - base.startPrice;
      const spec: ScenarioSpec = {
        ...base,
        seed: path.seed,
        symbol: msg.symbol || base.symbol,
        startPrice: msg.startPrice,
        durationMs: msg.durationMs,
        tickSize: msg.tickSize,
        levelStep: msg.levelStep,
        intensity: { ...path.intensity },
        liquidationZones: base.liquidationZones?.map((z) => ({ ...z, price: z.price + shift })),
      };
      const result = engine.run(spec);
      const formed = formingBarSnapshots(result.states, spec.startPrice, msg.nextTime + i * msg.gapSec);
      const bar = formed.bars[formed.bars.length - 1];
      if (bar) candles.push({ id: path.id, label: path.label, color: path.color, bar });
    }
    self.postMessage({ type: 'done', candles });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
