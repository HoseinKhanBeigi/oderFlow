import type { PriceImpactEfficiency } from './trade.js';
import type {
  LiquidityDynamicsSnapshot,
  LiquidityVacuum,
  LiquidityWall,
  MovePotentialEventType,
} from './liquidity.js';

export type MoveDirection = 'UP' | 'DOWN' | 'NEUTRAL';
export type PathOfLeastResistance = 'UP' | 'DOWN' | 'BALANCED';
export type LiquidityDensityClass = 'THIN' | 'NORMAL' | 'THICK' | 'EXTREMELY_THICK';
export type TargetDifficulty = 'VERY_EASY' | 'EASY' | 'MODERATE' | 'DIFFICULT' | 'VERY_DIFFICULT';
export type PressureLabel = 'VERY_WEAK' | 'MODERATE' | 'STRONG' | 'VERY_STRONG';
export type VelocityLabel = 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';
export type AccelerationTrend = 'DECREASING' | 'STABLE' | 'INCREASING';

export interface DirectionAnalysis {
  direction: MoveDirection;
  /** 0–100 strength of the bias; 50 is balanced. */
  score: number;
  confidence: number;
}

export interface MovePotentialAnalysis {
  upsidePotential: number;
  downsidePotential: number;
}

export interface LiquidityTarget {
  price: number;
  distancePercent: number;
  cumulativeLiquidity: number;
  liquidityDensity: number;
  relativeLiquidity: number;
  difficultyScore: number;
  densityClass: LiquidityDensityClass;
  reachabilityScore: number;
  difficulty: TargetDifficulty;
}

export type UnscoredLiquidityTarget = Omit<LiquidityTarget, 'reachabilityScore' | 'difficulty'>;

export interface LiquidityDistanceMap {
  currentPrice: number;
  atr: number;
  upside: UnscoredLiquidityTarget[];
  downside: UnscoredLiquidityTarget[];
}

export interface FlowLiquidityRatios {
  buyPressureRatio: number;
  sellPressureRatio: number;
  buyPressurePercentile: number;
  sellPressurePercentile: number;
  buyLabel: PressureLabel;
  sellLabel: PressureLabel;
  netFlow: number;
  netFlowVsMedian: number;
}

export interface MovePotentialSnapshot {
  symbol: string;
  currentPrice: number;
  atr: number;
  dataQualityScore: number;

  direction: DirectionAnalysis;
  movePotential: MovePotentialAnalysis;
  pathOfLeastResistance: PathOfLeastResistance;

  flow: FlowLiquidityRatios;
  liquidity: {
    nearbyAskLiquidity: number;
    nearbyBidLiquidity: number;
    nearbyAskDensityClass: LiquidityDensityClass;
    nearbyBidDensityClass: LiquidityDensityClass;
    askConsumptionRate: number;
    bidConsumptionRate: number;
    askReplenishmentRate: number;
    bidReplenishmentRate: number;
    askPullRate: number;
    bidPullRate: number;
    walls: LiquidityWall[];
    vacuums: LiquidityVacuum[];
    events: MovePotentialEventType[];
  };

  targets: {
    upside: LiquidityTarget[];
    downside: LiquidityTarget[];
  };

  priceImpactEfficiency: PriceImpactEfficiency;
  warnings: string[];
}

export interface TargetReachabilityInput {
  side: 'UP' | 'DOWN';
  target: UnscoredLiquidityTarget;
  flowToward: number;
  opposingNearby: number;
  pressureRatio: number;
  pressurePercentile: number;
  atr: number;
  impactEfficiency: PriceImpactEfficiency;
  absorptionToward: boolean;
  dataQualityScore: number;
  consumptionEase: number;
  replenishmentDrag: number;
  pullEase: number;
  wallAhead: boolean;
  vacuumAhead: boolean;
}
