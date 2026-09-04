import type { WindowId } from './trade.js';
import type { IntensityLabel } from './liquidity-response.js';
import type {
  AggressivePowerContribution,
  FootprintAggressionLevel,
} from './aggressive-flow.js';

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
  /** Footprint ASK-executed (buys) or BID-executed (sells) volume. */
  volume: number;
  percentile: number;
  velocityPerSec: number;
  tradeCount: number;
  averageTradeSize: number;
  largeVolume: number;
  imbalanceCount: number;
  imbalanceStrength: number;
  deltaContribution: number;
  cvdContribution: number;
  consecutiveImbalances: number;
  /** AggressiveBuyPower / AggressiveSellPower (0–100). */
  power: number;
  contributions: AggressivePowerContribution[];
  topLevels: FootprintAggressionLevel[];
  /** False when footprint / trade tape is unavailable — UI must show NO DATA, not 0. */
  hasData: boolean;
  lowConfidence: boolean;
  /** @deprecated Prefer `power`. Kept for older UI bindings. */
  score: number;
}

export interface PassiveSideView {
  currentDepth: number;
  nearDepth: number;
  consumption: IntensityLabel;
  replenishment: IntensityLabel;
  withdrawal: IntensityLabel;
  survival: number;
  survivalLabel: 'STRONG' | 'MODERATE' | 'WEAK';
  strength: number;
  /** Defense power 0–100 from order book / passive liquidity. */
  defensePower: number;
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

/**
 * Why a battle read is untrustworthy, so the UI can say "the feed is down" or
 * "the market is quiet" instead of collapsing both into one vague warning.
 */
export type BattleDataStatus = 'OK' | 'NO_TRADES' | 'STALE_TRADES' | 'BOOK_UNRELIABLE';

export interface BattleDataHealth {
  status: BattleDataStatus;
  /** Milliseconds since the last trade actually arrived (local clock). */
  tradeAgeMs: number;
  /** Age at which this symbol is considered stale — adapts to its own cadence. */
  staleAfterMs: number;
  /** Typical gap between prints for this symbol; 0 until enough samples. */
  medianTradeGapMs: number;
  bookReliable: boolean;
  /** Human-readable reason, empty when status is OK. */
  detail: string;
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
  /** Feed health behind this read — drives the UI's data warnings. */
  dataHealth: BattleDataHealth;
}

export function emptyAggressiveSide(): AggressiveSideView {
  return {
    volume: 0,
    percentile: 0,
    velocityPerSec: 0,
    tradeCount: 0,
    averageTradeSize: 0,
    largeVolume: 0,
    imbalanceCount: 0,
    imbalanceStrength: 0,
    deltaContribution: 0,
    cvdContribution: 0,
    consecutiveImbalances: 0,
    power: 0,
    contributions: [],
    topLevels: [],
    hasData: false,
    lowConfidence: false,
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
    survivalLabel: 'WEAK',
    strength: 0,
    defensePower: 0,
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
    dataHealth: {
      status: 'NO_TRADES',
      tradeAgeMs: 0,
      staleAfterMs: 0,
      medianTradeGapMs: 0,
      bookReliable: false,
      detail: 'No trades received yet.',
    },
  };
}
