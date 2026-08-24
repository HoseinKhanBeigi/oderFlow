import WebSocket from 'ws';
import { OrderFlowEngine } from '../engine/order-flow-engine.js';
import { STOCK_TAPE_EXCHANGE } from '../exchange/venues.js';
import { polygonTimestampMs } from '../exchange/polygon-stocks.js';
import { StockTickClassifier, syntheticStockBook } from '../exchange/stock-adapter.js';
import type { MarketTrade } from '../models/trade.js';
import type { RawTradeListener } from './live-feed.js';
import type { CoinOverview, LiveFeedEvent, LiveFeedListener, LiveSummary } from './live-feed.js';
import { minUsdFor, type WatchCoin } from './watchlist.js';

export type StockTapeSource = 'finnhub' | 'polygon' | 'yahoo';

export interface StockFeedConfig {
  stocks: WatchCoin[];
  summaryMs: number;
  finnhubKey?: string;
  polygonKey?: string;
}

interface YahooQuote {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
}

export function resolveStockTapeSource(env: NodeJS.ProcessEnv = process.env): StockTapeSource {
  if (env.FINNHUB_API_KEY?.trim()) return 'finnhub';
  if (env.POLYGON_API_KEY?.trim()) return 'polygon';
  return 'yahoo';
}

/**
 * US stock tape — last-sale prints, separate from Binance.
 * Finnhub is preferred for live; Polygon WS is the fallback when only that key
 * is set. Yahoo is delayed volume deltas and is never written to the footprint.
 */
export class StockLiveFeed {
  readonly engine = new OrderFlowEngine();
  readonly source: StockTapeSource;
  private readonly classifier = new StockTickClassifier();
  private readonly listeners = new Set<LiveFeedListener>();
  private readonly rawTradeListeners = new Set<RawTradeListener>();
  private readonly tradeCount = new Map<string, number>();
  private readonly lastStates = new Map<string, Partial<Record<'10s' | '1m' | '5m', string>>>();
  private readonly lastYahooVol = new Map<string, number>();
  private readonly lastMoveEvents = new Map<string, string>();
  private ws: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private summaryTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private seq = 0;
  connected = false;

  constructor(readonly config: StockFeedConfig) {
    this.source = config.finnhubKey?.trim()
      ? 'finnhub'
      : config.polygonKey?.trim()
        ? 'polygon'
        : 'yahoo';

    for (const stock of config.stocks) {
      this.engine.getSymbol(stock.symbol, 'stock');
      this.tradeCount.set(stock.symbol, 0);
      this.lastStates.set(stock.symbol, {});
    }

    this.engine.on((ev) => {
      if (ev.kind === 'large_trade') {
        const e = ev.event;
        this.emit({
          type: 'large_trade',
          symbol: e.symbol,
          side: e.type.includes('BUY') ? 'BUY' : 'SELL',
          quoteValue: e.quoteValue,
          price: e.price,
          tier: e.tier,
          relativeClass: e.relativeClass,
        });
      }
      if (ev.kind === 'burst') {
        this.emit({
          type: 'burst',
          symbol: ev.symbol,
          side: ev.burst.side,
          totalQuoteValue: ev.burst.totalQuoteValue,
          tradeCount: ev.burst.tradeCount,
          durationMs: ev.burst.endTime - ev.burst.startTime,
        });
      }
      if (ev.kind === 'alert') {
        this.emit({
          type: 'alert',
          symbol: ev.alert.symbol,
          alertType: ev.alert.type,
          message: ev.alert.message,
        });
      }
      if (ev.kind === 'move_potential' && ev.events.length) {
        const sig = [...ev.events].sort().join(',');
        if (sig !== this.lastMoveEvents.get(ev.symbol)) {
          this.lastMoveEvents.set(ev.symbol, sig);
          this.emit({ type: 'move_potential', symbol: ev.symbol, events: ev.events });
        }
      }
    });
  }

  on(listener: LiveFeedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onAnyTrade(listener: RawTradeListener): () => void {
    this.rawTradeListeners.add(listener);
    return () => this.rawTradeListeners.delete(listener);
  }

  start(): void {
    this.closed = false;
    this.summaryTimer = setInterval(() => this.emitAllSummaries(Date.now()), this.config.summaryMs);
    if (this.source === 'finnhub') this.connectFinnhub();
    else if (this.source === 'polygon') this.connectPolygon();
    else this.startYahooPoll();
  }

  stop(): void {
    this.closed = true;
    this.connected = false;
    this.ws?.close();
    this.ws = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.summaryTimer) clearInterval(this.summaryTimer);
  }

  private connectFinnhub(): void {
    const url = `wss://ws.finnhub.io?token=${this.config.finnhubKey}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      for (const stock of this.config.stocks) {
        ws.send(JSON.stringify({ type: 'subscribe', symbol: stock.symbol }));
      }
      this.connected = true;
      console.log(`[stocks] live tape — Finnhub (${this.config.stocks.length} names)`);
    });

    ws.on('message', (raw) => {
      let msg: { type?: string; data?: Array<{ s: string; p: number; t: number; v: number }> };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type !== 'trade' || !msg.data) return;
      for (const print of msg.data) {
        if (!this.config.stocks.some((s) => s.symbol === print.s)) continue;
        this.handlePrint(
          {
            symbol: print.s,
            timestamp: print.t,
            price: print.p,
            quantity: print.v,
            tradeId: `${print.s}-${print.t}-${++this.seq}`,
          },
          true,
        );
      }
    });

    ws.on('close', () => {
      this.connected = false;
      if (!this.closed) setTimeout(() => this.connectFinnhub(), 3_000);
    });

    ws.on('error', () => ws.close());
  }

  private connectPolygon(): void {
    const ws = new WebSocket('wss://socket.polygon.io/stocks');
    this.ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({ action: 'auth', params: this.config.polygonKey }));
    });

    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of rows) {
        const msg = row as { ev?: string; status?: string; message?: string; sym?: string; p?: number; s?: number; t?: number; i?: string | number };
        if (msg.ev === 'status' && msg.status === 'auth_success') {
          const params = this.config.stocks.map((s) => `T.${s.symbol}`).join(',');
          ws.send(JSON.stringify({ action: 'subscribe', params }));
          this.connected = true;
          console.log(`[stocks] live tape — Polygon (${this.config.stocks.length} names)`);
          continue;
        }
        if (msg.ev === 'status' && msg.status === 'auth_failed') {
          console.error('[stocks] Polygon auth failed:', msg.message ?? 'check POLYGON_API_KEY');
          continue;
        }
        if (msg.ev !== 'T' || !msg.sym) continue;
        if (!this.config.stocks.some((s) => s.symbol === msg.sym)) continue;
        this.handlePrint(
          {
            symbol: msg.sym,
            timestamp: polygonTimestampMs(Number(msg.t)),
            price: Number(msg.p),
            quantity: Number(msg.s),
            tradeId: msg.i ?? `${msg.sym}-${msg.t}-${++this.seq}`,
          },
          true,
        );
      }
    });

    ws.on('close', () => {
      this.connected = false;
      if (!this.closed) setTimeout(() => this.connectPolygon(), 3_000);
    });

    ws.on('error', () => ws.close());
  }

  private startYahooPoll(): void {
    console.log('[stocks] Yahoo delayed quotes — set FINNHUB_API_KEY (live) or POLYGON_API_KEY (live + history)');
    this.connected = true;
    void this.pollYahoo();
    this.pollTimer = setInterval(() => void this.pollYahoo(), 2_500);
  }

  private async pollYahoo(): Promise<void> {
    const symbols = this.config.stocks.map((s) => s.symbol).join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 order-flow-dashboard' },
      });
      if (!res.ok) return;
      const json = (await res.json()) as { quoteResponse?: { result?: YahooQuote[] } };
      const quotes = json.quoteResponse?.result ?? [];
      for (const q of quotes) {
        const price = q.regularMarketPrice;
        const volume = q.regularMarketVolume;
        if (!price || volume === undefined) continue;
        const ts = (q.regularMarketTime ?? Math.floor(Date.now() / 1000)) * 1000;
        this.engine.ingestBookSnapshot(syntheticStockBook(q.symbol, price, ts));

        const prev = this.lastYahooVol.get(q.symbol);
        this.lastYahooVol.set(q.symbol, volume);
        if (prev === undefined || volume <= prev) continue;
        const qty = volume - prev;
        if (qty <= 0) continue;
        this.handlePrint(
          {
            symbol: q.symbol,
            timestamp: ts,
            price,
            quantity: qty,
            tradeId: `yahoo-${q.symbol}-${ts}`,
          },
          false,
        );
      }
    } catch {
      /* ignore poll errors */
    }
  }

  private handlePrint(
    print: { symbol: string; timestamp: number; price: number; quantity: number; tradeId?: string | number },
    intoFootprint: boolean,
  ): void {
    const trade = this.classifier.classify(print);
    this.handleTrade(trade, intoFootprint);
  }

  private handleTrade(trade: MarketTrade, intoFootprint: boolean): void {
    this.engine.ingestBookSnapshot(syntheticStockBook(trade.symbol, trade.price, trade.timestamp));
    this.engine.ingestTrade(trade);
    const next = (this.tradeCount.get(trade.symbol) ?? 0) + 1;
    this.tradeCount.set(trade.symbol, next);

    if (intoFootprint) {
      for (const listener of this.rawTradeListeners) {
        try {
          listener(trade, STOCK_TAPE_EXCHANGE);
        } catch (err) {
          console.error('[stocks] raw trade listener failed:', err instanceof Error ? err.message : err);
        }
      }
    }

    const floor = minUsdFor(trade.symbol, this.config.stocks);
    if (trade.quoteValue < floor) return;

    const engine = this.engine.getSymbol(trade.symbol, 'stock');
    const rel = engine.largeTrades.relativeSize(trade.quoteValue);
    const tier = engine.largeTrades.absoluteTier(trade.quoteValue);
    let tag = rel.classification !== 'NORMAL' ? rel.classification : '';
    if (tier) tag = tag ? `${tag} T${tier}` : `T${tier}`;

    this.emit({
      type: 'trade',
      trade: {
        id: `${trade.symbol}-${trade.tradeId ?? trade.timestamp}-${next}`,
        symbol: trade.symbol,
        timestamp: trade.timestamp,
        side: trade.side,
        price: trade.price,
        quoteValue: trade.quoteValue,
        tag,
        relativeClass: rel.classification,
        tier,
        exchange: STOCK_TAPE_EXCHANGE,
      },
    });
  }

  private emitAllSummaries(now: number): void {
    const overview: CoinOverview[] = [];
    for (const stock of this.config.stocks) {
      const engine = this.engine.getSymbol(stock.symbol, 'stock');
      const windows = {
        '10s': engine.snapshot('10s', now),
        '30s': engine.snapshot('30s', now),
        '1m': engine.snapshot('1m', now),
        '5m': engine.snapshot('5m', now),
        '15m': engine.snapshot('15m', now),
      };
      const states = this.lastStates.get(stock.symbol) ?? {};
      for (const key of ['10s', '1m', '5m'] as const) {
        const w = windows[key];
        const prev = states[key] ?? null;
        if (w.state !== prev && w.state !== 'NO_SIGNAL') {
          this.emit({
            type: 'state_change',
            symbol: stock.symbol,
            window: key,
            state: w.state,
            delta: w.delta,
            previousState: prev,
          });
        }
        states[key] = w.state;
      }
      this.lastStates.set(stock.symbol, states);
      overview.push({
        symbol: stock.symbol,
        label: stock.label,
        price: windows['10s'].price,
        delta10s: windows['10s'].delta,
        state10s: windows['10s'].state,
      });
      const summary: LiveSummary = {
        timestamp: now,
        symbol: stock.symbol,
        market: 'stock',
        price: windows['10s'].price,
        tradeCount: this.tradeCount.get(stock.symbol) ?? 0,
        windows,
      };
      this.emit({ type: 'summary', summary });
    }
    this.emit({ type: 'overview', coins: overview });
  }

  private emit(event: LiveFeedEvent): void {
    for (const l of this.listeners) l(event);
  }
}
