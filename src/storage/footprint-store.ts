import type { ExchangeId } from '../exchange/venues.js';
import type { MarketType } from '../models/trade.js';
import type { FootprintBar, FootprintLevel, FootprintSource } from '../footprint/types.js';
import { getPool, initSchema } from './db.js';

/** Levels are stored as `[price, buy, sell]` triples to keep JSONB compact. */
type LevelTriple = [number, number, number];

const UPSERT_COLUMNS = 13;

function encodeLevels(levels: FootprintLevel[]): LevelTriple[] {
  return levels.map((l) => [l.price, round2(l.buy), round2(l.sell)]);
}

function decodeLevels(raw: unknown): FootprintLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: FootprintLevel[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const price = Number(row[0]);
    const buy = Number(row[1]);
    const sell = Number(row[2]);
    if (!Number.isFinite(price)) continue;
    out.push({ price, buy: Number.isFinite(buy) ? buy : 0, sell: Number.isFinite(sell) ? sell : 0 });
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Writes bars, overwriting any existing row for the same
 * (symbol, exchange, market, minute). Last write wins: the aggregator holds
 * the complete bar in memory, and a backfill run is authoritative for its day.
 */
export async function upsertBars(bars: FootprintBar[], source: FootprintSource = 'live'): Promise<number> {
  if (!bars.length) return 0;
  await initSchema();
  const pool = getPool();

  let written = 0;
  for (let i = 0; i < bars.length; i += 500) {
    const chunk = bars.slice(i, i + 500);
    const values: unknown[] = [];
    const rows: string[] = [];

    chunk.forEach((bar, idx) => {
      const base = idx * UPSERT_COLUMNS;
      rows.push(
        `($${base + 1},$${base + 2},$${base + 3},to_timestamp($${base + 4}),$${base + 5},$${base + 6},` +
          `$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12}::jsonb,$${base + 13})`,
      );
      values.push(
        bar.symbol,
        bar.exchange,
        bar.market,
        bar.time,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        round2(bar.totalBuy),
        round2(bar.totalSell),
        bar.trades,
        JSON.stringify(encodeLevels(bar.levels)),
        source,
      );
    });

    const res = await pool.query(
      `INSERT INTO footprint_bars
         (symbol, exchange, market, bucket_ts, open, high, low, close, total_buy, total_sell, trades, levels, source)
       VALUES ${rows.join(',')}
       ON CONFLICT (symbol, exchange, market, bucket_ts) DO UPDATE SET
         open       = EXCLUDED.open,
         high       = EXCLUDED.high,
         low        = EXCLUDED.low,
         close      = EXCLUDED.close,
         total_buy  = EXCLUDED.total_buy,
         total_sell = EXCLUDED.total_sell,
         trades     = EXCLUDED.trades,
         levels     = EXCLUDED.levels,
         source     = EXCLUDED.source,
         updated_at = now()`,
      values,
    );
    written += res.rowCount ?? 0;
  }
  return written;
}

export interface LoadBarsQuery {
  symbol: string;
  market: MarketType;
  exchanges: ExchangeId[];
  /** Inclusive lower bound, unix seconds. */
  fromSec: number;
  /** Exclusive upper bound, unix seconds. */
  toSec: number;
  limit?: number;
}

export async function loadBars(query: LoadBarsQuery): Promise<FootprintBar[]> {
  if (!query.exchanges.length) return [];
  await initSchema();
  const pool = getPool();

  const res = await pool.query(
    `SELECT symbol, exchange, market,
            EXTRACT(EPOCH FROM bucket_ts)::bigint AS t,
            open, high, low, close, total_buy, total_sell, trades, levels
       FROM footprint_bars
      WHERE symbol = $1
        AND market = $2
        AND exchange = ANY($3::text[])
        AND bucket_ts >= to_timestamp($4)
        AND bucket_ts <  to_timestamp($5)
      ORDER BY bucket_ts ASC
      LIMIT $6`,
    [query.symbol, query.market, query.exchanges, query.fromSec, query.toSec, query.limit ?? 200_000],
  );

  return res.rows.map((row) => ({
    symbol: String(row.symbol),
    exchange: String(row.exchange) as ExchangeId,
    market: String(row.market) as MarketType,
    time: Number(row.t),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    totalBuy: Number(row.total_buy),
    totalSell: Number(row.total_sell),
    trades: Number(row.trades),
    levels: decodeLevels(row.levels),
  }));
}

/** Drops bars older than the retention window. Returns rows removed. */
export async function pruneOlderThan(days: number): Promise<number> {
  await initSchema();
  const res = await getPool().query(
    `DELETE FROM footprint_bars WHERE bucket_ts < now() - ($1::int * INTERVAL '1 day')`,
    [days],
  );
  return res.rowCount ?? 0;
}

export async function recordBackfillRun(
  symbol: string,
  exchange: ExchangeId,
  market: MarketType,
  day: string,
  bars: number,
  aggTrades: number,
): Promise<void> {
  await initSchema();
  await getPool().query(
    `INSERT INTO footprint_backfill_runs (symbol, exchange, market, day, bars, agg_trades)
     VALUES ($1,$2,$3,$4::date,$5,$6)
     ON CONFLICT (symbol, exchange, market, day) DO UPDATE SET
       bars = EXCLUDED.bars,
       agg_trades = EXCLUDED.agg_trades,
       completed_at = now()`,
    [symbol, exchange, market, day, bars, aggTrades],
  );
}

export async function completedBackfillDays(
  exchange: ExchangeId,
  market: MarketType,
): Promise<Set<string>> {
  await initSchema();
  const res = await getPool().query(
    `SELECT symbol, to_char(day, 'YYYY-MM-DD') AS day
       FROM footprint_backfill_runs
      WHERE exchange = $1 AND market = $2`,
    [exchange, market],
  );
  return new Set(res.rows.map((r) => `${r.symbol}|${r.day}`));
}

export interface CoverageRow {
  symbol: string;
  exchange: string;
  bars: number;
  firstBar: number | null;
  lastBar: number | null;
}

export async function coverage(market: MarketType): Promise<CoverageRow[]> {
  await initSchema();
  const res = await getPool().query(
    `SELECT symbol, exchange, count(*)::int AS bars,
            EXTRACT(EPOCH FROM min(bucket_ts))::bigint AS first_bar,
            EXTRACT(EPOCH FROM max(bucket_ts))::bigint AS last_bar
       FROM footprint_bars
      WHERE market = $1
      GROUP BY symbol, exchange
      ORDER BY symbol, exchange`,
    [market],
  );
  return res.rows.map((r) => ({
    symbol: String(r.symbol),
    exchange: String(r.exchange),
    bars: Number(r.bars),
    firstBar: r.first_bar === null ? null : Number(r.first_bar),
    lastBar: r.last_bar === null ? null : Number(r.last_bar),
  }));
}
