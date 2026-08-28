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

function emptyBar(partial: Pick<MarketBar, 'time' | 'open' | 'high' | 'low' | 'close'> & Partial<MarketBar>): MarketBar {
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
