/**
 * Backfills footprint history from Binance's public daily archives.
 *
 * The live recorder can only capture data from the moment it starts, so the
 * 30-day window is reconstructed from https://data.binance.vision — free,
 * no API key, tick-level aggTrades.
 *
 *   npm run backfill -- --days 30
 *   npm run backfill -- --days 7 --symbols BTCUSDT,ETHUSDT --concurrency 4
 *   npm run backfill -- --days 1 --dry-run
 *
 * US stocks are a different tape — use `npm run backfill:stocks`.
 */
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import { FootprintAggregator } from '../src/footprint/aggregator.js';
import { classifyTrade } from '../src/flow/trade-classifier.js';
import { DEFAULT_WATCHLIST } from '../src/live/watchlist.js';
import type { MarketType } from '../src/models/trade.js';
import { isStorageEnabled } from '../src/storage/db.js';
import { closePool } from '../src/storage/db.js';
import {
  completedBackfillDays,
  recordBackfillRun,
  upsertBars,
} from '../src/storage/footprint-store.js';

interface Args {
  days: number;
  symbols: string[];
  market: MarketType;
  concurrency: number;
  force: boolean;
  dryRun: boolean;
  gapFill: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const market: MarketType = (get('--market') ?? process.env.MARKET ?? 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';
  const symbolsRaw = get('--symbols') ?? process.env.SYMBOLS ?? '';
  const symbols = symbolsRaw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  return {
    days: Math.min(Math.max(Number(get('--days') ?? 30), 1), 365),
    symbols: symbols.length ? symbols : DEFAULT_WATCHLIST.map((c) => c.symbol),
    market,
    concurrency: Math.min(Math.max(Number(get('--concurrency') ?? 3), 1), 8),
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    gapFill: argv.includes('--gap-fill'),
  };
}

function utcDays(count: number): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  // Yesterday backwards: today's archive is not published until the day rolls.
  for (let i = 1; i <= count; i++) {
    const d = new Date(today.getTime() - i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out.reverse();
}

function archiveUrl(symbol: string, day: string, market: MarketType): string {
  const segment = market === 'spot' ? 'spot' : 'futures/um';
  return `https://data.binance.vision/data/${segment}/daily/aggTrades/${symbol}/${symbol}-aggTrades-${day}.zip`;
}

/**
 * Returns the deflate stream for a single-entry zip.
 *
 * Implemented inline against the local file header so the project does not
 * take on an unzip dependency for one call site.
 */
function unzipSingleEntry(buf: Buffer): Readable {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip archive');
  const method = buf.readUInt16LE(8);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  const body = Readable.from([buf.subarray(start)]);
  if (method === 0) return body;
  if (method !== 8) throw new Error(`unsupported zip compression method ${method}`);
  return body.pipe(createInflateRaw());
}

async function download(url: string, attempts = 3): Promise<Buffer | null> {
  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'oderFlow-backfill/1.0' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (i < attempts - 1) await sleep(1_000 * 2 ** i);
    }
  }
  throw new Error(`download failed after ${attempts} attempts: ${lastError}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spot archives use microseconds and `True`/`False`; futures use ms and `true`/`false`. */
function normalizeTimestamp(raw: number): number {
  return raw > 1e14 ? Math.floor(raw / 1000) : raw;
}

interface DayResult {
  bars: number;
  aggTrades: number;
  skipped?: 'missing' | 'done';
}

async function backfillDay(symbol: string, day: string, args: Args): Promise<DayResult> {
  const buf = await download(archiveUrl(symbol, day, args.market));
  if (!buf) return { bars: 0, aggTrades: 0, skipped: 'missing' };

  const aggregator = new FootprintAggregator({ market: args.market });
  let aggTrades = 0;
  let lastTs = 0;

  const rl = createInterface({ input: unzipSingleEntry(buf), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    if (line.charCodeAt(0) === 97 /* 'a' */ && line.startsWith('agg_trade_id')) continue;

    const cols = line.split(',');
    if (cols.length < 7) continue;
    const price = Number(cols[1]);
    const quantity = Number(cols[2]);
    const rawTs = Number(cols[5]);
    const makerFlag = cols[6];
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || !Number.isFinite(rawTs)) continue;

    const timestamp = normalizeTimestamp(rawTs);
    lastTs = timestamp;
    aggTrades++;

    aggregator.ingest(
      classifyTrade({
        symbol,
        marketType: args.market,
        timestamp,
        price,
        quantity,
        isBuyerMaker: makerFlag === 'true' || makerFlag === 'True',
      }),
      'binance',
    );
  }

  // Roll the final minute of the day.
  aggregator.closeStale(lastTs + 60_000);
  const bars = aggregator.drainClosed();

  if (!args.dryRun && bars.length) {
    await upsertBars(bars, 'backfill');
    await recordBackfillRun(symbol, 'binance', args.market, day, bars.length, aggTrades);
  }

  return { bars: bars.length, aggTrades };
}

interface RestAggTrade {
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

/**
 * Fills the window between the last published archive and now using the REST
 * aggTrades endpoint.
 *
 * Binance publishes day D's archive early on D+1, so without this the chart
 * has a hole covering the most recent hours — exactly where people look.
 * Paged by `fromId` because the time-range form caps at one hour.
 */
async function gapFillSymbol(symbol: string, sinceMs: number, args: Args): Promise<DayResult> {
  const base = args.market === 'spot' ? 'https://api.binance.com/api/v3' : 'https://fapi.binance.com/fapi/v1';
  const aggregator = new FootprintAggregator({ market: args.market });
  const endMs = Date.now();
  let aggTrades = 0;
  let lastTs = sinceMs;
  let fromId: number | null = null;
  let windowStart = sinceMs;

  for (let page = 0; page < 50_000; page++) {
    // The time-range form caps at one hour, so it is only used to find the
    // first trade id; everything after that pages by id.
    let url: string;
    if (fromId === null) {
      if (windowStart >= endMs) break;
      const windowEnd = Math.min(windowStart + 3_600_000, endMs);
      url = `${base}/aggTrades?symbol=${symbol}&startTime=${windowStart}&endTime=${windowEnd}&limit=1000`;
    } else {
      url = `${base}/aggTrades?symbol=${symbol}&fromId=${fromId}&limit=1000`;
    }

    const res = await fetch(url, { headers: { 'User-Agent': 'oderFlow-backfill/1.0' } });
    if (res.status === 429 || res.status === 418) {
      const wait = Number(res.headers.get('retry-after') ?? 30) * 1000;
      console.warn(`    rate limited, sleeping ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`aggTrades HTTP ${res.status}`);

    const rows = (await res.json()) as RestAggTrade[];
    if (!Array.isArray(rows) || !rows.length) {
      // A quiet hour is not the end of the data — step to the next window.
      if (fromId === null) {
        windowStart += 3_600_000;
        continue;
      }
      break;
    }

    for (const row of rows) {
      const price = Number(row.p);
      const quantity = Number(row.q);
      if (!Number.isFinite(price) || !Number.isFinite(quantity)) continue;
      lastTs = row.T;
      aggTrades++;
      aggregator.ingest(
        classifyTrade({ symbol, marketType: args.market, timestamp: row.T, price, quantity, isBuyerMaker: row.m }),
        'binance',
      );
    }

    const last = rows[rows.length - 1];
    if (!last) break;
    if (last.T >= endMs) break;
    fromId = last.a + 1;
    await sleep(120);
  }

  // Leave the in-progress minute to the live recorder.
  aggregator.closeStale(lastTs);
  const bars = aggregator.drainClosed();
  if (!args.dryRun && bars.length) await upsertBars(bars, 'backfill');
  return { bars: bars.length, aggTrades };
}

async function runGapFill(args: Args): Promise<void> {
  // Archives are published for completed UTC days only.
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const sinceMs = todayUtc.getTime();
  const hours = ((Date.now() - sinceMs) / 3_600_000).toFixed(1);

  console.log(`\nGap-filling ${hours}h since ${todayUtc.toISOString()} from the REST API (slow for busy symbols)…`);
  for (const symbol of args.symbols) {
    try {
      const result = await gapFillSymbol(symbol, sinceMs, args);
      console.log(`  ${symbol} — ${result.bars} bars from ${result.aggTrades.toLocaleString()} aggTrades`);
    } catch (err) {
      console.error(`  ${symbol} — FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dryRun && !isStorageEnabled()) {
    console.error('DATABASE_URL is not set. Set it, or pass --dry-run to parse without writing.');
    process.exit(1);
  }

  const days = utcDays(args.days);
  const done = args.force || args.dryRun ? new Set<string>() : await completedBackfillDays('binance', args.market);

  const jobs: Array<{ symbol: string; day: string }> = [];
  for (const symbol of args.symbols) {
    for (const day of days) {
      if (done.has(`${symbol}|${day}`)) continue;
      jobs.push({ symbol, day });
    }
  }

  const total = args.symbols.length * days.length;
  console.log(
    `Backfilling ${args.symbols.length} symbols × ${days.length} days (${days[0]} → ${days[days.length - 1]}) ` +
      `· market=${args.market} · ${jobs.length}/${total} to fetch${args.dryRun ? ' · DRY RUN' : ''}`,
  );
  if (!jobs.length) {
    console.log('Nothing to do — everything already backfilled. Use --force to redo.');
    if (args.gapFill) await runGapFill(args);
    return;
  }

  let completed = 0;
  let barsTotal = 0;
  let tradesTotal = 0;
  let missing = 0;
  let failed = 0;
  const started = Date.now();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      if (!job) return;
      try {
        const result = await backfillDay(job.symbol, job.day, args);
        completed++;
        if (result.skipped === 'missing') {
          missing++;
          console.log(`  [${completed}/${jobs.length}] ${job.symbol} ${job.day} — not published yet, skipped`);
        } else {
          barsTotal += result.bars;
          tradesTotal += result.aggTrades;
          console.log(
            `  [${completed}/${jobs.length}] ${job.symbol} ${job.day} — ${result.bars} bars from ` +
              `${result.aggTrades.toLocaleString()} aggTrades`,
          );
        }
      } catch (err) {
        completed++;
        failed++;
        console.error(`  [${completed}/${jobs.length}] ${job.symbol} ${job.day} — FAILED: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));

  const mins = ((Date.now() - started) / 60_000).toFixed(1);
  console.log(
    `\nDone in ${mins} min · ${barsTotal.toLocaleString()} bars · ` +
      `${tradesTotal.toLocaleString()} aggTrades · ${missing} unpublished · ${failed} failed`,
  );

  if (args.gapFill) await runGapFill(args);
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void closePool());
