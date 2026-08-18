import WebSocket from 'ws';
import { OrderFlowEngine } from '../engine/order-flow-engine.js';
import { BinanceFuturesAdapter, BinanceSpotAdapter } from '../exchange/binance-adapters.js';
import { BINANCE_FUTURES_WS, BINANCE_SPOT_WS, streamName } from '../exchange/types.js';
import type { BinanceAggTrade, BinanceDepthDelta, BinanceForceOrder } from '../exchange/types.js';

export interface StreamOptions {
  symbols: string[];
  marketType: 'spot' | 'perp';
  channels?: Array<'aggTrade' | 'depth@100ms' | 'forceOrder'>;
  url?: string;
}

interface CombinedEvent {
  stream: string;
  data: Record<string, unknown>;
}

/**
 * Thin WS client. Adapters normalize; the engine analyzes.
 * Reconnects with backoff and marks integrity on disconnect.
 */
export class BinanceMarketDataClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private readonly spot = new BinanceSpotAdapter();
  private readonly futures = new BinanceFuturesAdapter();

  constructor(
    private readonly engine: OrderFlowEngine,
    private readonly options: StreamOptions,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const channels = this.options.channels ?? ['aggTrade', 'depth@100ms'];
    const streams = this.options.symbols.flatMap((s) =>
      channels.map((c) => streamName(s, c === 'forceOrder' ? 'forceOrder' : c)),
    );
    const base = this.options.url ?? (this.options.marketType === 'spot' ? BINANCE_SPOT_WS : BINANCE_FUTURES_WS);
    const url = `${base}?streams=${streams.join('/')}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
    });

    ws.on('message', (raw) => {
      let parsed: CombinedEvent;
      try {
        parsed = JSON.parse(String(raw)) as CombinedEvent;
      } catch {
        return;
      }
      this.dispatch(parsed);
    });

    ws.on('close', () => {
      const now = Date.now();
      for (const symbol of this.options.symbols) {
        this.engine.noteReconnect(symbol, this.options.marketType, now);
      }
      if (!this.closed) this.reconnect();
    });

    ws.on('error', () => {
      ws.close();
    });
  }

  private reconnect(): void {
    this.attempt += 1;
    const delay = Math.min(30_000, 500 * 2 ** this.attempt);
    setTimeout(() => {
      if (!this.closed) this.connect();
    }, delay);
  }

  private dispatch(msg: CombinedEvent): void {
    const data = msg.data;
    if (!data || typeof data !== 'object') return;
    const event = data.e;
    const futures = this.options.marketType === 'perp';

    if (event === 'aggTrade') {
      const trade = futures
        ? this.futures.normalizeAggTrade(data as unknown as BinanceAggTrade)
        : this.spot.normalizeAggTrade(data as unknown as BinanceAggTrade);
      this.engine.ingestTrade(trade);
      return;
    }

    if (event === 'depthUpdate') {
      const delta = futures
        ? this.futures.normalizeDepthDelta(data as unknown as BinanceDepthDelta)
        : this.spot.normalizeDepthDelta(data as unknown as BinanceDepthDelta);
      this.engine.ingestBookDelta(delta);
      return;
    }

    if (event === 'forceOrder' && futures) {
      this.engine.ingestLiquidation(this.futures.normalizeForceOrder(data as unknown as BinanceForceOrder));
    }
  }
}
