import type { FlowBattleConfig } from '../config/types.js';
import { clamp, safeDiv } from '../core/integrity.js';
import type { AbsorptionResult } from '../models/signals.js';
import type { IcebergLikeFlag } from '../models/liquidity.js';
import type { PriceImpactEfficiency } from '../models/trade.js';
import type {
  FlowBattleSnapshot,
  FlowBattleState,
  FlowBias,
  FlowWinner,
  IcebergLikePassive,
  PassiveFlowMetrics,
} from '../models/passive.js';
import { emptyFlowBattle } from '../models/passive.js';
import { DefenseEngine, type DefenseInput } from '../liquidity/defense-engine.js';

export interface FlowWinnerInput {
  price: number;
  aggressiveBuy: number;
  aggressiveSell: number;
  delta: number;
  priceChangePercent: number;
  impact: PriceImpactEfficiency;
  flowMultipleBuy: number;
  flowMultipleSell: number;
  buyBurst: boolean;
  sellBurst: boolean;
  persistentBuy: boolean;
  persistentSell: boolean;
  windowMs: number;
  absorption: AbsorptionResult;
  iceberg: IcebergLikeFlag | null;
  visibleAsk: number;
  visibleBid: number;
  metrics: PassiveFlowMetrics;
}

export class FlowWinnerEngine {
  constructor(
    private readonly config: FlowBattleConfig,
    private readonly defense: DefenseEngine,
  ) {}

  analyze(input: FlowWinnerInput): FlowBattleSnapshot {
    const m = input.metrics;
    const defIn: DefenseInput = {
      price: input.price,
      aggressiveBuy: input.aggressiveBuy,
      aggressiveSell: input.aggressiveSell,
      askConsumed: m.askLiquidityConsumed,
      bidConsumed: m.bidLiquidityConsumed,
      askReplenished: m.askLiquidityReplenished,
      bidReplenished: m.bidLiquidityReplenished,
      askInitial: m.askLiquidityInitial,
      bidInitial: m.bidLiquidityInitial,
      askFinal: m.askLiquidityFinal,
      bidFinal: m.bidLiquidityFinal,
      priceChangePercent: input.priceChangePercent,
      impactLow: input.impact === 'LOW',
    };
    m.askDefenseStrength = this.defense.askDefenseStrength(defIn);
    m.bidDefenseStrength = this.defense.bidDefenseStrength(defIn);

    const askCr = safeDiv(m.askLiquidityConsumed, Math.max(m.askLiquidityReplenished, 1e-9));
    const bidCr = safeDiv(m.bidLiquidityConsumed, Math.max(m.bidLiquidityReplenished, 1e-9));
    const execAsk = safeDiv(input.aggressiveBuy, Math.max(input.visibleAsk, 1e-9));
    const execBid = safeDiv(input.aggressiveSell, Math.max(input.visibleBid, 1e-9));
    const buyEff = buyEfficiency(input.aggressiveBuy, input.priceChangePercent, input.impact);
    const sellEff = sellEfficiency(input.aggressiveSell, input.priceChangePercent, input.impact);

    const aggressiveBuyer = aggressiveStrength({
      volume: input.aggressiveBuy,
      opposing: input.aggressiveSell,
      multiple: input.flowMultipleBuy,
      consumption: m.askLiquidityConsumed,
      replenishment: m.askLiquidityReplenished,
      efficiency: buyEff,
      burst: input.buyBurst,
      persistent: input.persistentBuy,
      minAttack: this.config.minAttackQuote,
    });
    const aggressiveSeller = aggressiveStrength({
      volume: input.aggressiveSell,
      opposing: input.aggressiveBuy,
      multiple: input.flowMultipleSell,
      consumption: m.bidLiquidityConsumed,
      replenishment: m.bidLiquidityReplenished,
      efficiency: sellEff,
      burst: input.sellBurst,
      persistent: input.persistentSell,
      minAttack: this.config.minAttackQuote,
    });
    const passiveSeller = passiveStrength({
      executedAgainst: m.passiveSellExecutedVolume,
      replenishment: m.askLiquidityReplenished,
      consumption: m.askLiquidityConsumed,
      defense: m.askDefenseStrength,
      rejected: input.priceChangePercent <= 0.08,
      iceberg: input.iceberg?.type === 'ICEBERG_LIKE_SELL_ABSORPTION',
      minAttack: this.config.minAttackQuote,
    });
    const passiveBuyer = passiveStrength({
      executedAgainst: m.passiveBuyExecutedVolume,
      replenishment: m.bidLiquidityReplenished,
      consumption: m.bidLiquidityConsumed,
      defense: m.bidDefenseStrength,
      rejected: input.priceChangePercent >= -0.08,
      iceberg: input.iceberg?.type === 'ICEBERG_LIKE_BUY_ABSORPTION',
      minAttack: this.config.minAttackQuote,
    });

    const { winner, score, evidence, state, bias } = decideWinner({
      aggressiveBuyer,
      passiveSeller,
      aggressiveSeller,
      passiveBuyer,
      input,
      askCr,
      bidCr,
      buyEff,
      sellEff,
      consumeOver: this.config.consumeOverReplenish,
      replenishOver: this.config.replenishOverConsume,
      minAttack: this.config.minAttackQuote,
    });

    const failure = this.defense.failure(defIn);
    let defenseZone = null as FlowBattleSnapshot['defenseZone'];
    if (winner.winner === 'PASSIVE_SELLERS' && m.askDefenseStrength >= this.config.minDefenseScore) {
      defenseZone = this.defense.noteDefense(
        input.price,
        'SELL',
        input.aggressiveBuy,
        m.askLiquidityReplenished,
        input.priceChangePercent,
        m.askDefenseStrength,
      );
    } else if (winner.winner === 'PASSIVE_BUYERS' && m.bidDefenseStrength >= this.config.minDefenseScore) {
      defenseZone = this.defense.noteDefense(
        input.price,
        'BUY',
        input.aggressiveSell,
        m.bidLiquidityReplenished,
        input.priceChangePercent,
        m.bidDefenseStrength,
      );
    }

    const icebergLike = toIcebergPassive(input.iceberg, execAsk, execBid);
    const persistentPassive =
      input.windowMs >= 60_000 && winner.winner === 'PASSIVE_SELLERS' && (input.persistentBuy || input.buyBurst)
        ? 'PERSISTENT_PASSIVE_SELLER_CONTROL'
        : input.windowMs >= 60_000 && winner.winner === 'PASSIVE_BUYERS' && (input.persistentSell || input.sellBurst)
          ? 'PERSISTENT_PASSIVE_BUYER_CONTROL'
          : null;

    const out: FlowBattleSnapshot = {
      ...emptyFlowBattle(),
      metrics: m,
      winner: { winner: winner.winner, score, confidence: winner.confidence, evidence },
      battle: {
        aggressiveBuyerStrength: aggressiveBuyer,
        passiveSellerStrength: passiveSeller,
        aggressiveSellerStrength: aggressiveSeller,
        passiveBuyerStrength: passiveBuyer,
        bullishControl: clamp(aggressiveBuyer - passiveSeller, -100, 100),
        bearishControl: clamp(aggressiveSeller - passiveBuyer, -100, 100),
        winner: winner.winner,
      },
      state,
      bias,
      failure: failure && failure.confidence >= this.config.minFailureConfidence ? failure : null,
      icebergLike,
      defenseZone,
      executionToVisibleAsk: execAsk,
      executionToVisibleBid: execBid,
      askConsumptionToReplenishment: askCr,
      bidConsumptionToReplenishment: bidCr,
      buyExecutionEfficiency: buyEff,
      sellExecutionEfficiency: sellEff,
      persistentPassive,
    };
    return out;
  }
}

function aggressiveStrength(p: {
  volume: number;
  opposing: number;
  multiple: number;
  consumption: number;
  replenishment: number;
  efficiency: number;
  burst: boolean;
  persistent: boolean;
  minAttack: number;
}): number {
  if (p.volume < p.minAttack * 0.2) return 0;
  const share = p.volume / Math.max(p.volume + p.opposing, 1);
  const consume = p.consumption / Math.max(p.consumption + p.replenishment, 1);
  let s = 18 * share + 22 * clamp((Number.isFinite(p.multiple) ? p.multiple : 1) / 6, 0, 1);
  s += 22 * consume + 28 * p.efficiency;
  if (p.burst) s += 5;
  if (p.persistent) s += 5;
  return clamp(s, 0, 100);
}

function passiveStrength(p: {
  executedAgainst: number;
  replenishment: number;
  consumption: number;
  defense: number;
  rejected: boolean;
  iceberg: boolean;
  minAttack: number;
}): number {
  if (p.executedAgainst < p.minAttack * 0.2 && p.defense < 20) return 0;
  const replenish = p.replenishment / Math.max(p.replenishment + p.consumption, 1);
  let s = 20 * clamp(p.executedAgainst / Math.max(p.minAttack * 8, 1), 0, 1);
  s += 30 * replenish + 0.35 * p.defense;
  if (p.rejected) s += 12;
  if (p.iceberg) s += 8;
  return clamp(s, 0, 100);
}

function buyEfficiency(buy: number, chg: number, impact: PriceImpactEfficiency): number {
  if (buy <= 0) return 0;
  if (chg <= 0) return 0;
  const impactN = impact === 'EXTREME' ? 1 : impact === 'HIGH' ? 0.75 : impact === 'NORMAL' ? 0.45 : 0.15;
  return clamp(0.5 * impactN + 0.5 * clamp(chg / 0.4, 0, 1), 0, 1);
}

function sellEfficiency(sell: number, chg: number, impact: PriceImpactEfficiency): number {
  if (sell <= 0) return 0;
  if (chg >= 0) return 0;
  const impactN = impact === 'EXTREME' ? 1 : impact === 'HIGH' ? 0.75 : impact === 'NORMAL' ? 0.45 : 0.15;
  return clamp(0.5 * impactN + 0.5 * clamp(-chg / 0.4, 0, 1), 0, 1);
}

function decideWinner(p: {
  aggressiveBuyer: number;
  passiveSeller: number;
  aggressiveSeller: number;
  passiveBuyer: number;
  input: FlowWinnerInput;
  askCr: number;
  bidCr: number;
  buyEff: number;
  sellEff: number;
  consumeOver: number;
  replenishOver: number;
  minAttack: number;
}): {
  winner: { winner: FlowWinner; confidence: number };
  score: number;
  evidence: string[];
  state: FlowBattleState;
  bias: FlowBias;
} {
  const i = p.input;
  const upGap = p.aggressiveBuyer - p.passiveSeller;
  const downGap = p.aggressiveSeller - p.passiveBuyer;
  const buyAttack = i.aggressiveBuy >= p.minAttack;
  const sellAttack = i.aggressiveSell >= p.minAttack;
  const askEaten = i.metrics.askLiquidityRemoved > i.metrics.askLiquidityAdded * 1.15 || p.askCr >= p.consumeOver;
  const bidEaten = i.metrics.bidLiquidityRemoved > i.metrics.bidLiquidityAdded * 1.15 || p.bidCr >= p.consumeOver;
  const asksBreaking = askEaten && p.buyEff >= 0.3 && i.priceChangePercent > 0.05;
  const bidsBreaking = bidEaten && p.sellEff >= 0.3 && i.priceChangePercent < -0.05;
  const asksDefending = p.askCr > 0 && p.askCr <= 1 / p.replenishOver && i.priceChangePercent <= 0.08;
  const bidsDefending = p.bidCr > 0 && p.bidCr <= 1 / p.replenishOver && i.priceChangePercent >= -0.08;

  const evidence: string[] = [];

  if (!buyAttack && !sellAttack) {
    return {
      winner: { winner: 'BALANCED', confidence: 0.7 },
      score: 0,
      evidence: ['Aggressive buying and selling are both moderate'],
      state: 'BALANCED_AUCTION',
      bias: 'NEUTRAL',
    };
  }

  if (i.absorption.detected && i.absorption.type === 'BUYER_ABSORPTION') {
    evidence.push('Large positive delta', 'Minimal upside price response');
    if (asksDefending || i.absorption.absorbingSide === 'PASSIVE_SELLER') {
      evidence.push('Ask liquidity persisted or replenished');
    }
    return pack('PASSIVE_SELLERS', Math.max(p.passiveSeller, 70), evidence, 'BUYERS_ABSORBED', 'POTENTIALLY_BEARISH', 0.78);
  }
  if (i.absorption.detected && i.absorption.type === 'SELLER_ABSORPTION') {
    evidence.push('Large negative delta', 'Minimal downside price response');
    if (bidsDefending) evidence.push('Bid liquidity persisted or replenished');
    return pack('PASSIVE_BUYERS', Math.max(p.passiveBuyer, 70), evidence, 'SELLERS_ABSORBED', 'POTENTIALLY_BULLISH', 0.78);
  }

  if (buyAttack && asksBreaking && upGap > 0) {
    evidence.push('Aggressive buys consumed asks', 'Price rising with the buy flow');
    return pack('AGGRESSIVE_BUYERS', p.aggressiveBuyer, evidence, 'BUYERS_BREAKING_ASKS', 'BULLISH_CONTINUATION', 0.8);
  }
  if (sellAttack && bidsBreaking && downGap > 0) {
    evidence.push('Aggressive sells consumed bids', 'Price falling with the sell flow');
    return pack('AGGRESSIVE_SELLERS', p.aggressiveSeller, evidence, 'SELLERS_BREAKING_BIDS', 'BEARISH_CONTINUATION', 0.8);
  }
  if (buyAttack && i.priceChangePercent > 0.12 && p.buyEff >= 0.3 && p.aggressiveBuyer >= p.passiveSeller) {
    evidence.push('Price rising with aggressive buy flow');
    return pack('AGGRESSIVE_BUYERS', p.aggressiveBuyer, evidence, 'BUYERS_BREAKING_ASKS', 'BULLISH_CONTINUATION', 0.74);
  }
  if (sellAttack && i.priceChangePercent < -0.12 && p.sellEff >= 0.3 && p.aggressiveSeller >= p.passiveBuyer) {
    evidence.push('Price falling with aggressive sell flow');
    return pack('AGGRESSIVE_SELLERS', p.aggressiveSeller, evidence, 'SELLERS_BREAKING_BIDS', 'BEARISH_CONTINUATION', 0.74);
  }

  if (buyAttack && (asksDefending || p.passiveSeller > p.aggressiveBuyer + 5) && i.priceChangePercent <= 0.12) {
    evidence.push('Aggressive buying failed to lift price', 'Passive sellers defending the ask');
    const absorbed = i.priceChangePercent <= 0.04 && p.passiveSeller >= 55;
    return pack(
      'PASSIVE_SELLERS',
      p.passiveSeller,
      evidence,
      absorbed ? 'BUYERS_ABSORBED' : 'PASSIVE_SELLERS_DEFENDING',
      'POTENTIALLY_BEARISH',
      0.72,
    );
  }
  if (sellAttack && (bidsDefending || p.passiveBuyer > p.aggressiveSeller + 5) && i.priceChangePercent >= -0.12) {
    evidence.push('Aggressive selling failed to push price down', 'Passive buyers defending the bid');
    const absorbed = i.priceChangePercent >= -0.04 && p.passiveBuyer >= 55;
    return pack(
      'PASSIVE_BUYERS',
      p.passiveBuyer,
      evidence,
      absorbed ? 'SELLERS_ABSORBED' : 'PASSIVE_BUYERS_DEFENDING',
      'POTENTIALLY_BULLISH',
      0.72,
    );
  }

  if (buyAttack && upGap > 12 && downGap < 8) {
    evidence.push('Buyers attacking asks');
    return pack('UNRESOLVED', Math.abs(upGap), evidence, 'BUYERS_ATTACKING', 'NEUTRAL', 0.55);
  }
  if (sellAttack && downGap > 12 && upGap < 8) {
    evidence.push('Sellers attacking bids');
    return pack('UNRESOLVED', Math.abs(downGap), evidence, 'SELLERS_ATTACKING', 'NEUTRAL', 0.55);
  }

  if (Math.abs(upGap) < 10 && Math.abs(downGap) < 10) {
    return {
      winner: { winner: 'BALANCED', confidence: 0.65 },
      score: 0,
      evidence: ['Neither side is controlling price'],
      state: 'BALANCED_AUCTION',
      bias: 'NEUTRAL',
    };
  }

  return {
    winner: { winner: 'UNRESOLVED', confidence: 0.5 },
    score: Math.max(Math.abs(upGap), Math.abs(downGap)),
    evidence: ['Flow and price response disagree'],
    state: 'BALANCED_AUCTION',
    bias: 'NEUTRAL',
  };
}

function pack(
  winner: FlowWinner,
  score: number,
  evidence: string[],
  state: FlowBattleState,
  bias: FlowBias,
  confidence: number,
) {
  return {
    winner: { winner, confidence },
    score: clamp(score, 0, 100),
    evidence,
    state,
    bias,
  };
}

function toIcebergPassive(
  flag: IcebergLikeFlag | null,
  execAsk: number,
  execBid: number,
): IcebergLikePassive | null {
  if (!flag) return null;
  if (flag.type === 'ICEBERG_LIKE_SELL_ABSORPTION') {
    return {
      type: 'ICEBERG_LIKE_PASSIVE_SELLING',
      visibleLiquidity: flag.visibleQuote,
      executedAgainstLevel: flag.aggressiveQuote,
      replenishmentRatio: execAsk,
      confidence: clamp(0.5 + Math.min(flag.aggressiveQuote / Math.max(flag.visibleQuote, 1) / 20, 0.35), 0, 1),
    };
  }
  return {
    type: 'ICEBERG_LIKE_PASSIVE_BUYING',
    visibleLiquidity: flag.visibleQuote,
    executedAgainstLevel: flag.aggressiveQuote,
    replenishmentRatio: execBid,
    confidence: clamp(0.5 + Math.min(flag.aggressiveQuote / Math.max(flag.visibleQuote, 1) / 20, 0.35), 0, 1),
  };
}
