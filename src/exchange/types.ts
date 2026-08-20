import type { MarketType } from '../models/trade.js';

export interface BinanceAggTrade {
  e: 'aggTrade';
  E: number;
  s: string;
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

export interface BinanceTrade {
  e?: 'trade';
  E?: number;
  s: string;
  t: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

export interface BinanceBookTicker {
  s: string;
  b: string;
  B: string;
  a: string;
  A: string;
  E?: number;
}

export interface BinanceDepthSnapshot {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export interface BinanceDepthDelta {
  e: 'depthUpdate';
  E: number;
  s: string;
  U: number;
  u: number;
  pu?: number;
  b: [string, string][];
  a: [string, string][];
}

export interface BinanceForceOrder {
  e: 'forceOrder';
  E: number;
  o: {
    s: string;
    S: 'BUY' | 'SELL';
    o: string;
    q: string;
    p: string;
    ap: string;
    X: string;
    T: number;
  };
}

export interface BinanceMarkPrice {
  e: 'markPriceUpdate';
  E: number;
  s: string;
  p: string;
  i?: string;
}

export function streamName(symbol: string, channel: string): string {
  return `${symbol.toLowerCase()}@${channel}`;
}

export const BINANCE_SPOT_WS = 'wss://stream.binance.com:9443/stream';
export const BINANCE_FUTURES_WS = 'wss://fstream.binance.com/stream';
/** Single / combined raw path — required for TradFi equity perps (AMZNUSDT, AAPLUSDT, …). */
export const BINANCE_FUTURES_WS_RAW = 'wss://fstream.binance.com/ws';

/** Combined stream wraps `{ stream, data }`; `/ws/<stream>` sends `data` at the top level. */
export function unwrapBinancePayload(msg: Record<string, unknown>): Record<string, unknown> | null {
  const nested = msg.data;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  if (
    typeof msg.e === 'string' ||
    (typeof msg.s === 'string' && (msg.p != null || (msg.b != null && msg.a != null))) ||
    (Array.isArray(msg.bids) && Array.isArray(msg.asks))
  ) {
    return msg;
  }
  return null;
}

export type AdapterMarket = MarketType;
