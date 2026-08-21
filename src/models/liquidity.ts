export type BpsBand = 0.05 | 0.1 | 0.25 | 0.5 | 1.0;

export const DEFAULT_BPS_BANDS: BpsBand[] = [0.05, 0.1, 0.25, 0.5, 1.0];

export interface NearbyLiquidity {
  bid: Record<string, number>;
  ask: Record<string, number>;
}

export interface LiquidityPressure {
  buyPressure: number;
  sellPressure: number;
}

export interface ConsumptionSnapshot {
  askConsumptionRate: number;
  bidConsumptionRate: number;
  askReplenishmentRate: number;
  bidReplenishmentRate: number;
}

export type FlowLiquidityRegime =
  | 'LARGE_BUY_FLOW_THIN_ASKS'
  | 'LARGE_BUY_FLOW_HEAVY_ASK_REPLENISHMENT'
  | 'LARGE_SELL_FLOW_THIN_BIDS'
  | 'LARGE_SELL_FLOW_HEAVY_BID_REPLENISHMENT'
  | 'BALANCED';

export interface IcebergLikeFlag {
  type: 'ICEBERG_LIKE_SELL_ABSORPTION' | 'ICEBERG_LIKE_BUY_ABSORPTION';
  price: number;
  visibleQuote: number;
  aggressiveQuote: number;
  note: 'possible hidden/replenishing liquidity';
}

export type LiquidityWallKind = 'ASK_LIQUIDITY_WALL' | 'BID_LIQUIDITY_WALL';
export type LiquidityWallStatus = 'ACTIVE' | 'CONSUMED' | 'PULLED';

export interface LiquidityWall {
  kind: LiquidityWallKind;
  price: number;
  quoteValue: number;
  vsNearbyMedian: number;
  percentile: number;
  status: LiquidityWallStatus;
}

export interface LiquidityVacuum {
  kind: 'UPSIDE_LIQUIDITY_VACUUM' | 'DOWNSIDE_LIQUIDITY_VACUUM';
  fromPrice: number;
  toPrice: number;
  segmentLiquidity: number;
  relativeDensity: number;
}

export type MovePotentialEventType =
  | 'ASK_WALL_DETECTED'
  | 'BID_WALL_DETECTED'
  | 'ASK_WALL_CONSUMED'
  | 'BID_WALL_CONSUMED'
  | 'ASK_LIQUIDITY_PULLED'
  | 'BID_LIQUIDITY_PULLED'
  | 'UPSIDE_LIQUIDITY_VACUUM'
  | 'DOWNSIDE_LIQUIDITY_VACUUM';

export interface LiquidityDynamicsSnapshot {
  askConsumptionRate: number;
  bidConsumptionRate: number;
  askReplenishmentRate: number;
  bidReplenishmentRate: number;
  askPullRate: number;
  bidPullRate: number;
  askConsumptionNorm: number;
  bidConsumptionNorm: number;
  askReplenishmentNorm: number;
  bidReplenishmentNorm: number;
  askPullNorm: number;
  bidPullNorm: number;
}
