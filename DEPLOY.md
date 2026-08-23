# Deploying to Railway

The dashboard runs as a single Node service plus a Postgres database. Postgres
stores 1-minute footprint bars so the chart has real history instead of the
empty candles it used to draw for anything older than the current session.

## 1. Pick a non-US region first

**Binance returns HTTP 451 to US IP addresses.** The server connects to Binance
from its own IP, so a US-region deployment produces a dashboard that connects to
nothing. Before the first deploy, open the service and set:

> Settings → Deploy → **Region** → `europe-west4` (Amsterdam) or `asia-southeast1` (Singapore)

## 2. Create the service and database

```bash
railway init
railway add --database postgres
railway up
```

`railway.json` already sets the start command and points the healthcheck at
`/api/health`.

## 3. Wire the database to the app — this is not automatic

Adding a Postgres service does **not** give the app access to it. Railway keeps
variables per-service, so you must add a reference by hand:

> oderFlow service → **Variables** → New Variable
>
> | Name | Value |
> | --- | --- |
> | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |

The `${{...}}` reference is required. Do **not** paste a literal connection
string, and do not accept Railway's "Suggested Variables" autofill for
`DATABASE_URL` — it reads `.env.example` and offers a localhost URL, which would
point the app at its own container and silently store nothing.

Saving the variable triggers a redeploy. The schema is created on first
connection, so there is no migration to run. Confirm with:

```bash
curl https://<your-app>.up.railway.app/api/health
```

`storage.enabled` must be `true`. If it is `false`, the variable is missing.

## 4. Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | Set by Railway. **Without it the app runs fine but stores nothing.** |
| `PORT` | `3456` | Set by Railway. |
| `MARKET` | `perp` | `perp` or `spot`. |
| `SYMBOLS` | full watchlist | Comma-separated override, e.g. `BTCUSDT,ETHUSDT`. |
| `EXCHANGES` | all | Comma-separated venue ids. |
| `FOOTPRINT_RETENTION_DAYS` | `30` | Bars older than this are pruned every 6 hours. |
| `FOOTPRINT_FLUSH_MS` | `15000` | How often in-progress bars are checkpointed. |
| `FOOTPRINT_PUSH_MS` | `1000` | Live bar push interval per connected browser. |

## 5. Backfill the last 30 days

Live recording only captures data from the moment the server starts. The
preceding 30 days are reconstructed from Binance's public daily archives
(`data.binance.vision`) — free, no API key, tick-level `aggTrades`.

Run it once against the deployed database:

```bash
railway run npm run backfill -- --days 30 --gap-fill
```

Or locally against the same database:

```bash
DATABASE_URL='...' npm run backfill -- --days 30 --gap-fill
```

Options:

| Flag | Default | Notes |
| --- | --- | --- |
| `--days N` | `30` | Completed UTC days to fetch, counting back from yesterday. |
| `--symbols A,B` | full watchlist | Restrict the run. |
| `--concurrency N` | `3` | Parallel symbol-days. Each holds one archive in memory. |
| `--gap-fill` | off | Also pull today's trades via REST (see below). |
| `--force` | off | Re-fetch days already recorded as complete. |
| `--dry-run` | off | Parse and report without writing. |

The script is **idempotent** — completed symbol-days are tracked in
`footprint_backfill_runs` and skipped on the next run, so it is safe to re-run
after an interruption.

### Why `--gap-fill`

Binance publishes day `D`'s archive early on `D+1`. Without gap-fill your
history stops at the end of yesterday, leaving a hole of up to 24 hours right
where people look most. `--gap-fill` closes it using the REST `aggTrades`
endpoint, paging by trade id.

REST is much slower than the archives, so it is opt-in. It is quick for quiet
symbols and slow for BTC. Run it after the archive pass, and schedule it as a
Railway cron if you want the seam closed continuously.

### What it costs

Measured on real data, per symbol:

| | BTCUSDT (busiest) | Typical alt / equity perp |
| --- | --- | --- |
| aggTrades per day | ~2.8M | 15k–200k |
| Archive download per day | ~32 MB | 0.7–2.4 MB |
| Stored bars per day | 1,440 | 1,300–1,440 |
| Stored size, 30 days | ~10 MB | ~1–3 MB |

Aggregation is what makes this cheap: a day of BTC is 175 MB of raw CSV but only
about 290 KB once collapsed into 1-minute bars with per-price levels. The full
17-symbol watchlist is roughly **2.5 GB of one-time downloads** and settles at
well under **500 MB stored**.

Expect roughly 25 seconds per BTC day and a few seconds for smaller symbols, so
a full 30-day 17-symbol backfill takes on the order of half an hour.

## 6. Verify

```bash
curl https://<your-app>.up.railway.app/api/health
curl https://<your-app>.up.railway.app/api/footprint/coverage
```

`coverage` lists bar counts and the first/last bar per symbol — the quickest way
to confirm the backfill landed and live recording is extending it.

## How history and live fit together

- The server aggregates **every** trade into 1-minute bars, not just the large
  prints shown in the tape, so stored bars are a true footprint.
- `/api/footprint` returns bars rolled up to the requested timeframe, stopping
  at the start of the current minute.
- That final minute arrives over the WebSocket instead, so the two sources never
  double-count. When the minute rolls, the browser refetches.
- Bars past the retention window are deleted every 6 hours.

## Adding dependencies: use pnpm

This project builds with **pnpm**. Nixpacks reads `pnpm-lock.yaml` and runs
`pnpm i --frozen-lockfile`, so a dependency added with npm updates the wrong
lockfile and the deploy fails with:

```
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"
because pnpm-lock.yaml is not up to date with package.json
```

Use pnpm for dependency changes:

```bash
pnpm add some-package
pnpm add -D some-dev-package
```

If you do end up editing `package.json` by hand or installing with npm, refresh
the lockfile without touching `node_modules`:

```bash
pnpm install --lockfile-only
```

`package-lock.json` is gitignored so it cannot come back and desync the build.

## Notes and limitations

- **Backfill is Binance-only.** The other venues stream live into the database,
  but have no historical archive here, so their history begins when you deploy.
- **Archive lag is about a day**, which is what `--gap-fill` exists to cover.
- **Price bucketing is coarse for cheap or low-range instruments.** Buckets come
  from `tickSize()`, which uses $0.50 steps for anything priced $100–$1,000. An
  equity perp that moves a few cents a minute collapses into one or two levels
  per bar. Adjust `src/footprint/tick-size.ts` if you want finer granularity —
  but keep it identical to `tickSize()` in `public/app.js`, or stored and
  browser-rendered bars will land on different grids.
- **Restarts lose at most `FOOTPRINT_FLUSH_MS` of the in-progress minute.**
  `SIGTERM` triggers a final flush, so ordinary redeploys lose nothing.
