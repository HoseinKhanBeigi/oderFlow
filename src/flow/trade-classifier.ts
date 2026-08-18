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
  tradeId?: string | number;
  isForced?: boolean;
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
    throw new Error('Trade is missing maker/taker (isBuyerMaker) and aggressorSide');
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

export function assertAggressive(trade: MarketTrade): void {
  if (trade.isAggressiveBuy === trade.isAggressiveSell) {
    throw new Error('Trade must be exactly one of aggressive buy or aggressive sell');
  }
}
