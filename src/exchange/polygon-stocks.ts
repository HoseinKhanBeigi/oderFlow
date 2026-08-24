/**
 * Polygon.io US stock trades — historical REST used for 30-day footprint backfill.
 * Live WS is handled in StockLiveFeed when POLYGON_API_KEY is the only tape key.
 */

export function polygonTimestampMs(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw > 1e16) return Math.floor(raw / 1e6);
  if (raw > 1e14) return Math.floor(raw / 1e3);
  return Math.floor(raw);
}

export interface PolygonStockPrint {
  symbol: string;
  timestamp: number;
  price: number;
  quantity: number;
  tradeId?: string | number;
}

interface PolygonTradeRow {
  price?: number;
  size?: number;
  sip_timestamp?: number;
  participant_timestamp?: number;
  id?: string | number;
}

interface PolygonTradesPage {
  results?: PolygonTradeRow[];
  next_url?: string;
  status?: string;
  error?: string;
  message?: string;
}

export function parsePolygonTrade(symbol: string, row: PolygonTradeRow): PolygonStockPrint | null {
  const price = Number(row.price);
  const quantity = Number(row.size);
  const ts = polygonTimestampMs(Number(row.sip_timestamp ?? row.participant_timestamp ?? 0));
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  if (ts <= 0) return null;
  return { symbol, timestamp: ts, price, quantity, tradeId: row.id };
}

async function polygonGet(url: string, apiKey: string, attempts = 4): Promise<PolygonTradesPage> {
  const parsed = new URL(url);
  parsed.searchParams.set('apiKey', apiKey);
  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(parsed, { headers: { 'User-Agent': 'oderFlow-stock-backfill/1.0' } });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? 12) * 1000;
      await sleep(Number.isFinite(wait) ? wait : 12_000);
      continue;
    }
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      if (i < attempts - 1) await sleep(1_000 * 2 ** i);
      continue;
    }
    return (await res.json()) as PolygonTradesPage;
  }
  throw new Error(lastError || 'polygon request failed');
}

export async function fetchPolygonTradesDay(
  symbol: string,
  day: string,
  apiKey: string,
  onPrint: (print: PolygonStockPrint) => void,
): Promise<number> {
  const next = nextUtcDay(day);
  let url =
    `https://api.polygon.io/v3/trades/${encodeURIComponent(symbol)}` +
    `?timestamp.gte=${day}T00:00:00.000Z&timestamp.lt=${next}T00:00:00.000Z` +
    `&limit=50000&order=asc&sort=timestamp`;
  let count = 0;

  for (let page = 0; page < 400 && url; page++) {
    const body = await polygonGet(url, apiKey);
    if (body.status === 'ERROR' || body.error) {
      throw new Error(body.error ?? body.message ?? 'polygon error');
    }
    for (const row of body.results ?? []) {
      const print = parsePolygonTrade(symbol, row);
      if (!print) continue;
      count++;
      onPrint(print);
    }
    url = body.next_url ?? '';
    if (url) await sleep(120);
  }
  return count;
}

function nextUtcDay(day: string): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(ms + 86_400_000).toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
