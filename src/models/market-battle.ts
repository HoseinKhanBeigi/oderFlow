import type { WindowId } from './trade.js';
import type { IntensityLabel } from './liquidity-response.js';

/** Aggressive buyers vs passive sellers. */
export type UpsideBattleState =
  | 'BUYERS_WINNING'
  | 'SELLERS_DEFENDING'
  | 'SELLER_ABSORPTION'
  | 'UPSIDE_VACUUM'
  | 'BALANCED'
  | 'NO_MEANINGFUL_BATTLE'
  | 'LOW_CONFIDENCE';

/** Aggressive sellers vs passive buyers. */
export type DownsideBattleState =
  | 'SELLERS_WINNING'
  | 'BUYERS_DEFENDING'
  | 'BUYER_ABSORPTION'
  | 'DOWNSIDE_VACUUM'
  | 'BALANCED'
  | 'NO_MEANINGFUL_BATTLE'
  | 'LOW_CONFIDENCE';

export type MarketBattleSummaryState =
  | 'BUYERS_IN_CONTROL'
  | 'SELLERS_IN_CONTROL'
  | 'PASSIVE_BUYERS_DEFENDING'
  | 'PASSIVE_SELLERS_DEFENDING'
  | 'TWO_SIDED_DEFENSE'
  | 'TWO_SIDED_AGGRESSION'
  | 'COMPRESSION'
  | 'NO_CLEAR_WINNER';

export type BattleIntensity = 'HIGH' | 'MODERATE' | 'LOW' | 'NONE';

export interface AggressiveSideView {
  volume: number;
  percentile: number;
  velocityPerSec: number;
  tradeCount: number;
  largeVolume: number;
  /** False when trade tape is unavailable — UI must show NO DATA, not 0. */
  hasData: boolean;
  score: number;
}

export interface PassiveSideView {
  currentDepth: number;
  nearDepth: number;
  consumption: IntensityLabel;
  replenishment: IntensityLabel;
  withdrawal: IntensityLabel;
  survival: number;
  strength: number;
  /** False / low when book is unreliable — UI marks LOW CONFIDENCE. */
  reliable: boolean;
  score: number;
}

export interface PriceResponseView {
  displacementPercent: number;
  efficiency: IntensityLabel;
  efficiencyScore: number;
}

export interface UpsideBattle {
  aggressive: AggressiveSideView;
  passive: PassiveSideView;
  price: PriceResponseView;
  /** Independent 0–100 intensity of the upside interaction. */
  battleScore: number;
  state: UpsideBattleState;
  why: string[];
}

export interface DownsideBattle {
  aggressive: AggressiveSideView;
  passive: PassiveSideView;
  price: PriceResponseView;
  /** Independent 0–100 intensity of the downside interaction. */
  battleScore: number;
  state: DownsideBattleState;
  why: string[];
}

export interface MarketBattleSummary {
  state: MarketBattleSummaryState;
  why: string;
}

export interface MarketBattleSnapshot {
  window: WindowId;
  upside: UpsideBattle;
  downside: DownsideBattle;
  /** Alias of upside.battleScore (0–100, independent of downside). */
  upsideBattleScore: number;
  /** Alias of downside.battleScore (0–100, independent of upside). */
  downsideBattleScore: number;
  summary: MarketBattleSummary;
}

export function emptyAggressiveSide(): AggressiveSideView {
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

export function emptyPassiveSide(): PassiveSideView {
  return {
    currentDepth: 0,
    nearDepth: 0,
    consumption: 'NORMAL',
    replenishment: 'NORMAL',
    withdrawal: 'NORMAL',
    survival: 0,
    strength: 0,
    reliable: false,
    score: 0,
  };
}

export function emptyPriceResponse(): PriceResponseView {
  return {
    displacementPercent: 0,
    efficiency: 'NORMAL',
    efficiencyScore: 0,
  };
}

export function emptyMarketBattle(window: WindowId = '10s'): MarketBattleSnapshot {
  const upside: UpsideBattle = {
    aggressive: emptyAggressiveSide(),
    passive: emptyPassiveSide(),
    price: emptyPriceResponse(),
    battleScore: 0,
    state: 'NO_MEANINGFUL_BATTLE',
    why: ['Insufficient data'],
  };
  const downside: DownsideBattle = {
    aggressive: emptyAggressiveSide(),
    passive: emptyPassiveSide(),
    price: emptyPriceResponse(),
    battleScore: 0,
    state: 'NO_MEANINGFUL_BATTLE',
    why: ['Insufficient data'],
  };
  return {
    window,
    upside,
    downside,
    upsideBattleScore: 0,
    downsideBattleScore: 0,
    summary: {
      state: 'NO_CLEAR_WINNER',
      why: 'No meaningful battle in this window.',
    },
  };
}
