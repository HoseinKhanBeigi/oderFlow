import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let ready: Promise<void> | null = null;

export function databaseUrl(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  return url ? url : null;
}

export function isStorageEnabled(): boolean {
  return databaseUrl() !== null;
}

/**
 * Railway's Postgres presents a certificate that does not chain to a public
 * root, so verification is disabled for its internal hostnames. External
 * databases keep full verification.
 */
function sslFor(url: string): pg.ConnectionConfig['ssl'] {
  if (process.env.PGSSLMODE === 'disable') return undefined;
  if (/\.railway\.internal|localhost|127\.0\.0\.1/.test(url)) return undefined;
  return { rejectUnauthorized: false };
}

export function getPool(): pg.Pool {
  const url = databaseUrl();
  if (!url) throw new Error('DATABASE_URL is not set');
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      ssl: sslFor(url),
      max: Number(process.env.PGPOOL_MAX ?? 8),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => {
      console.error('[db] idle client error:', err.message);
    });
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS footprint_bars (
  symbol      TEXT             NOT NULL,
  exchange    TEXT             NOT NULL,
  market      TEXT             NOT NULL,
  bucket_ts   TIMESTAMPTZ      NOT NULL,
  open        DOUBLE PRECISION NOT NULL,
  high        DOUBLE PRECISION NOT NULL,
  low         DOUBLE PRECISION NOT NULL,
  close       DOUBLE PRECISION NOT NULL,
  total_buy   DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_sell  DOUBLE PRECISION NOT NULL DEFAULT 0,
  trades      INTEGER          NOT NULL DEFAULT 0,
  levels      JSONB            NOT NULL DEFAULT '[]'::jsonb,
  source      TEXT             NOT NULL DEFAULT 'live',
  updated_at  TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, exchange, market, bucket_ts)
);

CREATE INDEX IF NOT EXISTS footprint_bars_bucket_ts_idx ON footprint_bars (bucket_ts);

CREATE TABLE IF NOT EXISTS footprint_backfill_runs (
  symbol      TEXT        NOT NULL,
  exchange    TEXT        NOT NULL,
  market      TEXT        NOT NULL,
  day         DATE        NOT NULL,
  bars        INTEGER     NOT NULL DEFAULT 0,
  agg_trades  BIGINT      NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, exchange, market, day)
);
`;

/** Creates tables on first use. Safe to call repeatedly and concurrently. */
export async function initSchema(): Promise<void> {
  if (!ready) {
    ready = getPool()
      .query(SCHEMA)
      .then(() => undefined)
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  return ready;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  ready = null;
  await p.end();
}
