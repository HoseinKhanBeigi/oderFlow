export interface WatchCoin {
  symbol: string;
  label: string;
  minUsd: number;
}

/**
 * Default dashboard coins. Alts use a lower tape floor so $1K–$5K prints still show.
 */
export const DEFAULT_WATCHLIST: WatchCoin[] = [
  { symbol: 'BTCUSDT', label: 'BTC', minUsd: 10_000 },
  { symbol: 'ETHUSDT', label: 'ETH', minUsd: 5_000 },
  { symbol: 'AVAXUSDT', label: 'AVAX', minUsd: 1_000 },
  { symbol: 'NEARUSDT', label: 'NEAR', minUsd: 1_000 },
  { symbol: 'DOTUSDT', label: 'DOT', minUsd: 1_000 },
  { symbol: 'SOLUSDT', label: 'SOL', minUsd: 3_000 },
  { symbol: 'LINKUSDT', label: 'LINK', minUsd: 1_000 },
  { symbol: 'SUIUSDT', label: 'SUI', minUsd: 1_000 },
];

export function minUsdFor(symbol: string, list = DEFAULT_WATCHLIST): number {
  return list.find((c) => c.symbol === symbol)?.minUsd ?? 1_000;
}
