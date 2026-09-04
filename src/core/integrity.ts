export type IntegrityFlag =
  | 'reconnect'
  | 'duplicate'
  | 'outOfOrder'
  | 'staleBook'
  | 'sequenceGap'
  | 'wideSpread'
  | 'missingData'
  | 'latencySpike';

/** How many inter-trade gaps feed the median. ~2 min of a 1 Hz symbol. */
const GAP_WINDOW = 128;

export interface IntegrityState {
  flags: Set<IntegrityFlag>;
  /** Exchange event time of the newest accepted trade. Use for ordering, never for liveness. */
  lastTradeTimestamp: number;
  /** Local clock when that trade was accepted. Use for liveness — immune to clock skew. */
  lastTradeReceivedAt: number;
  lastBookTimestamp: number;
  lastBookReceivedAt: number;
  lastReconnectAt: number;
  lastSequenceGapAt: number;
  /**
   * Median gap between accepted trades, in ms. Lets staleness thresholds adapt
   * to how often a symbol actually prints instead of assuming a busy market.
   */
  medianTradeGapMs: number;
  tradeGapSamples: number;
  healthy: boolean;
}

export class IntegrityMonitor {
  readonly flags = new Set<IntegrityFlag>();
  lastTradeTimestamp = 0;
  lastTradeReceivedAt = 0;
  lastBookTimestamp = 0;
  lastBookReceivedAt = 0;
  lastReconnectAt = 0;
  lastSequenceGapAt = 0;
  /** Ring of recent inter-trade gaps (local clock) used for the median. */
  private readonly gaps = new Float64Array(GAP_WINDOW);
  private gapWrite = 0;
  private gapFilled = 0;
  private readonly recentIds: Array<string | number>;
  private idWrite = 0;
  private idFilled = 0;
  private readonly idSet = new Set<string>();

  constructor(
    private readonly duplicateWindow: number,
    private readonly maxOutOfOrderMs: number,
  ) {
    this.recentIds = new Array(duplicateWindow);
  }

  noteReconnect(now: number): void {
    this.lastReconnectAt = now;
    this.flags.add('reconnect');
  }

  noteSequenceGap(now: number): void {
    this.lastSequenceGapAt = now;
    this.flags.add('sequenceGap');
  }

  noteMissingData(): void {
    this.flags.add('missingData');
  }

  noteLatencySpike(): void {
    this.flags.add('latencySpike');
  }

  noteWideSpread(): void {
    this.flags.add('wideSpread');
  }

  noteStaleBook(): void {
    this.flags.add('staleBook');
  }

  clearTransient(): void {
    this.flags.delete('duplicate');
    this.flags.delete('outOfOrder');
    this.flags.delete('wideSpread');
    this.flags.delete('staleBook');
    this.flags.delete('latencySpike');
  }

  acceptTradeId(id: string | number | undefined, timestamp: number, receivedAt = Date.now()): boolean {
    if (id === undefined) return true;
    const key = String(id);
    if (this.idSet.has(key)) {
      this.flags.add('duplicate');
      return false;
    }
    if (this.idFilled === this.duplicateWindow) {
      const evicted = this.recentIds[this.idWrite];
      if (evicted !== undefined) this.idSet.delete(String(evicted));
    }
    this.recentIds[this.idWrite] = id;
    this.idWrite = (this.idWrite + 1) % this.duplicateWindow;
    if (this.idFilled < this.duplicateWindow) this.idFilled += 1;
    this.idSet.add(key);

    if (this.lastTradeTimestamp && timestamp + this.maxOutOfOrderMs < this.lastTradeTimestamp) {
      this.flags.add('outOfOrder');
    }
    if (timestamp >= this.lastTradeTimestamp) this.lastTradeTimestamp = timestamp;
    this.noteTradeReceived(receivedAt);
    return true;
  }

  /**
   * Liveness is measured on the local clock, not exchange event time: the two
   * come from different clocks, so mixing them turns ordinary skew into a
   * permanent "data is stale" verdict on a perfectly healthy feed.
   */
  private noteTradeReceived(receivedAt: number): void {
    if (this.lastTradeReceivedAt > 0) {
      const gap = receivedAt - this.lastTradeReceivedAt;
      if (gap >= 0) {
        this.gaps[this.gapWrite] = gap;
        this.gapWrite = (this.gapWrite + 1) % GAP_WINDOW;
        if (this.gapFilled < GAP_WINDOW) this.gapFilled += 1;
      }
    }
    this.lastTradeReceivedAt = receivedAt;
  }

  /** Median inter-trade gap in ms, or 0 until there are enough samples to mean anything. */
  medianTradeGapMs(): number {
    if (this.gapFilled < 8) return 0;
    const sorted = Array.from(this.gaps.subarray(0, this.gapFilled)).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  }

  /** Milliseconds since the last trade actually arrived, or Infinity if none ever did. */
  tradeAgeMs(now: number): number {
    return this.lastTradeReceivedAt > 0 ? Math.max(0, now - this.lastTradeReceivedAt) : Infinity;
  }

  snapshot(): IntegrityState {
    return {
      flags: new Set(this.flags),
      lastTradeTimestamp: this.lastTradeTimestamp,
      lastTradeReceivedAt: this.lastTradeReceivedAt,
      lastBookTimestamp: this.lastBookTimestamp,
      lastBookReceivedAt: this.lastBookReceivedAt,
      lastReconnectAt: this.lastReconnectAt,
      lastSequenceGapAt: this.lastSequenceGapAt,
      medianTradeGapMs: this.medianTradeGapMs(),
      tradeGapSamples: this.gapFilled,
      healthy: this.flags.size === 0,
    };
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function safeDiv(num: number, den: number): number {
  if (den === 0) return 0;
  return num / den;
}

export function bpsDiff(a: number, b: number): number {
  if (a === 0) return 0;
  return (Math.abs(a - b) / a) * 10_000;
}

export function pctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

export function formatQuote(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function formatTapeTime(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
