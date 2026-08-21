import { classifyTrade } from '../flow/trade-classifier.js';
import type { MarketTrade, MarketType } from '../models/trade.js';
import { canonicalFromVenue } from './venues.js';

export interface DydxTrade {
  id: string;
  side: string;
  size: string;
  price: string;
  createdAt: string;
  type?: string;
}

export class DydxAdapter {
  constructor(readonly marketType: MarketType) {}

  normalizeTrade(msg: DydxTrade, market = ''): MarketTrade {
    const side = msg.side.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    return classifyTrade({
      symbol: canonicalFromVenue('dydx', market),
      marketType: this.marketType,
      timestamp: Date.parse(msg.createdAt) || Date.now(),
      price: Number(msg.price),
      quantity: Number(msg.size),
      aggressorSide: side,
      tradeId: msg.id,
      isForced: msg.type === 'LIQUIDATION' || msg.type === 'LIQUIDATED',
    });
  }
}
