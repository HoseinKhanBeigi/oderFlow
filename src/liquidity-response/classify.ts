import { pctChange, safeDiv } from '../core/integrity.js';
import type { LiquidityResponseConfig } from '../config/types.js';
import type {
  AggressionSide,
  ConfidenceLabel,
  EffortVsResultState,
  EfficiencyMetrics,
  IntensityLabel,
  LiquidityAbsorption,
  LiquiditySideResponse,
  MicrostructureState,
  ReversalSetup,
  VacuumKind,
  WhyFact,
} from '../models/liquidity-response.js';
import type { BookWindow } from './book-accountant.js';

export interface ClassifyInput {
  buy: number;
  sell: number;
  delta: number;
  priceStart: number;
  priceEnd: number;
  priceHigh: number;
  priceLow: number;
  atr: number;
  nearAskShare: number;
  nearBidShare: number;
  book: BookWindow;
  buyPct: number;
  sellPct: number;
  deltaPct: number;
  movePct: number;
  absEffPct: number;
  askConsPct: number;
  askReplPct: number;
  askPullPct: number;
  bidConsPct: number;
  bidReplPct: number;
  bidPullPct: number;
  repeatedAsk: boolean;
  repeatedBid: boolean;
  hasBook: boolean;
  ticks: number;
  spotConfirms?: boolean | null;
  futuresConfirms?: boolean | null;
}

export function efficiencyMetrics(input: {
  buy: number;
  sell: number;
  priceStart: number;
  priceEnd: number;
  priceHigh: number;
  priceLow: number;
  atr: number;
  classification: IntensityLabel;
}): EfficiencyMetrics {
  const total = input.buy + input.sell;
  const delta = input.buy - input.sell;
  const priceChange = input.priceEnd - input.priceStart;
  const priceChangePercent = pctChange(input.priceStart, input.priceEnd);
  const range = Math.max(0, input.priceHigh - input.priceLow);
  const atr = input.atr > 0 ? input.atr : range;
  const absMove = Math.abs(priceChange);
  return {
    aggressiveBuyVolume: input.buy,
    aggressiveSellVolume: input.sell,
    totalExecutedVolume: total,
    delta,
    priceChange,
    priceChangePercent,
    priceRange: range,
    atrNormalized: atr > 0 ? absMove / atr : 0,
    absoluteEfficiency: safeDiv(absMove, total),
    directionalEfficiency: safeDiv(priceChange, Math.abs(delta)),
    bpsPer100m: safeDiv(Math.abs(priceChangePercent) * 100, total / 100_000_000),
    classification: input.classification,
  };
}

export function intensityFromPercentile(p: number): IntensityLabel {
  if (p >= 92) return 'EXTREME';
  if (p >= 75) return 'HIGH';
  if (p <= 25) return 'LOW';
  return 'NORMAL';
}

export function aggressionSide(buyPct: number, sellPct: number, delta: number): AggressionSide {
  if (buyPct >= 60 && buyPct >= sellPct + 8) return 'BUYERS';
  if (sellPct >= 60 && sellPct >= buyPct + 8) return 'SELLERS';
  if (delta > 0 && buyPct >= 55) return 'BUYERS';
  if (delta < 0 && sellPct >= 55) return 'SELLERS';
  return 'BALANCED';
}

export function detectAbsorption(cfg: LiquidityResponseConfig, input: ClassifyInput): LiquidityAbsorption {
  const empty: LiquidityAbsorption = {
    detected: false,
    kind: null,
    absorbingSide: null,
    strength: 0,
    usedBookEvidence: false,
    usedPriceEvidence: false,
  };

  const largeBuy = input.buyPct >= cfg.largeAggressionPercentile;
  const largeSell = input.sellPct >= cfg.largeAggressionPercentile;
  const extremeBuy = input.buyPct >= cfg.extremeAggressionPercentile;
  const extremeSell = input.sellPct >= cfg.extremeAggressionPercentile;
  const weakMove = input.movePct <= cfg.weakDisplacementPercentile;
  const priceFailedUp = pctChange(input.priceStart, input.priceEnd) <= 0.04;
  const priceFailedDown = pctChange(input.priceStart, input.priceEnd) >= -0.04;

  const askDefense =
    input.book.ask.response === 'REPLENISHMENT' ||
    input.repeatedAsk ||
    input.askReplPct >= 70 ||
    input.nearAskShare >= cfg.nearTouchShare;
  const bidDefense =
    input.book.bid.response === 'REPLENISHMENT' ||
    input.repeatedBid ||
    input.bidReplPct >= 70 ||
    input.nearBidShare >= cfg.nearTouchShare;

  if (input.delta > 0 && largeBuy && priceFailedUp && weakMove && askDefense) {
    const usedBook =
      input.hasBook &&
      (input.book.ask.response === 'REPLENISHMENT' || input.repeatedAsk || input.askReplPct >= 60);
    if (!usedBook && input.nearAskShare < cfg.nearTouchShare) return empty;
    const strength = Math.min(
      1,
      0.45 +
        (extremeBuy ? 0.2 : 0.1) +
        (usedBook ? 0.2 : 0.05) +
        (input.nearAskShare >= cfg.nearTouchShare ? 0.1 : 0) +
        (input.repeatedAsk ? 0.1 : 0),
    );
    return {
      detected: strength >= 0.55,
      kind: strength >= 0.55 ? 'SELL_ABSORPTION' : null,
      absorbingSide: strength >= 0.55 ? 'PASSIVE_SELLER' : null,
      strength,
      usedBookEvidence: usedBook,
      usedPriceEvidence: true,
    };
  }

  if (input.delta < 0 && largeSell && priceFailedDown && weakMove && bidDefense) {
    const usedBook =
      input.hasBook &&
      (input.book.bid.response === 'REPLENISHMENT' || input.repeatedBid || input.bidReplPct >= 60);
    if (!usedBook && input.nearBidShare < cfg.nearTouchShare) return empty;
    const strength = Math.min(
      1,
      0.45 +
        (extremeSell ? 0.2 : 0.1) +
        (usedBook ? 0.2 : 0.05) +
        (input.nearBidShare >= cfg.nearTouchShare ? 0.1 : 0) +
        (input.repeatedBid ? 0.1 : 0),
    );
    return {
      detected: strength >= 0.55,
      kind: strength >= 0.55 ? 'BUY_ABSORPTION' : null,
      absorbingSide: strength >= 0.55 ? 'PASSIVE_BUYER' : null,
      strength,
      usedBookEvidence: usedBook,
      usedPriceEvidence: true,
    };
  }

  return empty;
}

export function detectVacuum(cfg: LiquidityResponseConfig, input: ClassifyInput): VacuumKind {
  const buyAttack = input.buyPct >= 60 && input.delta > 0;
  const sellAttack = input.sellPct >= 60 && input.delta < 0;
  const askGone =
    (input.book.ask.response === 'WITHDRAWAL' || input.askPullPct >= 70) &&
    input.book.askDepthChange < 0 &&
    input.book.ask.cancelled >= input.book.ask.consumed * cfg.vacuumPullShare;
  const bidGone =
    (input.book.bid.response === 'WITHDRAWAL' || input.bidPullPct >= 70) &&
    input.book.bidDepthChange < 0 &&
    input.book.bid.cancelled >= input.book.bid.consumed * cfg.vacuumPullShare;
  const upMove = pctChange(input.priceStart, input.priceEnd) > 0.05 && input.movePct >= 55;
  const downMove = pctChange(input.priceStart, input.priceEnd) < -0.05 && input.movePct >= 55;
  const spreadOut = input.book.spreadDeltaBps >= cfg.vacuumSpreadExpandBps;

  if (buyAttack && askGone && (upMove || spreadOut)) return 'UPSIDE_LIQUIDITY_VACUUM';
  if (sellAttack && bidGone && (downMove || spreadOut)) return 'DOWNSIDE_LIQUIDITY_VACUUM';
  return null;
}

export function classifyEffort(
  cfg: LiquidityResponseConfig,
  input: ClassifyInput,
  absorption: LiquidityAbsorption,
): EffortVsResultState {
  if (input.buy + input.sell <= 0) return 'INSUFFICIENT';
  if (absorption.detected && absorption.kind === 'SELL_ABSORPTION') return 'BUY_ABSORPTION';
  if (absorption.detected && absorption.kind === 'BUY_ABSORPTION') return 'SELL_ABSORPTION';

  const largeBuy = input.buyPct >= cfg.largeAggressionPercentile;
  const largeSell = input.sellPct >= cfg.largeAggressionPercentile;
  const strongMove = input.movePct >= cfg.strongDisplacementPercentile;
  const weakMove = input.movePct <= cfg.weakDisplacementPercentile;
  const px = pctChange(input.priceStart, input.priceEnd);
  const askGone = input.book.ask.response === 'CONSUMPTION' || input.book.ask.response === 'WITHDRAWAL';
  const bidGone = input.book.bid.response === 'CONSUMPTION' || input.book.bid.response === 'WITHDRAWAL';

  if (input.delta > 0 && largeBuy) {
    if (px > 0 && strongMove) return askGone || strongMove ? 'EFFICIENT_BUYING' : 'INEFFICIENT_BUYING';
    if (weakMove || px <= 0) return 'INEFFICIENT_BUYING';
  }
  if (input.delta < 0 && largeSell) {
    if (px < 0 && strongMove) return bidGone || strongMove ? 'EFFICIENT_SELLING' : 'INEFFICIENT_SELLING';
    if (weakMove || px >= 0) return 'INEFFICIENT_SELLING';
  }
  return 'BALANCED';
}

export function classifyState(
  effort: EffortVsResultState,
  absorption: LiquidityAbsorption,
  vacuum: VacuumKind,
  book: BookWindow,
): MicrostructureState {
  if (vacuum === 'UPSIDE_LIQUIDITY_VACUUM') return 'UPSIDE_LIQUIDITY_VACUUM';
  if (vacuum === 'DOWNSIDE_LIQUIDITY_VACUUM') return 'DOWNSIDE_LIQUIDITY_VACUUM';
  if (absorption.detected && absorption.kind === 'SELL_ABSORPTION') return 'BUYERS_BEING_ABSORBED';
  if (absorption.detected && absorption.kind === 'BUY_ABSORPTION') return 'SELLERS_BEING_ABSORBED';
  if (effort === 'EFFICIENT_BUYING') return 'BUYERS_IN_CONTROL';
  if (effort === 'EFFICIENT_SELLING') return 'SELLERS_IN_CONTROL';
  if (book.ask.response === 'REPLENISHMENT' && effort === 'INEFFICIENT_BUYING') return 'PASSIVE_SELLERS_DEFENDING';
  if (book.bid.response === 'REPLENISHMENT' && effort === 'INEFFICIENT_SELLING') return 'PASSIVE_BUYERS_DEFENDING';
  if (effort === 'INEFFICIENT_BUYING' || effort === 'INEFFICIENT_SELLING') return 'TRANSITION';
  return 'BALANCED';
}

export function classifyConfidence(
  input: ClassifyInput,
  absorption: LiquidityAbsorption,
  vacuum: VacuumKind,
  effort: EffortVsResultState,
): ConfidenceLabel {
  let agree = 0;
  let disagree = 0;
  const buyCtrl = effort === 'EFFICIENT_BUYING' || vacuum === 'UPSIDE_LIQUIDITY_VACUUM';
  const sellCtrl = effort === 'EFFICIENT_SELLING' || vacuum === 'DOWNSIDE_LIQUIDITY_VACUUM';

  if (input.buyPct >= 75 || input.sellPct >= 75) agree += 1;
  else if (input.buyPct >= 55 || input.sellPct >= 55) agree += 0.5;

  const bookWithBuy = input.book.ask.response === 'CONSUMPTION' || input.book.ask.response === 'WITHDRAWAL';
  const bookWithSell = input.book.bid.response === 'CONSUMPTION' || input.book.bid.response === 'WITHDRAWAL';
  const bookAgainstBuy = input.book.ask.response === 'REPLENISHMENT';
  const bookAgainstSell = input.book.bid.response === 'REPLENISHMENT';

  if (buyCtrl && bookWithBuy) agree += 1;
  else if (sellCtrl && bookWithSell) agree += 1;
  else if (buyCtrl && bookAgainstBuy) disagree += 1;
  else if (sellCtrl && bookAgainstSell) disagree += 1;
  else if (absorption.usedBookEvidence) agree += 1;

  if (input.movePct >= 70 && (buyCtrl || sellCtrl)) agree += 1;
  else if (input.movePct <= 40 && (buyCtrl || sellCtrl)) disagree += 1;
  else if (absorption.usedPriceEvidence) agree += 1;

  if (input.spotConfirms === true || input.futuresConfirms === true) agree += 1;
  if (input.spotConfirms === false || input.futuresConfirms === false) disagree += 1;

  if (agree >= 3.5 && disagree < 1) return 'HIGH';
  if (agree >= 2 && disagree <= 1) return 'MEDIUM';
  return 'LOW';
}

export function whyFacts(input: ClassifyInput, absorption: LiquidityAbsorption, compareYes: boolean | null): WhyFact[] {
  const askCh = input.book.ask.remaining - input.book.ask.initial;
  const askPct = input.book.ask.initial > 0 ? (askCh / input.book.ask.initial) * 100 : 0;
  const facts: WhyFact[] = [
    { label: 'Aggressive buyers', value: `${Math.round(input.buyPct)}th percentile`, percentile: input.buyPct },
    {
      label: input.delta >= 0 ? 'Positive Delta' : 'Negative Delta',
      value: `${Math.round(input.deltaPct)}th percentile`,
      percentile: input.deltaPct,
    },
    { label: 'Ask liquidity', value: `${askPct >= 0 ? '+' : ''}${askPct.toFixed(0)}%` },
    { label: 'Price displacement', value: `${Math.round(input.movePct)}th percentile`, percentile: input.movePct },
  ];
  if (compareYes != null) facts.push({ label: 'Spot confirmation', value: compareYes ? 'YES' : 'NO' });
  if (absorption.detected) {
    facts.push({
      label: 'Absorption',
      value: absorption.kind === 'SELL_ABSORPTION' ? 'passive sellers' : 'passive buyers',
    });
  }
  return facts;
}

export function detectReversal(
  cfg: LiquidityResponseConfig,
  input: ClassifyInput,
  absorption: LiquidityAbsorption,
): ReversalSetup | null {
  const px = pctChange(input.priceStart, input.priceEnd);
  const midRange = (input.priceHigh + input.priceLow) / 2 || input.priceEnd;
  const reclaimed = input.priceEnd > midRange && px > 0;
  const lost = input.priceEnd < midRange && px < 0;
  const majorBid = input.book.bid.remaining > 0 && input.book.bid.remaining >= input.book.ask.remaining;
  const majorAsk = input.book.ask.remaining > 0 && input.book.ask.remaining >= input.book.bid.remaining;

  const bullish =
    majorBid &&
    input.sellPct >= cfg.largeAggressionPercentile &&
    (input.repeatedBid || input.book.bid.response === 'REPLENISHMENT') &&
    absorption.kind === 'BUY_ABSORPTION' &&
    input.absEffPct <= 45 &&
    reclaimed;

  const bearish =
    majorAsk &&
    input.buyPct >= cfg.largeAggressionPercentile &&
    (input.repeatedAsk || input.book.ask.response === 'REPLENISHMENT') &&
    absorption.kind === 'SELL_ABSORPTION' &&
    input.absEffPct <= 45 &&
    lost;

  if (bullish) {
    return {
      detected: true,
      kind: 'BULLISH',
      label: 'POTENTIAL_REVERSAL_CONDITIONS_DETECTED',
      reasons: [
        'major bid liquidity',
        'aggressive selling',
        'bid replenishment',
        'passive buyer absorption',
        'selling efficiency decreased',
        'price reclaimed local structure',
      ],
    };
  }
  if (bearish) {
    return {
      detected: true,
      kind: 'BEARISH',
      label: 'POTENTIAL_REVERSAL_CONDITIONS_DETECTED',
      reasons: [
        'major ask liquidity',
        'aggressive buying',
        'ask replenishment',
        'passive seller absorption',
        'buying efficiency decreased',
        'price lost local structure',
      ],
    };
  }
  return null;
}

export function responseIntensity(
  addedPct: number,
  cancelPct: number,
  consumePct: number,
): { consumption: IntensityLabel; replenishment: IntensityLabel; withdrawal: IntensityLabel } {
  return {
    consumption: intensityFromPercentile(consumePct),
    replenishment: intensityFromPercentile(addedPct),
    withdrawal: intensityFromPercentile(cancelPct),
  };
}

export type { LiquiditySideResponse };
