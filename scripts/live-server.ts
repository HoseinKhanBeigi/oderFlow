import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { LiveBinanceFeed } from '../src/live/live-feed.js';
import { StockLiveFeed } from '../src/live/stock-feed.js';
import { DEFAULT_WATCHLIST, STOCK_WATCHLIST } from '../src/live/watchlist.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { LiveFeedEvent } from '../src/live/live-feed.js';
import {
  EXCHANGE_LABELS,
  STOCK_TAPE_EXCHANGE,
  fetchVenueDepth,
  fetchVenueKlines,
  isCryptoExchangeId,
  isExchangeId,
  parseExchangesEnv,
  type ExchangeId,
} from '../src/exchange/venues.js';
import { FootprintRecorder } from '../src/storage/footprint-recorder.js';
import { coverage, loadBars } from '../src/storage/footprint-store.js';
import { isStorageEnabled } from '../src/storage/db.js';
import { rollup } from '../src/footprint/rollup.js';
import { toWire, type FootprintBar } from '../src/footprint/types.js';
import type { MarketType } from '../src/models/trade.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(__dirname, '../public');
const PORT = Number(process.env.PORT ?? 3456);
const MARKET = (process.env.MARKET ?? 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';

const extra = (process.env.SYMBOLS ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const ALL_WATCH = [...DEFAULT_WATCHLIST, ...STOCK_WATCHLIST];

const coins = extra.length
  ? extra.map((symbol) => {
      const known = ALL_WATCH.find((c) => c.symbol === symbol);
      return {
        symbol,
        label: known?.label ?? symbol.replace(/USDT$/, ''),
        minUsd: known?.minUsd ?? 1_000,
        venue: known?.venue ?? ('crypto' as const),
      };
    })
  : ALL_WATCH;

const cryptoCoins = coins.filter((c) => c.venue !== 'equity');
const stockCoins = coins.filter((c) => c.venue === 'equity');

function isStockSymbol(symbol: string): boolean {
  return stockCoins.some((c) => c.symbol === symbol) || coins.find((c) => c.symbol === symbol)?.venue === 'equity';
}

const EXCHANGES = parseExchangesEnv();

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
};

const RETENTION_DAYS = Number(process.env.FOOTPRINT_RETENTION_DAYS ?? 30);

const feed = new LiveBinanceFeed({
  coins: cryptoCoins,
  market: MARKET as 'spot' | 'perp',
  summaryMs: 2_000,
  exchanges: EXCHANGES,
});

const stockFeed = stockCoins.length
  ? new StockLiveFeed({
      stocks: stockCoins,
      summaryMs: 2_000,
      finnhubKey: process.env.FINNHUB_API_KEY?.trim() || undefined,
      polygonKey: process.env.POLYGON_API_KEY?.trim() || undefined,
    })
  : null;

const recorder = new FootprintRecorder({
  market: MARKET as 'spot' | 'perp',
  retentionDays: RETENTION_DAYS,
  flushMs: Number(process.env.FOOTPRINT_FLUSH_MS ?? 15_000),
});
feed.onAnyTrade((trade, exchange) => recorder.ingest(trade, exchange));
stockFeed?.onAnyTrade((trade, exchange) => recorder.ingest(trade, exchange));

const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/depth')) {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const symbol = (u.searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();
      const exchange = parseExchangeParam(u.searchParams.get('exchange'));
      if (isStockSymbol(symbol)) {
        json(res, { bids: [], asks: [] });
        return;
      }
      try {
        json(res, await fetchVenueDepth(exchange, symbol, MARKET, 100));
      } catch {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
      return;
    }

    if (req.url?.startsWith('/api/liq-estimate')) {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const symbol = (u.searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();
      if (isStockSymbol(symbol)) {
        json(res, { symbol, price: 0, oiUsd: 0, longRatio: 0, shortRatio: 0, split: 'none' });
        return;
      }
      try {
        json(res, await getLiqEstimate(symbol));
      } catch {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
      return;
    }

    if (req.url?.startsWith('/api/leverage-brackets')) {
      try {
        json(res, await getLeverageBrackets());
      } catch {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
      return;
    }

    if (req.url?.startsWith('/api/klines')) {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const symbol = (u.searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();
      if (isStockSymbol(symbol)) {
        json(res, []);
        return;
      }
      const interval = u.searchParams.get('interval') ?? '1m';
      const exchange = parseExchangeParam(u.searchParams.get('exchange'));
      const rawLimit = Number(u.searchParams.get('limit') ?? 300);
      const limit = Number.isFinite(rawLimit) ? Math.min(8000, Math.max(1, Math.floor(rawLimit))) : 300;
      try {
        json(res, await fetchKlinesPaged(exchange, symbol, interval, limit));
      } catch {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end('[]');
      }
      return;
    }

    if (req.url?.startsWith('/api/footprint/coverage')) {
      if (!isStorageEnabled()) {
        json(res, { enabled: false, rows: [] });
        return;
      }
      try {
        json(res, {
          enabled: true,
          retentionDays: RETENTION_DAYS,
          rows: await coverage(MARKET as 'spot' | 'perp'),
          stockRows: await coverage('stock'),
        });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'coverage failed' }));
      }
      return;
    }

    if (req.url?.startsWith('/api/footprint')) {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      try {
        json(res, await getFootprintHistory(u.searchParams));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled: isStorageEnabled(), bars: [], error: err instanceof Error ? err.message : 'query failed' }));
      }
      return;
    }

    if (req.url === '/api/health') {
      json(res, {
        ok: true,
        market: MARKET,
        storage: recorder.stats(),
        stockTape: stockFeed
          ? { source: stockFeed.source, connected: stockFeed.connected, symbols: stockCoins.length }
          : { source: 'none', connected: false, symbols: 0 },
        uptimeSec: Math.round(process.uptime()),
      });
      return;
    }

    if (req.url === '/api/config') {
    json(res, {
      coins,
      crypto: coins.filter((c) => c.venue === 'crypto'),
      stocks: stockCoins,
      market: MARKET,
      stockSource: stockFeed?.source ?? 'none',
      stockTape: STOCK_TAPE_EXCHANGE,
      exchanges: EXCHANGES,
      exchangeLabels: EXCHANGE_LABELS,
      port: PORT,
      history: { enabled: isStorageEnabled(), retentionDays: RETENTION_DAYS },
      tiers: DEFAULT_CONFIG.largeTradeThresholds,
      relative: {
        large: DEFAULT_CONFIG.relative.largePercentile,
        veryLarge: DEFAULT_CONFIG.relative.veryLargePercentile,
        extreme: DEFAULT_CONFIG.relative.extremePercentile,
      },
    });
    return;
  }

  const requested = req.url?.split('?')[0] || '/';
  const path = requested === '/' ? '/index.html' : requested;
  if (!path.startsWith('/') || path.includes('..')) {
    res.writeHead(400);
    res.end();
    return;
  }

  try {
    const file = join(PUBLIC, path);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(ev: LiveFeedEvent): void {
  const raw = JSON.stringify(ev);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  }
}

/**
 * Live footprint is pushed per subscriber rather than broadcast: a client only
 * ever renders one symbol, and fanning every symbol out is ~20x the bytes.
 * Always sent as 1-minute bars — the browser rolls them up to its timeframe.
 */
interface FootprintSub {
  symbol: string;
  exchanges: ExchangeId[];
}
const footprintSubs = new Map<WebSocket, FootprintSub>();

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let msg: { type?: string; symbol?: unknown; exchange?: unknown };
    try {
      msg = JSON.parse(String(raw)) as typeof msg;
    } catch {
      return;
    }
    if (msg.type !== 'sub_footprint') return;
    const symbol = String(msg.symbol ?? '').toUpperCase();
    if (!coins.some((c) => c.symbol === symbol)) return;
    footprintSubs.set(socket, {
      symbol,
      exchanges: isStockSymbol(symbol)
        ? [STOCK_TAPE_EXCHANGE]
        : parseFootprintExchanges(typeof msg.exchange === 'string' ? msg.exchange : 'binance'),
    });
    sendLiveFootprint(socket);
  });
  socket.on('close', () => footprintSubs.delete(socket));
});

function sendLiveFootprint(socket: WebSocket): void {
  const sub = footprintSubs.get(socket);
  if (!sub || socket.readyState !== WebSocket.OPEN) return;
  const bars: Array<{ exchange: ExchangeId; bar: ReturnType<typeof toWire> }> = [];
  for (const exchange of sub.exchanges) {
    const bar = recorder.aggregator.currentBar(sub.symbol, exchange);
    if (bar) bars.push({ exchange, bar: toWire(bar) });
  }
  if (!bars.length) return;
  socket.send(JSON.stringify({ type: 'footprint_live', symbol: sub.symbol, bars }));
}

const liveFootprintTimer = setInterval(() => {
  for (const socket of footprintSubs.keys()) sendLiveFootprint(socket);
}, Number(process.env.FOOTPRINT_PUSH_MS ?? 1_000));
liveFootprintTimer.unref?.();

feed.on(broadcast);
stockFeed?.on(broadcast);
feed.start();
stockFeed?.start();
recorder.start();

server.listen(PORT, () => {
  console.log(`\n  Order Flow Dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Exchanges: ${EXCHANGES.map((id) => EXCHANGE_LABELS[id]).join(' · ')}`);
  console.log(`  Crypto perp: ${cryptoCoins.map((c) => c.label).join(' · ')}`);
  const tape = stockFeed?.source ?? 'none';
  console.log(
    `  US stocks (${tape}): ${stockCoins.length ? stockCoins.map((c) => c.label).join(' · ') : 'none'}`,
  );
  console.log(
    `  Footprint history: ${isStorageEnabled() ? `Postgres · ${RETENTION_DAYS}d retention` : 'disabled (set DATABASE_URL)'}`,
  );
  if (stockCoins.length && tape === 'yahoo') {
    console.log('  Stock footprints need FINNHUB_API_KEY (live) and POLYGON_API_KEY (30d history).');
  }
  console.log('');
});

function parseExchangeParam(raw: string | null): ExchangeId {
  const id = (raw ?? 'binance').toLowerCase();
  return isExchangeId(id) ? id : 'binance';
}

// ── Footprint history ────────────────────────────────────────────────────────

const MAX_TF_MINUTES = 1440;
const footprintCache = new Map<string, { at: number; payload: unknown }>();

function parseFootprintExchanges(raw: string | null): ExchangeId[] {
  const value = (raw ?? 'binance').toLowerCase();
  if (value === 'sip') return [STOCK_TAPE_EXCHANGE];
  if (value === 'all') return EXCHANGES;
  const ids = value
    .split(',')
    .map((s) => s.trim())
    .filter((id): id is ExchangeId => isCryptoExchangeId(id) || isExchangeId(id));
  const crypto = ids.filter(isCryptoExchangeId);
  return crypto.length ? [...new Set(crypto)] : ['binance'];
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

async function getFootprintHistory(params: URLSearchParams): Promise<unknown> {
  const symbol = (params.get('symbol') ?? 'BTCUSDT').toUpperCase();
  const stock = isStockSymbol(symbol);
  const market: MarketType = stock ? 'stock' : (MARKET as 'spot' | 'perp');
  const exchanges = stock ? [STOCK_TAPE_EXCHANGE] : parseFootprintExchanges(params.get('exchange'));
  const tf = clampInt(params.get('tf'), 1, 1, MAX_TF_MINUTES);
  const limit = clampInt(params.get('limit'), 1_500, 1, 5_000);
  const days = clampInt(params.get('days'), RETENTION_DAYS, 1, RETENTION_DAYS);

  if (!isStorageEnabled()) {
    return { enabled: false, symbol, tf, bars: [], reason: 'DATABASE_URL not configured' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  // History stops at the start of the current minute; that minute is owned by
  // the live WS feed. Without this split the two sources double-count it.
  const liveFrom = nowSec - (nowSec % 60);

  const key = `${symbol}|${market}|${exchanges.join(',')}|${tf}|${limit}|${days}|${liveFrom}`;
  const hit = footprintCache.get(key);
  if (hit && Date.now() - hit.at < 20_000) return hit.payload;

  // Closed bars can still be sitting in the recorder's buffer.
  await recorder.flush();

  const spanMinutes = Math.min(days * 1440, limit * tf + tf);
  const fromSec = liveFrom - spanMinutes * 60;

  const rows = await loadBars({
    symbol,
    market,
    exchanges,
    fromSec,
    toSec: liveFrom,
  });

  const merged: FootprintBar[] = tf === 1 && exchanges.length === 1 ? rows : rollup(rows, tf);
  const bars = merged.slice(-limit).map(toWire);

  const payload = {
    enabled: true,
    symbol,
    market,
    tf,
    exchanges,
    retentionDays: RETENTION_DAYS,
    liveFrom,
    bars,
  };
  footprintCache.set(key, { at: Date.now(), payload });
  if (footprintCache.size > 200) {
    const oldest = [...footprintCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) footprintCache.delete(oldest[0]);
  }
  return payload;
}

async function fetchKlinesPaged(exchange: ExchangeId, symbol: string, interval: string, limit: number) {
  const pageSize = 1500;
  if (limit <= pageSize) {
    return fetchVenueKlines(exchange, symbol, interval, MARKET, limit);
  }
  const chunks: Array<Array<[number, string, string, string, string, string]>> = [];
  let endTime: number | undefined;
  let remaining = limit;
  for (let i = 0; i < 6 && remaining > 0; i++) {
    const n = Math.min(pageSize, remaining);
    const rows = await fetchVenueKlines(exchange, symbol, interval, MARKET, n, endTime);
    const first = rows[0];
    if (!first) break;
    chunks.unshift(rows);
    remaining -= rows.length;
    endTime = first[0] - 1;
    if (rows.length < n) break;
  }
  const merged = new Map<number, [number, string, string, string, string, string]>();
  for (const row of chunks.flat()) merged.set(row[0], row);
  return [...merged.values()].sort((a, b) => a[0] - b[0]).slice(-limit);
}

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

type LevBracket = { floor: number; cap: number; minLev: number; maxLev: number };
type LevSpec = { max: number; brackets: LevBracket[] };

let levCache: { at: number; data: Record<string, LevSpec> } | null = null;

async function getLeverageBrackets(): Promise<Record<string, LevSpec>> {
  if (levCache && Date.now() - levCache.at < 15 * 60_000) return levCache.data;
  const wanted = new Set(cryptoCoins.map((c) => c.symbol));
  const r = await fetch('https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!r.ok) throw new Error(`leverage brackets ${r.status}`);
  const payload = (await r.json()) as {
    data?: {
      brackets?: Array<{
        symbol?: string;
        riskBrackets?: Array<{
          bracketNotionalFloor?: number;
          bracketNotionalCap?: number;
          minOpenPosLeverage?: number;
          maxOpenPosLeverage?: number;
        }>;
      }>;
    };
  };
  const out: Record<string, LevSpec> = {};
  for (const item of payload.data?.brackets ?? []) {
    if (!item.symbol || !wanted.has(item.symbol)) continue;
    const brackets = (item.riskBrackets ?? [])
      .map((b) => ({
        floor: Number(b.bracketNotionalFloor),
        cap: Number(b.bracketNotionalCap),
        minLev: Number(b.minOpenPosLeverage),
        maxLev: Number(b.maxOpenPosLeverage),
      }))
      .filter((b) => Number.isFinite(b.floor) && b.cap > 0 && b.maxLev > 0)
      .sort((a, b) => a.floor - b.floor);
    if (!brackets.length) continue;
    out[item.symbol] = {
      max: Math.max(...brackets.map((b) => b.maxLev)),
      brackets,
    };
  }
  if (Object.keys(out).length) levCache = { at: Date.now(), data: out };
  return out;
}

type LiqEstimate = {
  symbol: string;
  price: number;
  oiUsd: number;
  longRatio: number;
  shortRatio: number;
  split: 'position' | 'account' | 'none';
};

const liqEstCache = new Map<string, { at: number; data: LiqEstimate }>();

function asShare(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1 && n <= 100) return n / 100;
  if (n > 1) return 0;
  return n;
}

async function binanceJson<T>(url: string): Promise<T | null> {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  return (await r.json()) as T;
}

async function getLiqEstimate(symbol: string): Promise<LiqEstimate> {
  const hit = liqEstCache.get(symbol);
  if (hit && Date.now() - hit.at < 30_000) return hit.data;
  const q = encodeURIComponent(symbol);
  const [oi, mark, pos, acc] = await Promise.all([
    binanceJson<{ openInterest?: string }>(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${q}`),
    binanceJson<{ markPrice?: string }>(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${q}`),
    binanceJson<Array<{ longAccount?: string; shortAccount?: string }>>(
      `https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${q}&period=5m&limit=1`,
    ),
    binanceJson<Array<{ longAccount?: string; shortAccount?: string }>>(
      `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${q}&period=5m&limit=1`,
    ),
  ]);
  if (!oi || !mark) throw new Error('oi fetch failed');
  const price = Number(mark.markPrice);
  const contracts = Number(oi.openInterest);
  const posLong = asShare(Number(pos?.[0]?.longAccount));
  const posShort = asShare(Number(pos?.[0]?.shortAccount));
  const accLong = asShare(Number(acc?.[0]?.longAccount));
  const accShort = asShare(Number(acc?.[0]?.shortAccount));
  const usePos = posLong > 0 && posShort > 0;
  const longRatio = usePos ? posLong : accLong > 0 ? accLong : 0.5;
  const shortRatio = usePos ? posShort : accShort > 0 ? accShort : 0.5;
  const data: LiqEstimate = {
    symbol,
    price: Number.isFinite(price) ? price : 0,
    oiUsd: Number.isFinite(contracts) && Number.isFinite(price) ? contracts * price : 0,
    longRatio,
    shortRatio,
    split: usePos ? 'position' : accLong > 0 ? 'account' : 'none',
  };
  if (data.oiUsd > 0) liqEstCache.set(symbol, { at: Date.now(), data });
  return data;
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal} — flushing footprint buffer…`);
  clearInterval(liveFootprintTimer);
  feed.stop();
  stockFeed?.stop();
  // Railway sends SIGTERM on redeploy; without this the last bars are lost.
  await recorder.stop().catch(() => undefined);
  server.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
