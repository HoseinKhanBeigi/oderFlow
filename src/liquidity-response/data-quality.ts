import { clamp } from '../core/integrity.js';
import type { IntegrityFlag } from '../core/integrity.js';

export interface DataQualityInput {
  flags?: Iterable<IntegrityFlag | string>;
  bookEmpty: boolean;
  tradeCount: number;
  lastTradeAgeMs: number;
  lastBookAgeMs: number;
  baselineSize: number;
  oiExpected: boolean;
  oiPresent: boolean;
  liquidationExpected: boolean;
  liquidationPresent: boolean;
  exchangeCount: number;
}

export function dataQualityScore(input: DataQualityInput): number {
  let s = 100;
  const flags = new Set([...(input.flags ?? [])].map(String));
  if (flags.has('reconnect')) s -= 22;
  if (flags.has('sequenceGap')) s -= 18;
  if (flags.has('staleBook')) s -= 22;
  if (flags.has('missingData')) s -= 16;
  if (flags.has('wideSpread')) s -= 10;
  if (flags.has('outOfOrder')) s -= 8;
  if (input.bookEmpty) s -= 18;
  if (input.tradeCount < 6) s -= 16;
  else if (input.tradeCount < 12) s -= 8;
  if (input.lastTradeAgeMs > 8_000) s -= 12;
  if (input.lastBookAgeMs > 4_000) s -= 14;
  if (input.baselineSize < 8) s -= 18;
  else if (input.baselineSize < 20) s -= 8;
  if (input.oiExpected && !input.oiPresent) s -= 10;
  if (input.liquidationExpected && !input.liquidationPresent) s -= 6;
  if (input.exchangeCount <= 1) s -= 4;
  return clamp(s, 0, 100);
}
