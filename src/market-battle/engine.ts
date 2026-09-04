import { clamp, safeDiv } from '../core/integrity.js';
import type { FlowBattleSnapshot } from '../models/passive.js';
import type { LiquidityResponseSnapshot, IntensityLabel } from '../models/liquidity-response.js';
import type { PassiveLiquiditySnapshot } from '../models/passive-liquidity.js';
import type { NetAggressionSnapshot } from '../models/net-aggression.js';
import type { PriceImpactEfficiency, WindowId } from '../models/trade.js';
import type {
  AggressiveSideView,
  BattleIntensity,
  DownsideBattle,
  DownsideBattleState,
  MarketBattleSnapshot,
  MarketBattleSummary,
  MarketBattleSummaryState,
  PassiveSideView,
  PriceResponseView,
  UpsideBattle,
  UpsideBattleState,
} from '../models/market-battle.js';
export interface MarketBattleInput {
  window: WindowId;
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
  buyTradeCount: number;
  sellTradeCount: number;
  largeBuyVolume: number;
  largeSellVolume: number;
  priceChangePercent: number;
  priceImpactEfficiency: PriceImpactEfficiency;
  /** Window confidence from OrderFlowEngine (0–1). */
  confidence: number;
  /** True when no usable trade tape in this window. */
  tradeDataMissing?: boolean;
  flowBattle: FlowBattleSnapshot;
  liquidityResponse: LiquidityResponseSnapshot;
  passiveLiquidity: PassiveLiquiditySnapshot | null;
  netAggression: NetAggressionSnapshot | null;
}

/**
 * Composes existing OrderFlow / PassiveLiquidity / LiquidityResponse /
 * PriceResponse outputs into the two microstructure battles.
 * Does not invent independent volume or depth signals.
 */
export class MarketBattleEngine {
  analyze(input: MarketBattleInput): MarketBattleSnapshot {
    const lr = input.liquidityResponse;
    const fb = input.flowBattle;
    const pl = input.passiveLiquidity;
    const na = input.netAggression;
    const tradeMissing = Boolean(input.tradeDataMissing);

    const bookReliable = pl
      ? (pl.dataQuality?.trustworthy ?? false) && (pl.dataQuality?.score ?? 0) >= 35
      : lr.dataQuality >= 40 && lr.confidence !== 'LOW';


    const buyPct = na?.buy.percentile ?? lr.norms.aggressiveBuy.percentile ?? 50;
    const sellPct = na?.sell.percentile ?? lr.norms.aggressiveSell.percentile ?? 50;

    const upsideAgg = buildAggressive({
      volume: input.aggressiveBuyVolume,
      percentile: buyPct,
      velocityPerSec: na?.buy.velocityPerSec ?? safeDiv(input.aggressiveBuyVolume, Math.max(na?.windowMs ?? 10_000, 1) / 1000),
      tradeCount: input.buyTradeCount,
      largeVolume: input.largeBuyVolume,
      hasData: !tradeMissing,
      baseScore: fb.battle.aggressiveBuyerStrength,
    });

    const downsideAgg = buildAggressive({
      volume: input.aggressiveSellVolume,
      percentile: sellPct,
      velocityPerSec: na?.sell.velocityPerSec ?? safeDiv(input.aggressiveSellVolume, Math.max(na?.windowMs ?? 10_000, 1) / 1000),
      tradeCount: input.sellTradeCount,
      largeVolume: input.largeSellVolume,
      hasData: !tradeMissing,
      baseScore: fb.battle.aggressiveSellerStrength,
    });

    const upsidePas = buildPassive({
      currentDepth: pl?.context.askDepth ?? lr.askDepth.current,
      nearDepth: pl?.context.nearAskDepth ?? lr.askDepth.current,
      consumption: lr.askConsumption,
      replenishment: lr.askReplenishment,
      withdrawal: lr.askWithdrawal,
      survival: pl?.context.askPersistence ?? clamp(100 - intensityToScore(lr.askWithdrawal), 0, 100),
      strength: pl?.passiveSellerStrength ?? fb.battle.passiveSellerStrength,
      reliable: bookReliable,
      baseScore: fb.battle.passiveSellerStrength,
      depthPercentile: lr.askDepth.currentPercentile,
    });

    const downsidePas = buildPassive({
      currentDepth: pl?.context.bidDepth ?? lr.bidDepth.current,
      nearDepth: pl?.context.nearBidDepth ?? lr.bidDepth.current,
      consumption: lr.bidConsumption,
      replenishment: lr.bidReplenishment,
      withdrawal: lr.bidWithdrawal,
      survival: pl?.context.bidPersistence ?? clamp(100 - intensityToScore(lr.bidWithdrawal), 0, 100),
      strength: pl?.passiveBuyerStrength ?? fb.battle.passiveBuyerStrength,
      reliable: bookReliable,
      baseScore: fb.battle.passiveBuyerStrength,
      depthPercentile: lr.bidDepth.currentPercentile,
    });

    const upsidePrice = buildPriceResponse({
      displacementPercent: Math.max(0, input.priceChangePercent),
      impact: input.priceImpactEfficiency,
      lrEfficiency: lr.efficiency,
      executionEfficiency: fb.buyExecutionEfficiency,
      directional: input.priceChangePercent > 0.02,
      absorption: lr.absorption.kind === 'BUY_ABSORPTION' || input.priceChangePercent <= 0.04,
    });

    const downsidePrice = buildPriceResponse({
      displacementPercent: Math.max(0, -input.priceChangePercent),
      impact: input.priceImpactEfficiency,
      lrEfficiency: lr.efficiency,
      executionEfficiency: fb.sellExecutionEfficiency,
      directional: input.priceChangePercent < -0.02,
      absorption: lr.absorption.kind === 'SELL_ABSORPTION' || input.priceChangePercent >= -0.04,
    });

    const upside = classifyUpside({
      aggressive: upsideAgg,
      passive: upsidePas,
      price: upsidePrice,
      lr,
      vacuum: lr.vacuum === 'UPSIDE_LIQUIDITY_VACUUM' || (pl?.upsideVacuum.detected ?? false),
      absorption: lr.absorption.kind === 'BUY_ABSORPTION' || (pl?.sellerAbsorption.type === 'SELLER_ABSORPTION'),
      tradeMissing,
      bookReliable,
    });

    const downside = classifyDownside({
      aggressive: downsideAgg,
      passive: downsidePas,
      price: downsidePrice,
      lr,
      vacuum: lr.vacuum === 'DOWNSIDE_LIQUIDITY_VACUUM' || (pl?.downsideVacuum.detected ?? false),
      absorption: lr.absorption.kind === 'SELL_ABSORPTION' || (pl?.buyerAbsorption.type === 'BUYER_ABSORPTION'),
      tradeMissing,
      bookReliable,
    });

    const summary = summarizeBattles(upside, downside);

    return {
      window: input.window,
      upside,
      downside,
      upsideBattleScore: upside.battleScore,
      downsideBattleScore: downside.battleScore,
      summary,
    };
  }
}

function buildAggressive(p: {
  volume: number;
  percentile: number;
  velocityPerSec: number;
  tradeCount: number;
  largeVolume: number;
  hasData: boolean;
  baseScore: number;
}): AggressiveSideView {
  if (!p.hasData) {
    return {
      volume: 0,
      percentile: 0,
      velocityPerSec: 0,
      tradeCount: 0,
      largeVolume: 0,
      hasData: false,
      score: 0,
    };
  }
  const pctScore = clamp(p.percentile, 0, 100);
  const largeShare = clamp(safeDiv(p.largeVolume, Math.max(p.volume, 1e-9)), 0, 1);
  const velocityBoost = clamp(Math.log10(1 + Math.max(p.velocityPerSec, 0) / 50_000) * 25, 0, 20);
  const countBoost = clamp(Math.log10(1 + p.tradeCount) * 8, 0, 15);
  const composed =
    0.55 * p.baseScore +
    0.25 * pctScore +
    0.1 * (largeShare * 100) +
    0.05 * velocityBoost +
    0.05 * countBoost;
  return {
    volume: p.volume,
    percentile: pctScore,
    velocityPerSec: p.velocityPerSec,
    tradeCount: p.tradeCount,
    largeVolume: p.largeVolume,
    hasData: true,
    score: clamp(composed, 0, 100),
  };
}

function buildPassive(p: {
  currentDepth: number;
  nearDepth: number;
  consumption: IntensityLabel;
  replenishment: IntensityLabel;
  withdrawal: IntensityLabel;
  survival: number;
  strength: number;
  reliable: boolean;
  baseScore: number;
  depthPercentile: number;
}): PassiveSideView {
  const replenishN = intensityToScore(p.replenishment);
  const withdrawN = intensityToScore(p.withdrawal);
  const depthN = clamp(p.depthPercentile, 0, 100);
  const survivalN = clamp(p.survival, 0, 100);
  const composed =
    0.4 * p.baseScore +
    0.2 * clamp(p.strength, 0, 100) +
    0.15 * replenishN +
    0.15 * survivalN +
    0.1 * depthN -
    0.08 * withdrawN;
  return {
    currentDepth: p.currentDepth,
    nearDepth: p.nearDepth,
    consumption: p.consumption,
    replenishment: p.replenishment,
    withdrawal: p.withdrawal,
    survival: survivalN,
    strength: clamp(p.strength, 0, 100),
    reliable: p.reliable,
    score: clamp(composed, 0, 100),
  };
}

function buildPriceResponse(p: {
  displacementPercent: number;
  impact: PriceImpactEfficiency;
  lrEfficiency: IntensityLabel;
  executionEfficiency: number;
  directional: boolean;
  absorption: boolean;
}): PriceResponseView {
  if (!p.directional || p.absorption) {
    const lowEff: IntensityLabel =
      p.impact === 'LOW' || p.lrEfficiency === 'LOW' ? 'LOW' : p.lrEfficiency === 'NORMAL' ? 'LOW' : 'NORMAL';
    return {
      displacementPercent: p.displacementPercent,
      efficiency: lowEff,
      efficiencyScore: clamp(p.executionEfficiency * 100 * 0.35, 0, 40),
    };
  }
  const impactN = intensityToScore(p.impact);
  const lrN = intensityToScore(p.lrEfficiency);
  const score = clamp(0.45 * impactN + 0.35 * lrN + 0.2 * p.executionEfficiency * 100, 0, 100);
  const efficiency: IntensityLabel =
    score >= 80 ? 'EXTREME' : score >= 60 ? 'HIGH' : score >= 35 ? 'NORMAL' : 'LOW';
  return {
    displacementPercent: p.displacementPercent,
    efficiency,
    efficiencyScore: score,
  };
}

function classifyUpside(p: {
  aggressive: AggressiveSideView;
  passive: PassiveSideView;
  price: PriceResponseView;
  lr: LiquidityResponseSnapshot;
  vacuum: boolean;
  absorption: boolean;
  tradeMissing: boolean;
  bookReliable: boolean;
}): UpsideBattle {
  const aggI = aggressionIntensity(p.aggressive);
  const consI = toBattleIntensity(p.passive.consumption);
  const replI = toBattleIntensity(p.passive.replenishment);
  const withI = toBattleIntensity(p.passive.withdrawal);
  const effI = toBattleIntensity(p.price.efficiency);
  const survivalLow = p.passive.survival < 35;
  const battleScore = battleIntensityScore(p.aggressive.score, p.passive.score, aggI);

  if (p.tradeMissing) {
    return packUpside(p, battleScore, 'NO_MEANINGFUL_BATTLE', ['Trade data unavailable']);
  }
  if (!p.bookReliable && aggI !== 'NONE') {
    return packUpside(p, battleScore * 0.5, 'LOW_CONFIDENCE', [
      'Book data unreliable — passive side marked low confidence',
    ]);
  }
  if (aggI === 'NONE' || (aggI === 'LOW' && p.aggressive.percentile < 35)) {
    return packUpside(p, Math.min(battleScore, 25), 'NO_MEANINGFUL_BATTLE', [
      'Aggressive buy flow is not meaningful in this window',
    ]);
  }

  // Aggressive Buy HIGH + consumption HIGH + replenishment HIGH + efficiency LOW → SELLER ABSORPTION
  if (
    (aggI === 'HIGH' || aggI === 'MODERATE') &&
    (consI === 'HIGH' || consI === 'MODERATE') &&
    (replI === 'HIGH' || p.passive.survival >= 55) &&
    (effI === 'LOW' || p.absorption)
  ) {
    return packUpside(p, battleScore, 'SELLER_ABSORPTION', [
      'Aggressive buying is being absorbed',
      'Ask consumption high with replenishment holding',
      'Upward price efficiency remains low',
    ]);
  }

  // Aggressive Buy HIGH + consumption HIGH + replenishment LOW + efficiency HIGH → BUYERS WINNING
  if (
    aggI === 'HIGH' &&
    (consI === 'HIGH' || consI === 'MODERATE') &&
    (replI === 'LOW' || p.passive.score + 8 < p.aggressive.score) &&
    (effI === 'HIGH' || p.price.efficiencyScore >= 55)
  ) {
    return packUpside(p, battleScore, 'BUYERS_WINNING', [
      'Aggressive buyers consuming ask liquidity',
      'Ask replenishment weak relative to consumption',
      'Upward price displacement is efficient',
    ]);
  }

  // Moderate agg + withdrawal HIGH + survival LOW + efficiency HIGH → UPSIDE VACUUM
  if (
    (aggI === 'MODERATE' || aggI === 'HIGH') &&
    (withI === 'HIGH' || p.vacuum || survivalLow) &&
    (effI === 'HIGH' || p.price.displacementPercent > 0.08)
  ) {
    return packUpside(p, battleScore, 'UPSIDE_VACUUM', [
      'Ask liquidity withdrawing / thin survival',
      'Price displacing upward through thin asks',
    ]);
  }

  // Defense holding
  if (
    (aggI === 'HIGH' || aggI === 'MODERATE') &&
    (effI === 'LOW' || p.price.displacementPercent < 0.06) &&
    (replI === 'HIGH' || p.passive.survival >= 50 || p.passive.score >= p.aggressive.score)
  ) {
    return packUpside(p, battleScore, 'SELLERS_DEFENDING', [
      'Passive sellers defending the ask',
      'Aggressive buy effort is not producing upside',
    ]);
  }

  // Buyers winning via score gap + price
  if (p.aggressive.score >= p.passive.score + 12 && p.price.efficiencyScore >= 45 && p.price.displacementPercent > 0.05) {
    return packUpside(p, battleScore, 'BUYERS_WINNING', [
      'Aggressive buyers outscoring passive sellers',
      'Price responding to the upside attack',
    ]);
  }

  if (Math.abs(p.aggressive.score - p.passive.score) < 10) {
    return packUpside(p, battleScore, 'BALANCED', ['Upside attack and ask defense are evenly matched']);
  }

  if (p.passive.score > p.aggressive.score) {
    return packUpside(p, battleScore, 'SELLERS_DEFENDING', ['Passive seller strength exceeds aggressive buy pressure']);
  }

  return packUpside(p, battleScore, 'BALANCED', ['No clear upside winner from liquidity and price response']);
}

function classifyDownside(p: {
  aggressive: AggressiveSideView;
  passive: PassiveSideView;
  price: PriceResponseView;
  lr: LiquidityResponseSnapshot;
  vacuum: boolean;
  absorption: boolean;
  tradeMissing: boolean;
  bookReliable: boolean;
}): DownsideBattle {
  const aggI = aggressionIntensity(p.aggressive);
  const consI = toBattleIntensity(p.passive.consumption);
  const replI = toBattleIntensity(p.passive.replenishment);
  const withI = toBattleIntensity(p.passive.withdrawal);
  const effI = toBattleIntensity(p.price.efficiency);
  const survivalLow = p.passive.survival < 35;
  const battleScore = battleIntensityScore(p.aggressive.score, p.passive.score, aggI);

  if (p.tradeMissing) {
    return packDownside(p, battleScore, 'NO_MEANINGFUL_BATTLE', ['Trade data unavailable']);
  }
  if (!p.bookReliable && aggI !== 'NONE') {
    return packDownside(p, battleScore * 0.5, 'LOW_CONFIDENCE', [
      'Book data unreliable — passive side marked low confidence',
    ]);
  }
  if (aggI === 'NONE' || (aggI === 'LOW' && p.aggressive.percentile < 35)) {
    return packDownside(p, Math.min(battleScore, 25), 'NO_MEANINGFUL_BATTLE', [
      'Aggressive sell flow is not meaningful in this window',
    ]);
  }

  if (
    (aggI === 'HIGH' || aggI === 'MODERATE') &&
    (consI === 'HIGH' || consI === 'MODERATE') &&
    (replI === 'HIGH' || p.passive.survival >= 55) &&
    (effI === 'LOW' || p.absorption)
  ) {
    return packDownside(p, battleScore, 'BUYER_ABSORPTION', [
      'Aggressive selling is being absorbed',
      'Bid consumption high with replenishment holding',
      'Downward price efficiency remains low',
    ]);
  }

  if (
    aggI === 'HIGH' &&
    (consI === 'HIGH' || consI === 'MODERATE') &&
    (replI === 'LOW' || p.passive.score + 8 < p.aggressive.score) &&
    (effI === 'HIGH' || p.price.efficiencyScore >= 55)
  ) {
    return packDownside(p, battleScore, 'SELLERS_WINNING', [
      'Aggressive sellers consuming bid liquidity',
      'Bid replenishment weak relative to consumption',
      'Downward price displacement is efficient',
    ]);
  }

  if (
    (aggI === 'MODERATE' || aggI === 'HIGH') &&
    (withI === 'HIGH' || p.vacuum || survivalLow) &&
    (effI === 'HIGH' || p.price.displacementPercent > 0.08)
  ) {
    return packDownside(p, battleScore, 'DOWNSIDE_VACUUM', [
      'Bid liquidity withdrawing / thin survival',
      'Price displacing downward through thin bids',
    ]);
  }

  if (
    (aggI === 'HIGH' || aggI === 'MODERATE') &&
    (effI === 'LOW' || p.price.displacementPercent < 0.06) &&
    (replI === 'HIGH' || p.passive.survival >= 50 || p.passive.score >= p.aggressive.score)
  ) {
    return packDownside(p, battleScore, 'BUYERS_DEFENDING', [
      'Passive buyers defending the bid',
      'Aggressive sell effort is not producing downside',
    ]);
  }

  if (p.aggressive.score >= p.passive.score + 12 && p.price.efficiencyScore >= 45 && p.price.displacementPercent > 0.05) {
    return packDownside(p, battleScore, 'SELLERS_WINNING', [
      'Aggressive sellers outscoring passive buyers',
      'Price responding to the downside attack',
    ]);
  }

  if (Math.abs(p.aggressive.score - p.passive.score) < 10) {
    return packDownside(p, battleScore, 'BALANCED', ['Downside attack and bid defense are evenly matched']);
  }

  if (p.passive.score > p.aggressive.score) {
    return packDownside(p, battleScore, 'BUYERS_DEFENDING', ['Passive buyer strength exceeds aggressive sell pressure']);
  }

  return packDownside(p, battleScore, 'BALANCED', ['No clear downside winner from liquidity and price response']);
}

function summarizeBattles(upside: UpsideBattle, downside: DownsideBattle): MarketBattleSummary {
  const u = upside.state;
  const d = downside.state;

  const buyersAttacking = u === 'BUYERS_WINNING' || u === 'UPSIDE_VACUUM';
  const sellersAttacking = d === 'SELLERS_WINNING' || d === 'DOWNSIDE_VACUUM';
  const sellersDefending = u === 'SELLERS_DEFENDING' || u === 'SELLER_ABSORPTION';
  const buyersDefending = d === 'BUYERS_DEFENDING' || d === 'BUYER_ABSORPTION';

  if (buyersAttacking && buyersDefending) {
    return {
      state: 'BUYERS_IN_CONTROL',
      why: 'Aggressive buyers are successfully consuming ask liquidity while passive buyers are simultaneously preventing aggressive sellers from producing meaningful downside displacement.',
    };
  }
  if (sellersAttacking && sellersDefending) {
    return {
      state: 'SELLERS_IN_CONTROL',
      why: 'Aggressive sellers are successfully consuming bid liquidity while passive sellers are simultaneously preventing aggressive buyers from producing meaningful upside displacement.',
    };
  }
  if (sellersDefending && buyersDefending) {
    return {
      state: 'TWO_SIDED_DEFENSE',
      why: 'Passive liquidity is holding on both sides — aggressive flow is not producing lasting price displacement.',
    };
  }
  if (buyersAttacking && sellersAttacking) {
    return {
      state: 'TWO_SIDED_AGGRESSION',
      why: 'Both aggressive buyers and aggressive sellers are moving price through liquidity — two-sided aggression.',
    };
  }
  if (buyersAttacking && !sellersAttacking) {
    return {
      state: 'BUYERS_IN_CONTROL',
      why: 'Upside attack is winning while the downside is not producing a meaningful seller breakthrough.',
    };
  }
  if (sellersAttacking && !buyersAttacking) {
    return {
      state: 'SELLERS_IN_CONTROL',
      why: 'Downside attack is winning while the upside is not producing a meaningful buyer breakthrough.',
    };
  }
  if (buyersDefending && !sellersDefending) {
    return {
      state: 'PASSIVE_BUYERS_DEFENDING',
      why: 'Passive buyers are absorbing or rejecting aggressive sell pressure without a clear upside breakout.',
    };
  }
  if (sellersDefending && !buyersDefending) {
    return {
      state: 'PASSIVE_SELLERS_DEFENDING',
      why: 'Passive sellers are absorbing or rejecting aggressive buy pressure without a clear downside breakout.',
    };
  }
  if (
    (u === 'BALANCED' || u === 'NO_MEANINGFUL_BATTLE' || u === 'LOW_CONFIDENCE') &&
    (d === 'BALANCED' || d === 'NO_MEANINGFUL_BATTLE' || d === 'LOW_CONFIDENCE')
  ) {
    if (u === 'BALANCED' && d === 'BALANCED') {
      return {
        state: 'COMPRESSION',
        why: 'Both battles are balanced — aggression and defense are compressing without a clear controller.',
      };
    }
    return {
      state: 'NO_CLEAR_WINNER',
      why: 'Neither battle has a clear winner from liquidity response and price response.',
    };
  }

  return {
    state: 'NO_CLEAR_WINNER' satisfies MarketBattleSummaryState,
    why: 'Battle states disagree — no single side controls both attack and defense.',
  };
}

function packUpside(
  p: { aggressive: AggressiveSideView; passive: PassiveSideView; price: PriceResponseView },
  battleScore: number,
  state: UpsideBattleState,
  why: string[],
): UpsideBattle {
  return {
    aggressive: p.aggressive,
    passive: p.passive,
    price: p.price,
    battleScore: clamp(battleScore, 0, 100),
    state,
    why,
  };
}

function packDownside(
  p: { aggressive: AggressiveSideView; passive: PassiveSideView; price: PriceResponseView },
  battleScore: number,
  state: DownsideBattleState,
  why: string[],
): DownsideBattle {
  return {
    aggressive: p.aggressive,
    passive: p.passive,
    price: p.price,
    battleScore: clamp(battleScore, 0, 100),
    state,
    why,
  };
}

function aggressionIntensity(agg: AggressiveSideView): BattleIntensity {
  if (!agg.hasData) return 'NONE';
  if (agg.percentile >= 70 || agg.score >= 65) return 'HIGH';
  if (agg.percentile >= 40 || agg.score >= 35) return 'MODERATE';
  if (agg.volume > 0 && (agg.percentile >= 20 || agg.score >= 15)) return 'LOW';
  return 'NONE';
}

function toBattleIntensity(label: IntensityLabel): BattleIntensity {
  if (label === 'EXTREME' || label === 'HIGH') return 'HIGH';
  if (label === 'LOW') return 'LOW';
  return 'MODERATE';
}

function intensityToScore(label: IntensityLabel): number {
  if (label === 'EXTREME') return 95;
  if (label === 'HIGH') return 78;
  if (label === 'NORMAL') return 50;
  return 22;
}

function battleIntensityScore(agg: number, pas: number, aggI: BattleIntensity): number {
  if (aggI === 'NONE') return clamp(Math.max(agg, pas) * 0.25, 0, 100);
  // Independent intensity — not a zero-sum of the other battle.
  return clamp(0.55 * Math.max(agg, pas) + 0.45 * ((agg + pas) / 2), 0, 100);
}

export function analyzeMarketBattle(input: MarketBattleInput): MarketBattleSnapshot {
  return new MarketBattleEngine().analyze(input);
}
