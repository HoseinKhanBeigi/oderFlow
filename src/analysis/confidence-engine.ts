import type { ConfidencePenalties } from '../config/types.js';
import { clamp } from '../core/integrity.js';
import type { IntegrityFlag } from '../core/integrity.js';
import type { PriceImpactEfficiency } from '../models/trade.js';

export interface ConfidenceInput {
  flags: Set<IntegrityFlag>;
  tradeCount: number;
  bookEmpty: boolean;
  spreadBps: number;
  maxSpreadBps: number;
  deltaPercent: number;
  priceChangePercent: number;
  impactEfficiency: PriceImpactEfficiency;
  recentFlip: boolean;
}

export class ConfidenceEngine {
  constructor(private readonly penalties: ConfidencePenalties) {}

  score(input: ConfidenceInput): number {
    let c = 1;
    if (input.tradeCount < 8) c -= this.penalties.lowVolume;
    if (input.flags.has('staleBook')) c -= this.penalties.staleBook;
    if (input.bookEmpty || input.flags.has('missingData')) c -= this.penalties.missingData;
    if (input.flags.has('reconnect')) c -= this.penalties.reconnect;
    if (input.flags.has('sequenceGap')) c -= this.penalties.sequenceGap;
    if (input.spreadBps > input.maxSpreadBps) c -= this.penalties.wideSpread;
    if (input.recentFlip) c -= this.penalties.rapidFlip;

    const flowSign = Math.sign(input.deltaPercent);
    const priceSign = Math.sign(input.priceChangePercent);
    if (
      flowSign !== 0 &&
      priceSign !== 0 &&
      flowSign !== priceSign &&
      input.impactEfficiency !== 'LOW'
    ) {
      c -= this.penalties.contradictoryPrice;
    }

    return clamp(c, 0, 1);
  }
}
