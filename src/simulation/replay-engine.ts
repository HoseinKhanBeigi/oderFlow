import { RingBuffer } from '../core/ring-buffer.js';
import { cloneEvent, compareEvents, EventSequencer, type SimulationEvent } from './events.js';

/**
 * Deterministic event log. Given the same stream, replay output is identical.
 * No RNG is used here.
 *
 * Uses a ring buffer so eviction is O(1). An array + shift() at capacity was
 * O(n) per insert and starved the live event loop under full watchlist load.
 */
export class ReplayEngine {
  private readonly buf: RingBuffer<SimulationEvent>;
  private cursor = 0;
  private readonly sequencer = new EventSequencer();
  readonly capacity: number;

  constructor(opts: { capacity?: number } = {}) {
    this.capacity = opts.capacity ?? 50_000;
    this.buf = new RingBuffer(this.capacity);
  }

  get length(): number {
    return this.buf.length;
  }

  get position(): number {
    return this.cursor;
  }

  clear(): void {
    this.buf.clear();
    this.cursor = 0;
    this.sequencer.reset();
  }

  record(event: SimulationEvent): SimulationEvent {
    const copy = cloneEvent(event);
    if (!copy.seq) copy.seq = this.sequencer.next();
    const evicted = this.buf.push(copy);
    if (evicted !== undefined && this.cursor > 0) this.cursor -= 1;
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
    while (this.cursor < this.buf.length && (this.buf.at(this.cursor)?.timestamp ?? 0) < timestamp) {
      this.cursor += 1;
    }
  }

  /** Events with timestamp in (prevTime, now]. */
  drainUntil(now: number): SimulationEvent[] {
    const out: SimulationEvent[] = [];
    while (this.cursor < this.buf.length) {
      const ev = this.buf.at(this.cursor);
      if (!ev || ev.timestamp > now) break;
      out.push(ev);
      this.cursor += 1;
    }
    return out;
  }

  peek(): SimulationEvent | undefined {
    return this.buf.at(this.cursor);
  }

  remaining(): number {
    return this.buf.length - this.cursor;
  }

  done(): boolean {
    return this.cursor >= this.buf.length;
  }

  slice(fromTs: number, toTs: number): SimulationEvent[] {
    const out: SimulationEvent[] = [];
    for (const e of this.buf.values()) {
      if (e.timestamp >= fromTs && e.timestamp <= toTs) out.push(cloneEvent(e));
    }
    return out;
  }

  all(): SimulationEvent[] {
    return this.buf.toArray().map(cloneEvent);
  }
}
