import { MicrostructureBacktestEngine } from '../src/backtest/engine.js';
import { getStudyPreset, runSignalStudy } from '../src/backtest/signal-study.js';
import type { BacktestResult, BacktestRunConfig, MarketBar, PercentileWindowId, Strategy, DataCoverage } from '../src/backtest/types.js';

interface RunMsg {
  type: 'run';
  bars: MarketBar[];
  strategy: Strategy;
  coverage: DataCoverage;
  config: BacktestRunConfig;
}

interface StudyMsg {
  type: 'study';
  bars: MarketBar[];
  presetId: string;
  tfMinutes: number;
  window: PercentileWindowId;
  signalFromSec: number;
}

self.onmessage = (ev: MessageEvent<RunMsg | StudyMsg>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'run') {
      const engine = new MicrostructureBacktestEngine();
      const result: BacktestResult = engine.run(msg.bars, msg.strategy, msg.coverage, msg.config, (p) => {
        self.postMessage({ type: 'progress', ...p });
      });
      self.postMessage({ type: 'result', result });
      return;
    }
    if (msg.type === 'study') {
      const preset = getStudyPreset(msg.presetId);
      const result = runSignalStudy(msg.bars, preset, msg.tfMinutes, msg.window, msg.signalFromSec);
      self.postMessage({ type: 'study', result });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
