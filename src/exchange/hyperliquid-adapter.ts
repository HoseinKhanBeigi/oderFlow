import { classifyTrade } from '../flow/trade-classifier.js';
import type { MarketTrade, MarketType } from '../models/trade.js';
import { canonicalFromVenue } from './venues.js';

export interface HyperliquidTrade {
  coin: string;
  side: string;
  px: string;
  sz: string;
  time: number;
  tid?: number;
  hash?: string;
}

export class HyperliquidAdapter {
  constructor(readonly marketType: MarketType) {}

  normalizeTrade(msg: HyperliquidTrade): MarketTrade {
    const side = msg.side.toUpperCase() === 'A' ? 'SELL' : 'BUY';
    return classifyTrade({
      symbol: canonicalFromVenue('hyperliquid', msg.coin),
      marketType: this.marketType,
      timestamp: msg.time,
      price: Number(msg.px),
      quantity: Number(msg.sz),
      aggressorSide: side,
      tradeId: msg.tid ?? msg.hash,
    });
  }
}
