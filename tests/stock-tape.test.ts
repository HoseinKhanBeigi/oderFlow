import { describe, expect, it } from 'vitest';
import { polygonTimestampMs, parsePolygonTrade } from '../src/exchange/polygon-stocks.js';
import { StockTickClassifier } from '../src/exchange/stock-adapter.js';
import { FootprintAggregator } from '../src/footprint/aggregator.js';
import { STOCK_WATCHLIST } from '../src/live/watchlist.js';

describe('stock tick classifier', () => {
  it('treats an uptick as aggressive buy and a downtick as sell', () => {
    const c = new StockTickClassifier();
    const first = c.classify({ symbol: 'AAPL', timestamp: 1, price: 100, quantity: 10 });
    expect(first.marketType).toBe('stock');
    expect(first.quoteValue).toBe(1000);

    const up = c.classify({ symbol: 'AAPL', timestamp: 2, price: 100.05, quantity: 5 });
    expect(up.side).toBe('BUY');
    const down = c.classify({ symbol: 'AAPL', timestamp: 3, price: 99.9, quantity: 5 });
    expect(down.side).toBe('SELL');
    const unchanged = c.classify({ symbol: 'AAPL', timestamp: 4, price: 99.9, quantity: 1 });
    expect(unchanged.side).toBe('SELL');
  });
});

describe('polygon trade timestamps', () => {
  it('normalizes nanosecond SIP timestamps to ms', () => {
    expect(polygonTimestampMs(1_700_000_000_000_000_000)).toBe(1_700_000_000_000);
    expect(polygonTimestampMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('drops incomplete prints', () => {
    expect(parsePolygonTrade('NVDA', { price: 180, size: 0, sip_timestamp: 1_700_000_000_000 })).toBeNull();
    expect(parsePolygonTrade('NVDA', { price: 180, size: 10, sip_timestamp: 1_700_000_000_000 })?.quantity).toBe(10);
  });
});

describe('stock footprint aggregator', () => {
  it('buckets NVDA at a penny and tags market=stock', () => {
    const agg = new FootprintAggregator({ market: 'perp' });
    const c = new StockTickClassifier();
    agg.ingest(
      c.classify({ symbol: 'NVDA', timestamp: 1_700_000_000_000, price: 180.12, quantity: 20 }),
      'sip',
    );
    const bar = agg.currentBar('NVDA', 'sip');
    expect(bar?.market).toBe('stock');
    expect(bar?.levels).toHaveLength(1);
    expect(bar?.levels[0]?.price).toBe(180.12);
    expect(bar?.totalBuy + bar!.totalSell).toBeCloseTo(3602.4, 4);
  });
});

describe('stock watchlist', () => {
  it('uses cash tickers, not Binance USDT perps', () => {
    expect(STOCK_WATCHLIST.map((c) => c.symbol)).toContain('AAPL');
    expect(STOCK_WATCHLIST.some((c) => c.symbol.endsWith('USDT'))).toBe(false);
  });
});
