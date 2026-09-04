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
import { EXCHANGE_LABELS, parseExchangesEnv, type ExchangeId } from '../exchange/venues.js';
import type { LiquidationEvent, MarketTrade, MarketType, OrderBookSnapshot } from '../models/trade.js';
import type { WindowSnapshot } from '../models/signals.js';
import { isVolatileWindow } from '../analysis/alerts.js';
import type { PassiveLiquiditySnapshot } from '../models/passive-liquidity.js';
import type { BinanceAggTrade, BinanceBookTicker, BinanceForceOrder, BinanceTrade } from '../exchange/types.js';
import { DEFAULT_WATCHLIST, minUsdFor, type WatchCoin } from './watchlist.js';
import { VenueTradeFan } from './venue-trades.js';

export interface LiveFeedConfig {
  coins: WatchCoin[];
  market: MarketType;
  summaryMs: number;
  exchanges?: ExchangeId[];
  /**
   * Venues whose trades feed the analysis engine (flow, footprint aggression,
   * market battle). Defaults to Binance alone.
   *
   * Caveat before widening this: the order book is Binance-only, so adding
   * venues here scales the *attack* side without scaling *defense*, which
   * inflates attack-vs-defense ratios. Prefer `engineTradeFallback` unless you
   * also have depth for the extra venues.
   */
  engineTradeVenues?: ExchangeId[];
  /**
   * Venue to fall back to when the primary stops delivering trades for this
   * long. Keeps flow analysis alive through a Binance outage or geo-block.
   * Set to 0 to disable.
   */
  engineTradeFallbackMs?: number;
  engineTradeFallback?: ExchangeId;
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
  exchange?: ExchangeId;
  market?: MarketType;
}

/**
 * Passive liquidity is window-independent and large, so it travels in its own
 * event instead of being repeated inside every window of every summary.
 */
export type WireWindowSnapshot = Omit<WindowSnapshot, 'passiveLiquidity'>;

export interface LiveSummary {
  timestamp: number;
  symbol: string;
  market: MarketType;
  price: number;
  tradeCount: number;
  windows: Record<'10s' | '30s' | '1m' | '5m' | '15m', WireWindowSnapshot>;
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
      type: 'book';
      symbol: string;
      bids: { price: number; quantity: number; quoteValue: number }[];
      asks: { price: number; quantity: number; quoteValue: number }[];
      mid: number;
      spread: number;
      bidTotal: number;
      askTotal: number;
    }
  | {
      type: 'state_change';
      symbol: string;
      window: string;
      state: string;
      delta: number;
      previousState: string | null;
    }
  | {
      type: 'move_potential';
      symbol: string;
      events: string[];
    }
  | {
      type: 'passive_liquidity';
      symbol: string;
      snapshot: PassiveLiquiditySnapshot;
    };

export type LiveFeedListener = (event: LiveFeedEvent) => void;

/**
 * Every normalized trade, before the watchlist `minUsd` tape filter.
 * The footprint recorder needs the full stream, not just large prints.
 */
export type RawTradeListener = (trade: MarketTrade, exchange: ExchangeId) => void;
export type RawLiquidationListener = (liq: LiquidationEvent) => void;

function stripPassive(snapshot: WindowSnapshot): WireWindowSnapshot {
  const { passiveLiquidity: _passiveLiquidity, ...wire } = snapshot;
  return wire;
}

function parseBookLevels(rows: unknown): { price: number; quantity: number; quoteValue: number }[] {
  if (!Array.isArray(rows)) return [];
  const levels: { price: number; quantity: number; quoteValue: number }[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = Number(row[0]);
    const quantity = Number(row[1]);
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) continue;
    levels.push({ price, quantity, quoteValue: price * quantity });
  }
  return levels;
}

export class LiveBinanceFeed {
  readonly engine: OrderFlowEngine;
  readonly coins: WatchCoin[];
  readonly exchanges: ExchangeId[];
  private readonly sockets: WebSocket[] = [];
  private closed = false;
  private lastSummary = 0;
  private readonly lastBookEmit = new Map<string, number>();
  private readonly tradeCount = new Map<string, number>();
  private readonly lastMoveEvents = new Map<string, string>();
  private readonly lastStates = new Map<string, Partial<Record<'10s' | '1m' | '5m', string>>>();
  private readonly listeners = new Set<LiveFeedListener>();
  private readonly rawTradeListeners = new Set<RawTradeListener>();
  private readonly rawLiqListeners = new Set<RawLiquidationListener>();
  private readonly spot = new BinanceSpotAdapter();
  private readonly futures = new BinanceFuturesAdapter();
  private readonly venueUp: Partial<Record<ExchangeId, boolean>> = {};
  private venues: VenueTradeFan | null = null;
  /** Venues whose trades reach the analysis engine. */
  private readonly engineTradeVenues: ExchangeId[];
  private readonly lastEngineTradeAt = new Map<ExchangeId, number>();
  private readonly startedAt = Date.now();
  private fallbackAnnounced = false;

  constructor(readonly config: LiveFeedConfig) {
    this.engine = new OrderFlowEngine();
    this.coins = config.coins;
    this.exchanges = config.exchanges?.length ? config.exchanges : parseExchangesEnv();
    this.engineTradeVenues = config.engineTradeVenues?.length ? config.engineTradeVenues : ['binance'];
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

  onAnyLiquidation(listener: RawLiquidationListener): () => void {
    this.rawLiqListeners.add(listener);
    return () => this.rawLiqListeners.delete(listener);
  }

  start(): void {
    this.closed = false;
    this.connect();
    const extra = this.exchanges.filter((id) => id !== 'binance');
    if (extra.length) {
      this.venues = new VenueTradeFan(
        this.coins,
        this.config.market,
        extra,
        (trade, exchange) => this.handleVenueTrade(trade, exchange),
        (exchange, connected) => this.setVenueUp(exchange, connected),
      );
      this.venues.start();
    }
  }

  stop(): void {
    this.closed = true;
    this.venues?.stop();
    this.venues = null;
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
      this.openSocket(`${BINANCE_SPOT_WS}?streams=${this.depthList(this.coins)}`, 'spot book');
      return;
    }

    const crypto = this.coins.filter((c) => c.venue !== 'equity');
    const equity = this.coins.filter((c) => c.venue === 'equity');
    if (crypto.length) {
      this.openCombined(BINANCE_FUTURES_WS, crypto, 'trade', 'crypto perp');
      this.openSocket(`${BINANCE_FUTURES_WS}?streams=${this.depthList(crypto)}`, 'crypto book');
      this.openSocket(`${BINANCE_FUTURES_WS}?streams=!forceOrder@arr`, 'liquidations');
    }
    // TradFi equity perps (https://www.binance.com/en/futures/AMZNUSDT) need /ws/, not combined /stream.
    if (equity.length) {
      this.openRawCombined(equity, 'trade', 'equity perp');
      this.openSocket(`${BINANCE_FUTURES_WS}?streams=${this.depthList(equity)}`, 'equity book');
    }
  }

  private streamList(coins: WatchCoin[], tradeChannel: string): string {
    return coins
      .flatMap((c) => [streamName(c.symbol, tradeChannel), streamName(c.symbol, 'bookTicker')])
      .join('/');
  }

  private depthList(coins: WatchCoin[]): string {
    return coins.map((c) => streamName(c.symbol, 'depth20@100ms')).join('/');
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

    ws.on('open', () => this.setVenueUp('binance', true));

    ws.on('message', (raw) => this.onSocketMessage(raw));

    ws.on('close', () => {
      const idx = this.sockets.indexOf(ws);
      if (idx >= 0) this.sockets.splice(idx, 1);
      if (this.closed) return;
      if (this.sockets.length === 0) this.setVenueUp('binance', false);
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
    const stream = String(msg.stream ?? '');
    const data = unwrapBinancePayload(msg);
    if (!data) return;
    const event = (data.e as string | undefined) ?? (data.b && data.a && !Array.isArray(data.b) ? 'bookTicker' : undefined);
    const symbol = String(data.s ?? stream.split('@')[0] ?? '').toUpperCase();

    if (stream.includes('depth20') || (Array.isArray(data.bids) && Array.isArray(data.asks))) {
      this.handleDepth(symbol, data, market);
    } else if (event === 'depthUpdate' && Array.isArray(data.b) && Array.isArray(data.a)) {
      this.handleDepth(symbol, { bids: data.b, asks: data.a, lastUpdateId: data.u }, market);
    }

    if (event === 'forceOrder' || stream.includes('forceOrder')) {
      const raw = (data.o ? data : { e: 'forceOrder', E: Date.now(), o: data }) as unknown as BinanceForceOrder;
      if (raw?.o?.s) {
        const liq = this.futures.normalizeForceOrder(raw);
        if (this.coins.some((c) => c.symbol === liq.symbol)) {
          this.engine.ingestLiquidation(liq);
          for (const listener of this.rawLiqListeners) {
            try {
              listener(liq);
            } catch (err) {
              console.error('[feed] liquidation listener failed:', err instanceof Error ? err.message : err);
            }
          }
        }
      }
    }

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

  /**
   * Whether this venue's trades should reach the analysis engine.
   *
   * Normally only the configured venues do. If the primary has gone silent for
   * longer than the fallback window, the fallback venue is admitted too, so a
   * blocked or broken primary degrades the read instead of blanking it.
   */
  private feedsEngine(exchange: ExchangeId): boolean {
    if (this.engineTradeVenues.includes(exchange)) return true;
    const fallback = this.config.engineTradeFallback;
    const windowMs = this.config.engineTradeFallbackMs ?? 0;
    if (!fallback || windowMs <= 0 || exchange !== fallback) return false;
    const primaryAt = Math.max(
      0,
      ...this.engineTradeVenues.map((id) => this.lastEngineTradeAt.get(id) ?? 0),
    );
    // Never seen a primary trade, or it stopped: let the fallback through.
    const silent = primaryAt === 0 ? this.startedAt : primaryAt;
    if (Date.now() - silent <= windowMs) return false;
    if (!this.fallbackAnnounced) {
      this.fallbackAnnounced = true;
      console.warn(
        `[feed] ${this.config.market}: no trades from ${this.engineTradeVenues.join('/')} for ` +
          `${Math.round(windowMs / 1000)}s — feeding the engine from ${fallback} instead.`,
      );
    }
    return true;
  }

  private handleDepth(symbol: string, data: Record<string, unknown>, market: MarketType): void {
    if (!symbol || !this.coins.some((c) => c.symbol === symbol)) return;
    const bids = parseBookLevels(data.bids ?? data.b);
    const asks = parseBookLevels(data.asks ?? data.a);
    if (!bids.length && !asks.length) return;

    const snapshot: OrderBookSnapshot = {
      symbol,
      marketType: market === 'spot' ? 'spot' : 'perp',
      timestamp: Date.now(),
      bids,
      asks,
      lastUpdateId: typeof data.lastUpdateId === 'number' ? data.lastUpdateId : undefined,
    };
    this.engine.ingestBookSnapshot(snapshot);

    const now = Date.now();
    if (now - (this.lastBookEmit.get(symbol) ?? 0) < 120) return;
    this.lastBookEmit.set(symbol, now);

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : 0;
    this.emit({
      type: 'book',
      symbol,
      bids,
      asks,
      mid,
      spread,
      bidTotal: bids.reduce((s, l) => s + l.quoteValue, 0),
      askTotal: asks.reduce((s, l) => s + l.quoteValue, 0),
    });
  }

  private handleTrade(trade: MarketTrade, exchange: ExchangeId = 'binance'): void {
    if (!this.coins.some((c) => c.symbol === trade.symbol)) return;
    if (this.feedsEngine(exchange)) {
      this.engine.ingestTrade(trade);
      this.lastEngineTradeAt.set(exchange, Date.now());
    }
    const seqKey = `${exchange}:${trade.symbol}`;
    const next = (this.tradeCount.get(seqKey) ?? 0) + 1;
    this.tradeCount.set(seqKey, next);
    if (exchange === 'binance') this.tradeCount.set(trade.symbol, next);

    for (const listener of this.rawTradeListeners) {
      try {
        listener(trade, exchange);
      } catch (err) {
        console.error('[feed] raw trade listener failed:', err instanceof Error ? err.message : err);
      }
    }

    const floor = minUsdFor(trade.symbol, this.coins);
    if (trade.quoteValue < floor) return;

    let relativeClass = 'NORMAL';
    let tier: number | null = null;
    let tag = '';
    if (exchange === 'binance') {
      const engine = this.engine.getSymbol(trade.symbol, this.config.market);
      const rel = engine.largeTrades.relativeSize(trade.quoteValue);
      tier = engine.largeTrades.absoluteTier(trade.quoteValue);
      relativeClass = rel.classification;
      tag = relativeClass !== 'NORMAL' ? relativeClass : '';
      if (tier) tag = tag ? `${tag} T${tier}` : `T${tier}`;
    }

    this.emit({
      type: 'trade',
      trade: {
        id: `${exchange}-${trade.symbol}-${trade.tradeId ?? trade.timestamp}-${next}`,
        symbol: trade.symbol,
        timestamp: trade.timestamp,
        side: trade.side,
        price: trade.price,
        quoteValue: trade.quoteValue,
        tag,
        relativeClass,
        tier,
        exchange,
        market: this.config.market,
      },
    });
  }

  private handleVenueTrade(trade: MarketTrade, exchange: ExchangeId): void {
    if (this.coins.some((c) => c.symbol === trade.symbol && c.venue === 'equity')) return;
    this.handleTrade(trade, exchange);
  }

  private setVenueUp(exchange: ExchangeId, connected: boolean): void {
    this.venueUp[exchange] = connected;
    const live = this.exchanges.filter((id) => this.venueUp[id]).map((id) => EXCHANGE_LABELS[id]);
    this.emit({
      type: 'status',
      connected: live.length > 0,
      message: live.length
        ? `Live · ${live.join(' · ')}`
        : `Disconnected (${EXCHANGE_LABELS[exchange]}) — reconnecting…`,
    });
  }

  private emitAllSummaries(now: number): void {
    const overview: CoinOverview[] = [];

    for (const coin of this.coins) {
      const engine = this.engine.getSymbol(coin.symbol, this.config.market);
      const full = {
        '10s': engine.snapshot('10s', now),
        '30s': engine.snapshot('30s', now),
        '1m': engine.snapshot('1m', now),
        '5m': engine.snapshot('5m', now),
        '15m': engine.snapshot('15m', now),
      };
      const windows = {
        '10s': stripPassive(full['10s']),
        '30s': stripPassive(full['30s']),
        '1m': stripPassive(full['1m']),
        '5m': stripPassive(full['5m']),
        '15m': stripPassive(full['15m']),
      };

      const passive = full['1m'].passiveLiquidity;
      if (passive.mid > 0) {
        this.emit({ type: 'passive_liquidity', symbol: coin.symbol, snapshot: passive });
      }

      const states = this.lastStates.get(coin.symbol) ?? {};
      for (const key of ['10s', '1m', '5m'] as const) {
        // Use the full window for alerts — WireWindowSnapshot omits passiveLiquidity.
        const w = full[key];
        const prev = states[key] ?? null;
        if (w.state !== prev && w.state !== 'NO_SIGNAL' && isVolatileWindow(w)) {
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
    const tagged = { ...event, market: this.config.market === 'spot' ? 'spot' : 'perp' };
    for (const l of this.listeners) l(tagged as LiveFeedEvent);
  }
}

export { DEFAULT_WATCHLIST };
export function defaultMinUsd(symbol: string): number {
  return minUsdFor(symbol);
}
