import type { MarketMechanics, PercentileBand } from '../models/liquidity-response.js';
import type { LiquidityDepthView } from '../models/liquidity-response.js';
import { percentileBand } from './percentile-band.js';

export interface MechanicsInput {
  buyPct: number;
  sellPct: number;
  delta: number;
  movePct: number;
  priceMovePercent: number;
  ask: LiquidityDepthView;
  bid: LiquidityDepthView;
  bands: PercentileBandConfigLike;
}

interface PercentileBandConfigLike {
  veryLow: number;
  low: number;
  normal: number;
  elevated: number;
  high: number;
}

const LOW_MAX: PercentileBand[] = ['VERY_LOW', 'LOW', 'NORMAL'];
const HIGH_MIN: PercentileBand[] = ['HIGH', 'EXTREME'];

export function classifyMarketMechanics(input: MechanicsInput): MarketMechanics {
  const buyBand = percentileBand(input.buyPct, input.bands);
  const sellBand = percentileBand(input.sellPct, input.bands);
  const moveBand = percentileBand(input.movePct, input.bands);
  const askWithdraw = input.ask.changeState === 'WITHDRAWAL_DOMINATED';
  const bidWithdraw = input.bid.changeState === 'WITHDRAWAL_DOMINATED';
  const askConsume = input.ask.changeState === 'CONSUMPTION_DOMINATED';
  const bidConsume = input.bid.changeState === 'CONSUMPTION_DOMINATED';
  const askRepl = input.ask.changeState === 'REPLENISHMENT_DOMINATED';
  const bidRepl = input.bid.changeState === 'REPLENISHMENT_DOMINATED';
  const askDrop = (input.ask.changePercent ?? 0) <= -15;
  const bidDrop = (input.bid.changePercent ?? 0) <= -15;
  const buyQuiet = LOW_MAX.includes(buyBand);
  const sellQuiet = LOW_MAX.includes(sellBand);
  const buyHot = HIGH_MIN.includes(buyBand) || input.buyPct >= 80;
  const sellHot = HIGH_MIN.includes(sellBand) || input.sellPct >= 80;
  const moveHot = HIGH_MIN.includes(moveBand) || input.movePct >= 80;
  const moveCold = input.movePct <= 40;

  if (input.ask.changeState === 'UNKNOWN' && input.bid.changeState === 'UNKNOWN' && !moveHot && buyQuiet && sellQuiet) {
    return 'UNKNOWN';
  }

  if (input.priceMovePercent > 0.04 && buyQuiet && (askWithdraw || askDrop) && moveHot) {
    return 'LIQUIDITY_DRIVEN_UP';
  }
  if (input.priceMovePercent < -0.04 && sellQuiet && (bidWithdraw || bidDrop) && moveHot) {
    return 'LIQUIDITY_DRIVEN_DOWN';
  }
  if (buyHot && askRepl && moveCold) return 'BUYER_ABSORPTION';
  if (sellHot && bidRepl && moveCold) return 'SELLER_ABSORPTION';
  if (buyHot && (askConsume || input.ask.consumptionRatio >= 0.55) && moveHot && input.priceMovePercent > 0) {
    return 'FLOW_DRIVEN_UP';
  }
  if (sellHot && (bidConsume || input.bid.consumptionRatio >= 0.55) && moveHot && input.priceMovePercent < 0) {
    return 'FLOW_DRIVEN_DOWN';
  }
  return 'BALANCED';
}

export function mechanicsInterpretation(kind: MarketMechanics): string {
  switch (kind) {
    case 'LIQUIDITY_DRIVEN_UP':
      return 'Price is rising primarily because sell liquidity is disappearing, not because aggressive buying is exceptionally large.';
    case 'LIQUIDITY_DRIVEN_DOWN':
      return 'Price is falling primarily because bid liquidity is disappearing, not because aggressive selling is exceptionally large.';
    case 'FLOW_DRIVEN_UP':
      return 'Aggressive buyers are strong, ask liquidity is being consumed, and price is responding efficiently.';
    case 'FLOW_DRIVEN_DOWN':
      return 'Aggressive sellers are strong, bid liquidity is being consumed, and price is responding efficiently.';
    case 'BUYER_ABSORPTION':
      return 'Buyers are extremely aggressive but sellers replenish asks and price response remains weak — passive sellers are defending.';
    case 'SELLER_ABSORPTION':
      return 'Sellers are extremely aggressive but buyers replenish bids and price response remains weak — passive buyers are defending.';
    case 'UNKNOWN':
      return 'Order-book data is not consistent enough to classify why price moved.';
    default:
      return 'Aggression, book response, and price displacement do not show a clear directional mechanic.';
  }
}
