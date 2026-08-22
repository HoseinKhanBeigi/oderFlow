export type FlowWinner =
  | 'AGGRESSIVE_BUYERS'
  | 'AGGRESSIVE_SELLERS'
  | 'PASSIVE_BUYERS'
  | 'PASSIVE_SELLERS'
  | 'BALANCED'
  | 'UNRESOLVED';

export type FlowBattleState =
  | 'BUYERS_ATTACKING'
  | 'SELLERS_ATTACKING'
  | 'PASSIVE_BUYERS_DEFENDING'
  | 'PASSIVE_SELLERS_DEFENDING'
  | 'BUYERS_BREAKING_ASKS'
  | 'SELLERS_BREAKING_BIDS'
  | 'BUYERS_ABSORBED'
  | 'SELLERS_ABSORBED'
  | 'BALANCED_AUCTION';

export type FlowBias =
  | 'POTENTIALLY_BULLISH'
  | 'POTENTIALLY_BEARISH'
  | 'BULLISH_CONTINUATION'
  | 'BEARISH_CONTINUATION'
  | 'NEUTRAL';

export interface PassiveFlowMetrics {
  passiveBuyExecutedVolume: number;
  passiveSellExecutedVolume: number;
  bidLiquidityAdded: number;
  askLiquidityAdded: number;
  bidLiquidityRemoved: number;
  askLiquidityRemoved: number;
  bidLiquidityConsumed: number;
  askLiquidityConsumed: number;
  bidLiquidityReplenished: number;
  askLiquidityReplenished: number;
  bidDefenseStrength: number;
  askDefenseStrength: number;
  bidLiquidityInitial: number;
  askLiquidityInitial: number;
  bidLiquidityFinal: number;
  askLiquidityFinal: number;
}

export interface FlowWinnerAnalysis {
  winner: FlowWinner;
  score: number;
  confidence: number;
  evidence: string[];
}

export interface BuyerSellerBattle {
  aggressiveBuyerStrength: number;
  passiveSellerStrength: number;
  aggressiveSellerStrength: number;
  passiveBuyerStrength: number;
  bullishControl: number;
  bearishControl: number;
  winner: FlowWinner;
}

export interface PassiveFailureEvent {
  type: 'PASSIVE_SELLER_FAILURE' | 'PASSIVE_BUYER_FAILURE';
  price: number;
  consumedLiquidity: number;
  priceResponse: number;
  confidence: number;
}

export interface IcebergLikePassive {
  type: 'ICEBERG_LIKE_PASSIVE_SELLING' | 'ICEBERG_LIKE_PASSIVE_BUYING';
  visibleLiquidity: number;
  executedAgainstLevel: number;
  replenishmentRatio: number;
  confidence: number;
}

export interface PassiveDefenseZone {
  priceMin: number;
  priceMax: number;
  side: 'BUY' | 'SELL';
  testCount: number;
  totalAggressiveVolumeAbsorbed: number;
  replenishmentVolume: number;
  averagePriceResponse: number;
  defenseStrength: number;
}

export interface FlowBattleSnapshot {
  metrics: PassiveFlowMetrics;
  winner: FlowWinnerAnalysis;
  battle: BuyerSellerBattle;
  state: FlowBattleState;
  bias: FlowBias;
  failure: PassiveFailureEvent | null;
  icebergLike: IcebergLikePassive | null;
  defenseZone: PassiveDefenseZone | null;
  executionToVisibleAsk: number;
  executionToVisibleBid: number;
  askConsumptionToReplenishment: number;
  bidConsumptionToReplenishment: number;
  buyExecutionEfficiency: number;
  sellExecutionEfficiency: number;
  persistentPassive: 'PERSISTENT_PASSIVE_SELLER_CONTROL' | 'PERSISTENT_PASSIVE_BUYER_CONTROL' | null;
}

export function emptyPassiveMetrics(): PassiveFlowMetrics {
  return {
    passiveBuyExecutedVolume: 0,
    passiveSellExecutedVolume: 0,
    bidLiquidityAdded: 0,
    askLiquidityAdded: 0,
    bidLiquidityRemoved: 0,
    askLiquidityRemoved: 0,
    bidLiquidityConsumed: 0,
    askLiquidityConsumed: 0,
    bidLiquidityReplenished: 0,
    askLiquidityReplenished: 0,
    bidDefenseStrength: 0,
    askDefenseStrength: 0,
    bidLiquidityInitial: 0,
    askLiquidityInitial: 0,
    bidLiquidityFinal: 0,
    askLiquidityFinal: 0,
  };
}

export function emptyFlowBattle(): FlowBattleSnapshot {
  return {
    metrics: emptyPassiveMetrics(),
    winner: { winner: 'UNRESOLVED', score: 0, confidence: 0, evidence: [] },
    battle: {
      aggressiveBuyerStrength: 0,
      passiveSellerStrength: 0,
      aggressiveSellerStrength: 0,
      passiveBuyerStrength: 0,
      bullishControl: 0,
      bearishControl: 0,
      winner: 'UNRESOLVED',
    },
    state: 'BALANCED_AUCTION',
    bias: 'NEUTRAL',
    failure: null,
    icebergLike: null,
    defenseZone: null,
    executionToVisibleAsk: 0,
    executionToVisibleBid: 0,
    askConsumptionToReplenishment: 0,
    bidConsumptionToReplenishment: 0,
    buyExecutionEfficiency: 0,
    sellExecutionEfficiency: 0,
    persistentPassive: null,
  };
}
