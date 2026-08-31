import type { PassiveLiquidityConfig } from '../config/types.js';
import { RingBuffer } from '../core/ring-buffer.js';
import type {
  HeatmapCell,
  HeatmapFrame,
  PassiveLiquidityEvent,
  PassiveLiquidityEventType,
  PassiveLiquidityLevel,
} from '../models/passive-liquidity.js';

/**
 * Time x price x notional history for the liquidity heatmap.
 *
 * Frames are cut on a fixed interval so the render layer can draw at its own
 * cadence without touching the per-update book state. Historical frames are
 * retained, which is what makes walls appearing, moving and vanishing visible.
 */
export class HeatmapRecorder {
  private readonly frames: RingBuffer<HeatmapFrame>;
  private frameStart = 0;
  private pending = new Map<number, HeatmapCell>();
  private pendingMid = 0;

  constructor(private readonly config: PassiveLiquidityConfig) {
    this.frames = new RingBuffer<HeatmapFrame>(config.heatmapFrames);
  }

  record(
    now: number,
    mid: number,
    levels: PassiveLiquidityLevel[],
    events: PassiveLiquidityEvent[],
  ): void {
    if (mid <= 0) return;
    if (this.frameStart === 0) this.frameStart = now;

    if (now - this.frameStart >= this.config.heatmapFrameMs) {
      this.flush();
      this.frameStart = now;
    }

    this.pendingMid = mid;
    for (const level of levels) {
      if (level.quantity <= 0 || level.outOfView) continue;
      const cell = this.pending.get(level.price) ?? {
        price: level.price,
        bidNotional: 0,
        askNotional: 0,
        event: 'NONE' as PassiveLiquidityEventType | 'NONE',
      };
      // Latest observation wins inside a frame rather than summing repeats.
      if (level.side === 'BID') cell.bidNotional = level.notionalValue;
      else cell.askNotional = level.notionalValue;
      this.pending.set(level.price, cell);
    }

    this.annotate(events);
  }

  /**
   * Applies events to the frame being accumulated. Used for events derived at
   * snapshot time (absorption, vacuum), which are known after the book update
   * that produced the frame.
   */
  annotate(events: PassiveLiquidityEvent[]): void {
    for (const event of events) {
      const cell = this.pending.get(event.price);
      if (cell && rank(event.type) > rank(cell.event)) cell.event = event.type;
    }
  }

  snapshot(): HeatmapFrame[] {
    const out = this.frames.toArray();
    if (this.pending.size) out.push(this.buildFrame());
    return out;
  }

  reset(): void {
    this.frames.clear();
    this.pending.clear();
    this.frameStart = 0;
  }

  private flush(): void {
    if (!this.pending.size) return;
    this.frames.push(this.buildFrame());
    this.pending = new Map();
  }

  private buildFrame(): HeatmapFrame {
    return {
      at: this.frameStart,
      mid: this.pendingMid,
      cells: [...this.pending.values()].sort((a, b) => b.price - a.price),
    };
  }
}

/** Structural events outrank routine size changes when colouring a cell. */
function rank(event: PassiveLiquidityEventType | 'NONE'): number {
  switch (event) {
    case 'NONE':
      return 0;
    case 'LIQUIDITY_ADDED':
      return 1;
    case 'LIQUIDITY_MOVED':
      return 2;
    case 'LIQUIDITY_REPLENISHED':
      return 3;
    case 'LIQUIDITY_CANCELLED':
      return 4;
    case 'LIQUIDITY_CONSUMED':
      return 5;
    case 'WALL_APPEARED':
      return 6;
    case 'WALL_ATTACKED':
      return 7;
    case 'WALL_DEFENDED':
      return 8;
    case 'WALL_DISAPPEARED':
      return 9;
    case 'WALL_BROKEN':
      return 10;
    case 'ABSORPTION_DETECTED':
      return 11;
    case 'VACUUM_DETECTED':
      return 12;
    default:
      return 0;
  }
}
