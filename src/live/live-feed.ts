import WebSocket from 'ws';
import { OrderFlowEngine } from '../engine/order-flow-engine.js';
import { BinanceFuturesAdapter, BinanceSpotAdapter } from '../exchange/binance-adapters.js';
import {
  BINANCE_FUTURES_WS,
  BINANCE_FUTURES_WS_RAW,
  BINANCE_SPOT_WS,
  streamName,
  unwrapBinancePayload,
} from '../exchange/types.js';
import type { MarketTrade, MarketType } from '../models/trade.js';
import type { WindowSnapshot } from '../models/signals.js';
import type { BinanceAggTrade, BinanceBookTicker, BinanceTrade } from '../exchange/types.js';
import { DEFAULT_WATCHLIST, minUsdFor, type WatchCoin } from './watchlist.js';

export interface LiveFeedConfig {
  coins: WatchCoin[];
  market: MarketType;
  summaryMs: number;
}

export interface TapeItem {
  id: string;
  symbol: string;
  timestamp: number;
  side: 'BUY' | 'SELL';
  price: number;
  quoteValue: number;
  tag: string;
  relativeClass: string;
  tier: number | null;
}

export interface LiveSummary {
  timestamp: number;
  symbol: string;
  market: MarketType;
  price: number;
  tradeCount: number;
  windows: Record<'10s' | '30s' | '1m' | '5m' | '15m', WindowSnapshot>;
}

export interface CoinOverview {
  symbol: string;
  label: string;
  price: number;
  delta10s: number;
  state10s: string;
}

export type LiveFeedEvent =
  | { type: 'status'; connected: boolean; message: string }
  | { type: 'trade'; trade: TapeItem }
  | { type: 'summary'; summary: LiveSummary }
  | { type: 'overview'; coins: CoinOverview[] }
  | {
      type: 'burst';
      symbol: string;
      side: 'BUY' | 'SELL';
      totalQuoteValue: number;
      tradeCount: number;
      durationMs: number;
    }
  | { type: 'alert'; symbol: string; alertType: string; message: string }
  | {
      type: 'large_trade';
      symbol: string;
      side: 'BUY' | 'SELL';
      quoteValue: number;
      price: number;
      tier: number | null;
      relativeClass: string;
    }
  | {
      type: 'state_change';
      symbol: string;
      window: string;
      state: string;
      delta: number;
      previousState: string | null;
    };

export type LiveFeedListener = (event: LiveFeedEvent) => void;

export class LiveBinanceFeed {
  readonly engine: OrderFlowEngine;
  readonly coins: WatchCoin[];
  private readonly sockets: WebSocket[] = [];
  private closed = false;
  private lastSummary = 0;
  private readonly tradeCount = new Map<string, number>();
  private readonly lastStates = new Map<string, Partial<Record<'10s' | '1m' | '5m', string>>>();
  private readonly listeners = new Set<LiveFeedListener>();
  private readonly spot = new BinanceSpotAdapter();
  private readonly futures = new BinanceFuturesAdapter();

  constructor(readonly config: LiveFeedConfig) {
    this.engine = new OrderFlowEngine();
    this.coins = config.coins;
    for (const coin of this.coins) {
      this.engine.getSymbol(coin.symbol, config.market);
      this.tradeCount.set(coin.symbol, 0);
      this.lastStates.set(coin.symbol, {});
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
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.closeSockets();
    this.emit({ type: 'status', connected: false, message: 'Stopped' });
  }

  private closeSockets(): void {
    for (const ws of this.sockets.splice(0)) {
      ws.removeAllListeners();
      ws.close();
    }
  }

  private connect(): void {
    this.closeSockets();
    this.emit({ type: 'status', connected: false, message: 'Connecting…' });
    const { market } = this.config;
    const tradeChannel = market === 'spot' ? 'aggTrade' : 'trade';

    if (market === 'spot') {
      this.openCombined(BINANCE_SPOT_WS, this.coins, tradeChannel, 'spot');
      return;
    }

    const crypto = this.coins.filter((c) => c.venue !== 'equity');
    const equity = this.coins.filter((c) => c.venue === 'equity');
    if (crypto.length) this.openCombined(BINANCE_FUTURES_WS, crypto, 'trade', 'crypto perp');
    // TradFi equity perps (https://www.binance.com/en/futures/AMZNUSDT) need /ws/, not combined /stream.
    if (equity.length) this.openRawCombined(equity, 'trade', 'equity perp');
  }

  private streamList(coins: WatchCoin[], tradeChannel: string): string {
    return coins
      .flatMap((c) => [streamName(c.symbol, tradeChannel), streamName(c.symbol, 'bookTicker')])
      .join('/');
  }

  private openCombined(base: string, coins: WatchCoin[], tradeChannel: string, label: string): void {
    this.openSocket(`${base}?streams=${this.streamList(coins, tradeChannel)}`, label);
  }

  private openRawCombined(coins: WatchCoin[], tradeChannel: string, label: string): void {
    this.openSocket(`${BINANCE_FUTURES_WS_RAW}/${this.streamList(coins, tradeChannel)}`, label);
  }

  private openSocket(url: string, label: string): void {
    const ws = new WebSocket(url);
    this.sockets.push(ws);

    ws.on('open', () => {
      this.emit({
        type: 'status',
        connected: true,
        message: `Live — ${this.coins.length} symbols · Binance ${this.config.market}`,
      });
    });

    ws.on('message', (raw) => this.onSocketMessage(raw));

    ws.on('close', () => {
      const idx = this.sockets.indexOf(ws);
      if (idx >= 0) this.sockets.splice(idx, 1);
      if (this.closed) return;
      if (this.sockets.length === 0) {
        this.emit({ type: 'status', connected: false, message: `Disconnected (${label}) — reconnecting…` });
      }
      setTimeout(() => {
        if (!this.closed) this.openSocket(url, label);
      }, 2_000);
    });

    ws.on('error', () => ws.close());
  }

  private onSocketMessage(raw: WebSocket.RawData): void {
    const { market } = this.config;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const data = unwrapBinancePayload(msg);
    if (!data) return;
    const event = (data.e as string | undefined) ?? (data.b && data.a ? 'bookTicker' : undefined);
    const symbol = String(data.s ?? '');
    if (!symbol) return;

    if (event === 'aggTrade') {
      const trade =
        market === 'spot'
          ? this.spot.normalizeAggTrade(data as unknown as BinanceAggTrade)
          : this.futures.normalizeAggTrade(data as unknown as BinanceAggTrade);
      this.handleTrade(trade);
    }

    if (event === 'trade') {
      const trade =
        market === 'spot'
          ? this.spot.normalizeTrade(data as unknown as BinanceTrade)
          : this.futures.normalizeTrade(data as unknown as BinanceTrade);
      this.handleTrade(trade);
    }

    if (event === 'bookTicker') {
      const book =
        market === 'spot'
          ? this.spot.normalizeBookTicker(data as unknown as BinanceBookTicker)
          : this.futures.normalizeBookTicker(data as unknown as BinanceBookTicker);
      if (!this.coins.some((c) => c.symbol === book.symbol)) return;
      this.engine.ingestBookSnapshot(book);
    }

    const now = Date.now();
    if (now - this.lastSummary >= this.config.summaryMs) {
      this.lastSummary = now;
      this.emitAllSummaries(now);
    }
  }

  private handleTrade(trade: MarketTrade): void {
    if (!this.coins.some((c) => c.symbol === trade.symbol)) return;
    this.engine.ingestTrade(trade);
    const next = (this.tradeCount.get(trade.symbol) ?? 0) + 1;
    this.tradeCount.set(trade.symbol, next);

    const floor = minUsdFor(trade.symbol, this.coins);
    if (trade.quoteValue < floor) return;

    const engine = this.engine.getSymbol(trade.symbol, this.config.market);
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

    for (const coin of this.coins) {
      const engine = this.engine.getSymbol(coin.symbol, this.config.market);
      const windows = {
        '10s': engine.snapshot('10s', now),
        '30s': engine.snapshot('30s', now),
        '1m': engine.snapshot('1m', now),
        '5m': engine.snapshot('5m', now),
        '15m': engine.snapshot('15m', now),
      };

      const states = this.lastStates.get(coin.symbol) ?? {};
      for (const key of ['10s', '1m', '5m'] as const) {
        const w = windows[key];
        const prev = states[key] ?? null;
        if (w.state !== prev && w.state !== 'NO_SIGNAL') {
          this.emit({
            type: 'state_change',
            symbol: coin.symbol,
            window: key,
            state: w.state,
            delta: w.delta,
            previousState: prev,
          });
        }
        states[key] = w.state;
      }
      this.lastStates.set(coin.symbol, states);

      overview.push({
        symbol: coin.symbol,
        label: coin.label,
        price: windows['10s'].price,
        delta10s: windows['10s'].delta,
        state10s: windows['10s'].state,
      });

      this.emit({
        type: 'summary',
        summary: {
          timestamp: now,
          symbol: coin.symbol,
          market: this.config.market,
          price: windows['10s'].price,
          tradeCount: this.tradeCount.get(coin.symbol) ?? 0,
          windows,
        },
      });
    }

    this.emit({ type: 'overview', coins: overview });
  }

  private emit(event: LiveFeedEvent): void {
    for (const l of this.listeners) l(event);
  }
}

export { DEFAULT_WATCHLIST };
export function defaultMinUsd(symbol: string): number {
  return minUsdFor(symbol);
}
