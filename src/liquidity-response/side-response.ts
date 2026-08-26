import { safeDiv } from '../core/integrity.js';
import type { LiquidityResponseConfig } from '../config/types.js';
import type {
  AskSideState,
  BidSideState,
  IntensityLabel,
  LiquidityChangeState,
  LiquidityDepthView,
  PercentileBand,
} from '../models/liquidity-response.js';
import type { SideWindow } from './book-accountant.js';
import { bandToIntensity, percentileBand } from './percentile-band.js';

export interface SideClassifyInput {
  side: 'ask' | 'bid';
  window: SideWindow;
  currentPercentile: number;
  consumePct: number;
  replenishPct: number;
  withdrawPct: number;
  sampleSize: number;
  aggressiveVolume: number;
  aggressivePct: number;
  priceMovePercent: number;
  movePct: number;
  changePercent: number | null;
  changeReason: string | null;
  consistencyLow: boolean;
}

export function consumptionRatio(consumed: number, cancelled: number): number {
  const removed = consumed + cancelled;
  return safeDiv(consumed, Math.max(removed, 1e-9));
}

export function classifyChangeState(
  window: SideWindow,
  changePercent: number | null,
): LiquidityChangeState {
  if (changePercent == null) return 'UNKNOWN';
  const total = window.added + window.cancelled + window.consumed;
  if (total <= 0 && Math.abs(changePercent) < 8) return 'STABLE';
  if (total <= 0) return 'MIXED';
  const a = safeDiv(window.added, total);
  const c = safeDiv(window.cancelled, total);
  const x = safeDiv(window.consumed, total);
  if (a >= 0.5 && a >= c && a >= x) return 'REPLENISHMENT_DOMINATED';
  if (x >= 0.55 && x >= c) return 'CONSUMPTION_DOMINATED';
  if (c >= 0.55 && c >= x) return 'WITHDRAWAL_DOMINATED';
  return 'MIXED';
}

export function classifyAskSide(input: SideClassifyInput): AskSideState {
  if (input.consistencyLow) return 'UNKNOWN';
  const buyHigh = input.aggressivePct >= 80;
  const consumeHigh = highish(input.consumePct, input.window.consumed, input.window);
  const replenishHigh = highish(input.replenishPct, input.window.added, input.window);
  const withdrawHigh = highish(input.withdrawPct, input.window.cancelled, input.window);
  const pxUp = input.priceMovePercent > 0.04 && input.movePct >= 70;
  const pxWeak = input.movePct <= 40;

  if (buyHigh && consumeHigh && replenishHigh && pxWeak) return 'PASSIVE_SELLERS_DEFENDING';
  if (buyHigh && consumeHigh && !replenishHigh && pxUp) return 'PASSIVE_SELLERS_FAILING';
  if (withdrawHigh && (input.changePercent ?? 0) <= -15) return 'ASKS_BEING_WITHDRAWN';
  if (consumeHigh) return 'ASKS_BEING_CONSUMED';
  if (replenishHigh) return 'ASKS_BEING_REPLENISHED';
  if (Math.abs(input.changePercent ?? 0) < 8) return 'ASK_STABLE';
  return 'ASK_STABLE';
}

export function classifyBidSide(input: SideClassifyInput): BidSideState {
  if (input.consistencyLow) return 'UNKNOWN';
  const sellHigh = input.aggressivePct >= 80;
  const consumeHigh = highish(input.consumePct, input.window.consumed, input.window);
  const replenishHigh = highish(input.replenishPct, input.window.added, input.window);
  const withdrawHigh = highish(input.withdrawPct, input.window.cancelled, input.window);
  const pxDown = input.priceMovePercent < -0.04 && input.movePct >= 70;
  const pxWeak = input.movePct <= 40;

  if (sellHigh && consumeHigh && replenishHigh && pxWeak) return 'PASSIVE_BUYERS_DEFENDING';
  if (sellHigh && consumeHigh && !replenishHigh && pxDown) return 'PASSIVE_BUYERS_FAILING';
  if (withdrawHigh && (input.changePercent ?? 0) <= -15) return 'BIDS_BEING_WITHDRAWN';
  if (consumeHigh) return 'BIDS_BEING_CONSUMED';
  if (replenishHigh) return 'BIDS_BEING_REPLENISHED';
  if (Math.abs(input.changePercent ?? 0) < 8) return 'BID_STABLE';
  return 'BID_STABLE';
}

export function toDepthView(
  cfg: LiquidityResponseConfig,
  input: SideClassifyInput,
  sideState: AskSideState | BidSideState,
): LiquidityDepthView {
  const removed = input.window.consumed + input.window.cancelled;
  return {
    current: input.window.remaining,
    currentPercentile: input.currentPercentile,
    changePercent: input.changePercent,
    changeReason: input.changeReason,
    consumed: input.window.consumed,
    cancelled: input.window.cancelled,
    replenished: input.window.added,
    removed,
    consumptionRatio: consumptionRatio(input.window.consumed, input.window.cancelled),
    changeState: classifyChangeState(input.window, input.changePercent),
    sideState,
  };
}

export function intensityForComponent(
  cfg: LiquidityResponseConfig,
  amount: number,
  removed: number,
  initial: number,
  percentile: number,
  sampleSize: number,
  dropPercent: number | null,
): IntensityLabel {
  const band: PercentileBand = percentileBand(percentile, cfg.percentileBands);
  let fromPct = bandToIntensity(band);
  if (sampleSize < 8) fromPct = 'NORMAL';
  const share = safeDiv(amount, Math.max(removed, 1e-9));
  const drop = dropPercent ?? 0;
  if (drop <= -cfg.unexplainedDropPercent && share >= 0.55) {
    return amount / Math.max(initial, 1e-9) >= 0.8 ? 'EXTREME' : 'HIGH';
  }
  if (share >= 0.7 && removed > 0 && Math.abs(drop) >= 15) return fromPct === 'LOW' ? 'HIGH' : fromPct;
  return fromPct;
}

function highish(percentile: number, amount: number, window: SideWindow): boolean {
  const share = safeDiv(amount, Math.max(window.added + window.cancelled + window.consumed, 1e-9));
  return percentile >= 75 || share >= 0.5;
}

export function changeTooltip(changePercent: number | null, reason: string | null): string {
  if (changePercent == null) {
    return reason === 'ORDER_BOOK_DATA_RESET'
      ? 'Ask/bid depth change is unknown because the order book was reset, unsynchronized, or empty.'
      : `Depth change is unknown (${(reason ?? 'INSUFFICIENT_DATA').replace(/_/g, ' ').toLowerCase()}).`;
  }
  const dir = changePercent >= 0 ? 'increased' : 'decreased';
  return `Displayed liquidity inside the configured price band ${dir} ${Math.abs(changePercent).toFixed(0)}% relative to the previous valid snapshot.`;
}
