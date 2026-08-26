import type { OiInterpretation } from '../models/liquidity-response.js';

export function interpretOi(input: {
  priceChangePercent: number;
  futuresDelta: number;
  oiChangePercent: number | null;
  threshold: number;
}): OiInterpretation {
  if (input.oiChangePercent == null) return 'UNCLEAR';
  const pxUp = input.priceChangePercent > 0.02;
  const pxDown = input.priceChangePercent < -0.02;
  const dUp = input.futuresDelta > 0;
  const dDown = input.futuresDelta < 0;
  const oiUp = input.oiChangePercent > input.threshold;
  const oiDown = input.oiChangePercent < -input.threshold;
  if (pxUp && dUp && oiUp) return 'LIKELY_NEW_LONGS';
  if (pxUp && dUp && oiDown) return 'LIKELY_SHORT_COVERING';
  if (pxDown && dDown && oiUp) return 'LIKELY_NEW_SHORTS';
  if (pxDown && dDown && oiDown) return 'LIKELY_LONG_UNWIND';
  return 'UNCLEAR';
}
