import { DEFAULT_TICK_MS, type PlaybackSpeed } from './types.js';

export type ClockListener = (simTime: number, dtMs: number) => void;

/**
 * Fixed simulation tick. Independent of requestAnimationFrame.
 * The UI must subscribe to state, not drive these ticks.
 */
export class SimulationClock {
  tickMs: number;
  speed: PlaybackSpeed = 1;
  playing = false;
  simTime: number;
  private readonly origin: number;
  private listener: ClockListener | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly wallClock: () => number;

  constructor(opts: { tickMs?: number; startTime?: number; now?: () => number } = {}) {
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.origin = opts.startTime ?? 0;
    this.simTime = this.origin;
    this.wallClock = opts.now ?? (() => Date.now());
  }

  onTick(listener: ClockListener): void {
    this.listener = listener;
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.schedule();
  }

  pause(): void {
    this.playing = false;
    this.clearTimer();
  }

  step(): void {
    this.advanceOnce();
  }

  reset(): void {
    this.pause();
    this.simTime = this.origin;
  }

  setSpeed(speed: PlaybackSpeed): void {
    this.speed = speed;
    if (this.playing) {
      this.clearTimer();
      this.schedule();
    }
  }

  setTime(simTime: number): void {
    this.simTime = simTime;
  }

  private intervalMs(): number {
    return Math.max(4, this.tickMs / this.speed);
  }

  private schedule(): void {
    this.clearTimer();
    const wait = this.intervalMs();
    this.timer = setTimeout(() => {
      this.advanceOnce();
      if (this.playing) this.schedule();
    }, wait);
  }

  private advanceOnce(): void {
    this.simTime += this.tickMs;
    this.listener?.(this.simTime, this.tickMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  wallNow(): number {
    return this.wallClock();
  }
}
