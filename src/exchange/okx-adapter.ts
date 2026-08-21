import { classifyTrade } from '../flow/trade-classifier.js';
import type { MarketTrade, MarketType } from '../models/trade.js';
import { canonicalFromVenue } from './venues.js';

export interface OkxPublicTrade {
  instId: string;
  tradeId: string;
  px: string;
  sz: string;
  side: string;
  ts: string;
}

export class OkxAdapter {
  constructor(
    readonly marketType: MarketType,
    private readonly contractValue = new Map<string, number>(),
  ) {}

  setContractValue(instId: string, ctVal: number): void {
    this.contractValue.set(instId, ctVal);
  }

  normalizeTrade(msg: OkxPublicTrade): MarketTrade {
    const side = msg.side.toLowerCase() === 'sell' ? 'SELL' : 'BUY';
    const ctVal = this.contractValue.get(msg.instId) ?? 1;
    return classifyTrade({
      symbol: canonicalFromVenue('okx', msg.instId),
      marketType: this.marketType,
      timestamp: Number(msg.ts),
      price: Number(msg.px),
      quantity: Number(msg.sz) * ctVal,
      aggressorSide: side,
      tradeId: msg.tradeId,
    });
  }
}
