import { describe, expect, it } from 'vitest';
import { LocalOrderBook } from '../src/liquidity/local-order-book.js';
import { book, bookLadder, T0 } from './helpers.js';

describe('LocalOrderBook snapshot guard', () => {
  it('refuses to replace a depth ladder with top-of-book (bookTicker-shaped) snapshot', () => {
    const ob = new LocalOrderBook();
    ob.applySnapshot(
      bookLadder({
        timestamp: T0,
        mid: 100,
        bids: [
          { price: 99.9, quote: 1_000_000 },
          { price: 99.8, quote: 1_000_000 },
          { price: 99.7, quote: 1_000_000 },
        ],
        asks: [
          { price: 100.1, quote: 1_000_000 },
          { price: 100.2, quote: 1_000_000 },
          { price: 100.3, quote: 1_000_000 },
        ],
      }),
    );
    expect(ob.sortedLevels('bid')).toHaveLength(3);
    expect(ob.sortedLevels('ask')).toHaveLength(3);

    ob.applySnapshot(book({ timestamp: T0 + 1, mid: 100.05 }));

    expect(ob.sortedLevels('bid')).toHaveLength(3);
    expect(ob.sortedLevels('ask')).toHaveLength(3);
    expect(ob.mid()).toBeCloseTo(100, 5);
  });

  it('still accepts thin snapshots when the book is empty or already thin', () => {
    const ob = new LocalOrderBook();
    ob.applySnapshot(book({ timestamp: T0, mid: 100, bidQuote: 2_000_000, askQuote: 3_000_000 }));
    expect(ob.sortedLevels('bid')).toHaveLength(1);
    expect(ob.bestBid()?.quoteValue).toBeCloseTo(2_000_000, 0);

    ob.applySnapshot(book({ timestamp: T0 + 1, mid: 101, bidQuote: 4_000_000, askQuote: 5_000_000 }));
    expect(ob.mid()).toBeCloseTo(101, 5);
    expect(ob.bestAsk()?.quoteValue).toBeCloseTo(5_000_000, 0);
  });
});
