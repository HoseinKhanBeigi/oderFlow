import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { LiveBinanceFeed } from '../src/live/live-feed.js';
import { DEFAULT_WATCHLIST, EQUITY_PERP_WATCHLIST } from '../src/live/watchlist.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { LiveFeedEvent } from '../src/live/live-feed.js';

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
});

const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/depth')) {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const symbol = (u.searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();
      const base =
        MARKET === 'spot'
          ? 'https://api.binance.com/api/v3/depth'
          : 'https://fapi.binance.com/fapi/v1/depth';
      try {
        const r = await fetch(`${base}?symbol=${encodeURIComponent(symbol)}&limit=100`);
        const data = await r.json();
        json(res, data);
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
      const base =
        MARKET === 'spot'
          ? 'https://api.binance.com/api/v3/klines'
          : 'https://fapi.binance.com/fapi/v1/klines';
      try {
        const r = await fetch(
          `${base}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=300`,
        );
        const data = await r.json();
        json(res, data);
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
  console.log(`  Crypto perp (Binance): ${crypto.map((c) => c.label).join(' · ')}`);
  console.log(`  Equity perp (Binance): ${equity.map((c) => c.label).join(' · ')}`);
  console.log(`  SpaceX is not listed on Binance.\n`);
});

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

process.on('SIGINT', () => {
  feed.stop();
  server.close();
  process.exit(0);
});
