import { cloneEvent, compareEvents, EventSequencer, type SimulationEvent } from './events.js';

/**
 * Deterministic event log. Given the same stream, replay output is identical.
 * No RNG is used here.
 */
export class ReplayEngine {
  private readonly events: SimulationEvent[] = [];
  private cursor = 0;
  private readonly sequencer = new EventSequencer();
  readonly capacity: number;

  constructor(opts: { capacity?: number } = {}) {
    this.capacity = opts.capacity ?? 200_000;
  }

  get length(): number {
    return this.events.length;
  }

  get position(): number {
    return this.cursor;
  }

  clear(): void {
    this.events.length = 0;
    this.cursor = 0;
    this.sequencer.reset();
  }

  record(event: SimulationEvent): SimulationEvent {
    const copy = cloneEvent(event);
    if (!copy.seq) copy.seq = this.sequencer.next();
    this.events.push(copy);
    if (this.events.length > this.capacity) this.events.shift();
    return copy;
  }

  load(events: SimulationEvent[]): void {
    this.clear();
    const sorted = [...events].map(cloneEvent).sort(compareEvents);
    for (const ev of sorted) this.record(ev);
    this.cursor = 0;
  }

  rewind(): void {
    this.cursor = 0;
  }

  seek(timestamp: number): void {
    this.cursor = 0;
    while (this.cursor < this.events.length && (this.events[this.cursor]?.timestamp ?? 0) < timestamp) {
      this.cursor += 1;
    }
  }

  /** Events with timestamp in (prevTime, now]. */
  drainUntil(now: number): SimulationEvent[] {
    const out: SimulationEvent[] = [];
    while (this.cursor < this.events.length) {
      const ev = this.events[this.cursor];
      if (!ev || ev.timestamp > now) break;
      out.push(ev);
      this.cursor += 1;
    }
    return out;
  }

  peek(): SimulationEvent | undefined {
    return this.events[this.cursor];
  }

  remaining(): number {
    return this.events.length - this.cursor;
  }

  done(): boolean {
    return this.cursor >= this.events.length;
  }

  slice(fromTs: number, toTs: number): SimulationEvent[] {
    return this.events.filter((e) => e.timestamp >= fromTs && e.timestamp <= toTs).map(cloneEvent);
  }

  all(): SimulationEvent[] {
    return this.events.map(cloneEvent);
  }
}
