import type {
  AbsorptionKind,
  AggressionSide,
  CvdDirection,
  EffortVsResultState,
  EntryContext,
  IntensityLabel,
  LiquidityAbsorption,
  MicrostructureState,
  ReversalSetup,
  StructureSnapshot,
} from '../models/liquidity-response.js';

export interface EntryContextInput {
  state: MicrostructureState;
  absorption: LiquidityAbsorption;
  structure: StructureSnapshot;
  effort: EffortVsResultState;
  aggression: AggressionSide;
  delta: number;
  priceMovePercent: number;
  efficiency: IntensityLabel;
  askReplenishment: IntensityLabel;
  bidReplenishment: IntensityLabel;
  cvdDirection: CvdDirection;
  reversal: ReversalSetup | null;
  spotDeltaTurnsPositive: boolean;
  spotDeltaTurnsNegative: boolean;
}

/**
 * Entry context is not a trade instruction. Absorption alone never confirms
 * a long or short — structure and price response must agree.
 */
export function classifyEntry(input: EntryContextInput): EntryContext {
  const bullishShift = input.structure.shift === 'BULLISH_CHOCH' || input.structure.shift === 'BULLISH_BOS';
  const bearishShift = input.structure.shift === 'BEARISH_CHOCH' || input.structure.shift === 'BEARISH_BOS';
  const sellerAbsorbed =
    input.absorption.kind === 'BUY_ABSORPTION' ||
    input.state === 'SELLERS_BEING_ABSORBED' ||
    input.effort === 'SELL_ABSORPTION';
  const buyerAbsorbed =
    input.absorption.kind === 'SELL_ABSORPTION' ||
    input.state === 'BUYERS_BEING_ABSORBED' ||
    input.effort === 'BUY_ABSORPTION';
  const priceUp = input.priceMovePercent > 0.04 && (input.efficiency === 'HIGH' || input.efficiency === 'EXTREME');
  const priceDown = input.priceMovePercent < -0.04 && (input.efficiency === 'HIGH' || input.efficiency === 'EXTREME');
  const failedHH = input.structure.lowerHigh || (input.structure.swingHigh != null && input.priceMovePercent <= 0.04);
  const failedLL = input.structure.higherLow || (input.structure.swingLow != null && input.priceMovePercent >= -0.04);

  if (
    sellerAbsorbed &&
    (bullishShift || input.reversal?.kind === 'BULLISH') &&
    input.spotDeltaTurnsPositive &&
    priceUp
  ) {
    return 'LONG_CONFIRMATION';
  }
  if (
    buyerAbsorbed &&
    (bearishShift || input.reversal?.kind === 'BEARISH') &&
    input.spotDeltaTurnsNegative &&
    priceDown &&
    failedHH
  ) {
    return 'SHORT_CONFIRMATION';
  }

  const longSetup =
    (input.state === 'PASSIVE_BUYERS_DEFENDING' || sellerAbsorbed) &&
    (input.aggression === 'SELLERS' || input.delta < 0) &&
    highish(input.bidReplenishment) &&
    (input.efficiency === 'LOW' || input.efficiency === 'NORMAL') &&
    failedLL;
  if (longSetup) return 'LONG_SETUP_FORMING';

  const shortSetup =
    (input.state === 'PASSIVE_SELLERS_DEFENDING' || buyerAbsorbed) &&
    (input.aggression === 'BUYERS' || input.delta > 0) &&
    highish(input.askReplenishment) &&
    (input.efficiency === 'LOW' || input.efficiency === 'NORMAL') &&
    failedHH;
  if (shortSetup) return 'SHORT_SETUP_FORMING';

  return 'NO_ENTRY';
}

function highish(x: IntensityLabel): boolean {
  return x === 'HIGH' || x === 'EXTREME';
}

export type { AbsorptionKind };
