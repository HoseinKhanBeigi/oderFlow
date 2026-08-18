import type { AggressorSide, MarketState, PriceImpactEfficiency, WindowId } from './trade.js';

export interface AbsorptionResult {
  detected: boolean;
  type: 'BUYER_ABSORPTION' | 'SELLER_ABSORPTION' | null;
  strength: number;
  confidence: number;
}

export interface LargeParticipantFlow {
  side: AggressorSide | 'NONE';
  largeParticipantFlowScore: number;
  confidence: number;
  interpretation: string;
}

export interface WindowSnapshot {
  symbol: string;
  marketType: 'spot' | 'perp' | 'stock' | 'combined';
  price: number;
  window: WindowId;

  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
  buyTradeCount: number;
  sellTradeCount: number;
  averageBuySize: number;
  averageSellSize: number;

  delta: number;
  deltaPercent: number;

  largeBuyVolume: number;
  largeSellVolume: number;
  largeBuyFlowShare: number;
  largeSellFlowShare: number;
  largestBuy: number;
  largestSell: number;

  buyBurstDetected: boolean;
  sellBurstDetected: boolean;
  persistentBuyFlow: boolean;
  persistentSellFlow: boolean;

  priceStart: number;
  priceEnd: number;
  absolutePriceChange: number;
  priceChangePercent: number;

  priceImpactEfficiency: PriceImpactEfficiency;
  flowMultipleBuy: number;
  flowMultipleSell: number;

  forcedBuyVolume: number;
  forcedSellVolume: number;

  buyPressure: number;
  sellPressure: number;
  askReplenishmentRate: number;
  bidReplenishmentRate: number;
  askConsumptionRate: number;
  bidConsumptionRate: number;

  largeBuyFlowAcceleration: import('./trade.js').AccelerationLabel;
  largeSellFlowAcceleration: import('./trade.js').AccelerationLabel;

  absorption: AbsorptionResult;

  largeFlowDirectionalScore: number;
  largeParticipantFlowScore: number;
  confidence: number;
  state: MarketState;
}

export interface MultiWindowSnapshot {
  symbol: string;
  marketType: 'spot' | 'perp' | 'stock' | 'combined';
  price: number;
  timestamp: number;
  windows: Partial<Record<WindowId, WindowSnapshot>>;
}

export interface SpotPerpSnapshot {
  symbol: string;
  timestamp: number;
  price: number;
  spot: WindowSnapshot | null;
  perp: WindowSnapshot | null;
  combined: WindowSnapshot | null;
}

export interface AlertEvent {
  type: string;
  symbol: string;
  window: WindowId;
  timestamp: number;
  message: string;
  payload: Record<string, number | string | boolean>;
}
