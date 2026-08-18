import WebSocket from 'ws';
import { OrderFlowEngine } from '../engine/order-flow-engine.js';
import { StockTickClassifier, syntheticStockBook } from '../exchange/stock-adapter.js';
import type { MarketTrade } from '../models/trade.js';
import { minUsdFor, type WatchCoin } from './watchlist.js';
import type { CoinOverview, LiveFeedEvent, LiveFeedListener, LiveSummary } from './live-feed.js';

export interface StockFeedConfig {
  stocks: WatchCoin[];
  summaryMs: number;
  finnhubKey?: string;
}

interface YahooQuote {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
}

/**
 * US stock tape — separate from Binance.
 * Prefers Finnhub live trades when FINNHUB_API_KEY is set.
 * Otherwise polls Yahoo quotes (delayed, volume-delta prints).
 */
export class StockLiveFeed {
  readonly engine = new OrderFlowEngine();
  private readonly classifier = new StockTickClassifier();
  private readonly listeners = new Set<LiveFeedListener>();
  private readonly tradeCount = new Map<string, number>();
  private readonly lastStates = new Map<string, Partial<Record<'10s' | '1m' | '5m', string>>>();
  private readonly lastYahooVol = new Map<string, number>();
  private ws: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private summaryTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private seq = 0;

  constructor(readonly config: StockFeedConfig) {
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
    });
  }

  on(listener: LiveFeedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.closed = false;
    this.summaryTimer = setInterval(() => this.emitAllSummaries(Date.now()), this.config.summaryMs);
    if (this.config.finnhubKey) this.connectFinnhub();
    else this.startYahooPoll();
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    this.emit({ type: 'status', connected: false, message: 'Stock feed stopped' });
  }

  private connectFinnhub(): void {
    const url = `wss://ws.finnhub.io?token=${this.config.finnhubKey}`;
    this.emit({ type: 'status', connected: false, message: 'Connecting US stocks (Finnhub)…' });
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      for (const stock of this.config.stocks) {
        ws.send(JSON.stringify({ type: 'subscribe', symbol: stock.symbol }));
      }
      this.emit({
        type: 'status',
        connected: true,
        message: `Live stocks — Finnhub (${this.config.stocks.length} names)`,
      });
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
        const trade = this.classifier.classify({
          symbol: print.s,
          timestamp: print.t,
          price: print.p,
          quantity: print.v,
          tradeId: `${print.s}-${print.t}-${++this.seq}`,
        });
        this.handleTrade(trade);
      }
    });

    ws.on('close', () => {
      this.emit({ type: 'status', connected: false, message: 'Stocks disconnected — reconnecting…' });
      if (!this.closed) setTimeout(() => this.connectFinnhub(), 3_000);
    });

    ws.on('error', () => ws.close());
  }

  private startYahooPoll(): void {
    this.emit({
      type: 'status',
      connected: true,
      message: 'Stocks via Yahoo (delayed). Set FINNHUB_API_KEY for live trades.',
    });
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
        const trade = this.classifier.classify({
          symbol: q.symbol,
          timestamp: ts,
          price,
          quantity: qty,
          tradeId: `yahoo-${q.symbol}-${ts}`,
        });
        this.handleTrade(trade);
      }
    } catch {
      /* ignore poll errors */
    }
  }

  private handleTrade(trade: MarketTrade): void {
    this.engine.ingestBookSnapshot(syntheticStockBook(trade.symbol, trade.price, trade.timestamp));
    this.engine.ingestTrade(trade);
    const next = (this.tradeCount.get(trade.symbol) ?? 0) + 1;
    this.tradeCount.set(trade.symbol, next);

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
