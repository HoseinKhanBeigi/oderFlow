import WebSocket from 'ws';
import { OrderFlowEngine } from '../engine/order-flow-engine.js';
import { BinanceFuturesAdapter, BinanceSpotAdapter } from '../exchange/binance-adapters.js';
import { BINANCE_FUTURES_WS, BINANCE_SPOT_WS, streamName } from '../exchange/types.js';
import type { MarketTrade, MarketType } from '../models/trade.js';
import type { WindowSnapshot } from '../models/signals.js';
import type { BinanceAggTrade, BinanceBookTicker, BinanceTrade } from '../exchange/types.js';
import { SymbolEngine } from '../engine/symbol-engine.js';

export interface LiveFeedConfig {
  symbol: string;
  market: MarketType;
  minUsd: number;
  summaryMs: number;
}

export interface TapeItem {
  id: string;
  timestamp: number;
  side: 'BUY' | 'SELL';
  price: number;
  quoteValue: number;
  tag: string;
}

export interface LiveSummary {
  timestamp: number;
  symbol: string;
  market: MarketType;
  price: number;
  tradeCount: number;
  windows: {
    '10s': WindowSnapshot;
    '1m': WindowSnapshot;
    '5m': WindowSnapshot;
  };
}

export type LiveFeedEvent =
  | { type: 'status'; connected: boolean; message: string }
  | { type: 'trade'; trade: TapeItem }
  | { type: 'summary'; summary: LiveSummary }
  | { type: 'burst'; side: 'BUY' | 'SELL'; totalQuoteValue: number; tradeCount: number; durationMs: number }
  | { type: 'alert'; alertType: string; message: string };

export type LiveFeedListener = (event: LiveFeedEvent) => void;

export class LiveBinanceFeed {
  readonly engine: OrderFlowEngine;
  readonly sym: SymbolEngine;
  private ws: WebSocket | null = null;
  private closed = false;
  private lastSummary = 0;
  private tradeCount = 0;
  private readonly listeners = new Set<LiveFeedListener>();
  private readonly spot = new BinanceSpotAdapter();
  private readonly futures = new BinanceFuturesAdapter();

  constructor(readonly config: LiveFeedConfig) {
    this.engine = new OrderFlowEngine();
    this.sym = this.engine.getSymbol(config.symbol, config.market);

    this.engine.on((ev) => {
      if (ev.kind === 'burst') {
        this.emit({
          type: 'burst',
          side: ev.burst.side,
          totalQuoteValue: ev.burst.totalQuoteValue,
          tradeCount: ev.burst.tradeCount,
          durationMs: ev.burst.endTime - ev.burst.startTime,
        });
      }
      if (ev.kind === 'alert') {
        this.emit({ type: 'alert', alertType: ev.alert.type, message: ev.alert.message });
      }
    });
  }

  on(listener: LiveFeedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    this.emit({ type: 'status', connected: false, message: 'Stopped' });
  }

  private connect(): void {
    const { symbol, market } = this.config;
    const base = market === 'spot' ? BINANCE_SPOT_WS : BINANCE_FUTURES_WS;
    const tradeChannel = market === 'spot' ? 'aggTrade' : 'trade';
    const streams = [streamName(symbol, tradeChannel), streamName(symbol, 'bookTicker')].join('/');
    const url = `${base}?streams=${streams}`;

    this.emit({ type: 'status', connected: false, message: 'Connecting…' });

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.emit({
        type: 'status',
        connected: true,
        message: `Live — Binance ${market} (${tradeChannel})`,
      });
    });

    ws.on('message', (raw) => {
      let msg: { data?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(raw)) as { data?: Record<string, unknown> };
      } catch {
        return;
      }
      const data = msg.data;
      if (!data?.e) return;

      if (data.e === 'aggTrade') {
        const trade =
          market === 'spot'
            ? this.spot.normalizeAggTrade(data as unknown as BinanceAggTrade)
            : this.futures.normalizeAggTrade(data as unknown as BinanceAggTrade);
        this.handleTrade(trade);
      }

      if (data.e === 'trade') {
        const trade =
          market === 'spot'
            ? this.spot.normalizeTrade(data as unknown as BinanceTrade)
            : this.futures.normalizeTrade(data as unknown as BinanceTrade);
        this.handleTrade(trade);
      }

      if (data.e === 'bookTicker') {
        const book =
          market === 'spot'
            ? this.spot.normalizeBookTicker(data as unknown as BinanceBookTicker)
            : this.futures.normalizeBookTicker(data as unknown as BinanceBookTicker);
        this.engine.ingestBookSnapshot(book);
      }

      const now = Date.now();
      if (now - this.lastSummary >= this.config.summaryMs) {
        this.lastSummary = now;
        this.emitSummary(now);
      }
    });

    ws.on('close', () => {
      this.emit({ type: 'status', connected: false, message: 'Disconnected — reconnecting…' });
      if (!this.closed) setTimeout(() => this.connect(), 2_000);
    });

    ws.on('error', () => ws.close());
  }

  private handleTrade(trade: MarketTrade): void {
    this.engine.ingestTrade(trade);
    this.tradeCount += 1;

    if (trade.quoteValue < this.config.minUsd) return;

    const rel = this.sym.largeTrades.relativeSize(trade.quoteValue);
    const tier = this.sym.largeTrades.absoluteTier(trade.quoteValue);
    let tag = rel.classification !== 'NORMAL' ? rel.classification : '';
    if (tier) tag = tag ? `${tag} T${tier}` : `T${tier}`;

    this.emit({
      type: 'trade',
      trade: {
        id: `${trade.tradeId ?? trade.timestamp}-${this.tradeCount}`,
        timestamp: trade.timestamp,
        side: trade.side,
        price: trade.price,
        quoteValue: trade.quoteValue,
        tag,
      },
    });
  }

  private emitSummary(now: number): void {
    this.emit({
      type: 'summary',
      summary: {
        timestamp: now,
        symbol: this.config.symbol,
        market: this.config.market,
        price: this.sym.snapshot('10s', now).price,
        tradeCount: this.tradeCount,
        windows: {
          '10s': this.sym.snapshot('10s', now),
          '1m': this.sym.snapshot('1m', now),
          '5m': this.sym.snapshot('5m', now),
        },
      },
    });
  }

  private emit(event: LiveFeedEvent): void {
    for (const l of this.listeners) l(event);
  }
}

export function defaultMinUsd(symbol: string): number {
  return symbol.startsWith('BTC') ? 10_000 : 5_000;
}
