import { FootprintAggregator } from '../footprint/aggregator.js';
import type { FootprintBar } from '../footprint/types.js';
import type { ExchangeId } from '../exchange/venues.js';
import type { MarketTrade, MarketType } from '../models/trade.js';
import { isStorageEnabled } from './db.js';
import { pruneOlderThan, upsertBars } from './footprint-store.js';

export interface FootprintRecorderOptions {
  market: MarketType;
  /** How often in-progress bars are checkpointed. */
  flushMs?: number;
  retentionDays?: number;
  pruneMs?: number;
}

/** Bars held while the database is unreachable, before the oldest are dropped. */
const MAX_PENDING = 20_000;

/**
 * Persists live footprint bars to Postgres.
 *
 * Writes survive a database outage by buffering in memory, and the ingest path
 * never throws: a storage failure degrades history, it must not kill the feed.
 */
export class FootprintRecorder {
  readonly aggregator: FootprintAggregator;
  private flushTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private pending: FootprintBar[] = [];
  private inFlight: Promise<void> | null = null;
  private lastError = '';
  private written = 0;

  constructor(private readonly options: FootprintRecorderOptions) {
    this.aggregator = new FootprintAggregator({ market: options.market });
  }

  get enabled(): boolean {
    return isStorageEnabled();
  }

  ingest(trade: MarketTrade, exchange: ExchangeId): void {
    this.aggregator.ingest(trade, exchange);
  }

  start(): void {
    if (!this.enabled) {
      console.log('[footprint] DATABASE_URL not set — history will not be persisted');
      return;
    }
    const flushMs = this.options.flushMs ?? 15_000;
    const pruneMs = this.options.pruneMs ?? 6 * 60 * 60_000;

    this.flushTimer = setInterval(() => void this.flush(), flushMs);
    this.flushTimer.unref?.();

    this.pruneTimer = setInterval(() => void this.prune(), pruneMs);
    this.pruneTimer.unref?.();

    void this.prune();
    console.log(`[footprint] recording to Postgres · flush ${flushMs / 1000}s · retention ${this.retentionDays}d`);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.flushTimer = null;
    this.pruneTimer = null;
    if (this.enabled) await this.flush();
  }

  private get retentionDays(): number {
    return this.options.retentionDays ?? 30;
  }

  /**
   * Persists closed and in-progress bars. Concurrent callers share one write,
   * so `/api/footprint` can await this to guarantee it reads complete history.
   */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runFlush().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runFlush(): Promise<void> {
    this.aggregator.closeStale();
    const batch = [...this.pending, ...this.aggregator.drainClosed(), ...this.aggregator.openBars(true)];
    this.pending = [];
    if (!batch.length) return;

    try {
      this.written += await upsertBars(batch, 'live');
      this.lastError = '';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.lastError) {
        console.error('[footprint] flush failed, buffering:', message);
        this.lastError = message;
      }
      this.pending = batch.slice(-MAX_PENDING);
    }
  }

  private async prune(): Promise<void> {
    if (!this.enabled) return;
    try {
      const removed = await pruneOlderThan(this.retentionDays);
      if (removed > 0) console.log(`[footprint] pruned ${removed} bars older than ${this.retentionDays}d`);
    } catch (err) {
      console.error('[footprint] prune failed:', err instanceof Error ? err.message : err);
    }
  }

  stats(): { enabled: boolean; written: number; pending: number; lastError: string } {
    return {
      enabled: this.enabled,
      written: this.written,
      pending: this.pending.length,
      lastError: this.lastError,
    };
  }
}
