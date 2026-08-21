import type { MarketTrade, MarketType } from '../models/trade.js';
import { BitgetAdapter, parseBitgetTrade } from '../exchange/bitget-adapter.js';
import { BitstampAdapter, type BitstampTrade } from '../exchange/bitstamp-adapter.js';
import { BybitAdapter, type BybitPublicTrade } from '../exchange/bybit-adapter.js';
import { DydxAdapter, type DydxTrade } from '../exchange/dydx-adapter.js';
import { HyperliquidAdapter, type HyperliquidTrade } from '../exchange/hyperliquid-adapter.js';
import { OkxAdapter, type OkxPublicTrade } from '../exchange/okx-adapter.js';
import { fetchOkxContractValues, venueInstrument, type ExchangeId } from '../exchange/venues.js';
import type { WatchCoin } from './watchlist.js';
import { openReconnectingJsonSocket } from './json-socket.js';

export type VenueTradeHandler = (trade: MarketTrade, exchange: ExchangeId) => void;
export type VenueStatusHandler = (exchange: ExchangeId, connected: boolean) => void;

const BYBIT_WS = {
  spot: 'wss://stream.bybit.com/v5/public/spot',
  perp: 'wss://stream.bybit.com/v5/public/linear',
} as const;

const OKX_WS = 'wss://ws.okx.com:8443/ws/v5/public';
const BITGET_WS = 'wss://ws.bitget.com/v2/ws/public';
const HYPERLIQUID_WS = 'wss://api.hyperliquid.xyz/ws';
const DYDX_WS = 'wss://indexer.dydx.trade/v4/ws';
const BITSTAMP_WS = 'wss://ws.bitstamp.net';

export class VenueTradeFan {
  private readonly stops: Array<() => void> = [];
  private closed = false;
  private readonly bybit: BybitAdapter;
  private readonly okx: OkxAdapter;
  private readonly bitget: BitgetAdapter;
  private readonly hyperliquid: HyperliquidAdapter;
  private readonly dydx: DydxAdapter;
  private readonly bitstamp: BitstampAdapter;

  constructor(
    private readonly coins: WatchCoin[],
    private readonly market: MarketType,
    private readonly enabled: ExchangeId[],
    private readonly onTrade: VenueTradeHandler,
    private readonly onStatus: VenueStatusHandler,
  ) {
    const type = market === 'spot' ? 'spot' : 'perp';
    this.bybit = new BybitAdapter(type);
    this.okx = new OkxAdapter(type);
    this.bitget = new BitgetAdapter(type);
    this.hyperliquid = new HyperliquidAdapter(type);
    this.dydx = new DydxAdapter(type);
    this.bitstamp = new BitstampAdapter(type);
  }

  start(): void {
    this.closed = false;
    const crypto = this.coins.filter((c) => c.venue !== 'equity');
    if (!crypto.length) return;
    if (this.enabled.includes('bybit')) this.connectBybit(crypto);
    if (this.enabled.includes('okx')) this.connectOkx(crypto);
    if (this.enabled.includes('bitget')) this.connectBitget(crypto);
    if (this.enabled.includes('hyperliquid')) this.connectHyperliquid(crypto);
    if (this.enabled.includes('dydx')) this.connectDydx(crypto);
    if (this.enabled.includes('bitstamp')) this.connectBitstamp(crypto);
  }

  stop(): void {
    this.closed = true;
    while (this.stops.length) this.stops.pop()?.();
  }

  private isStopped = (): boolean => this.closed;

  private connectBybit(coins: WatchCoin[]): void {
    const args = coins.map((c) => `publicTrade.${c.symbol}`);
    const url = this.market === 'spot' ? BYBIT_WS.spot : BYBIT_WS.perp;
    this.stops.push(
      openReconnectingJsonSocket({
        url,
        label: 'bybit',
        pingMs: 20_000,
        ping: (ws) => ws.send(JSON.stringify({ op: 'ping' })),
        isStopped: this.isStopped,
        onConnection: (up) => this.onStatus('bybit', up),
        onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args })),
        onMessage: (msg) => {
          const payload = msg as { topic?: string; data?: BybitPublicTrade[] };
          if (!payload.topic?.startsWith('publicTrade.') || !Array.isArray(payload.data)) return;
          for (const row of payload.data) {
            if (!row?.p || !row?.v) continue;
            this.onTrade(this.bybit.normalizeTrade(row), 'bybit');
          }
        },
      }),
    );
  }

  private connectOkx(coins: WatchCoin[]): void {
    const args = coins
      .map((c) => venueInstrument('okx', c.symbol, this.market))
      .filter((inst): inst is string => Boolean(inst))
      .map((instId) => ({ channel: 'trades', instId }));

    void fetchOkxContractValues(this.market)
      .then((map) => {
        for (const [instId, ctVal] of map) this.okx.setContractValue(instId, ctVal);
      })
      .catch(() => undefined);

    this.stops.push(
      openReconnectingJsonSocket({
        url: OKX_WS,
        label: 'okx',
        pingMs: 20_000,
        ping: (ws) => ws.send('ping'),
        isStopped: this.isStopped,
        onConnection: (up) => this.onStatus('okx', up),
        onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args })),
        onMessage: (msg) => {
          const payload = msg as { arg?: { channel?: string }; data?: OkxPublicTrade[] };
          if (payload.arg?.channel !== 'trades' || !Array.isArray(payload.data)) return;
          for (const row of payload.data) {
            if (!row?.px || !row?.sz) continue;
            this.onTrade(this.okx.normalizeTrade(row), 'okx');
          }
        },
      }),
    );
  }

  private connectBitget(coins: WatchCoin[]): void {
    const instType = this.market === 'spot' ? 'SPOT' : 'USDT-FUTURES';
    const args = coins.map((c) => ({ instType, channel: 'trade', instId: c.symbol }));
    this.stops.push(
      openReconnectingJsonSocket({
        url: BITGET_WS,
        label: 'bitget',
        pingMs: 25_000,
        ping: (ws) => ws.send(JSON.stringify({ op: 'ping' })),
        isStopped: this.isStopped,
        onConnection: (up) => this.onStatus('bitget', up),
        onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args })),
        onMessage: (msg) => {
          const payload = msg as {
            action?: string;
            arg?: { channel?: string; instId?: string };
            data?: unknown[];
          };
          if (payload.arg?.channel !== 'trade' || !Array.isArray(payload.data)) return;
          const inst = payload.arg.instId ?? '';
          for (const row of payload.data) {
            const parsed = parseBitgetTrade(row, inst);
            if (!parsed) continue;
            this.onTrade(this.bitget.normalizeTrade(parsed, inst), 'bitget');
          }
        },
      }),
    );
  }

  private connectHyperliquid(coins: WatchCoin[]): void {
    const names = coins
      .map((c) => venueInstrument('hyperliquid', c.symbol, this.market))
      .filter((inst): inst is string => Boolean(inst));
    this.stops.push(
      openReconnectingJsonSocket({
        url: HYPERLIQUID_WS,
        label: 'hyperliquid',
        pingMs: 20_000,
        ping: (ws) => ws.send(JSON.stringify({ method: 'ping' })),
        isStopped: this.isStopped,
        onConnection: (up) => this.onStatus('hyperliquid', up),
        onOpen: (ws) => {
          for (const coin of names) {
            ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
          }
        },
        onMessage: (msg) => {
          const payload = msg as { channel?: string; data?: HyperliquidTrade[] };
          if (payload.channel !== 'trades' || !Array.isArray(payload.data)) return;
          for (const row of payload.data) {
            if (!row?.px || !row?.sz) continue;
            this.onTrade(this.hyperliquid.normalizeTrade(row), 'hyperliquid');
          }
        },
      }),
    );
  }

  private connectDydx(coins: WatchCoin[]): void {
    const markets = coins
      .map((c) => venueInstrument('dydx', c.symbol, this.market))
      .filter((inst): inst is string => Boolean(inst));
    this.stops.push(
      openReconnectingJsonSocket({
        url: DYDX_WS,
        label: 'dydx',
        isStopped: this.isStopped,
        onConnection: (up) => this.onStatus('dydx', up),
        onOpen: (ws) => {
          for (const id of markets) {
            ws.send(JSON.stringify({ type: 'subscribe', channel: 'v4_trades', id, batched: true }));
          }
        },
        onMessage: (msg) => {
          const payload = msg as { channel?: string; id?: string; contents?: unknown };
          if (payload.channel !== 'v4_trades') return;
          const market = payload.id ?? '';
          for (const row of dydxTradeRows(payload.contents)) {
            if (!row?.price || !row?.size) continue;
            this.onTrade(this.dydx.normalizeTrade(row, market), 'dydx');
          }
        },
      }),
    );
  }

  private connectBitstamp(coins: WatchCoin[]): void {
    const markets = coins
      .map((c) => venueInstrument('bitstamp', c.symbol, this.market))
      .filter((inst): inst is string => Boolean(inst));
    this.stops.push(
      openReconnectingJsonSocket({
        url: BITSTAMP_WS,
        label: 'bitstamp',
        isStopped: this.isStopped,
        onConnection: (up) => this.onStatus('bitstamp', up),
        onOpen: (ws) => {
          for (const market of markets) {
            ws.send(JSON.stringify({ event: 'bts:subscribe', data: { channel: `live_trades_${market}` } }));
          }
        },
        onMessage: (msg) => {
          const payload = msg as { event?: string; channel?: string; data?: BitstampTrade };
          if (payload.event !== 'trade' || !payload.data) return;
          const market = String(payload.channel ?? '').replace(/^live_trades_/, '');
          this.onTrade(this.bitstamp.normalizeTrade(payload.data, market), 'bitstamp');
        },
      }),
    );
  }
}

function dydxTradeRows(contents: unknown): DydxTrade[] {
  const out: DydxTrade[] = [];
  const take = (block: unknown): void => {
    if (!block || typeof block !== 'object') return;
    const trades = (block as { trades?: DydxTrade[] }).trades;
    if (Array.isArray(trades)) out.push(...trades);
  };
  if (Array.isArray(contents)) {
    for (const block of contents) take(block);
  } else {
    take(contents);
  }
  return out;
}
