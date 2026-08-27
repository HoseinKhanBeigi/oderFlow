import { DEFAULT_TICK_MS } from './types.js';
import { EventSequencer, type SimulationEvent } from './events.js';
import { MarketSimulationEngine } from './market-simulation-engine.js';
import { SeededRng } from './prng.js';
import { getPreset } from './presets.js';
import type {
  MarketSimulationState,
  ScenarioPresetId,
  ScenarioSpec,
} from './types.js';

export interface ScenarioResult {
  spec: ScenarioSpec;
  states: MarketSimulationState[];
  events: SimulationEvent[];
  final: MarketSimulationState;
}

const BASE_ASK = [
  { offset: 50, quote: 30_000_000 },
  { offset: 100, quote: 120_000_000 },
  { offset: 150, quote: 80_000_000 },
  { offset: 200, quote: 40_000_000 },
  { offset: 250, quote: 70_000_000 },
  { offset: 300, quote: 55_000_000 },
];

const BASE_BID = [
  { offset: 50, quote: 60_000_000 },
  { offset: 100, quote: 100_000_000 },
  { offset: 150, quote: 180_000_000 },
  { offset: 200, quote: 50_000_000 },
  { offset: 250, quote: 90_000_000 },
  { offset: 300, quote: 40_000_000 },
];

function depthScale(intensity: number): number {
  return 0.18 + intensity * 1.7;
}

/**
 * Builds a seeded, replayable event-driven scenario. Randomness only
 * comes from SeededRng — same spec + seed ⇒ same result.
 */
export class ScenarioEngine {
  readonly sequencer = new EventSequencer();

  run(spec: ScenarioSpec, tickMs = DEFAULT_TICK_MS): ScenarioResult {
    const rng = new SeededRng(spec.seed);
    const engine = this.createEngine(spec);
    this.seedBook(engine, spec, rng);
    if (spec.liquidationZones?.length) engine.setZones(spec.liquidationZones);
    if (spec.intensity.funding) engine.funding.set(spec.intensity.funding);
    if (spec.intensity.oiChange) {
      engine.oi.set(500_000_000);
    }

    const states: MarketSimulationState[] = [];
    const duration = spec.durationMs;
    for (let t = tickMs; t <= duration; t += tickMs) {
      this.applyTick(engine, spec, rng, t, duration, tickMs);
      states.push(engine.tick(t));
    }

    return {
      spec,
      states,
      events: engine.replay.all(),
      final: states[states.length - 1] ?? engine.snapshot(),
    };
  }

  runPreset(id: ScenarioPresetId, overrides: Partial<ScenarioSpec> = {}): ScenarioResult {
    const spec = { ...getPreset(id), ...overrides, intensity: { ...getPreset(id).intensity, ...overrides.intensity } };
    return this.run(spec);
  }

  createEngine(spec: ScenarioSpec): MarketSimulationEngine {
    const engine = new MarketSimulationEngine({
      symbol: spec.symbol,
      marketType: spec.marketType,
      tickSize: spec.tickSize,
      fillMode: 'walk',
    });
    engine.mode = 'synthetic';
    return engine;
  }

  seedBook(engine: MarketSimulationEngine, spec: ScenarioSpec, rng: SeededRng): void {
    const step = spec.levelStep || spec.tickSize;
    const asks = BASE_ASK.map((row, i) => ({
      price: spec.startPrice + row.offset * (step / 50),
      quote: row.quote * depthScale(spec.intensity.askDepth) * rng.nextFloat(0.92, 1.08) * (i === 0 ? 0.9 : 1),
    }));
    const bids = BASE_BID.map((row, i) => ({
      price: spec.startPrice - row.offset * (step / 50),
      quote: row.quote * depthScale(spec.intensity.bidDepth) * rng.nextFloat(0.92, 1.08) * (i === 0 ? 0.9 : 1),
    }));
    engine.reset(spec.startPrice);
    engine.seedBook({ price: spec.startPrice, bids, asks });
    engine.ingest({
      kind: 'book_snapshot',
      seq: this.sequencer.next(),
      timestamp: 0,
      symbol: spec.symbol,
      marketType: spec.marketType,
      bids: bids.map((l) => ({ price: l.price, quoteValue: l.quote })),
      asks: asks.map((l) => ({ price: l.price, quoteValue: l.quote })),
    });
  }

  applyTick(
    engine: MarketSimulationEngine,
    spec: ScenarioSpec,
    rng: SeededRng,
    t: number,
    duration: number,
    tickMs: number,
  ): void {
    const phase = t / duration;
    let buyI = spec.intensity.aggressiveBuy;
    let sellI = spec.intensity.aggressiveSell;
    if (spec.id === 'FAKE_BREAKOUT') {
      if (phase < 0.45) {
        buyI = 0.85;
        sellI = 0.08;
      } else {
        buyI = 0.1;
        sellI = 0.75;
      }
    }

    const base = 2_400_000 * (tickMs / DEFAULT_TICK_MS);
    const buy = buyI > 0 ? buyI * base * rng.nextFloat(0.45, 1.55) : 0;
    const sell = sellI > 0 ? sellI * base * rng.nextFloat(0.45, 1.55) : 0;
    if (buy > 0) engine.queueAggression('BUY', buy, t, false);
    if (sell > 0) engine.queueAggression('SELL', sell, t, false);

    const consumedAskGuess = buy;
    const consumedBidGuess = sell;
    const askRepl = spec.intensity.askReplenishment * consumedAskGuess * rng.nextFloat(0.7, 1.3);
    const bidRepl = spec.intensity.bidReplenishment * consumedBidGuess * rng.nextFloat(0.7, 1.3);
    if (askRepl > 0) engine.queueReplenish('ask', askRepl, engine.book.bestAsk()?.price ?? spec.startPrice);
    if (bidRepl > 0) engine.queueReplenish('bid', bidRepl, engine.book.bestBid()?.price ?? spec.startPrice);

    const askPull = spec.intensity.askWithdrawal * engine.book.nearbyDepth('ask') * rng.nextFloat(0.04, 0.14);
    const bidPull = spec.intensity.bidWithdrawal * engine.book.nearbyDepth('bid') * rng.nextFloat(0.04, 0.14);
    if (askPull > 0) engine.queueWithdraw('ask', askPull);
    if (bidPull > 0) engine.queueWithdraw('bid', bidPull);

    if (spec.intensity.oiChange && t % (tickMs * 8) === 0) {
      const stepOi = spec.intensity.oiChange * 8_000_000 * rng.nextFloat(0.6, 1.2);
      engine.oi.addChange(stepOi);
    }
  }
}

export interface ScenarioPlayer {
  engine: MarketSimulationEngine;
  spec: ScenarioSpec;
  step(now: number): MarketSimulationState;
  rng: SeededRng;
}

export function createScenarioPlayer(spec: ScenarioSpec, tickMs = DEFAULT_TICK_MS): ScenarioPlayer {
  const runner = new ScenarioEngine();
  const rng = new SeededRng(spec.seed);
  const engine = runner.createEngine(spec);
  runner.seedBook(engine, spec, rng);
  if (spec.liquidationZones?.length) engine.setZones(spec.liquidationZones);
  if (spec.intensity.funding) engine.funding.set(spec.intensity.funding);
  if (spec.intensity.oiChange) engine.oi.set(500_000_000);
  return {
    engine,
    spec,
    rng,
    step(now: number) {
        runner.applyTick(engine, spec, rng, now, spec.durationMs, tickMs);
      return engine.tick(now);
    },
  };
}
