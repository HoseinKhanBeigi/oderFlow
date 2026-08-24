export type AssetVenue = 'crypto' | 'equity';

export interface WatchCoin {
  symbol: string;
  label: string;
  minUsd: number;
  venue: AssetVenue;
}

export const DEFAULT_WATCHLIST: WatchCoin[] = [
  { symbol: 'BTCUSDT', label: 'BTC', minUsd: 10_000, venue: 'crypto' },
  { symbol: 'ETHUSDT', label: 'ETH', minUsd: 5_000, venue: 'crypto' },
  { symbol: 'AVAXUSDT', label: 'AVAX', minUsd: 1_000, venue: 'crypto' },
  { symbol: 'NEARUSDT', label: 'NEAR', minUsd: 1_000, venue: 'crypto' },
  { symbol: 'DOTUSDT', label: 'DOT', minUsd: 1_000, venue: 'crypto' },
  { symbol: 'SOLUSDT', label: 'SOL', minUsd: 3_000, venue: 'crypto' },
  { symbol: 'LINKUSDT', label: 'LINK', minUsd: 1_000, venue: 'crypto' },
  { symbol: 'SUIUSDT', label: 'SUI', minUsd: 1_000, venue: 'crypto' },
  { symbol: 'FARTCOINUSDT', label: 'FARTCOIN', minUsd: 500, venue: 'crypto' },
];

/**
 * Real US equities on the consolidated last-sale tape (Finnhub / Polygon).
 * These are not Binance USDT equity perps.
 */
export const STOCK_WATCHLIST: WatchCoin[] = [
  { symbol: 'AAPL', label: 'AAPL', minUsd: 5_000, venue: 'equity' },
  { symbol: 'AMZN', label: 'AMZN', minUsd: 5_000, venue: 'equity' },
  { symbol: 'META', label: 'META', minUsd: 5_000, venue: 'equity' },
  { symbol: 'MSFT', label: 'MSFT', minUsd: 5_000, venue: 'equity' },
  { symbol: 'GOOGL', label: 'GOOGL', minUsd: 5_000, venue: 'equity' },
  { symbol: 'TSLA', label: 'TSLA', minUsd: 5_000, venue: 'equity' },
  { symbol: 'AMD', label: 'AMD', minUsd: 5_000, venue: 'equity' },
  { symbol: 'NVDA', label: 'NVDA', minUsd: 5_000, venue: 'equity' },
];

/** @deprecated use STOCK_WATCHLIST — these are cash equities, not Binance perps. */
export const EQUITY_PERP_WATCHLIST = STOCK_WATCHLIST;

export function minUsdFor(
  symbol: string,
  list: WatchCoin[] = [...DEFAULT_WATCHLIST, ...STOCK_WATCHLIST],
): number {
  return list.find((c) => c.symbol === symbol)?.minUsd ?? 1_000;
}
