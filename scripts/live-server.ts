import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { LiveBinanceFeed } from '../src/live/live-feed.js';
import { DEFAULT_WATCHLIST, EQUITY_PERP_WATCHLIST } from '../src/live/watchlist.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { LiveFeedEvent } from '../src/live/live-feed.js';
import {
  EXCHANGE_LABELS,
  fetchVenueDepth,
  fetchVenueKlines,
  isExchangeId,
  parseExchangesEnv,
  type ExchangeId,
} from '../src/exchange/venues.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(__dirname, '../public');
const PORT = Number(process.env.PORT ?? 3456);
const MARKET = (process.env.MARKET ?? 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';

const extra = (process.env.SYMBOLS ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const coins = extra.length
  ? extra.map((symbol) => {
      const known = [...DEFAULT_WATCHLIST, ...EQUITY_PERP_WATCHLIST].find((c) => c.symbol === symbol);
      return {
        symbol,
        label: known?.label ?? symbol.replace(/USDT$/, ''),
        minUsd: known?.minUsd ?? 1_000,
        venue: known?.venue ?? ('crypto' as const),
      };
    })
  : [...DEFAULT_WATCHLIST, ...EQUITY_PERP_WATCHLIST];

const EXCHANGES = parseExchangesEnv();

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
};

const feed = new LiveBinanceFeed({
  coins,
  market: MARKET as 'spot' | 'perp',
  summaryMs: 2_000,
  exchanges: EXCHANGES,
});

const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/depth')) {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const symbol = (u.searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();
      const exchange = parseExchangeParam(u.searchParams.get('exchange'));
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

    if (req.url === '/api/config') {
    json(res, {
      coins,
      crypto: coins.filter((c) => c.venue === 'crypto'),
      stocks: coins.filter((c) => c.venue === 'equity'),
      market: MARKET,
      stockSource: 'binance-perp',
      exchanges: EXCHANGES,
      exchangeLabels: EXCHANGE_LABELS,
      port: PORT,
      tiers: DEFAULT_CONFIG.largeTradeThresholds,
      relative: {
        large: DEFAULT_CONFIG.relative.largePercentile,
        veryLarge: DEFAULT_CONFIG.relative.veryLargePercentile,
        extreme: DEFAULT_CONFIG.relative.extremePercentile,
      },
    });
    return;
  }

  const path = req.url === '/' ? '/index.html' : (req.url?.split('?')[0] ?? '/index.html');
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

feed.on(broadcast);
feed.start();

server.listen(PORT, () => {
  const crypto = coins.filter((c) => c.venue === 'crypto');
  const equity = coins.filter((c) => c.venue === 'equity');
  console.log(`\n  Order Flow Dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Exchanges: ${EXCHANGES.map((id) => EXCHANGE_LABELS[id]).join(' · ')}`);
  console.log(`  Crypto perp: ${crypto.map((c) => c.label).join(' · ')}`);
  console.log(`  Equity perp (Binance): ${equity.map((c) => c.label).join(' · ')}`);
  console.log(`  SpaceX is not listed on Binance.\n`);
});

function parseExchangeParam(raw: string | null): ExchangeId {
  const id = (raw ?? 'binance').toLowerCase();
  return isExchangeId(id) ? id : 'binance';
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
    if (!rows.length) break;
    chunks.unshift(rows);
    remaining -= rows.length;
    endTime = rows[0][0] - 1;
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
  const wanted = new Set(coins.map((c) => c.symbol));
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

process.on('SIGINT', () => {
  feed.stop();
  server.close();
  process.exit(0);
});
