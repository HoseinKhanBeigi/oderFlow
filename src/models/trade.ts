export type AggressorSide = 'BUY' | 'SELL';

export type MarketType = 'spot' | 'perp' | 'stock';

export type RelativeSizeClass = 'NORMAL' | 'LARGE' | 'VERY_LARGE' | 'EXTREME';

export type PriceImpactEfficiency = 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';

export type AccelerationLabel =
  | 'NONE'
  | 'DECELERATING'
  | 'WEAK'
  | 'MODERATE'
  | 'STRONG';

export type MarketState =
  | 'NO_SIGNAL'
  | 'LARGE_BUY_FLOW'
  | 'LARGE_SELL_FLOW'
  | 'PERSISTENT_BUY_FLOW'
  | 'PERSISTENT_SELL_FLOW'
  | 'BUY_BURST'
  | 'SELL_BURST'
  | 'BUYER_ABSORPTION'
  | 'SELLER_ABSORPTION'
  | 'LIQUIDITY_VACUUM_UP'
  | 'LIQUIDITY_VACUUM_DOWN'
  | 'FLOW_EXHAUSTION_BUY'
  | 'FLOW_EXHAUSTION_SELL';

export type WindowId = '1s' | '5s' | '10s' | '30s' | '1m' | '5m' | '15m';

export const WINDOW_MS: Record<WindowId, number> = {
  '1s': 1_000,
  '5s': 5_000,
  '10s': 10_000,
  '30s': 30_000,
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
};

export interface MarketTrade {
  symbol: string;
  marketType: MarketType;
  timestamp: number;
  price: number;
  quantity: number;
  quoteValue: number;
  side: AggressorSide;
  isAggressiveBuy: boolean;
  isAggressiveSell: boolean;
  tradeId?: string | number;
  isForced?: boolean;
}

export interface LiquidationEvent {
  symbol: string;
  marketType: MarketType;
  timestamp: number;
  price: number;
  quantity: number;
  quoteValue: number;
  /** SHORT liquidation → forced BUY; LONG liquidation → forced SELL */
  type: 'LONG_LIQUIDATION' | 'SHORT_LIQUIDATION';
  side: AggressorSide;
}

export interface BookLevel {
  price: number;
  quantity: number;
  quoteValue: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  marketType: MarketType;
  timestamp: number;
  bids: BookLevel[];
  asks: BookLevel[];
  lastUpdateId?: number;
}

export interface OrderBookDelta {
  symbol: string;
  marketType: MarketType;
  timestamp: number;
  bids: BookLevel[];
  asks: BookLevel[];
  firstUpdateId?: number;
  finalUpdateId?: number;
  prevUpdateId?: number;
}
