import type {
  MicroShift,
  StructureBias,
  StructureSnapshot,
} from '../models/liquidity-response.js';
import type { MinuteBar } from './minute-ring.js';

export function emptyStructure(): StructureSnapshot {
  return {
    swingHigh: null,
    swingLow: null,
    lastSwingHigh: null,
    lastSwingLow: null,
    higherHigh: false,
    higherLow: false,
    lowerHigh: false,
    lowerLow: false,
    bias: 'NONE',
    shift: 'NONE',
  };
}

/**
 * Lightweight local structure from 1m OHLC. Not an ICT model — swing context only.
 */
export function detectStructure(bars: MinuteBar[]): StructureSnapshot {
  const out = emptyStructure();
  if (bars.length < 6) return out;
  const highs: { i: number; price: number }[] = [];
  const lows: { i: number; price: number }[] = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const b = bars[i]!;
    if (b.high >= bars[i - 1]!.high && b.high >= bars[i - 2]!.high && b.high >= bars[i + 1]!.high && b.high >= bars[i + 2]!.high) {
      highs.push({ i, price: b.high });
    }
    if (b.low <= bars[i - 1]!.low && b.low <= bars[i - 2]!.low && b.low <= bars[i + 1]!.low && b.low <= bars[i + 2]!.low) {
      lows.push({ i, price: b.low });
    }
  }
  const sh = highs[highs.length - 1];
  const prevSh = highs[highs.length - 2];
  const sl = lows[lows.length - 1];
  const prevSl = lows[lows.length - 2];
  out.swingHigh = sh?.price ?? null;
  out.swingLow = sl?.price ?? null;
  out.lastSwingHigh = prevSh?.price ?? null;
  out.lastSwingLow = prevSl?.price ?? null;
  out.higherHigh = Boolean(sh && prevSh && sh.price > prevSh.price);
  out.lowerHigh = Boolean(sh && prevSh && sh.price < prevSh.price);
  out.higherLow = Boolean(sl && prevSl && sl.price > prevSl.price);
  out.lowerLow = Boolean(sl && prevSl && sl.price < prevSl.price);

  if (out.higherHigh && out.higherLow) out.bias = 'HH_HL';
  else if (out.lowerHigh && out.lowerLow) out.bias = 'LH_LL';
  else if (out.higherHigh && out.lowerLow) out.bias = 'HH_LL';
  else if (out.lowerHigh && out.higherLow) out.bias = 'LH_HL';

  const last = bars[bars.length - 1]!;
  out.shift = microShift(last, out);
  return out;
}

function microShift(last: MinuteBar, s: StructureSnapshot): MicroShift {
  if (s.swingHigh != null && last.close > s.swingHigh) {
    return s.bias === 'LH_LL' ? 'BULLISH_CHOCH' : 'BULLISH_BOS';
  }
  if (s.swingLow != null && last.close < s.swingLow) {
    return s.bias === 'HH_HL' ? 'BEARISH_CHOCH' : 'BEARISH_BOS';
  }
  return 'NONE';
}
