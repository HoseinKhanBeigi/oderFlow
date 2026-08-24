/**
 * Backfills US stock footprint history from Polygon trades.
 *
 * Crypto archives stay on `npm run backfill`. This path needs POLYGON_API_KEY
 * (Stocks plan) because there is no free tick archive comparable to Binance.
 *
 *   POLYGON_API_KEY=... npm run backfill:stocks -- --days 30
 *   POLYGON_API_KEY=... npm run backfill:stocks -- --days 7 --symbols AAPL,NVDA
 */
import { FootprintAggregator } from '../src/footprint/aggregator.js';
import { STOCK_TAPE_EXCHANGE } from '../src/exchange/venues.js';
import { fetchPolygonTradesDay } from '../src/exchange/polygon-stocks.js';
import { StockTickClassifier } from '../src/exchange/stock-adapter.js';
import { STOCK_WATCHLIST } from '../src/live/watchlist.js';
import { closePool, isStorageEnabled } from '../src/storage/db.js';
import { completedBackfillDays, recordBackfillRun, upsertBars } from '../src/storage/footprint-store.js';

interface Args {
  days: number;
  symbols: string[];
  concurrency: number;
  force: boolean;
  dryRun: boolean;
  apiKey: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const symbolsRaw = get('--symbols') ?? process.env.STOCK_SYMBOLS ?? '';
  const symbols = symbolsRaw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const apiKey = (get('--api-key') ?? process.env.POLYGON_API_KEY ?? '').trim();

  return {
    days: Math.min(Math.max(Number(get('--days') ?? 30), 1), 365),
    symbols: symbols.length ? symbols : STOCK_WATCHLIST.map((c) => c.symbol),
    concurrency: Math.min(Math.max(Number(get('--concurrency') ?? 2), 1), 4),
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    apiKey,
  };
}

function utcDays(count: number): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 1; i <= count; i++) {
    const d = new Date(today.getTime() - i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out.reverse();
}

async function backfillDay(symbol: string, day: string, args: Args): Promise<{ bars: number; trades: number }> {
  const classifier = new StockTickClassifier();
  const aggregator = new FootprintAggregator({ market: 'stock' });
  let trades = 0;
  let lastTs = 0;

  const count = await fetchPolygonTradesDay(symbol, day, args.apiKey, (print) => {
    lastTs = print.timestamp;
    trades++;
    aggregator.ingest(classifier.classify(print), STOCK_TAPE_EXCHANGE);
  });

  if (lastTs) aggregator.closeStale(lastTs + 60_000);
  const bars = aggregator.drainClosed();

  if (!args.dryRun) {
    if (bars.length) await upsertBars(bars, 'backfill');
    await recordBackfillRun(symbol, STOCK_TAPE_EXCHANGE, 'stock', day, bars.length, count);
  }

  return { bars: bars.length, trades };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.apiKey) {
    console.error('POLYGON_API_KEY is not set. Polygon Stocks is required for tick history.');
    process.exit(1);
  }
  if (!args.dryRun && !isStorageEnabled()) {
    console.error('DATABASE_URL is not set. Set it, or pass --dry-run to parse without writing.');
    process.exit(1);
  }

  const days = utcDays(args.days);
  const done = args.force || args.dryRun ? new Set<string>() : await completedBackfillDays(STOCK_TAPE_EXCHANGE, 'stock');
  const jobs: Array<{ symbol: string; day: string }> = [];
  for (const symbol of args.symbols) {
    for (const day of days) {
      if (done.has(`${symbol}|${day}`)) continue;
      jobs.push({ symbol, day });
    }
  }

  const total = args.symbols.length * days.length;
  console.log(
    `Stock backfill ${args.symbols.length} names × ${days.length} days (${days[0]} → ${days[days.length - 1]}) ` +
      `· ${jobs.length}/${total} to fetch${args.dryRun ? ' · DRY RUN' : ''}`,
  );
  if (!jobs.length) {
    console.log('Nothing to do — everything already backfilled. Use --force to redo.');
    return;
  }

  let completed = 0;
  let barsTotal = 0;
  let tradesTotal = 0;
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
        barsTotal += result.bars;
        tradesTotal += result.trades;
        console.log(
          `  [${completed}/${jobs.length}] ${job.symbol} ${job.day} — ${result.bars} bars from ` +
            `${result.trades.toLocaleString()} trades`,
        );
      } catch (err) {
        completed++;
        failed++;
        console.error(
          `  [${completed}/${jobs.length}] ${job.symbol} ${job.day} — FAILED: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
  const mins = ((Date.now() - started) / 60_000).toFixed(1);
  console.log(
    `\nDone in ${mins} min · ${barsTotal.toLocaleString()} bars · ${tradesTotal.toLocaleString()} trades · ${failed} failed`,
  );
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void closePool());
