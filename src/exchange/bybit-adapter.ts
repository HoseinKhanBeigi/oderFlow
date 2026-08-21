import { classifyTrade } from '../flow/trade-classifier.js';
import type { MarketTrade, MarketType } from '../models/trade.js';
import { canonicalFromVenue } from './venues.js';

export interface BybitPublicTrade {
  T: number;
  s: string;
  S: string;
  v: string;
  p: string;
  i: string;
}

export class BybitAdapter {
  constructor(readonly marketType: MarketType) {}

  normalizeTrade(msg: BybitPublicTrade): MarketTrade {
    const side = msg.S.toLowerCase() === 'sell' ? 'SELL' : 'BUY';
    return classifyTrade({
      symbol: canonicalFromVenue('bybit', msg.s),
      marketType: this.marketType,
      timestamp: msg.T,
      price: Number(msg.p),
      quantity: Number(msg.v),
      aggressorSide: side,
      tradeId: msg.i,
    });
  }
}
