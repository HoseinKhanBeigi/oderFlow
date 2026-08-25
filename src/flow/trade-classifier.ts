import type { AggressorSide, MarketTrade, MarketType } from '../models/trade.js';

export interface RawTradeInput {
  symbol: string;
  marketType?: MarketType;
  timestamp: number;
  price: number;
  quantity: number;
  /** True when the buyer is the maker (Binance `m`). Aggressor is then SELL. */
  isBuyerMaker?: boolean;
  /** Explicit aggressor side, if the venue provides it. */
  aggressorSide?: AggressorSide;
  /** Best bid, used only when the venue does not tag the aggressor. */
  bestBid?: number;
  /** Best ask, used only when the venue does not tag the aggressor. */
  bestAsk?: number;
  /** Age of the bid/ask used for inference, milliseconds. */
  bookAgeMs?: number;
  tradeId?: string | number;
  isForced?: boolean;
}

/**
 * Infer aggressor from bid/ask only when the print is clearly at/through the touch
 * and the book is fresh and tight. Inside-spread prints stay unknown.
 * Never inferred from candle direction.
 */
export function inferAggressorFromBook(
  price: number,
  bestBid?: number,
  bestAsk?: number,
  bookAgeMs?: number,
): AggressorSide | null {
  if (bestBid == null || bestAsk == null) return null;
  if (!(bestBid > 0 && bestAsk > 0 && bestAsk >= bestBid)) return null;
  if (bookAgeMs != null && bookAgeMs > 1_500) return null;
  const mid = (bestBid + bestAsk) / 2;
  if (mid <= 0) return null;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;
  if (spreadBps > 25) return null;
  if (price >= bestAsk) return 'BUY';
  if (price <= bestBid) return 'SELL';
  return null;
}

/**
 * Normalize a venue print into `MarketTrade`.
 * Aggression comes from maker/taker (or explicit aggressor), never from candle direction.
 */
export function classifyTrade(input: RawTradeInput): MarketTrade {
  const quoteValue = input.price * input.quantity;
  let side: AggressorSide;
  if (input.aggressorSide) {
    side = input.aggressorSide;
  } else if (input.isBuyerMaker !== undefined) {
    side = input.isBuyerMaker ? 'SELL' : 'BUY';
  } else {
    const inferred = inferAggressorFromBook(input.price, input.bestBid, input.bestAsk, input.bookAgeMs);
    if (!inferred) {
      throw new Error('Trade is missing maker/taker (isBuyerMaker) and aggressorSide');
    }
    side = inferred;
  }

  return {
    symbol: input.symbol,
    marketType: input.marketType ?? 'spot',
    timestamp: input.timestamp,
    price: input.price,
    quantity: input.quantity,
    quoteValue,
    side,
    isAggressiveBuy: side === 'BUY',
    isAggressiveSell: side === 'SELL',
    tradeId: input.tradeId,
    isForced: input.isForced,
  };
}

/** Same as `classifyTrade`, but returns null instead of throwing when the aggressor is unknown. */
export function tryClassifyTrade(input: RawTradeInput): MarketTrade | null {
  try {
    return classifyTrade(input);
  } catch {
    return null;
  }
}

export function assertAggressive(trade: MarketTrade): void {
  if (trade.isAggressiveBuy === trade.isAggressiveSell) {
    throw new Error('Trade must be exactly one of aggressive buy or aggressive sell');
  }
}
