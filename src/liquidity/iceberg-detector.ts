import type { IcebergConfig } from '../config/types.js';
import type { IcebergLikeFlag } from '../models/liquidity.js';
import type { MarketTrade } from '../models/trade.js';
import type { LocalOrderBook } from './local-order-book.js';

/**
 * Flags behavior consistent with hidden/replenishing liquidity.
 * Does not claim an iceberg order exists.
 */
export class IcebergLikeDetector {
  private aggressiveAtPrice = new Map<string, { quote: number; side: 'BUY' | 'SELL'; price: number }>();

  constructor(private readonly config: IcebergConfig) {}

  onTrade(trade: MarketTrade, book: LocalOrderBook): IcebergLikeFlag | null {
    const key = `${trade.side}:${trade.price}`;
    const prev = this.aggressiveAtPrice.get(key) ?? { quote: 0, side: trade.side, price: trade.price };
    prev.quote += trade.quoteValue;
    this.aggressiveAtPrice.set(key, prev);
    if (this.aggressiveAtPrice.size > 512) this.aggressiveAtPrice.clear();

    if (prev.quote < this.config.minAggressiveQuote) return null;

    if (trade.isAggressiveBuy) {
      const visible = book.levelQuote('ask', trade.price);
      if (visible > 0 && prev.quote >= visible * this.config.minAggressiveOverVisible) {
        return {
          type: 'ICEBERG_LIKE_SELL_ABSORPTION',
          price: trade.price,
          visibleQuote: visible,
          aggressiveQuote: prev.quote,
          note: 'possible hidden/replenishing liquidity',
        };
      }
    } else {
      const visible = book.levelQuote('bid', trade.price);
      if (visible > 0 && prev.quote >= visible * this.config.minAggressiveOverVisible) {
        return {
          type: 'ICEBERG_LIKE_BUY_ABSORPTION',
          price: trade.price,
          visibleQuote: visible,
          aggressiveQuote: prev.quote,
          note: 'possible hidden/replenishing liquidity',
        };
      }
    }
    return null;
  }
}
