import { classifyTrade } from '../flow/trade-classifier.js';
import type {
  BookLevel,
  LiquidationEvent,
  MarketTrade,
  OrderBookDelta,
  OrderBookSnapshot,
} from '../models/trade.js';
import type {
  BinanceAggTrade,
  BinanceBookTicker,
  BinanceDepthDelta,
  BinanceDepthSnapshot,
  BinanceForceOrder,
  BinanceMarkPrice,
  BinanceTrade,
} from './types.js';

function levels(rows: [string, string][]): BookLevel[] {
  return rows.map(([p, q]) => {
    const price = Number(p);
    const quantity = Number(q);
    return { price, quantity, quoteValue: price * quantity };
  });
}

export class BinanceSpotAdapter {
  readonly marketType = 'spot' as const;

  normalizeAggTrade(msg: BinanceAggTrade): MarketTrade {
    return classifyTrade({
      symbol: msg.s,
      marketType: 'spot',
      timestamp: msg.T,
      price: Number(msg.p),
      quantity: Number(msg.q),
      isBuyerMaker: msg.m,
      tradeId: msg.a,
    });
  }

  normalizeTrade(msg: BinanceTrade): MarketTrade {
    return classifyTrade({
      symbol: msg.s,
      marketType: 'spot',
      timestamp: msg.T,
      price: Number(msg.p),
      quantity: Number(msg.q),
      isBuyerMaker: msg.m,
      tradeId: msg.t,
    });
  }

  normalizeDepthSnapshot(symbol: string, snapshot: BinanceDepthSnapshot, timestamp: number): OrderBookSnapshot {
    return {
      symbol,
      marketType: 'spot',
      timestamp,
      lastUpdateId: snapshot.lastUpdateId,
      bids: levels(snapshot.bids),
      asks: levels(snapshot.asks),
    };
  }

  normalizeDepthDelta(msg: BinanceDepthDelta): OrderBookDelta {
    return {
      symbol: msg.s,
      marketType: 'spot',
      timestamp: msg.E,
      firstUpdateId: msg.U,
      finalUpdateId: msg.u,
      bids: levels(msg.b),
      asks: levels(msg.a),
    };
  }

  normalizeBookTicker(msg: BinanceBookTicker): OrderBookSnapshot {
    return {
      symbol: msg.s,
      marketType: 'spot',
      timestamp: msg.E ?? Date.now(),
      bids: levels([[msg.b, msg.B]]),
      asks: levels([[msg.a, msg.A]]),
    };
  }
}

export class BinanceFuturesAdapter {
  readonly marketType = 'perp' as const;

  normalizeAggTrade(msg: BinanceAggTrade): MarketTrade {
    return classifyTrade({
      symbol: msg.s,
      marketType: 'perp',
      timestamp: msg.T,
      price: Number(msg.p),
      quantity: Number(msg.q),
      isBuyerMaker: msg.m,
      tradeId: msg.a,
    });
  }

  normalizeTrade(msg: BinanceTrade): MarketTrade {
    return classifyTrade({
      symbol: msg.s,
      marketType: 'perp',
      timestamp: msg.T,
      price: Number(msg.p),
      quantity: Number(msg.q),
      isBuyerMaker: msg.m,
      tradeId: msg.t,
    });
  }

  normalizeDepthSnapshot(symbol: string, snapshot: BinanceDepthSnapshot, timestamp: number): OrderBookSnapshot {
    return {
      symbol,
      marketType: 'perp',
      timestamp,
      lastUpdateId: snapshot.lastUpdateId,
      bids: levels(snapshot.bids),
      asks: levels(snapshot.asks),
    };
  }

  normalizeDepthDelta(msg: BinanceDepthDelta): OrderBookDelta {
    return {
      symbol: msg.s,
      marketType: 'perp',
      timestamp: msg.E,
      firstUpdateId: msg.U,
      finalUpdateId: msg.u,
      prevUpdateId: msg.pu,
      bids: levels(msg.b),
      asks: levels(msg.a),
    };
  }

  normalizeBookTicker(msg: BinanceBookTicker): OrderBookSnapshot {
    return {
      symbol: msg.s,
      marketType: 'perp',
      timestamp: msg.E ?? Date.now(),
      bids: levels([[msg.b, msg.B]]),
      asks: levels([[msg.a, msg.A]]),
    };
  }

  normalizeForceOrder(msg: BinanceForceOrder): LiquidationEvent {
    const side = msg.o.S;
    const price = Number(msg.o.ap || msg.o.p);
    const quantity = Number(msg.o.q);
    return {
      symbol: msg.o.s,
      marketType: 'perp',
      timestamp: msg.o.T,
      price,
      quantity,
      quoteValue: price * quantity,
      side,
      type: side === 'BUY' ? 'SHORT_LIQUIDATION' : 'LONG_LIQUIDATION',
    };
  }

  normalizeMarkPrice(msg: BinanceMarkPrice): { symbol: string; timestamp: number; markPrice: number } {
    return { symbol: msg.s, timestamp: msg.E, markPrice: Number(msg.p) };
  }
}
