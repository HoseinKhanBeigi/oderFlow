import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { LiveBinanceFeed, defaultMinUsd } from '../src/live/live-feed.js';
import type { LiveFeedEvent } from '../src/live/live-feed.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(__dirname, '../public');
const PORT = Number(process.env.PORT ?? 3456);

const SYMBOL = (process.env.SYMBOL ?? 'BTCUSDT').toUpperCase();
const MARKET = (process.env.MARKET ?? 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';
const MIN_USD = Number(process.env.MIN_USD ?? defaultMinUsd(SYMBOL));

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
};

const feed = new LiveBinanceFeed({
  symbol: SYMBOL,
  market: MARKET as 'spot' | 'perp',
  minUsd: MIN_USD,
  summaryMs: 2_000,
});

const server = createServer(async (req, res) => {
  if (req.url === '/api/config') {
    json(res, { symbol: SYMBOL, market: MARKET, minUsd: MIN_USD, port: PORT });
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

wss.on('connection', () => {
  // Events broadcast globally via feed.on below
});

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
  console.log(`  ${SYMBOL} · ${MARKET} · min ${MIN_USD >= 1_000_000 ? `$${MIN_USD / 1_000_000}M` : MIN_USD >= 1_000 ? `$${MIN_USD / 1_000}K` : `$${MIN_USD}`}\n`);
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
