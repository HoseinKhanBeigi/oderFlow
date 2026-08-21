import type { MarketTrade, OrderBookSnapshot } from '../src/models/trade.js';
import { OrderFlowEngine } from '../src/engine/order-flow-engine.js';
import type { EngineConfig } from '../src/config/types.js';
import { mergeConfig } from '../src/config/defaults.js';

export const T0 = 1_700_000_000_000;

export function trade(partial: {
  symbol?: string;
  marketType?: 'spot' | 'perp';
  timestamp: number;
  price: number;
  quantity?: number;
  quoteValue?: number;
  side: 'BUY' | 'SELL';
  tradeId?: string | number;
  isForced?: boolean;
}): MarketTrade {
  const price = partial.price;
  const quoteValue = partial.quoteValue ?? price * (partial.quantity ?? 0);
  const quantity = partial.quantity ?? (price === 0 ? 0 : quoteValue / price);
  return {
    symbol: partial.symbol ?? 'BTCUSDT',
    marketType: partial.marketType ?? 'perp',
    timestamp: partial.timestamp,
    price,
    quantity,
    quoteValue,
    side: partial.side,
    isAggressiveBuy: partial.side === 'BUY',
    isAggressiveSell: partial.side === 'SELL',
    tradeId: partial.tradeId,
    isForced: partial.isForced,
  };
}

export function book(opts: {
  symbol?: string;
  timestamp: number;
  mid?: number;
  bidQuote?: number;
  askQuote?: number;
  bidPrice?: number;
  askPrice?: number;
}): OrderBookSnapshot {
  const mid = opts.mid ?? 100;
  const bidPrice = opts.bidPrice ?? mid * 0.999;
  const askPrice = opts.askPrice ?? mid * 1.001;
  const bidQuote = opts.bidQuote ?? 5_000_000;
  const askQuote = opts.askQuote ?? 5_000_000;
  return {
    symbol: opts.symbol ?? 'BTCUSDT',
    marketType: 'perp',
    timestamp: opts.timestamp,
    lastUpdateId: 1,
    bids: [{ price: bidPrice, quantity: bidQuote / bidPrice, quoteValue: bidQuote }],
    asks: [{ price: askPrice, quantity: askQuote / askPrice, quoteValue: askQuote }],
  };
}

export function bookLadder(opts: {
  symbol?: string;
  timestamp: number;
  mid: number;
  asks: { price: number; quote: number }[];
  bids: { price: number; quote: number }[];
}): OrderBookSnapshot {
  return {
    symbol: opts.symbol ?? 'BTCUSDT',
    marketType: 'perp',
    timestamp: opts.timestamp,
    lastUpdateId: 1,
    bids: opts.bids.map((l) => ({
      price: l.price,
      quantity: l.quote / l.price,
      quoteValue: l.quote,
    })),
    asks: opts.asks.map((l) => ({
      price: l.price,
      quantity: l.quote / l.price,
      quoteValue: l.quote,
    })),
  };
}

export function engine(overrides: Parameters<typeof mergeConfig>[0] = {}): OrderFlowEngine {
  return new OrderFlowEngine(overrides);
}

export function testConfig(overrides: Parameters<typeof mergeConfig>[0] = {}): EngineConfig {
  return mergeConfig(overrides);
}
