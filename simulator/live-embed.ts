import { PhaserRenderer } from './phaser-renderer.js';
import type { MarketSimulationState } from '../src/simulation/types.js';

export interface LiveSimulatorHandle {
  setState(state: MarketSimulationState | null): void;
  destroy(): void;
}

export function mountLiveSimulator(parent: HTMLElement): LiveSimulatorHandle {
  const renderer = new PhaserRenderer(parent);
  return {
    setState(state) {
      renderer.setState(state);
    },
    destroy() {
      renderer.destroy();
    },
  };
}

declare global {
  interface Window {
    mountLiveSimulator: typeof mountLiveSimulator;
  }
}

window.mountLiveSimulator = mountLiveSimulator;
