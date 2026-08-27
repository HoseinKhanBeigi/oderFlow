import { MarketSimulationEngine } from '../src/simulation/market-simulation-engine.js';
import { ScenarioEngine } from '../src/simulation/scenario-engine.js';
import type { WorkerRequest } from '../src/simulation/worker-protocol.js';

let engine = new MarketSimulationEngine({ fillMode: 'walk' });

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init':
        engine = new MarketSimulationEngine({
          symbol: msg.symbol,
          marketType: msg.marketType,
          tickSize: msg.tickSize,
          fillMode: msg.fillMode,
        });
        self.postMessage({ type: 'ready' });
        break;
      case 'event':
        engine.ingest(msg.event);
        break;
      case 'aggression':
        engine.queueAggression(msg.side, msg.quoteValue, msg.timestamp, msg.forced);
        break;
      case 'tick':
        self.postMessage({ type: 'state', state: engine.tick(msg.now) });
        break;
      case 'reset':
        engine.reset(msg.price ?? 0);
        self.postMessage({ type: 'state', state: engine.snapshot() });
        break;
      case 'seed':
        engine.seedBook(msg);
        break;
      case 'scenario': {
        const result = new ScenarioEngine().run(msg.spec);
        self.postMessage({ type: 'state', state: result.final });
        break;
      }
      case 'trail':
        engine.setTrailWindow(msg.window);
        break;
      case 'snapshot':
        self.postMessage({ type: 'state', state: engine.snapshot() });
        break;
      default:
        break;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
