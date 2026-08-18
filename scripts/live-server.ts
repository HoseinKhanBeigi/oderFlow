import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { LiveBinanceFeed } from '../src/live/live-feed.js';
import { DEFAULT_WATCHLIST } from '../src/live/watchlist.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(__dirname, '../public');
const PORT = Number(process.env.PORT ?? 3456);
const MARKET = (process.env.MARKET ?? 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';

const extra = (process.env.SYMBOLS ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const coins = extra.length
  ? extra.map((symbol) => ({
      symbol,
      label: symbol.replace(/USDT$/, ''),
      minUsd: DEFAULT_WATCHLIST.find((c) => c.symbol === symbol)?.minUsd ?? 1_000,
    }))
  : DEFAULT_WATCHLIST;

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
  if (req.url === '/api/config') {
    json(res, {
      coins,
      market: MARKET,
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

wss.on('connection', () => {});

feed.on((ev) => {
  const raw = JSON.stringify(ev);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  }
});

feed.start();

server.listen(PORT, () => {
  console.log(`\n  Order Flow Dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  ${coins.map((c) => c.label).join(' · ')} · ${MARKET}\n`);
});

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

process.on('SIGINT', () => {
  feed.stop();
  server.close();
  process.exit(0);
});
