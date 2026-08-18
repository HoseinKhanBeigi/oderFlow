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

export type AdapterMarket = MarketType;
