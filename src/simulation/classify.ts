import { intensityFromPercentile, safeDiv } from './math.js';
import type {
  EffortVsResult,
  SimulationMarketState,
  WhyFact,
} from './types.js';

export interface ClassifyInput {
  aggressiveBuy: number;
  aggressiveSell: number;
  delta: number;
  priceChangeBps: number;
  levelsConsumedUp: number;
  levelsConsumedDown: number;
  askConsumption: number;
  bidConsumption: number;
  askReplenishment: number;
  bidReplenishment: number;
  askWithdrawal: number;
  bidWithdrawal: number;
  buyerAbsorption: number;
  sellerAbsorption: number;
  upsideVacuum: boolean;
  downsideVacuum: boolean;
  askDefense: boolean;
  bidDefense: boolean;
  buyPercentile: number;
  sellPercentile: number;
  impactPercentile: number;
  shortLiquidations: number;
  longLiquidations: number;
  oiClassification?: string;
}

export function classifyEffort(input: ClassifyInput): EffortVsResult {
  const buy = input.aggressiveBuy;
  const sell = input.aggressiveSell;
  const total = buy + sell;
  if (total <= 1_000) return 'INSUFFICIENT';

  const up = input.priceChangeBps;
  const buyDom = buy >= sell * 1.25;
  const sellDom = sell >= buy * 1.25;

  if (input.buyerAbsorption >= 0.35 && buyDom) return 'BUYER_ABSORPTION';
  if (input.sellerAbsorption >= 0.35 && sellDom) return 'SELLER_ABSORPTION';

  if (buyDom && up >= 12 && input.askReplenishment < input.askConsumption * 0.5) return 'EFFICIENT_BUYING';
  if (sellDom && up <= -12 && input.bidReplenishment < input.bidConsumption * 0.5) return 'EFFICIENT_SELLING';

  if (buyDom && Math.abs(up) < 8) return 'INEFFICIENT_BUYING';
  if (sellDom && Math.abs(up) < 8) return 'INEFFICIENT_SELLING';

  if (buyDom && up > 0) return 'EFFICIENT_BUYING';
  if (sellDom && up < 0) return 'EFFICIENT_SELLING';
  return 'BALANCED';
}

export function classifyMarketState(input: ClassifyInput): SimulationMarketState {
  if (input.shortLiquidations > 0 && input.priceChangeBps > 0 && input.oiClassification === 'SHORT_COVERING') {
    return 'SHORT_SQUEEZE_DOMINATED';
  }
  if (input.longLiquidations > 0 && input.priceChangeBps < 0 && input.oiClassification === 'LONG_UNWIND') {
    return 'LONG_SQUEEZE_DOMINATED';
  }
  if (input.oiClassification === 'SHORT_COVERING') return 'SHORT_COVERING_DOMINATED';
  if (input.oiClassification === 'LONG_UNWIND') return 'LONG_UNWIND_DOMINATED';

  if (input.buyerAbsorption >= 0.35 || (input.askDefense && input.aggressiveBuy > input.aggressiveSell)) {
    return input.askDefense ? 'PASSIVE_SELLERS_DEFENDING' : 'BUYERS_BEING_ABSORBED';
  }
  if (input.sellerAbsorption >= 0.35 || (input.bidDefense && input.aggressiveSell > input.aggressiveBuy)) {
    return input.bidDefense ? 'PASSIVE_BUYERS_DEFENDING' : 'SELLERS_BEING_ABSORBED';
  }
  if (input.upsideVacuum) return 'UPSIDE_LIQUIDITY_VACUUM';
  if (input.downsideVacuum) return 'DOWNSIDE_LIQUIDITY_VACUUM';

  const buyDom = input.aggressiveBuy >= input.aggressiveSell * 1.25 && input.priceChangeBps > 0;
  const sellDom = input.aggressiveSell >= input.aggressiveBuy * 1.25 && input.priceChangeBps < 0;
  if (buyDom && input.levelsConsumedUp > 0) return 'BUYERS_IN_CONTROL';
  if (sellDom && input.levelsConsumedDown > 0) return 'SELLERS_IN_CONTROL';
  if (buyDom) return 'BUYERS_IN_CONTROL';
  if (sellDom) return 'SELLERS_IN_CONTROL';
  if (Math.abs(input.priceChangeBps) > 4 && Math.abs(input.delta) > 0) return 'TRANSITION';
  return 'BALANCED';
}

export function mechanicsLine(state: SimulationMarketState, effort: EffortVsResult): string {
  switch (state) {
    case 'UPSIDE_LIQUIDITY_VACUUM':
      return 'FLOW + LIQUIDITY-DRIVEN UP';
    case 'DOWNSIDE_LIQUIDITY_VACUUM':
      return 'FLOW + LIQUIDITY-DRIVEN DOWN';
    case 'PASSIVE_SELLERS_DEFENDING':
    case 'BUYERS_BEING_ABSORBED':
      return 'AGGRESSION ABSORBED BY ASK REPLENISHMENT';
    case 'PASSIVE_BUYERS_DEFENDING':
    case 'SELLERS_BEING_ABSORBED':
      return 'AGGRESSION ABSORBED BY BID REPLENISHMENT';
    case 'SHORT_SQUEEZE_DOMINATED':
    case 'SHORT_COVERING_DOMINATED':
      return 'FORCED BUYING FROM SHORT LIQUIDATIONS';
    case 'LONG_SQUEEZE_DOMINATED':
    case 'LONG_UNWIND_DOMINATED':
      return 'FORCED SELLING FROM LONG LIQUIDATIONS';
    case 'BUYERS_IN_CONTROL':
      return effort === 'EFFICIENT_BUYING' ? 'FLOW + CONSUMPTION DRIVEN UP' : 'BUYERS PRESENT, IMPACT MIXED';
    case 'SELLERS_IN_CONTROL':
      return effort === 'EFFICIENT_SELLING' ? 'FLOW + CONSUMPTION DRIVEN DOWN' : 'SELLERS PRESENT, IMPACT MIXED';
    default:
      return 'NO DOMINANT MECHANIC';
  }
}

export function priceEfficiencyLabel(input: ClassifyInput): 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME' {
  const effort = Math.max(input.aggressiveBuy, input.aggressiveSell);
  const result = Math.abs(input.priceChangeBps);
  const score = safeDiv(result, effort / 1_000_000);
  if (input.impactPercentile > 0) return intensityFromPercentile(input.impactPercentile);
  if (score >= 8) return 'EXTREME';
  if (score >= 3) return 'HIGH';
  if (score <= 0.4) return 'LOW';
  return 'NORMAL';
}

export function whyFacts(input: ClassifyInput): WhyFact[] {
  const facts: WhyFact[] = [];
  const up = input.priceChangeBps >= 0;
  const buyPct = input.buyPercentile;
  const sellPct = input.sellPercentile;

  if (up) {
    if (buyPct >= 75) facts.push({ text: `Aggressive buying is ${buyPct.toFixed(0)}th percentile`, weight: 1 });
    if (input.levelsConsumedUp > 0) {
      facts.push({
        text: `Buyers consumed ${input.levelsConsumedUp} ask level${input.levelsConsumedUp === 1 ? '' : 's'}`,
        weight: 1.1,
      });
    }
    if (input.askWithdrawal > 0 && input.askWithdrawal >= input.askConsumption * 0.25) {
      const share = safeDiv(input.askWithdrawal, input.askWithdrawal + input.askConsumption);
      facts.push({ text: `${Math.round(share * 100)}% of nearby asks were withdrawn`, weight: 1.2 });
    }
    if (input.askReplenishment < input.askConsumption * 0.4 && input.askConsumption > 0) {
      facts.push({ text: 'Ask replenishment is weak relative to consumption', weight: 0.9 });
    }
    if (input.askReplenishment > input.askConsumption * 0.7 && input.askConsumption > 0) {
      facts.push({ text: 'Passive sellers are replenishing asks as they are hit', weight: 1.2 });
    }
    if (input.upsideVacuum) facts.push({ text: 'Ask liquidity vacuum is amplifying upside displacement', weight: 1.3 });
    if (input.shortLiquidations > 0) {
      facts.push({ text: 'Short liquidations are adding forced buy aggression', weight: 1.2 });
    }
    if (input.impactPercentile >= 75) {
      facts.push({ text: `Price impact is ${input.impactPercentile.toFixed(0)}th percentile`, weight: 0.8 });
    }
  } else {
    if (sellPct >= 75) facts.push({ text: `Aggressive selling is ${sellPct.toFixed(0)}th percentile`, weight: 1 });
    if (input.levelsConsumedDown > 0) {
      facts.push({
        text: `Sellers consumed ${input.levelsConsumedDown} bid level${input.levelsConsumedDown === 1 ? '' : 's'}`,
        weight: 1.1,
      });
    }
    if (input.bidWithdrawal > 0 && input.bidWithdrawal >= input.bidConsumption * 0.25) {
      facts.push({ text: 'Nearby bids were withdrawn ahead of price', weight: 1.2 });
    }
    if (input.bidReplenishment < input.bidConsumption * 0.4 && input.bidConsumption > 0) {
      facts.push({ text: 'Bid replenishment is weak relative to consumption', weight: 0.9 });
    }
    if (input.bidReplenishment > input.bidConsumption * 0.7 && input.bidConsumption > 0) {
      facts.push({ text: 'Passive buyers are replenishing bids as they are hit', weight: 1.2 });
    }
    if (input.downsideVacuum) facts.push({ text: 'Bid liquidity vacuum is amplifying downside displacement', weight: 1.3 });
    if (input.longLiquidations > 0) {
      facts.push({ text: 'Long liquidations are adding forced sell aggression', weight: 1.2 });
    }
  }

  if (!facts.length) {
    facts.push({
      text: 'Aggressive effort and passive liquidity are roughly balanced this tick',
      weight: 0.4,
    });
  }
  return facts.sort((a, b) => b.weight - a.weight).slice(0, 8);
}

export function whyHeadline(state: SimulationMarketState, bps: number): string {
  if (state === 'BALANCED' || state === 'NO_SIGNAL') return 'WHY IS PRICE STABLE?';
  if (bps > 0) return 'WHY IS PRICE MOVING UP?';
  if (bps < 0) return 'WHY IS PRICE MOVING DOWN?';
  return 'WHY IS PRICE STALLING?';
}