import { classifyTrade } from '../flow/trade-classifier.js';
import type { MarketTrade, MarketType } from '../models/trade.js';
import { canonicalFromVenue } from './venues.js';

export interface BitstampTrade {
  id: number | string;
  amount: string | number;
  price: string | number;
  type: number | string;
  timestamp?: string | number;
  microtimestamp?: string | number;
}

export class BitstampAdapter {
  constructor(readonly marketType: MarketType) {}

  normalizeTrade(msg: BitstampTrade, market: string): MarketTrade {
    const ts =
      msg.microtimestamp != null
        ? Math.floor(Number(msg.microtimestamp) / 1000)
        : Number(msg.timestamp) * (String(msg.timestamp).length <= 10 ? 1000 : 1);
    const side = Number(msg.type) === 1 ? 'SELL' : 'BUY';
    return classifyTrade({
      symbol: canonicalFromVenue('bitstamp', market),
      marketType: this.marketType,
      timestamp: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
      price: Number(msg.price),
      quantity: Number(msg.amount),
      aggressorSide: side,
      tradeId: msg.id,
    });
  }
}
