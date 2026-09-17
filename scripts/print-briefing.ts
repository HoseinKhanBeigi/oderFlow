/**
 * Prints the LLM briefing for one symbol, live, so it can be read by hand.
 *
 * The test this exists for: read the output and decide an entry without looking
 * at the chart. If you cannot, the briefing is missing something — fix the
 * context builder, not the prompt.
 *
 * Run:
 *   pnpm briefing
 *   SYMBOL=ETHUSDT pnpm briefing
 *   MARKET=spot pnpm briefing
    10| *   FORMAT=json pnpm briefing
 *   INTERVAL_MS=10000 pnpm briefing
 */
import { LiveBinanceFeed } from '../src/live/live-feed.js';
import { DEFAULT_WATCHLIST, EQUITY_PERP_WATCHLIST, minUsdFor } from '../src/live/watchlist.js';
import { FootprintAggregator } from '../src/footprint/aggregator.js';
import { briefingToJson, briefingToText, buildBriefing, estimateTokens } from '../src/agent/index.js';
import type { FootprintBar } from '../src/footprint/types.js';

const SYMBOL = (process.env.SYMBOL ?? 'BTCUSDT').toUpperCase();
const MARKET = (process.env.MARKET ?? 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';
const FORMAT = (process.env.FORMAT ?? 'text').toLowerCase();
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 15_000);
const MAX_HISTORY_BARS = 60;

const known = [...DEFAULT_WATCHLIST, ...EQUITY_PERP_WATCHLIST].find((c) => c.symbol === SYMBOL);
const coin = {
  symbol: SYMBOL,
  label: known?.label ?? SYMBOL.replace(/USDT$/, ''),
  minUsd: known?.minUsd ?? minUsdFor(SYMBOL),
  venue: known?.venue ?? ('crypto' as const),
};

const feed = new LiveBinanceFeed({ coins: [coin], market: MARKET, summaryMs: 2_000 });
const footprint = new FootprintAggregator({ market: MARKET });
const closedBars: FootprintBar[] = [];

feed.onAnyTrade((trade, exchange) => {
  if (exchange !== 'binance' || trade.symbol !== SYMBOL) return;
  footprint.ingest(trade, exchange);
});

feed.on((event) => {
  if (event.type === 'status') console.error(`[feed] ${event.message}`);
});

feed.start();

console.error(`Briefing for ${SYMBOL} ${MARKET} every ${INTERVAL_MS}ms. Ctrl+C to stop.\n`);

const timer = setInterval(() => {
  const now = Date.now();
  let text: string;
  try {
    const briefing = buildBriefing({
      snapshot: feed.engine.multiWindow(SYMBOL, MARKET, now),
      footprint: recentBars(now),
      now,
    });
    text = FORMAT === 'json' ? briefingToJson(briefing, true) : briefingToText(briefing);
  } catch (err) {
    console.error(`[waiting] ${(err as Error).message}`);
    return;
  }

  console.log(`\n${'═'.repeat(100)}`);
  console.log(text);
  console.log(`${'─'.repeat(100)}`);
  console.log(`${text.length} chars · ~${estimateTokens(text)} tokens (${FORMAT})`);
}, INTERVAL_MS);

process.on('SIGINT', () => {
  clearInterval(timer);
  feed.stop();
  process.exit(0);
});

function recentBars(now: number): FootprintBar[] {
  footprint.closeStale(now);
  closedBars.push(...footprint.drainClosed());
  if (closedBars.length > MAX_HISTORY_BARS) {
    closedBars.splice(0, closedBars.length - MAX_HISTORY_BARS);
  }
  const open = footprint.currentBar(SYMBOL, 'binance');
  return open ? [...closedBars, open] : [...closedBars];
}
