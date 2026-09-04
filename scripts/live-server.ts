import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { LiveBinanceFeed } from '../src/live/live-feed.js';
import { DEFAULT_WATCHLIST, EQUITY_PERP_WATCHLIST } from '../src/live/watchlist.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import {
  EXCHANGE_LABELS,
  fetchVenueDepth,
  fetchVenueKlines,
  isExchangeId,
  parseExchangesEnv,
  type ExchangeId,
} from '../src/exchange/venues.js';
import { FootprintRecorder } from '../src/storage/footprint-recorder.js';
import { coverage, loadBars } from '../src/storage/footprint-store.js';
import { isStorageEnabled } from '../src/storage/db.js';
import { rollup } from '../src/footprint/rollup.js';
import { toWire, type FootprintBar } from '../src/footprint/types.js';
import {
  DEFAULT_IMBALANCE_RATIO,
  parseSpotExchangesEnv,
  SpotFlowEngine,
} from '../src/spot/index.js';
import type { WindowSnapshot } from '../src/models/signals.js';
import { PassiveFeatureRecorder, type PassiveLiquidityEngine } from '../src/passive-liquidity/index.js';
import {
  mergeDataset,
  klinesToCandles,
  tfToInterval,
  sourceTfMinutes,
  rollCandles,
  windowBars,
} from '../src/backtest/index.js';
import { buildSimulator } from './build-simulator.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(__dirname, '../public');
const PORT = Number(process.env.PORT ?? 3456);
const DEFAULT_VIEW = (process.env.MARKET ?? 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';

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
const SPOT_EXCHANGES = parseSpotExchangesEnv();
const cryptoCoins = coins.filter((c) => c.venue === 'crypto');
const IMBALANCE_RATIO = Number(process.env.SPOT_IMBALANCE_RATIO ?? DEFAULT_IMBALANCE_RATIO) || DEFAULT_IMBALANCE_RATIO;

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
};

const RETENTION_DAYS = Number(process.env.FOOTPRINT_RETENTION_DAYS ?? 30);

const perpFeed = new LiveBinanceFeed({
  coins,
  market: 'perp',
  summaryMs: 2_000,
  exchanges: EXCHANGES,
});

const spotFeed = new LiveBinanceFeed({
  coins: cryptoCoins,
  market: 'spot',
  summaryMs: 2_000,
  exchanges: SPOT_EXCHANGES,
});

const perpRecorder = new FootprintRecorder({
  market: 'perp',
  retentionDays: RETENTION_DAYS,
  flushMs: Number(process.env.FOOTPRINT_FLUSH_MS ?? 15_000),
});
const spotRecorder = new FootprintRecorder({
  market: 'spot',
  retentionDays: RETENTION_DAYS,
  flushMs: Number(process.env.FOOTPRINT_FLUSH_MS ?? 15_000),
});
const spotHub = new SpotFlowEngine(IMBALANCE_RATIO);
const passiveFeatures = { perp: new PassiveFeatureRecorder(), spot: new PassiveFeatureRecorder() };

perpFeed.onAnyTrade((trade, exchange) => {
  perpRecorder.ingest(trade, exchange);
});
spotFeed.onAnyTrade((trade, exchange) => {
  if (!spotHub.ingestTrade(trade, exchange)) return;
  spotRecorder.ingest(trade, exchange);
});

function passiveEngineFor(params: URLSearchParams): PassiveLiquidityEngine | null {
  const symbol = (params.get('symbol') ?? coins[0]?.symbol ?? 'BTCUSDT').toUpperCase();
  if (!coins.some((c) => c.symbol === symbol)) return null;
  const market = parseMarketParam(params.get('market'));
  const feed = market === 'spot' ? spotFeed : perpFeed;
  if (!feed.coins.some((c) => c.symbol === symbol)) return null;
  return feed.engine.getSymbol(symbol, market).passiveLiquidity;
}

const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/depth')) {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const symbol = (u.searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();
      const exchange = parseExchangeParam(u.searchParams.get('exchange'));
      const market = parseMarketParam(u.searchParams.get('market'));
      try {
        json(res, await fetchVenueDepth(exchange, symbol, market, 100));
      } catch {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
      return;
    }

    if (req.url?.startsWith('/api/passive-liquidity/level')) {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const engine = passiveEngineFor(u.searchParams);
      const price = Number(u.searchParams.get('price'));
      const side = u.searchParams.get('side') === 'BID' ? 'BID' : 'ASK';
      if (!engine || !Number.isFinite(price)) {
        json(res, { detail: null });
        return;
      }
      json(res, { detail: engine.levelDetail(side, price, Date.now()) });
      return;
    }

    if (req.url?.startsWith('/api/passive-liquidity/net')) {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const engine = passiveEngineFor(u.searchParams);
      const requested = Number(u.searchParams.get('windowMs') ?? 10_000);
      const windowMs = Number.isFinite(requested)
        ? Math.max(10_000, Math.min(900_000, Math.floor(requested)))
        : 10_000;
      json(res, { netLiquidity: engine ? engine.netLiquidity(Date.now(), windowMs) : null });
      return;
    }

    if (req.url?.startsWith('/api/passive-liquidity')) {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const engine = passiveEngineFor(u.searchParams);
      json(res, {
        snapshot: engine ? engine.snapshot({ now: Date.now() }) : null,
        memory: engine ? engine.priceLevelMemory().slice(0, 40) : [],
      });
      return;
    }

    if (req.url?.startsWith('/api/lab/dataset')) {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      try {
        json(res, await getLabDataset(u.searchParams));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'lab dataset failed', bars: [] }));
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
      const market = parseMarketParam(u.searchParams.get('market'));
      try {
        json(res, await fetchKlinesPaged(exchange, symbol, interval, limit, market));
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
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const market = parseMarketParam(u.searchParams.get('market'));
      try {
        json(res, { enabled: true, retentionDays: RETENTION_DAYS, rows: await coverage(market) });
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
        market: DEFAULT_VIEW,
        markets: ['perp', 'spot'],
        storage: { perp: perpRecorder.stats(), spot: spotRecorder.stats() },
        uptimeSec: Math.round(process.uptime()),
      });
      return;
    }

    if (req.url === '/api/config') {
    json(res, {
      coins,
      crypto: coins.filter((c) => c.venue === 'crypto'),
      stocks: coins.filter((c) => c.venue === 'equity'),
      market: DEFAULT_VIEW,
      markets: ['perp', 'spot'],
      stockSource: 'binance-perp',
      exchanges: EXCHANGES,
      spotExchanges: SPOT_EXCHANGES,
      exchangeLabels: EXCHANGE_LABELS,
      imbalanceRatio: IMBALANCE_RATIO,
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

function broadcast(ev: object): void {
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
  market: 'spot' | 'perp';
}
const footprintSubs = new Map<WebSocket, FootprintSub>();

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let msg: { type?: string; symbol?: unknown; exchange?: unknown; market?: unknown };
    try {
      msg = JSON.parse(String(raw)) as typeof msg;
    } catch {
      return;
    }
    if (msg.type !== 'sub_footprint') return;
    const symbol = String(msg.symbol ?? '').toUpperCase();
    if (!coins.some((c) => c.symbol === symbol)) return;
    const market = parseMarketParam(typeof msg.market === 'string' ? msg.market : 'perp');
    footprintSubs.set(socket, {
      symbol,
      market,
      exchanges: parseFootprintExchanges(typeof msg.exchange === 'string' ? msg.exchange : 'binance', market),
    });
    sendLiveFootprint(socket);
  });
  socket.on('close', () => {
    footprintSubs.delete(socket);
  });
});

function sendLiveFootprint(socket: WebSocket): void {
  const sub = footprintSubs.get(socket);
  if (!sub || socket.readyState !== WebSocket.OPEN) return;
  const rec = recorderFor(sub.market);
  const bars: Array<{ exchange: ExchangeId; bar: ReturnType<typeof toWire> }> = [];
  for (const exchange of sub.exchanges) {
    const bar = rec.aggregator.currentBar(sub.symbol, exchange);
    if (bar) bars.push({ exchange, bar: toWire(bar) });
  }
  if (!bars.length) return;
  socket.send(JSON.stringify({ type: 'footprint_live', symbol: sub.symbol, market: sub.market, bars }));
}

const liveFootprintTimer = setInterval(() => {
  for (const socket of footprintSubs.keys()) sendLiveFootprint(socket);
}, Number(process.env.FOOTPRINT_PUSH_MS ?? 250));
liveFootprintTimer.unref?.();

/** Compact live bars for every coin so the client can run chart-style alerts. */
function broadcastFootprintTicks(market: 'spot' | 'perp'): void {
  const rec = recorderFor(market);
  const exchanges = market === 'spot' ? SPOT_EXCHANGES : EXCHANGES;
  const bars: Array<{ symbol: string; exchange: ExchangeId; bar: ReturnType<typeof toWire> }> = [];
  for (const coin of coins) {
    if (market === 'spot' && coin.venue === 'equity') continue;
    for (const exchange of exchanges) {
      const bar = rec.aggregator.currentBar(coin.symbol, exchange);
      if (bar) bars.push({ symbol: coin.symbol, exchange, bar: toWire(bar) });
    }
  }
  if (!bars.length) return;
  broadcast({ type: 'footprint_tick', market, bars });
}

const footprintTickTimer = setInterval(() => {
  broadcastFootprintTicks('perp');
  broadcastFootprintTicks('spot');
}, Number(process.env.FOOTPRINT_TICK_MS ?? 1000));
footprintTickTimer.unref?.();

perpFeed.on((ev) => {
  if (ev.type === 'summary') {
    spotHub.setFuturesWindow(ev.summary.symbol, ev.summary.windows['1m'] as WindowSnapshot);
  }
  if (ev.type === 'passive_liquidity') {
    passiveFeatures.perp.record(ev.symbol, ev.snapshot.timestamp, ev.snapshot.features);
  }
  broadcast({ ...ev, market: 'perp' });
});
spotFeed.on((ev) => {
  if (ev.type === 'passive_liquidity') {
    passiveFeatures.spot.record(ev.symbol, ev.snapshot.timestamp, ev.snapshot.features);
  }
  if (ev.type === 'book') {
    spotHub.ingestBook({
      symbol: ev.symbol,
      marketType: 'spot',
      timestamp: Date.now(),
      bids: ev.bids,
      asks: ev.asks,
    });
  }
  if (ev.type === 'summary') {
    spotHub.ingestBinanceWindow(ev.summary.symbol, ev.summary.windows['1m'] as WindowSnapshot);
  }
  broadcast({ ...ev, market: 'spot' });
});
perpFeed.start();
spotFeed.start();
perpRecorder.start();
spotRecorder.start();

const spotFlowTimer = setInterval(() => {
  const now = Date.now();
  for (const coin of cryptoCoins) {
    const snapshot = spotHub.snapshot(coin.symbol, 'all', now);
    broadcast({ type: 'spot_flow', market: 'spot', snapshot });
  }
}, 2_000);
spotFlowTimer.unref?.();

const oiTimer = setInterval(() => {
  void (async () => {
    for (const coin of cryptoCoins) {
      try {
        const ctx = await fetchOiContext(coin.symbol);
        if (ctx.oiUsd > 0) {
          spotHub.setOi(coin.symbol, ctx.oiUsd);
          perpFeed.engine.getSymbol(coin.symbol, 'perp').liquidityResponse.noteOi(ctx.oiUsd);
        }
      } catch {
        /* OI is optional context */
      }
    }
  })();
}, 30_000);
oiTimer.unref?.();

void buildSimulator().catch((err) => {
  console.error('  Simulator bundle failed:', err instanceof Error ? err.message : err);
  console.error('  Dashboard will still start; /lab.html needs a successful bundle.');
}).finally(() => {
  server.listen(PORT, () => {
    const crypto = coins.filter((c) => c.venue === 'crypto');
    const equity = coins.filter((c) => c.venue === 'equity');
    console.log(`\n  Order Flow Dashboard`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Backtest lab: http://localhost:${PORT}/lab.html`);
    console.log(`  Exchanges (perp): ${EXCHANGES.map((id) => EXCHANGE_LABELS[id]).join(' · ')}`);
    console.log(`  Exchanges (spot): ${SPOT_EXCHANGES.map((id) => EXCHANGE_LABELS[id]).join(' · ')}`);
    console.log(`  Crypto perp + spot footprint: ${crypto.map((c) => c.label).join(' · ')}`);
    console.log(`  TradFi perp (Binance): ${equity.map((c) => c.label).join(' · ')}`);
    console.log(
      `  Footprint history: ${isStorageEnabled() ? `Postgres · ${RETENTION_DAYS}d retention` : 'disabled (set DATABASE_URL)'}`,
    );
    console.log(`  SpaceX is not listed on Binance.\n`);
  });
});

function parseExchangeParam(raw: string | null): ExchangeId {
  const id = (raw ?? 'binance').toLowerCase();
  return isExchangeId(id) ? id : 'binance';
}

function parseMarketParam(raw: string | null | undefined): 'spot' | 'perp' {
  return String(raw ?? '').toLowerCase() === 'spot' ? 'spot' : 'perp';
}

function recorderFor(market: 'spot' | 'perp'): FootprintRecorder {
  return market === 'spot' ? spotRecorder : perpRecorder;
}

// ── Footprint history ────────────────────────────────────────────────────────

const MAX_TF_MINUTES = 1440;
const footprintCache = new Map<string, { at: number; payload: unknown }>();

function parseFootprintExchanges(raw: string | null, market: 'spot' | 'perp' = 'perp'): ExchangeId[] {
  const allowed = market === 'spot' ? SPOT_EXCHANGES : EXCHANGES;
  const value = (raw ?? 'binance').toLowerCase();
  if (value === 'all') return [...allowed];
  const ids = value
    .split(',')
    .map((s) => s.trim())
    .filter((id): id is ExchangeId => isExchangeId(id) && allowed.includes(id));
  return ids.length ? [...new Set(ids)] : ['binance'];
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

async function getFootprintHistory(params: URLSearchParams): Promise<unknown> {
  const symbol = (params.get('symbol') ?? 'BTCUSDT').toUpperCase();
  const market = parseMarketParam(params.get('market'));
  const exchanges = parseFootprintExchanges(params.get('exchange'), market);
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

  const key = `${market}|${symbol}|${exchanges.join(',')}|${tf}|${limit}|${days}|${liveFrom}`;
  const hit = footprintCache.get(key);
  if (hit && Date.now() - hit.at < 20_000) return hit.payload;

  // Closed bars can still be sitting in the recorder's buffer.
  await recorderFor(market).flush();

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

async function getLabDataset(params: URLSearchParams) {
  const symbol = (params.get('symbol') ?? 'BTCUSDT').toUpperCase();
  const market = parseMarketParam(params.get('market'));
  const exchange = parseExchangeParam(params.get('exchange'));
  const tf = clampInt(params.get('tf'), 15, 1, 240);
  const nowSec = Math.floor(Date.now() / 1000);
  const liveFrom = nowSec - (nowSec % 60);
  const toSec = Math.min(clampInt(params.get('to'), liveFrom, 60, liveFrom), liveFrom);
  const defaultFrom = toSec - 30 * 86_400;
  const fromSec = clampInt(params.get('from'), defaultFrom, 1, toSec);
  const windowRaw = params.get('window') ?? '500';
  const pctWindow =
    windowRaw === '100' || windowRaw === '1000' || windowRaw === '1d' || windowRaw === '7d' || windowRaw === '30d'
      ? windowRaw
      : '500';
  const warmupSec = windowBars(pctWindow, tf) * tf * 60;
  const fetchFrom = Math.max(0, fromSec - warmupSec);
  const srcTf = sourceTfMinutes(tf);
  const interval = tfToInterval(tf);

  const rows = await fetchKlinesRange(exchange, symbol, interval, market, fetchFrom * 1000, toSec * 1000);
  let candles = klinesToCandles(rows);
  candles = rollCandles(candles, srcTf, tf);

  let footprint: import('../src/footprint/types.js').FootprintBar[] = [];
  let spotFootprint: import('../src/footprint/types.js').FootprintBar[] = [];
  if (isStorageEnabled()) {
    await recorderFor(market).flush();
    const fpRows = await loadBars({
      symbol,
      market,
      exchanges: parseFootprintExchanges(exchange, market),
      fromSec: fetchFrom,
      toSec: liveFrom,
    });
    footprint = tf === 1 && parseFootprintExchanges(exchange, market).length === 1 ? fpRows : rollup(fpRows, tf);
    if (market === 'perp') {
      try {
        await recorderFor('spot').flush();
        const spotRows = await loadBars({
          symbol,
          market: 'spot',
          exchanges: parseFootprintExchanges(exchange, 'spot'),
          fromSec: fetchFrom,
          toSec: liveFrom,
        });
        spotFootprint = tf === 1 ? spotRows : rollup(spotRows, tf);
      } catch {
        spotFootprint = [];
      }
    }
  }

  const merged = mergeDataset({
    candles,
    footprint,
    spotFootprint,
    passive: passiveFeatures[market].range(symbol, tf, fetchFrom, toSec),
    tfMinutes: tf,
    fromSec: fetchFrom,
    toSec,
  });

  return {
    symbol,
    market,
    exchange,
    tf,
    fromSec,
    toSec,
    signalFromSec: fromSec,
    bars: merged.bars,
    coverage: merged.coverage,
  };
}

async function fetchKlinesRange(
  exchange: ExchangeId,
  symbol: string,
  interval: string,
  market: 'spot' | 'perp',
  startMs: number,
  endMs: number,
) {
  const pageSize = 1500;
  const merged = new Map<number, [number, string, string, string, string, string]>();
  let cursor = startMs;
  for (let i = 0; i < 40; i++) {
    const rows = await fetchVenueKlines(exchange, symbol, interval, market, pageSize, undefined, cursor);
    if (!rows.length) break;
    for (const row of rows) {
      if (row[0] >= startMs && row[0] < endMs) merged.set(row[0], row);
    }
    const last = rows[rows.length - 1];
    if (!last || last[0] >= endMs - 1 || rows.length < pageSize) break;
    const next = last[0] + 1;
    if (next <= cursor) break;
    cursor = next;
  }
  return [...merged.values()].sort((a, b) => a[0] - b[0]);
}

async function fetchKlinesPaged(
  exchange: ExchangeId,
  symbol: string,
  interval: string,
  limit: number,
  market: 'spot' | 'perp' = 'perp',
) {
  const pageSize = 1500;
  if (limit <= pageSize) {
    return fetchVenueKlines(exchange, symbol, interval, market, limit);
  }
  const chunks: Array<Array<[number, string, string, string, string, string]>> = [];
  let endTime: number | undefined;
  let remaining = limit;
  for (let i = 0; i < 6 && remaining > 0; i++) {
    const n = Math.min(pageSize, remaining);
    const rows = await fetchVenueKlines(exchange, symbol, interval, market, n, endTime);
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

type OiContext = { symbol: string; oiUsd: number; fundingRate: number | null };

const oiCtxCache = new Map<string, { at: number; data: OiContext }>();

async function fetchOiContext(symbol: string): Promise<OiContext> {
  const hit = oiCtxCache.get(symbol);
  if (hit && Date.now() - hit.at < 30_000) return hit.data;
  const q = encodeURIComponent(symbol);
  const [oiRes, markRes] = await Promise.all([
    fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${q}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
    fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${q}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
  ]);
  if (!oiRes.ok || !markRes.ok) throw new Error('oi fetch failed');
  const oi = (await oiRes.json()) as { openInterest?: string };
  const mark = (await markRes.json()) as { markPrice?: string; lastFundingRate?: string };
  const price = Number(mark.markPrice);
  const contracts = Number(oi.openInterest);
  const fundingRate = Number(mark.lastFundingRate);
  const data: OiContext = {
    symbol,
    oiUsd: Number.isFinite(contracts) && Number.isFinite(price) ? contracts * price : 0,
    fundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
  };
  if (data.oiUsd > 0) oiCtxCache.set(symbol, { at: Date.now(), data });
  return data;
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal} — flushing footprint buffer…`);
  clearInterval(liveFootprintTimer);
  perpFeed.stop();
  spotFeed.stop();
  // Railway sends SIGTERM on redeploy; without this the last bars are lost.
  await Promise.all([perpRecorder.stop().catch(() => undefined), spotRecorder.stop().catch(() => undefined)]);
  server.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
