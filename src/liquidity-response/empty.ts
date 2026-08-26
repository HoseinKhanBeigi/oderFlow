import type { LiquidityDepthView, LiquidityResponseSnapshot } from '../models/liquidity-response.js';
import { emptyStructure } from './structure.js';

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
  bps5m: 0,
  vwapBps: 0,
  classification: 'NORMAL' as const,
  faded: false,
};

function emptyDepth(): LiquidityDepthView {
  return {
    current: 0,
    currentPercentile: 50,
    changePercent: null,
    changeReason: 'INSUFFICIENT_DATA',
    consumed: 0,
    cancelled: 0,
    replenished: 0,
    removed: 0,
    consumptionRatio: 0,
    changeState: 'UNKNOWN',
    sideState: 'UNKNOWN',
  };
}

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
    confidenceScore: 22,
    dataQuality: 50,
    why: [],
    effort: 'INSUFFICIENT',
    absorption: { ...EMPTY_ABSORPTION },
    vacuum: null,
    impact: { ...EMPTY_IMPACT },
    bands: [],
    levels: [],
    reversal: null,
    entryContext: 'NO_ENTRY',
    structure: emptyStructure(),
    cvdDirection: 'FLAT',
    oiChangePercent: null,
    oiInterpretation: null,
    shortLiquidationUsd: 0,
    longLiquidationUsd: 0,
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
    deltaAnalysis: {
      delta: 0,
      direction: 'BALANCED',
      absoluteDeltaPercentile: 50,
      directionalMagnitudePercentile: 50,
    },
    askDepth: emptyDepth(),
    bidDepth: emptyDepth(),
    marketMechanics: 'UNKNOWN',
    dataConsistency: 50,
    consistency: { valid: true, reason: null, score: 50 },
  };
}
