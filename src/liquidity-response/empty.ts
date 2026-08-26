import type { LiquidityResponseSnapshot } from '../models/liquidity-response.js';

const ZERO_NORM = {
  value: 0,
  percentile: 50,
  zScore: 0,
  median: 0,
  std: 0,
  window: 50,
};

const EMPTY_ABSORPTION = {
  detected: false,
  kind: null,
  absorbingSide: null,
  strength: 0,
  usedBookEvidence: false,
  usedPriceEvidence: false,
};

const EMPTY_IMPACT = {
  immediateBps: 0,
  bps5s: 0,
  bps30s: 0,
  bps1m: 0,
  vwapBps: 0,
  classification: 'NORMAL' as const,
};

export function emptyLiquidityResponse(): LiquidityResponseSnapshot {
  return {
    aggression: 'BALANCED',
    executed: 0,
    delta: 0,
    priceMovePercent: 0,
    priceMoveAbs: 0,
    efficiency: 'NORMAL',
    askConsumption: 'NORMAL',
    askReplenishment: 'NORMAL',
    askWithdrawal: 'NORMAL',
    bidConsumption: 'NORMAL',
    bidReplenishment: 'NORMAL',
    bidWithdrawal: 'NORMAL',
    askResponse: 'QUIET',
    bidResponse: 'QUIET',
    state: 'BALANCED',
    confidence: 'LOW',
    why: [],
    effort: 'INSUFFICIENT',
    absorption: { ...EMPTY_ABSORPTION },
    vacuum: null,
    impact: { ...EMPTY_IMPACT },
    bands: [],
    levels: [],
    reversal: null,
    byTf: {},
    norms: {
      aggressiveBuy: { ...ZERO_NORM },
      aggressiveSell: { ...ZERO_NORM },
      delta: { ...ZERO_NORM },
      priceDisplacement: { ...ZERO_NORM },
      askDepthChange: { ...ZERO_NORM },
    },
    compare: null,
    repeatedAskReplenishment: false,
    repeatedBidReplenishment: false,
  };
}
