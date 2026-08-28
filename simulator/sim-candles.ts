import type { MarketBar } from '../src/backtest/types.js';
import type { MarketSimulationState, SimulationMarketState } from '../src/simulation/types.js';

export interface PlayFrame {
  time: number;
  price: number;
  marketState: SimulationMarketState;
  whyHeadline: string;
  sellerAbsorption: number;
  buyerAbsorption: number;
  delta: number;
}

export interface PlayMarker {
  time: number;
  kind: 'ABSORPTION' | 'LIQUIDITY_VACUUM' | 'SHORT_SQUEEZE' | 'LONG_SQUEEZE';
  text: string;
  position: 'aboveBar' | 'belowBar';
}

export interface PlayChartData {
  bars: MarketBar[];
  frames: PlayFrame[];
  markers: PlayMarker[];
}

const NOTEWORTHY: Partial<Record<SimulationMarketState, PlayMarker['kind']>> = {
  SELLERS_BEING_ABSORBED: 'ABSORPTION',
  BUYERS_BEING_ABSORBED: 'ABSORPTION',
  UPSIDE_LIQUIDITY_VACUUM: 'LIQUIDITY_VACUUM',
  DOWNSIDE_LIQUIDITY_VACUUM: 'LIQUIDITY_VACUUM',
  SHORT_SQUEEZE_DOMINATED: 'SHORT_SQUEEZE',
  LONG_SQUEEZE_DOMINATED: 'LONG_SQUEEZE',
};

export function emptyBar(partial: Pick<MarketBar, 'time' | 'open' | 'high' | 'low' | 'close'> & Partial<MarketBar>): MarketBar {
  return {
    volume: 0,
    aggressiveBuy: 0,
    aggressiveSell: 0,
    trades: 0,
    buyTrades: 0,
    sellTrades: 0,
    largestBuy: 0,
    largestSell: 0,
    levels: [],
    hasFootprint: true,
    hasBook: true,
    spotBuy: 0,
    spotSell: 0,
    futuresBuy: 0,
    futuresSell: 0,
    bidDepth: null,
    askDepth: null,
    bidReplenishment: null,
    askReplenishment: null,
    bidWithdrawal: null,
    askWithdrawal: null,
    oi: null,
    oiChange: null,
    funding: null,
    longLiquidations: null,
    shortLiquidations: null,
    ...partial,
  };
}

function markerFor(state: SimulationMarketState, time: number): PlayMarker | null {
  const kind = NOTEWORTHY[state];
  if (!kind) return null;
  const above = state.includes('BUYERS') || state.includes('UPSIDE') || state === 'LONG_SQUEEZE_DOMINATED';
  const text =
    kind === 'ABSORPTION' ? 'ABS' : kind === 'LIQUIDITY_VACUUM' ? 'VAC' : 'SQZ';
  return { time, kind, text, position: above ? 'aboveBar' : 'belowBar' };
}

/**
 * Turns ScenarioEngine tick snapshots into OHLC candles.
 * `groupSize` ticks become one candle so the chart is readable.
 */
export function candlesFromStates(
  states: MarketSimulationState[],
  startPrice: number,
  groupSize = 4,
  epochSec = Math.floor(Date.now() / 1000),
): PlayChartData {
  const bars: MarketBar[] = [];
  const frames: PlayFrame[] = [];
  const markers: PlayMarker[] = [];
  const n = Math.max(1, groupSize);
  let prevClose = startPrice;
  let lastMarked: PlayMarker['kind'] | null = null;

  for (let i = 0; i < states.length; i += n) {
    const chunk = states.slice(i, i + n);
    const last = chunk[chunk.length - 1]!;
    const prices = chunk.map((s) => (s.price > 0 ? s.price : prevClose));
    const open = prevClose;
    const close = prices[prices.length - 1]!;
    const high = Math.max(open, ...prices);
    const low = Math.min(open, ...prices);
    const time = epochSec + bars.length;
    const aggressiveBuy = chunk.reduce((sum, s) => sum + s.aggressiveBuy, 0);
    const aggressiveSell = chunk.reduce((sum, s) => sum + s.aggressiveSell, 0);

    bars.push(
      emptyBar({
        time,
        open,
        high,
        low,
        close,
        volume: aggressiveBuy + aggressiveSell,
        aggressiveBuy,
        aggressiveSell,
        bidDepth: last.bidDepth,
        askDepth: last.askDepth,
        bidReplenishment: last.bidReplenishment,
        askReplenishment: last.askReplenishment,
        bidWithdrawal: last.bidWithdrawal,
        askWithdrawal: last.askWithdrawal,
        oi: last.openInterest ?? null,
        oiChange: last.oiChange ?? null,
        funding: last.fundingRate ?? null,
        longLiquidations: last.longLiquidations,
        shortLiquidations: last.shortLiquidations,
      }),
    );

    frames.push({
      time,
      price: close,
      marketState: last.marketState,
      whyHeadline: last.whyHeadline,
      sellerAbsorption: last.sellerAbsorption,
      buyerAbsorption: last.buyerAbsorption,
      delta: last.delta,
    });

    for (const s of chunk) {
      const mark = markerFor(s.marketState, time);
      if (mark && mark.kind !== lastMarked) {
        markers.push(mark);
        lastMarked = mark.kind;
      }
    }

    prevClose = close;
  }

  return { bars, frames, markers };
}

export const TF_OPTIONS: Array<{ minutes: number; label: string; interval: string }> = [
  { minutes: 15, label: '15m', interval: '15m' },
  { minutes: 60, label: '1h', interval: '1h' },
  { minutes: 240, label: '4h', interval: '4h' },
  { minutes: 1440, label: '1d', interval: '1d' },
];

export function candlesToBars(
  rows: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>,
): MarketBar[] {
  return rows.map((c) =>
    emptyBar({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      aggressiveBuy: c.close >= c.open ? c.volume : 0,
      aggressiveSell: c.close < c.open ? c.volume : 0,
    }),
  );
}

export function closedHistory(bars: MarketBar[], tfMinutes: number, nowSec = Math.floor(Date.now() / 1000)): MarketBar[] {
  if (bars.length < 2) return bars;
  const tfSec = tfMinutes * 60;
  const last = bars[bars.length - 1]!;
  if (last.time + tfSec > nowSec + 2) return bars.slice(0, -1);
  return bars;
}

export function nextBarTime(lastTime: number, tfMinutes: number): number {
  return lastTime + tfMinutes * 60;
}

export function averageTrueRange(bars: MarketBar[], lookback = 14): number {
  if (bars.length < 2) return Math.abs((bars[0]?.high ?? 0) - (bars[0]?.low ?? 0)) || 1;
  const n = Math.min(lookback, bars.length - 1);
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1] ?? cur;
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    sum += tr;
  }
  return sum / n || 1;
}

export function niceTick(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const m = raw / exp;
  const nice = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
  return nice * exp;
}

export function scaleFromHistory(bars: MarketBar[]): { startPrice: number; tickSize: number; levelStep: number; atr: number } {
  const last = bars[bars.length - 1]!;
  const atr = averageTrueRange(bars);
  const tick = niceTick(atr / 20);
  return { startPrice: last.close, tickSize: tick, levelStep: tick, atr };
}

/**
 * One next-timeframe candle, snapshotted as it forms. Every bar shares `nextTime`.
 */
export function formingBarSnapshots(
  states: MarketSimulationState[],
  startPrice: number,
  nextTime: number,
  maxFrames = 48,
): PlayChartData {
  const bars: MarketBar[] = [];
  const frames: PlayFrame[] = [];
  const markers: PlayMarker[] = [];
  if (!states.length) {
    const flat = emptyBar({ time: nextTime, open: startPrice, high: startPrice, low: startPrice, close: startPrice });
    return {
      bars: [flat],
      frames: [{ time: nextTime, price: startPrice, marketState: 'NO_SIGNAL', whyHeadline: '', sellerAbsorption: 0, buyerAbsorption: 0, delta: 0 }],
      markers: [],
    };
  }

  const stride = Math.max(1, Math.ceil(states.length / maxFrames));
  let high = startPrice;
  let low = startPrice;
  let lastMarked: PlayMarker['kind'] | null = null;
  let buy = 0;
  let sell = 0;

  for (let i = 0; i < states.length; i += stride) {
    const end = Math.min(i + stride, states.length);
    for (let j = i; j < end; j++) {
      const px = states[j]!.price > 0 ? states[j]!.price : startPrice;
      high = Math.max(high, px);
      low = Math.min(low, px);
      buy += states[j]!.aggressiveBuy;
      sell += states[j]!.aggressiveSell;
    }
    const last = states[end - 1]!;
    const close = last.price > 0 ? last.price : startPrice;
    bars.push(
      emptyBar({
        time: nextTime,
        open: startPrice,
        high,
        low,
        close,
        volume: buy + sell,
        aggressiveBuy: buy,
        aggressiveSell: sell,
        bidDepth: last.bidDepth,
        askDepth: last.askDepth,
        bidReplenishment: last.bidReplenishment,
        askReplenishment: last.askReplenishment,
        bidWithdrawal: last.bidWithdrawal,
        askWithdrawal: last.askWithdrawal,
        oi: last.openInterest ?? null,
        oiChange: last.oiChange ?? null,
        funding: last.fundingRate ?? null,
        longLiquidations: last.longLiquidations,
        shortLiquidations: last.shortLiquidations,
      }),
    );
    frames.push({
      time: nextTime,
      price: close,
      marketState: last.marketState,
      whyHeadline: last.whyHeadline,
      sellerAbsorption: last.sellerAbsorption,
      buyerAbsorption: last.buyerAbsorption,
      delta: last.delta,
    });
    const mark = markerFor(last.marketState, nextTime);
    if (mark && mark.kind !== lastMarked) {
      markers.push(mark);
      lastMarked = mark.kind;
    }
  }

  return { bars, frames, markers };
}
