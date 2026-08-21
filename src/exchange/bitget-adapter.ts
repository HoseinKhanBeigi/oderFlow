import { classifyTrade } from '../flow/trade-classifier.js';
import type { MarketTrade, MarketType } from '../models/trade.js';
import { canonicalFromVenue } from './venues.js';

export interface BitgetPublicTrade {
  ts: string;
  price: string;
  size: string;
  side: string;
  tradeId: string;
}

export class BitgetAdapter {
  constructor(readonly marketType: MarketType) {}

  normalizeTrade(msg: BitgetPublicTrade, instrument: string): MarketTrade {
    const side = msg.side.toLowerCase() === 'sell' ? 'SELL' : 'BUY';
    return classifyTrade({
      symbol: canonicalFromVenue('bitget', instrument),
      marketType: this.marketType,
      timestamp: Number(msg.ts),
      price: Number(msg.price),
      quantity: Number(msg.size),
      aggressorSide: side,
      tradeId: msg.tradeId,
    });
  }
}

export function parseBitgetTrade(row: unknown, _instrument?: string): BitgetPublicTrade | null {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const o = row as Record<string, unknown>;
    const price = String(o.price ?? o.p ?? '');
    const size = String(o.size ?? o.sz ?? '');
    const side = String(o.side ?? '');
    const ts = String(o.ts ?? o.T ?? '');
    if (!price || !size || !side) return null;
    return { ts, price, size, side, tradeId: String(o.tradeId ?? o.tid ?? ts) };
  }
  if (Array.isArray(row) && row.length >= 4) {
    const asStr = row.map((x) => String(x));
    const live = asStr[0] === 'live' || asStr[0] === 'snapshot';
    const parsed = live
      ? {
          ts: asStr[2] ?? '',
          price: asStr[3] ?? '',
          size: asStr[4] ?? '',
          side: asStr[5] ?? '',
          tradeId: asStr[2] ?? '',
        }
      : {
          ts: asStr[0] ?? '',
          price: asStr[1] ?? '',
          size: asStr[2] ?? '',
          side: asStr[3] ?? '',
          tradeId: asStr[4] ?? asStr[0] ?? '',
        };
    if (!parsed.price || !parsed.size || !parsed.side) return null;
    return parsed;
  }
  return null;
}
