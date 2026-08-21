import type { MarketType } from '../models/trade.js';

export const EXCHANGE_IDS = ['binance', 'bybit', 'okx', 'bitget', 'hyperliquid', 'dydx', 'bitstamp'] as const;
export type ExchangeId = (typeof EXCHANGE_IDS)[number];

export const EXCHANGE_LABELS: Record<ExchangeId, string> = {
  binance: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
  bitget: 'Bitget',
  hyperliquid: 'Hyperliquid',
  dydx: 'dYdX',
  bitstamp: 'Bitstamp',
};

export const EXCHANGE_SHORT: Record<ExchangeId, string> = {
  binance: 'BN',
  bybit: 'BY',
  okx: 'OKX',
  bitget: 'BG',
  hyperliquid: 'HL',
  dydx: 'DX',
  bitstamp: 'BS',
};

export function isExchangeId(value: string): value is ExchangeId {
  return (EXCHANGE_IDS as readonly string[]).includes(value);
}

export function parseExchangesEnv(raw = process.env.EXCHANGES): ExchangeId[] {
  if (!raw?.trim()) return [...EXCHANGE_IDS];
  const ids = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(isExchangeId);
  const unique = [...new Set(ids)];
  if (!unique.includes('binance')) unique.unshift('binance');
  return unique.length ? unique : [...EXCHANGE_IDS];
}

export function baseAsset(symbol: string): string {
  const base = symbol.toUpperCase();
  if (base.endsWith('USDT')) return base.slice(0, -4);
  if (base.endsWith('USDC')) return base.slice(0, -4);
  if (base.endsWith('USD')) return base.slice(0, -3);
  return base;
}

/** Canonical dashboard symbol (BTCUSDT) → venue instrument id. */
export function venueInstrument(exchange: ExchangeId, symbol: string, market: MarketType): string | null {
  const base = symbol.toUpperCase();
  if (!base) return null;
  if (exchange === 'binance' || exchange === 'bybit' || exchange === 'bitget') return base;
  if (exchange === 'hyperliquid') return baseAsset(base);
  if (exchange === 'dydx') return `${baseAsset(base)}-USD`;
  if (exchange === 'bitstamp') {
    const coin = baseAsset(base).toLowerCase();
    return market === 'spot' ? `${coin}usdt` : `${coin}usd-perp`;
  }
  const quote = base.endsWith('USDT') ? 'USDT' : base.endsWith('USD') ? 'USD' : '';
  const coin = quote ? base.slice(0, -quote.length) : base;
  if (!coin) return null;
  if (market === 'spot') return `${coin}-${quote || 'USDT'}`;
  return `${coin}-${quote || 'USDT'}-SWAP`;
}

export function canonicalFromVenue(exchange: ExchangeId, instrument: string): string {
  const raw = instrument.toUpperCase();
  if (exchange === 'okx') return raw.replace('-SWAP', '').replace(/-/g, '');
  if (exchange === 'hyperliquid') return raw.endsWith('USDT') ? raw : `${raw}USDT`;
  if (exchange === 'dydx') return `${raw.replace(/-USD$/, '')}USDT`;
  if (exchange === 'bitstamp') {
    const stripped = raw.replace(/-PERP$/, '').replace(/USD$/, 'USDT');
    return stripped.replace(/[^A-Z0-9]/g, '');
  }
  return raw;
}

function binanceInterval(interval: string): string {
  return interval;
}

function bybitInterval(interval: string): string {
  const map: Record<string, string> = {
    '1m': '1',
    '5m': '5',
    '15m': '15',
    '30m': '30',
    '1h': '60',
    '2h': '120',
    '4h': '240',
    '1d': 'D',
  };
  return map[interval] ?? interval.replace(/m$/, '').replace('h', '');
}

function okxInterval(interval: string): string {
  const map: Record<string, string> = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1H',
    '2h': '2H',
    '4h': '4H',
    '1d': '1D',
  };
  return map[interval] ?? interval;
}

function bitgetInterval(interval: string): string {
  const map: Record<string, string> = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1H',
    '2h': '1H',
    '4h': '4H',
    '1d': '1D',
  };
  return map[interval] ?? interval;
}

function bitstampStep(interval: string): number {
  const map: Record<string, number> = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '2h': 7200,
    '4h': 14400,
    '1d': 86400,
  };
  return map[interval] ?? 60;
}

function dydxResolution(interval: string): string {
  const map: Record<string, string> = {
    '1m': '1MIN',
    '5m': '5MINS',
    '15m': '15MINS',
    '30m': '30MINS',
    '1h': '1HOUR',
    '2h': '1HOUR',
    '4h': '4HOURS',
    '1d': '1DAY',
  };
  return map[interval] ?? '15MINS';
}

function intervalMs(interval: string): number {
  const map: Record<string, number> = {
    '1m': 60_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '2h': 7_200_000,
    '4h': 14_400_000,
    '1d': 86_400_000,
  };
  return map[interval] ?? 60_000;
}

const UA = { 'User-Agent': 'oderFlow/1.0' };

type KlineRow = [number, string, string, string, string, string];

function asKline(openTime: number, open: string | number, high: string | number, low: string | number, close: string | number, volume: string | number = '0'): KlineRow {
  return [openTime, String(open), String(high), String(low), String(close), String(volume)];
}

function rowKline(k: Array<string | number | undefined>): KlineRow {
  return asKline(Number(k[0]), k[1] ?? '0', k[2] ?? '0', k[3] ?? '0', k[4] ?? '0', k[5] ?? '0');
}

function sortKlines(rows: KlineRow[]): KlineRow[] {
  return [...rows].sort((a, b) => a[0] - b[0]);
}

function aggregateKlines(rows: KlineRow[], bucketMs: number): KlineRow[] {
  const out: KlineRow[] = [];
  for (const row of sortKlines(rows)) {
    const t = row[0] - (row[0] % bucketMs);
    const last = out[out.length - 1];
    if (!last || last[0] !== t) {
      out.push([t, row[1], row[2], row[3], row[4], row[5]]);
      continue;
    }
    last[2] = String(Math.max(Number(last[2]), Number(row[2])));
    last[3] = String(Math.min(Number(last[3]), Number(row[3])));
    last[4] = row[4];
    last[5] = String(Number(last[5]) + Number(row[5]));
  }
  return out;
}

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function fetchPost(url: string, body: unknown): Promise<unknown> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...UA, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

export async function fetchVenueKlines(
  exchange: ExchangeId,
  symbol: string,
  interval: string,
  market: MarketType,
  limit = 300,
): Promise<KlineRow[]> {
  const inst = venueInstrument(exchange, symbol, market);
  if (!inst) return [];

  if (exchange === 'binance') {
    const base =
      market === 'spot' ? 'https://api.binance.com/api/v3/klines' : 'https://fapi.binance.com/fapi/v1/klines';
    const data = await fetchJson(
      `${base}?symbol=${encodeURIComponent(inst)}&interval=${encodeURIComponent(binanceInterval(interval))}&limit=${limit}`,
    );
    if (!Array.isArray(data)) return [];
    return data.map((k) => {
      const row = k as unknown[];
      return asKline(Number(row[0]), String(row[1]), String(row[2]), String(row[3]), String(row[4]), String(row[5] ?? '0'));
    });
  }

  if (exchange === 'bybit') {
    const category = market === 'spot' ? 'spot' : 'linear';
    const data = (await fetchJson(
      `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${encodeURIComponent(inst)}&interval=${encodeURIComponent(bybitInterval(interval))}&limit=${Math.min(limit, 200)}`,
    )) as { result?: { list?: string[][] } };
    const list = data.result?.list ?? [];
    return sortKlines(list.map(rowKline));
  }

  if (exchange === 'okx') {
    const data = (await fetchJson(
      `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(inst)}&bar=${encodeURIComponent(okxInterval(interval))}&limit=${Math.min(limit, 300)}`,
    )) as { data?: string[][] };
    return sortKlines((data.data ?? []).map(rowKline));
  }

  if (exchange === 'bitget') {
    const productType = market === 'spot' ? 'SPOT' : 'USDT-FUTURES';
    const path =
      market === 'spot' ? 'https://api.bitget.com/api/v2/spot/market/candles' : 'https://api.bitget.com/api/v2/mix/market/candles';
    const data = (await fetchJson(
      `${path}?symbol=${encodeURIComponent(inst)}&granularity=${encodeURIComponent(bitgetInterval(interval))}&limit=${Math.min(limit, 200)}${market === 'spot' ? '' : `&productType=${productType}`}`,
    )) as { data?: string[][] };
    let rows = sortKlines((data.data ?? []).map(rowKline));
    if (interval === '2h') rows = aggregateKlines(rows, 2 * 60 * 60 * 1000);
    return rows;
  }

  if (exchange === 'hyperliquid') {
    const ms = intervalMs(interval);
    const endTime = Date.now();
    const data = (await fetchPost('https://api.hyperliquid.xyz/info', {
      type: 'candleSnapshot',
      req: {
        coin: inst,
        interval,
        startTime: endTime - ms * Math.min(limit, 500),
        endTime,
      },
    })) as Array<{ t?: number; o?: string; h?: string; l?: string; c?: string; v?: string }>;
    if (!Array.isArray(data)) return [];
    return sortKlines(data.map((k) => asKline(Number(k.t), k.o ?? '0', k.h ?? '0', k.l ?? '0', k.c ?? '0', k.v ?? '0')));
  }

  if (exchange === 'dydx') {
    const data = (await fetchJson(
      `https://indexer.dydx.trade/v4/candles/perpetualMarkets/${encodeURIComponent(inst)}?resolution=${encodeURIComponent(dydxResolution(interval))}&limit=${Math.min(limit, 300)}`,
    )) as { candles?: Array<{ startedAt?: string; open?: string; high?: string; low?: string; close?: string; usdVolume?: string }> };
    let rows = sortKlines(
      (data.candles ?? []).map((k) =>
        asKline(Date.parse(k.startedAt ?? '') || 0, k.open ?? '0', k.high ?? '0', k.low ?? '0', k.close ?? '0', k.usdVolume ?? '0'),
      ),
    );
    if (interval === '2h') rows = aggregateKlines(rows, 2 * 60 * 60 * 1000);
    return rows;
  }

  const data = (await fetchJson(
    `https://www.bitstamp.net/api/v2/ohlc/${encodeURIComponent(inst)}/?step=${bitstampStep(interval)}&limit=${Math.min(limit, 1000)}`,
  )) as { data?: { ohlc?: Array<{ timestamp?: string; open?: string; high?: string; low?: string; close?: string; volume?: string }> } };
  return sortKlines(
    (data.data?.ohlc ?? []).map((k) =>
      asKline(Number(k.timestamp) * 1000, k.open ?? '0', k.high ?? '0', k.low ?? '0', k.close ?? '0', k.volume ?? '0'),
    ),
  );
}

export interface VenueDepth {
  lastUpdateId?: number;
  bids: [string, string][];
  asks: [string, string][];
}

function pairs(rows: unknown, priceIdx = 0, sizeIdx = 1): [string, string][] {
  if (!Array.isArray(rows)) return [];
  const out: [string, string][] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length <= sizeIdx) continue;
    out.push([String(row[priceIdx]), String(row[sizeIdx])]);
  }
  return out;
}

export async function fetchVenueDepth(
  exchange: ExchangeId,
  symbol: string,
  market: MarketType,
  limit = 100,
): Promise<VenueDepth> {
  const inst = venueInstrument(exchange, symbol, market);
  if (!inst) return { bids: [], asks: [] };

  if (exchange === 'binance') {
    const base =
      market === 'spot' ? 'https://api.binance.com/api/v3/depth' : 'https://fapi.binance.com/fapi/v1/depth';
    const data = (await fetchJson(`${base}?symbol=${encodeURIComponent(inst)}&limit=${limit}`)) as {
      lastUpdateId?: number;
      bids?: [string, string][];
      asks?: [string, string][];
    };
    return { lastUpdateId: data.lastUpdateId, bids: data.bids ?? [], asks: data.asks ?? [] };
  }

  if (exchange === 'bybit') {
    const category = market === 'spot' ? 'spot' : 'linear';
    const data = (await fetchJson(
      `https://api.bybit.com/v5/market/orderbook?category=${category}&symbol=${encodeURIComponent(inst)}&limit=${Math.min(limit, 200)}`,
    )) as { result?: { b?: string[][]; a?: string[][]; seq?: number } };
    return {
      lastUpdateId: data.result?.seq,
      bids: pairs(data.result?.b),
      asks: pairs(data.result?.a),
    };
  }

  if (exchange === 'okx') {
    const data = (await fetchJson(
      `https://www.okx.com/api/v5/market/books?instId=${encodeURIComponent(inst)}&sz=${Math.min(limit, 400)}`,
    )) as { data?: Array<{ bids?: unknown; asks?: unknown }> };
    const book = data.data?.[0];
    return { bids: pairs(book?.bids), asks: pairs(book?.asks) };
  }

  if (exchange === 'bitget') {
    const path =
      market === 'spot'
        ? `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(inst)}&limit=${Math.min(limit, 150)}`
        : `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${encodeURIComponent(inst)}&productType=USDT-FUTURES&limit=${Math.min(limit, 100)}`;
    const data = (await fetchJson(path)) as { data?: { bids?: unknown; asks?: unknown } };
    return { bids: pairs(data.data?.bids), asks: pairs(data.data?.asks) };
  }

  if (exchange === 'hyperliquid') {
    const data = (await fetchPost('https://api.hyperliquid.xyz/info', { type: 'l2Book', coin: inst })) as {
      levels?: Array<Array<{ px?: string; sz?: string }>>;
    };
    const bids = (data.levels?.[0] ?? []).map((l) => [String(l.px ?? '0'), String(l.sz ?? '0')] as [string, string]);
    const asks = (data.levels?.[1] ?? []).map((l) => [String(l.px ?? '0'), String(l.sz ?? '0')] as [string, string]);
    return { bids, asks };
  }

  if (exchange === 'dydx') {
    const data = (await fetchJson(
      `https://indexer.dydx.trade/v4/orderbooks/perpetualMarket/${encodeURIComponent(inst)}`,
    )) as { bids?: Array<{ price?: string; size?: string }>; asks?: Array<{ price?: string; size?: string }> };
    return {
      bids: (data.bids ?? []).map((l) => [String(l.price ?? '0'), String(l.size ?? '0')] as [string, string]),
      asks: (data.asks ?? []).map((l) => [String(l.price ?? '0'), String(l.size ?? '0')] as [string, string]),
    };
  }

  const data = (await fetchJson(`https://www.bitstamp.net/api/v2/order_book/${encodeURIComponent(inst)}/`)) as {
    bids?: unknown;
    asks?: unknown;
  };
  return { bids: pairs(data.bids), asks: pairs(data.asks) };
}

export async function fetchOkxContractValues(market: MarketType): Promise<Map<string, number>> {
  const instType = market === 'spot' ? 'SPOT' : 'SWAP';
  const data = (await fetchJson(
    `https://www.okx.com/api/v5/public/instruments?instType=${instType}`,
  )) as { data?: Array<{ instId?: string; ctVal?: string }> };
  const map = new Map<string, number>();
  for (const row of data.data ?? []) {
    if (!row.instId) continue;
    const ctVal = Number(row.ctVal);
    map.set(row.instId, Number.isFinite(ctVal) && ctVal > 0 ? ctVal : 1);
  }
  return map;
}
