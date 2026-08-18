import { classifyTrade } from '../flow/trade-classifier.js';
import type { AggressorSide, MarketTrade, OrderBookSnapshot } from '../models/trade.js';

export interface StockPrint {
  symbol: string;
  timestamp: number;
  price: number;
  quantity: number;
  tradeId?: string | number;
}

/**
 * US stock prints usually have no maker/taker flag.
 * Tick rule: uptick → aggressive BUY, downtick → aggressive SELL.
 * This is an estimate, not exchange-true aggression like Binance `m`.
 */
export class StockTickClassifier {
  private readonly lastPrice = new Map<string, number>();
  private readonly lastSide = new Map<string, AggressorSide>();

  classify(print: StockPrint): MarketTrade {
    const prev = this.lastPrice.get(print.symbol);
    let side: AggressorSide = this.lastSide.get(print.symbol) ?? 'BUY';
    if (prev !== undefined) {
      if (print.price > prev) side = 'BUY';
      else if (print.price < prev) side = 'SELL';
    }
    this.lastPrice.set(print.symbol, print.price);
    this.lastSide.set(print.symbol, side);

    return classifyTrade({
      symbol: print.symbol,
      marketType: 'stock',
      timestamp: print.timestamp,
      price: print.price,
      quantity: print.quantity,
      aggressorSide: side,
      tradeId: print.tradeId,
    });
  }
}

export function syntheticStockBook(symbol: string, price: number, timestamp: number): OrderBookSnapshot {
  const bid = price * 0.9995;
  const ask = price * 1.0005;
  const depth = 50_000;
  return {
    symbol,
    marketType: 'stock',
    timestamp,
    bids: [{ price: bid, quantity: depth / bid, quoteValue: depth }],
    asks: [{ price: ask, quantity: depth / ask, quoteValue: depth }],
  };
}
