import type { PassiveLiquidityConfig } from '../config/types.js';
import { clamp } from '../core/integrity.js';
import type {
  AbsorptionAssessment,
  LiquidityZone,
  PassiveLiquidityMarketState,
  VacuumAssessment,
} from '../models/passive-liquidity.js';

export interface StateInput {
  trustworthy: boolean;
  dataQuality: number;

  sellerAbsorption: AbsorptionAssessment;
  buyerAbsorption: AbsorptionAssessment;
  upsideVacuum: VacuumAssessment;
  downsideVacuum: VacuumAssessment;

  passiveBuyerStrength: number;
  passiveSellerStrength: number;

  nearImbalance: number;

  aggressiveBuyPercentile: number;
  aggressiveSellPercentile: number;
  upsideDisplacementPercentile: number;
  downsideDisplacementPercentile: number;

  askConsumedPercentile: number;
  bidConsumedPercentile: number;
  askReplenishedPercentile: number;
  bidReplenishedPercentile: number;
  askCancelledPercentile: number;
  bidCancelledPercentile: number;

  floor: LiquidityZone | null;
  ceiling: LiquidityZone | null;
}

export interface StateResult {
  state: PassiveLiquidityMarketState;
  confidence: number;
}

/**
 * Picks the market state from evidence, not from a single dominant metric.
 * Structural reads (vacuum, absorption, floor/ceiling construction) take
 * precedence over descriptive ones because they carry more information.
 */
export function classifyState(input: StateInput, config: PassiveLiquidityConfig): StateResult {
  if (!input.trustworthy) {
    return { state: 'NO_DIRECTIONAL_EDGE', confidence: clamp(input.dataQuality, 0, 100) };
  }

  const evidence = (value: number): number =>
    clamp(0.6 * (value / 100) + 0.4 * (input.dataQuality / 100), 0, 1) * 100;

  if (input.upsideVacuum.detected && input.upsideVacuum.score >= input.downsideVacuum.score) {
    return { state: 'UPSIDE_LIQUIDITY_VACUUM', confidence: evidence(input.upsideVacuum.score) };
  }
  if (input.downsideVacuum.detected) {
    return { state: 'DOWNSIDE_LIQUIDITY_VACUUM', confidence: evidence(input.downsideVacuum.score) };
  }

  if (input.buyerAbsorption.detected && input.buyerAbsorption.score >= input.sellerAbsorption.score) {
    return { state: 'BUYER_ABSORPTION', confidence: evidence(input.buyerAbsorption.score) };
  }
  if (input.sellerAbsorption.detected) {
    return { state: 'SELLER_ABSORPTION', confidence: evidence(input.sellerAbsorption.score) };
  }

  const floor = input.floor;
  if (floor && (floor.state === 'BUILDING_FLOOR' || floor.state === 'CONFIRMED_SUPPORT')) {
    return { state: 'BUILDING_FLOOR', confidence: evidence(floor.confidence) };
  }
  const ceiling = input.ceiling;
  if (ceiling && (ceiling.state === 'BUILDING_CEILING' || ceiling.state === 'CONFIRMED_RESISTANCE')) {
    return { state: 'BUILDING_CEILING', confidence: evidence(ceiling.confidence) };
  }

  const buyersThrough =
    input.aggressiveBuyPercentile >= config.highPercentile &&
    input.askConsumedPercentile >= config.highPercentile &&
    input.upsideDisplacementPercentile >= config.highPercentile &&
    input.askReplenishedPercentile <= config.highPercentile;
  if (buyersThrough) {
    return {
      state: 'BUYERS_EXPANDING',
      confidence: evidence((input.aggressiveBuyPercentile + input.upsideDisplacementPercentile) / 2),
    };
  }

  const sellersThrough =
    input.aggressiveSellPercentile >= config.highPercentile &&
    input.bidConsumedPercentile >= config.highPercentile &&
    input.downsideDisplacementPercentile >= config.highPercentile &&
    input.bidReplenishedPercentile <= config.highPercentile;
  if (sellersThrough) {
    return {
      state: 'SELLERS_EXPANDING',
      confidence: evidence((input.aggressiveSellPercentile + input.downsideDisplacementPercentile) / 2),
    };
  }

  const buyersDefending =
    input.passiveBuyerStrength >= 65 &&
    input.passiveBuyerStrength - input.passiveSellerStrength >= 10 &&
    input.bidCancelledPercentile <= config.highPercentile;
  if (buyersDefending) {
    return { state: 'PASSIVE_BUYERS_DEFENDING', confidence: evidence(input.passiveBuyerStrength) };
  }

  const sellersDefending =
    input.passiveSellerStrength >= 65 &&
    input.passiveSellerStrength - input.passiveBuyerStrength >= 10 &&
    input.askCancelledPercentile <= config.highPercentile;
  if (sellersDefending) {
    return { state: 'PASSIVE_SELLERS_DEFENDING', confidence: evidence(input.passiveSellerStrength) };
  }

  if (Math.abs(input.nearImbalance) <= 0.15) {
    return { state: 'BALANCED', confidence: evidence(50) };
  }
  return { state: 'NO_DIRECTIONAL_EDGE', confidence: evidence(35) };
}
