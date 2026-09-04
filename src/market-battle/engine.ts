import { clamp } from '../core/integrity.js';
import type { FlowBattleSnapshot } from '../models/passive.js';
import type { LiquidityResponseSnapshot, IntensityLabel } from '../models/liquidity-response.js';
import type { PassiveLiquiditySnapshot } from '../models/passive-liquidity.js';
import type { NetAggressionSnapshot } from '../models/net-aggression.js';
import type { AggressiveFlowSnapshot, AggressiveSideFlow } from '../models/aggressive-flow.js';
import type { PriceImpactEfficiency, WindowId } from '../models/trade.js';
import type {
  AggressiveSideView,
  BattleDataHealth,
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
import { emptyAggressiveSide } from '../models/market-battle.js';

export interface MarketBattleInput {
  window: WindowId;
  priceChangePercent: number;
  priceImpactEfficiency: PriceImpactEfficiency;
  /** Window confidence from OrderFlowEngine (0–1). */
  confidence: number;
  /** True when no usable footprint / trade tape in this window. */
  tradeDataMissing?: boolean;
  /** True when trade tape is stale / incomplete. */
  tradeDataLowConfidence?: boolean;
  /** Milliseconds since the last trade arrived (local clock, not exchange time). */
  tradeAgeMs?: number;
  /** Age at which this symbol counts as stale — scaled to its own trade cadence. */
  staleAfterMs?: number;
  /** Typical gap between prints for this symbol; 0 until enough samples. */
  medianTradeGapMs?: number;
  flowBattle: FlowBattleSnapshot;
  liquidityResponse: LiquidityResponseSnapshot;
  passiveLiquidity: PassiveLiquiditySnapshot | null;
  netAggression: NetAggressionSnapshot | null;
  /** Footprint-derived ASK/BID executed aggression (required for attack scores). */
  aggressiveFlow: AggressiveFlowSnapshot | null;
}

/**
 * Composes Footprint aggression + PassiveLiquidity defense + PriceResponse
 * into the two microstructure battles.
 */
export class MarketBattleEngine {
  analyze(input: MarketBattleInput): MarketBattleSnapshot {
    const lr = input.liquidityResponse;
    const fb = input.flowBattle;
    const pl = input.passiveLiquidity;
    const af = input.aggressiveFlow;
    const tradeMissing = Boolean(input.tradeDataMissing) || !af?.buy.hasData;
    const tradeLowConf = Boolean(input.tradeDataLowConfidence) || Boolean(af?.buy.lowConfidence);

    const bookReliable = pl
      ? (pl.dataQuality?.trustworthy ?? false) && (pl.dataQuality?.score ?? 0) >= 35
      : lr.dataQuality >= 40 && lr.confidence !== 'LOW';

    const upsideAgg = mapAggressiveSide(af?.buy ?? null, tradeMissing, tradeLowConf);
    const downsideAgg = mapAggressiveSide(af?.sell ?? null, tradeMissing, tradeLowConf);

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
      absorption: lr.absorption.kind === 'BUY_ABSORPTION' || pl?.sellerAbsorption.type === 'SELLER_ABSORPTION',
      tradeMissing,
      tradeLowConf,
      bookReliable,
    });

    const downside = classifyDownside({
      aggressive: downsideAgg,
      passive: downsidePas,
      price: downsidePrice,
      lr,
      vacuum: lr.vacuum === 'DOWNSIDE_LIQUIDITY_VACUUM' || (pl?.downsideVacuum.detected ?? false),
      absorption: lr.absorption.kind === 'SELL_ABSORPTION' || pl?.buyerAbsorption.type === 'BUYER_ABSORPTION',
      tradeMissing,
      tradeLowConf,
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
      dataHealth: buildDataHealth(input, tradeMissing, tradeLowConf, bookReliable),
    };
  }
}

/** Names the specific reason a read is degraded, so the UI never has to guess. */
function buildDataHealth(
  input: MarketBattleInput,
  tradeMissing: boolean,
  tradeLowConf: boolean,
  bookReliable: boolean,
): BattleDataHealth {
  const tradeAgeMs = Number.isFinite(input.tradeAgeMs ?? NaN) ? (input.tradeAgeMs as number) : 0;
  const staleAfterMs = input.staleAfterMs ?? 0;
  const medianTradeGapMs = input.medianTradeGapMs ?? 0;
  const base = { tradeAgeMs, staleAfterMs, medianTradeGapMs, bookReliable };

  if (tradeMissing) {
    return {
      ...base,
      status: 'NO_TRADES',
      detail: 'No trades are reaching the engine — the trade feed is down or not subscribed.',
    };
  }
  if (tradeLowConf) {
    const age = Math.round(tradeAgeMs / 1000);
    const limit = Math.round(staleAfterMs / 1000);
    return {
      ...base,
      status: 'STALE_TRADES',
      detail: `Last trade ${age}s ago, over this symbol's ${limit}s staleness limit — quiet market or a lagging feed.`,
    };
  }
  if (!bookReliable) {
    return {
      ...base,
      status: 'BOOK_UNRELIABLE',
      detail: 'Trades are live but the order book is incomplete, so defense scores are unreliable.',
    };
  }
  return { ...base, status: 'OK', detail: '' };
}

function mapAggressiveSide(
  side: AggressiveSideFlow | null,
  tradeMissing: boolean,
  tradeLowConf: boolean,
): AggressiveSideView {
  if (tradeMissing || !side || !side.hasData) {
    return emptyAggressiveSide();
  }
  return {
    volume: side.executedVolume,
    percentile: side.activityPercentile,
    velocityPerSec: side.velocityPerSec,
    tradeCount: side.tradeCount,
    averageTradeSize: side.averageTradeSize,
    largeVolume: side.largeVolume,
    imbalanceCount: side.imbalanceCount,
    imbalanceStrength: side.imbalanceStrength,
    deltaContribution: side.deltaContribution,
    cvdContribution: side.cvdContribution,
    consecutiveImbalances: side.consecutiveImbalances,
    power: side.power,
    contributions: side.contributions,
    topLevels: side.topLevels,
    hasData: true,
    lowConfidence: tradeLowConf || side.lowConfidence,
    score: side.power,
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
  const defensePower = clamp(composed, 0, 100);
  return {
    currentDepth: p.currentDepth,
    nearDepth: p.nearDepth,
    consumption: p.consumption,
    replenishment: p.replenishment,
    withdrawal: p.withdrawal,
    survival: survivalN,
    survivalLabel: survivalN >= 65 ? 'STRONG' : survivalN >= 35 ? 'MODERATE' : 'WEAK',
    strength: clamp(p.strength, 0, 100),
    defensePower,
    reliable: p.reliable,
    score: defensePower,
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
  tradeLowConf: boolean;
  bookReliable: boolean;
}): UpsideBattle {
  const aggI = aggressionIntensity(p.aggressive);
  const consI = toBattleIntensity(p.passive.consumption);
  const replI = toBattleIntensity(p.passive.replenishment);
  const withI = toBattleIntensity(p.passive.withdrawal);
  const effI = toBattleIntensity(p.price.efficiency);
  const survivalLow = p.passive.survival < 35;
  const battleScore = battleIntensityScore(p.aggressive.power, p.passive.defensePower, aggI);

  if (p.tradeMissing) {
    return packUpside(p, battleScore, 'NO_MEANINGFUL_BATTLE', ['FOOTPRINT DATA UNAVAILABLE']);
  }
  if (p.tradeLowConf || p.aggressive.lowConfidence) {
    return packUpside(p, battleScore * 0.5, 'LOW_CONFIDENCE', [
      'Footprint / trade data delayed or incomplete — attack side low confidence',
    ]);
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

  // High Aggressive Buy Power + High Ask Replenishment + Low Upward Efficiency → SELLER ABSORPTION
  if (
    (aggI === 'HIGH' || aggI === 'MODERATE') &&
    (consI === 'HIGH' || consI === 'MODERATE') &&
    (replI === 'HIGH' || p.passive.survival >= 55) &&
    (effI === 'LOW' || p.absorption)
  ) {
    return packUpside(p, battleScore, 'SELLER_ABSORPTION', [
      'High aggressive buy power with ask replenishment holding',
      'Upward price efficiency remains low',
    ]);
  }

  // High Aggressive Buy Power + High Ask Consumption + Low Ask Replenishment + High Efficiency → BUYERS WINNING
  if (
    aggI === 'HIGH' &&
    (consI === 'HIGH' || consI === 'MODERATE') &&
    (replI === 'LOW' || p.passive.defensePower + 8 < p.aggressive.power) &&
    (effI === 'HIGH' || p.price.efficiencyScore >= 55)
  ) {
    return packUpside(p, battleScore, 'BUYERS_WINNING', [
      'Footprint aggression consuming ask liquidity',
      'Ask replenishment weak relative to consumption',
      'Upward price displacement is efficient',
    ]);
  }

  // Moderate Aggressive Buy Power + High Ask Withdrawal + Low Ask Survival + High Efficiency → UPSIDE VACUUM
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

  if (
    (aggI === 'HIGH' || aggI === 'MODERATE') &&
    (effI === 'LOW' || p.price.displacementPercent < 0.06) &&
    (replI === 'HIGH' || p.passive.survival >= 50 || p.passive.defensePower >= p.aggressive.power)
  ) {
    return packUpside(p, battleScore, 'SELLERS_DEFENDING', [
      'Passive sellers defending the ask',
      'Footprint buy attack is not producing upside',
    ]);
  }

  if (p.aggressive.power >= p.passive.defensePower + 12 && p.price.efficiencyScore >= 45 && p.price.displacementPercent > 0.05) {
    return packUpside(p, battleScore, 'BUYERS_WINNING', [
      'Aggressive buy power outscoring passive seller defense',
      'Price responding to the upside attack',
    ]);
  }

  if (Math.abs(p.aggressive.power - p.passive.defensePower) < 10) {
    return packUpside(p, battleScore, 'BALANCED', ['Upside attack and ask defense are evenly matched']);
  }

  if (p.passive.defensePower > p.aggressive.power) {
    return packUpside(p, battleScore, 'SELLERS_DEFENDING', ['Passive seller defense exceeds footprint buy pressure']);
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
  tradeLowConf: boolean;
  bookReliable: boolean;
}): DownsideBattle {
  const aggI = aggressionIntensity(p.aggressive);
  const consI = toBattleIntensity(p.passive.consumption);
  const replI = toBattleIntensity(p.passive.replenishment);
  const withI = toBattleIntensity(p.passive.withdrawal);
  const effI = toBattleIntensity(p.price.efficiency);
  const survivalLow = p.passive.survival < 35;
  const battleScore = battleIntensityScore(p.aggressive.power, p.passive.defensePower, aggI);

  if (p.tradeMissing) {
    return packDownside(p, battleScore, 'NO_MEANINGFUL_BATTLE', ['FOOTPRINT DATA UNAVAILABLE']);
  }
  if (p.tradeLowConf || p.aggressive.lowConfidence) {
    return packDownside(p, battleScore * 0.5, 'LOW_CONFIDENCE', [
      'Footprint / trade data delayed or incomplete — attack side low confidence',
    ]);
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
      'High aggressive sell power with bid replenishment holding',
      'Downward price efficiency remains low',
    ]);
  }

  if (
    aggI === 'HIGH' &&
    (consI === 'HIGH' || consI === 'MODERATE') &&
    (replI === 'LOW' || p.passive.defensePower + 8 < p.aggressive.power) &&
    (effI === 'HIGH' || p.price.efficiencyScore >= 55)
  ) {
    return packDownside(p, battleScore, 'SELLERS_WINNING', [
      'Footprint aggression consuming bid liquidity',
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
    (replI === 'HIGH' || p.passive.survival >= 50 || p.passive.defensePower >= p.aggressive.power)
  ) {
    return packDownside(p, battleScore, 'BUYERS_DEFENDING', [
      'Passive buyers defending the bid',
      'Footprint sell attack is not producing downside',
    ]);
  }

  if (p.aggressive.power >= p.passive.defensePower + 12 && p.price.efficiencyScore >= 45 && p.price.displacementPercent > 0.05) {
    return packDownside(p, battleScore, 'SELLERS_WINNING', [
      'Aggressive sell power outscoring passive buyer defense',
      'Price responding to the downside attack',
    ]);
  }

  if (Math.abs(p.aggressive.power - p.passive.defensePower) < 10) {
    return packDownside(p, battleScore, 'BALANCED', ['Downside attack and bid defense are evenly matched']);
  }

  if (p.passive.defensePower > p.aggressive.power) {
    return packDownside(p, battleScore, 'BUYERS_DEFENDING', ['Passive buyer defense exceeds footprint sell pressure']);
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
  if (agg.percentile >= 70 || agg.power >= 65) return 'HIGH';
  if (agg.percentile >= 40 || agg.power >= 35) return 'MODERATE';
  if (agg.volume > 0 && (agg.percentile >= 20 || agg.power >= 15)) return 'LOW';
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
