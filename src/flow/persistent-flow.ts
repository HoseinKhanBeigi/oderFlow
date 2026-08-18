import type { PersistentFlowConfig } from '../config/types.js';
import type { WindowAggregate } from '../core/bucket-ring.js';
import { computeDelta } from './delta-engine.js';

export interface PersistentFlowResult {
  persistentBuyFlow: boolean;
  persistentSellFlow: boolean;
}

export function detectPersistentFlow(
  agg: WindowAggregate,
  windowMs: number,
  flowMultipleBuy: number,
  flowMultipleSell: number,
  config: PersistentFlowConfig,
): PersistentFlowResult {
  const delta = computeDelta(agg);
  const longEnough = windowMs >= config.minDurationMs;
  const buy =
    longEnough &&
    delta.deltaPercent >= config.minSameSideDeltaPercent &&
    agg.buyCount >= config.minTradeCount &&
    flowMultipleBuy >= config.minFlowMultiple;
  const sell =
    longEnough &&
    delta.deltaPercent <= -config.minSameSideDeltaPercent &&
    agg.sellCount >= config.minTradeCount &&
    flowMultipleSell >= config.minFlowMultiple;
  return { persistentBuyFlow: buy, persistentSellFlow: sell };
}
