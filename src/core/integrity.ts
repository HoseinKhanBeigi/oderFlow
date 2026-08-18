export type IntegrityFlag =
  | 'reconnect'
  | 'duplicate'
  | 'outOfOrder'
  | 'staleBook'
  | 'sequenceGap'
  | 'wideSpread'
  | 'missingData'
  | 'latencySpike';

export interface IntegrityState {
  flags: Set<IntegrityFlag>;
  lastTradeTimestamp: number;
  lastBookTimestamp: number;
  lastReconnectAt: number;
  lastSequenceGapAt: number;
  healthy: boolean;
}

export class IntegrityMonitor {
  readonly flags = new Set<IntegrityFlag>();
  lastTradeTimestamp = 0;
  lastBookTimestamp = 0;
  lastReconnectAt = 0;
  lastSequenceGapAt = 0;
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

  acceptTradeId(id: string | number | undefined, timestamp: number): boolean {
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
    return true;
  }

  snapshot(): IntegrityState {
    return {
      flags: new Set(this.flags),
      lastTradeTimestamp: this.lastTradeTimestamp,
      lastBookTimestamp: this.lastBookTimestamp,
      lastReconnectAt: this.lastReconnectAt,
      lastSequenceGapAt: this.lastSequenceGapAt,
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
