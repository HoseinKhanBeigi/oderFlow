import type { SimulationEvent } from './events.js';
import type { MarketSimulationState, PlaybackSpeed, TrailWindowId } from './types.js';
import type { ScenarioSpec } from './types.js';

export type WorkerRequest =
  | { type: 'init'; symbol: string; marketType: 'spot' | 'perp'; tickSize: number; fillMode: 'walk' | 'print' }
  | { type: 'event'; event: SimulationEvent }
  | { type: 'aggression'; side: 'BUY' | 'SELL'; quoteValue: number; timestamp: number; forced?: boolean }
  | { type: 'tick'; now: number }
  | { type: 'reset'; price?: number }
  | { type: 'seed'; price: number; bids: Array<{ price: number; quote: number }>; asks: Array<{ price: number; quote: number }> }
  | { type: 'scenario'; spec: ScenarioSpec }
  | { type: 'speed'; speed: PlaybackSpeed }
  | { type: 'trail'; window: TrailWindowId }
  | { type: 'snapshot' };

export type WorkerResponse =
  | { type: 'state'; state: MarketSimulationState }
  | { type: 'ready' }
  | { type: 'error'; message: string };
