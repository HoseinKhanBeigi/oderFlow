import { MicrostructureBacktestEngine } from '../src/backtest/engine.js';
import type { BacktestResult, BacktestRunConfig, MarketBar, Strategy, DataCoverage } from '../src/backtest/types.js';

interface RunMsg {
  type: 'run';
  bars: MarketBar[];
  strategy: Strategy;
  coverage: DataCoverage;
  config: BacktestRunConfig;
}

self.onmessage = (ev: MessageEvent<RunMsg>) => {
  const msg = ev.data;
  if (msg.type !== 'run') return;
  try {
    const engine = new MicrostructureBacktestEngine();
    const result: BacktestResult = engine.run(msg.bars, msg.strategy, msg.coverage, msg.config, (p) => {
      self.postMessage({ type: 'progress', ...p });
    });
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
