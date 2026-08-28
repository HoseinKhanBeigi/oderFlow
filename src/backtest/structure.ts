import type { MarketBar, StructureBias, StructureShift, StructureState } from './types.js';

const EMPTY: StructureState = {
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
  swingHighTime: null,
  swingLowTime: null,
};

interface Pivot {
  index: number;
  time: number;
  price: number;
}

/**
 * Causal swing detector.
 *
 * A pivot at bar i is confirmed only after bars i+1 and i+2 have closed.
 * At bar n the last confirmable pivot is n-2. The current bar is never used
 * as a future look-ahead for pivot confirmation.
 */
export class CausalStructure {
  private readonly highs: Pivot[] = [];
  private readonly lows: Pivot[] = [];
  private bars = 0;
  private last: StructureState = { ...EMPTY };

  reset(): void {
    this.highs.length = 0;
    this.lows.length = 0;
    this.bars = 0;
    this.last = { ...EMPTY };
  }

  /**
   * Ingest a newly closed bar (index = bars processed so far).
   * Returns structure known at this close — no future bars.
   */
  push(bar: MarketBar, index: number, prevClose: number): StructureState {
    this.bars = index + 1;
    const confirmAt = index - 2;
    if (confirmAt >= 2) {
      // Caller must pass the three-bar window via tryConfirm.
    }
    void bar;
    void prevClose;
    return this.last;
  }

  /**
   * Confirm pivots using bars[i-2] against neighbors i-4..i.
   * `window` is [bar i-4, i-3, i-2, i-1, i] when i >= 4.
   */
  ingestClosed(bars: MarketBar[]): StructureState {
    const n = bars.length;
    if (n < 5) {
      this.last = { ...EMPTY, shift: 'NONE' };
      return this.last;
    }
    const i = n - 3;
    const c = bars[i];
    const a = bars[i - 2];
    const b = bars[i - 1];
    const d = bars[i + 1];
    const e = bars[i + 2];
    if (!c || !a || !b || !d || !e) return this.last;

    if (c.high >= a.high && c.high >= b.high && c.high >= d.high && c.high >= e.high) {
      const last = this.highs[this.highs.length - 1];
      if (!last || last.index !== i) this.highs.push({ index: i, time: c.time, price: c.high });
    }
    if (c.low <= a.low && c.low <= b.low && c.low <= d.low && c.low <= e.low) {
      const last = this.lows[this.lows.length - 1];
      if (!last || last.index !== i) this.lows.push({ index: i, time: c.time, price: c.low });
    }

    const sh = this.highs[this.highs.length - 1];
    const prevSh = this.highs[this.highs.length - 2];
    const sl = this.lows[this.lows.length - 1];
    const prevSl = this.lows[this.lows.length - 2];
    const lastBar = bars[n - 1]!;

    const higherHigh = Boolean(sh && prevSh && sh.price > prevSh.price);
    const lowerHigh = Boolean(sh && prevSh && sh.price < prevSh.price);
    const higherLow = Boolean(sl && prevSl && sl.price > prevSl.price);
    const lowerLow = Boolean(sl && prevSl && sl.price < prevSl.price);

    let bias: StructureBias = 'NONE';
    if (higherHigh && higherLow) bias = 'HH_HL';
    else if (lowerHigh && lowerLow) bias = 'LH_LL';
    else if (higherHigh && lowerLow) bias = 'HH_LL';
    else if (lowerHigh && higherLow) bias = 'LH_HL';

    const shift = microShift(lastBar, sh?.price ?? null, sl?.price ?? null, bias);

    this.last = {
      swingHigh: sh?.price ?? null,
      swingLow: sl?.price ?? null,
      lastSwingHigh: prevSh?.price ?? null,
      lastSwingLow: prevSl?.price ?? null,
      higherHigh,
      higherLow,
      lowerHigh,
      lowerLow,
      bias,
      shift,
      swingHighTime: sh?.time ?? null,
      swingLowTime: sl?.time ?? null,
    };
    return this.last;
  }

  snapshot(): StructureState {
    return this.last;
  }
}

function microShift(
  last: MarketBar,
  swingHigh: number | null,
  swingLow: number | null,
  bias: StructureBias,
): StructureShift {
  if (swingHigh != null && last.close > swingHigh) {
    return bias === 'LH_LL' ? 'BULLISH_CHOCH' : 'BULLISH_BOS';
  }
  if (swingLow != null && last.close < swingLow) {
    return bias === 'HH_HL' ? 'BEARISH_CHOCH' : 'BEARISH_BOS';
  }
  return 'NONE';
}

export function emptyStructure(): StructureState {
  return { ...EMPTY };
}
