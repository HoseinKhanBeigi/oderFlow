/**
 * Live aggressive flow tape — Binance WebSocket.
 *
 * Run:
 *   npm run demo:live
 *   SYMBOL=ETHUSDT npm run demo:live
 *   MIN_USD=50000 npm run demo:live          # only prints >= $50K
 *   MIN_USD=0 npm run demo:live              # every aggressive print (very noisy on BTC)
 *   MARKET=spot npm run demo:live            # spot instead of futures
 */
import WebSocket from 'ws';
import { OrderFlowEngine } from '../src/engine/order-flow-engine.js';
import { BinanceFuturesAdapter, BinanceSpotAdapter } from '../src/exchange/binance-adapters.js';
import { BINANCE_FUTURES_WS, BINANCE_SPOT_WS, streamName } from '../src/exchange/types.js';
import { formatQuote, formatTapeTime } from '../src/core/integrity.js';
import type { MarketTrade } from '../src/models/trade.js';
import type { BinanceAggTrade, BinanceBookTicker, BinanceTrade } from '../src/exchange/types.js';

const SYMBOL = (process.env.SYMBOL ?? 'BTCUSDT').toUpperCase();
const MARKET = (process.env.MARKET ?? 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';
const MIN_USD = Number(process.env.MIN_USD ?? (SYMBOL.startsWith('BTC') ? 10_000 : 5_000));
const SUMMARY_EVERY_MS = Number(process.env.INTERVAL_MS ?? 5_000);

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const engine = new OrderFlowEngine();
const spotAdapter = new BinanceSpotAdapter();
const futuresAdapter = new BinanceFuturesAdapter();
const sym = engine.getSymbol(SYMBOL, MARKET);

let tradeCount = 0;
let buyCount = 0;
let sellCount = 0;
let lastSummary = 0;

engine.on((ev) => {
  if (ev.kind === 'burst') {
    const b = ev.burst;
    console.log(
      `\n${BOLD}>>> ${b.side} BURST${RESET}  ${formatQuote(b.totalQuoteValue)} in ${((b.endTime - b.startTime) / 1000).toFixed(1)}s  (${b.tradeCount} trades)\n`,
    );
  }
  if (ev.kind === 'alert') {
    console.log(`\n${BOLD}!!! ${ev.alert.type}${RESET}  ${ev.alert.message}\n`);
  }
});

const base = MARKET === 'spot' ? BINANCE_SPOT_WS : BINANCE_FUTURES_WS;
// Futures `@aggTrade` can be unavailable on some networks; `@trade` is the reliable fallback.
const tradeChannel = MARKET === 'spot' ? 'aggTrade' : 'trade';
const streams = [streamName(SYMBOL, tradeChannel), streamName(SYMBOL, 'bookTicker')].join('/');
const url = `${base}?streams=${streams}`;

console.log(`${BOLD}Live aggressive flow — Binance ${MARKET}${RESET}`);
console.log(`Symbol: ${SYMBOL}  |  Stream: ${tradeChannel}  |  Min size: ${formatQuote(MIN_USD)}  |  Ctrl+C to stop\n`);
console.log(`${DIM}TIME       SIDE    PRICE           SIZE       NOTE${RESET}`);
console.log(`${DIM}${'─'.repeat(58)}${RESET}`);

const ws = new WebSocket(url);

ws.on('message', (raw) => {
  let msg: { stream: string; data: Record<string, unknown> };
  try {
    msg = JSON.parse(String(raw)) as { stream: string; data: Record<string, unknown> };
  } catch {
    return;
  }

  const data = msg.data;
  if (!data?.e) return;

  if (data.e === 'aggTrade') {
    const trade =
      MARKET === 'spot'
        ? spotAdapter.normalizeAggTrade(data as unknown as BinanceAggTrade)
        : futuresAdapter.normalizeAggTrade(data as unknown as BinanceAggTrade);
    engine.ingestTrade(trade);
    tradeCount += 1;
    printAggressiveTrade(trade);
  }

  if (data.e === 'trade') {
    const trade =
      MARKET === 'spot'
        ? spotAdapter.normalizeTrade(data as unknown as BinanceTrade)
        : futuresAdapter.normalizeTrade(data as unknown as BinanceTrade);
    engine.ingestTrade(trade);
    tradeCount += 1;
    printAggressiveTrade(trade);
  }

  if (data.e === 'bookTicker') {
    const book =
      MARKET === 'spot'
        ? spotAdapter.normalizeBookTicker(data as unknown as BinanceBookTicker)
        : futuresAdapter.normalizeBookTicker(data as unknown as BinanceBookTicker);
    engine.ingestBookSnapshot(book);
  }

  const now = Date.now();
  if (now - lastSummary >= SUMMARY_EVERY_MS) {
    lastSummary = now;
    printSummary(now);
  }
});

ws.on('open', () => {
  console.log(`${GREEN}Connected to Binance WebSocket.${RESET}\n`);
});

ws.on('close', () => {
  console.log(`\n${DIM}Disconnected.${RESET}`);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});

process.on('SIGINT', () => {
  console.log(`\n${DIM}Stopping…${RESET}`);
  ws.close();
});

function printAggressiveTrade(trade: MarketTrade): void {
  if (trade.quoteValue < MIN_USD) return;

  if (trade.isAggressiveBuy) buyCount += 1;
  if (trade.isAggressiveSell) sellCount += 1;

  const rel = sym.largeTrades.relativeSize(trade.quoteValue);
  const tier = sym.largeTrades.absoluteTier(trade.quoteValue);
  let tag = rel.classification !== 'NORMAL' ? rel.classification : '';
  if (tier) tag = tag ? `${tag} tier-${tier}` : `tier-${tier}`;

  printTrade({
    timestamp: trade.timestamp,
    side: trade.side,
    price: trade.price,
    quoteValue: trade.quoteValue,
    tag,
  });
}

function printTrade(t: {
  timestamp: number;
  side: 'BUY' | 'SELL';
  price: number;
  quoteValue: number;
  tag?: string;
}): void {
  const time = formatTapeTime(t.timestamp).padEnd(10);
  const sideColor = t.side === 'BUY' ? GREEN : RED;
  const side = `${sideColor}${t.side.padEnd(7)}${RESET}`;
  const price = t.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padEnd(16);
  const size = formatQuote(t.quoteValue).padEnd(10);
  const tag = t.tag ? `${DIM}${t.tag}${RESET}` : '';
  console.log(`${time}${side}${price}${size}${tag}`);
}

function printSummary(now: number): void {
  const s10 = sym.snapshot('10s', now);
  const s1m = sym.snapshot('1m', now);

  console.log(`${DIM}${'─'.repeat(58)}${RESET}`);
  console.log(
    `${BOLD}SUMMARY${RESET}  price $${s10.price.toFixed(2)}  |  ` +
      `${GREEN}buy ${formatQuote(s10.aggressiveBuyVolume)}${RESET}  |  ` +
      `${RED}sell ${formatQuote(s10.aggressiveSellVolume)}${RESET}  |  ` +
      `Δ10s ${formatQuote(s10.delta)}  |  state ${s10.state}`,
  );
  console.log(
    `         1m Δ ${formatQuote(s1m.delta)}  |  score ${s10.largeFlowDirectionalScore}  |  ` +
      `prints ${tradeCount} (shown buy ${buyCount} / sell ${sellCount})`,
  );
  if (s10.absorption.detected) {
    console.log(`         ${BOLD}absorption: ${s10.absorption.type}${RESET} strength ${s10.absorption.strength.toFixed(2)}`);
  }
  console.log(`${DIM}${'─'.repeat(58)}${RESET}\n`);
}
