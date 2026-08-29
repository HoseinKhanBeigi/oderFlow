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
  { symbol: 'XRPUSDT', label: 'XRP', minUsd: 1_000, venue: 'crypto' },
  { symbol: 'DOGEUSDT', label: 'DOGE', minUsd: 1_000, venue: 'crypto' },
  { symbol: 'SHIBUSDT', label: 'SHIB', minUsd: 500, venue: 'crypto' },
  { symbol: 'SUIUSDT', label: 'SUI', minUsd: 1_000, venue: 'crypto' },
  { symbol: 'FARTCOINUSDT', label: 'FARTCOIN', minUsd: 500, venue: 'crypto' },
  { symbol: 'PAXGUSDT', label: 'PAXG', minUsd: 1_000, venue: 'crypto' },
];

/**
 * Binance USD-M TradFi perpetuals (equity + commodities; same futures WS as crypto).
 * Example: https://www.binance.com/en/futures/AMZNUSDT
 * SpaceX is not listed.
 */
export const EQUITY_PERP_WATCHLIST: WatchCoin[] = [
  { symbol: 'AAPLUSDT', label: 'AAPL', minUsd: 500, venue: 'equity' },
  { symbol: 'AMZNUSDT', label: 'AMZN', minUsd: 500, venue: 'equity' },
  { symbol: 'METAUSDT', label: 'META', minUsd: 500, venue: 'equity' },
  { symbol: 'MSFTUSDT', label: 'MSFT', minUsd: 500, venue: 'equity' },
  { symbol: 'GOOGLUSDT', label: 'GOOGL', minUsd: 500, venue: 'equity' },
  { symbol: 'TSLAUSDT', label: 'TSLA', minUsd: 500, venue: 'equity' },
  { symbol: 'AMDUSDT', label: 'AMD', minUsd: 500, venue: 'equity' },
  { symbol: 'NVDAUSDT', label: 'NVDA', minUsd: 500, venue: 'equity' },
  { symbol: 'CLUSDT', label: 'CL', minUsd: 500, venue: 'equity' },
  { symbol: 'XAGUSDT', label: 'XAG', minUsd: 500, venue: 'equity' },
];

/** @deprecated use EQUITY_PERP_WATCHLIST */
export const STOCK_WATCHLIST = EQUITY_PERP_WATCHLIST;

export function minUsdFor(
  symbol: string,
  list: WatchCoin[] = [...DEFAULT_WATCHLIST, ...EQUITY_PERP_WATCHLIST],
): number {
  return list.find((c) => c.symbol === symbol)?.minUsd ?? 1_000;
}
