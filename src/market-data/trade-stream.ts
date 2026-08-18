import type { MarketTrade } from '../models/trade.js';

export type TradeHandler = (trade: MarketTrade) => void;

export class TradeStream {
  private readonly handlers = new Set<TradeHandler>();
  private readonly seen = new Set<string>();

  on(handler: TradeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  push(trade: MarketTrade): void {
    if (trade.tradeId !== undefined) {
      const id = `${trade.marketType}:${trade.symbol}:${trade.tradeId}`;
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > 20_000) this.seen.clear();
    }
    for (const handler of this.handlers) handler(trade);
  }
}
