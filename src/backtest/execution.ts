import type {
  ExecutionConfig,
  FeatureSnapshot,
  FillModel,
  LabTrade,
  MarketBar,
  RiskConfig,
  Strategy,
  TradeDirection,
} from './types.js';

export interface PendingOrder {
  signalId: string;
  direction: TradeDirection;
  type: 'MARKET' | 'LIMIT' | 'STOP';
  limitPrice: number;
  stopPrice: number;
  targetPrice: number;
  size: number;
  createdBar: number;
  evidence: LabTrade['evidence'];
  confidence: number;
  snapshot: FeatureSnapshot;
}

export function planEntry(
  strategy: Strategy,
  snap: FeatureSnapshot,
  direction: TradeDirection,
  barIndex: number,
  signalId: string,
): PendingOrder {
  const exec = strategy.execution;
  const risk = strategy.risk;
  const signalPrice = snap.close;
  const atr = Math.max(snap.atr, signalPrice * 0.0005);
  const stopDist = stopDistance(risk, snap, direction, atr, signalPrice);
  const stopPrice = direction === 'LONG' ? signalPrice - stopDist : signalPrice + stopDist;
  const rr = risk.takeProfits[0]?.kind === 'FIXED_RR' ? risk.takeProfits[0].value : 2;
  const targetPrice =
    direction === 'LONG' ? signalPrice + stopDist * rr : signalPrice - stopDist * rr;
  const size = positionSize(risk, signalPrice, stopDist);
  let limitPrice = signalPrice;
  if (exec.orderType === 'LIMIT') {
    if (exec.limitPrice != null) limitPrice = exec.limitPrice;
    else {
      const off = signalPrice * (exec.limitOffsetBps / 10_000);
      limitPrice = direction === 'LONG' ? signalPrice - off : signalPrice + off;
    }
  }
  return {
    signalId,
    direction,
    type: exec.orderType === 'STOP' ? 'STOP' : exec.orderType,
    limitPrice,
    stopPrice,
    targetPrice,
    size,
    createdBar: barIndex,
    evidence: [],
    confidence: snap.absorptionStrength || snap.dataQuality,
    snapshot: snap,
  };
}

export function tryFill(
  order: PendingOrder,
  bar: MarketBar,
  exec: ExecutionConfig,
): { price: number; slippage: number } | null {
  if (order.type === 'MARKET') {
    const slip = bar.open * (exec.slippageBps / 10_000);
    const price = order.direction === 'LONG' ? bar.open + slip : bar.open - slip;
    return { price, slippage: slip * order.size };
  }
  if (order.type === 'STOP') {
    if (order.direction === 'LONG' && bar.high >= order.limitPrice) {
      return fillAt(order.limitPrice, exec, order, 'taker');
    }
    if (order.direction === 'SHORT' && bar.low <= order.limitPrice) {
      return fillAt(order.limitPrice, exec, order, 'taker');
    }
    return null;
  }
  return tryLimitFill(order, bar, exec.fillModel, exec);
}

function fillAt(
  price: number,
  exec: ExecutionConfig,
  order: PendingOrder,
  _kind: 'maker' | 'taker',
): { price: number; slippage: number } {
  const slip = price * (exec.slippageBps / 10_000) * (exec.fillModel === 'OPTIMISTIC' ? 0 : 0.5);
  const adj = order.direction === 'LONG' ? price + slip : price - slip;
  return { price: adj, slippage: slip * order.size };
}

function tryLimitFill(
  order: PendingOrder,
  bar: MarketBar,
  model: FillModel,
  exec: ExecutionConfig,
): { price: number; slippage: number } | null {
  const px = order.limitPrice;
  const thru = exec.conservativeBps / 10_000;
  if (order.direction === 'LONG') {
    if (model === 'OPTIMISTIC' && bar.low <= px) return fillAt(px, exec, order, 'maker');
    if (model === 'REALISTIC') {
      const tradedThrough = bar.low < px;
      const volAtLevel = volumeNear(bar, px);
      if (tradedThrough || volAtLevel >= order.size * px * 0.25) return fillAt(px, exec, order, 'maker');
      return null;
    }
    if (bar.low <= px * (1 - thru)) return fillAt(px, exec, order, 'maker');
    return null;
  }
  if (model === 'OPTIMISTIC' && bar.high >= px) return fillAt(px, exec, order, 'maker');
  if (model === 'REALISTIC') {
    const tradedThrough = bar.high > px;
    const volAtLevel = volumeNear(bar, px);
    if (tradedThrough || volAtLevel >= order.size * px * 0.25) return fillAt(px, exec, order, 'maker');
    return null;
  }
  if (bar.high >= px * (1 + thru)) return fillAt(px, exec, order, 'maker');
  return null;
}

function volumeNear(bar: MarketBar, price: number): number {
  let v = 0;
  const tol = price * 0.0005;
  for (const lvl of bar.levels) {
    if (Math.abs(lvl.price - price) <= tol) v += lvl.buy + lvl.sell;
  }
  if (v > 0) return v;
  return bar.aggressiveBuy + bar.aggressiveSell;
}

export interface OpenPosition {
  trade: LabTrade;
  remainPct: number;
  trailStop: number;
}

export function managePosition(
  pos: OpenPosition,
  bar: MarketBar,
  risk: RiskConfig,
  exec: ExecutionConfig,
): { closed: boolean; exitPrice?: number; reason?: string } {
  const t = pos.trade;
  const long = t.direction === 'LONG';
  updateExcursion(t, bar);

  if (long && bar.low <= t.stopPrice && bar.high >= t.targetPrice) {
    return { closed: true, exitPrice: t.stopPrice, reason: 'STOP' };
  }
  if (!long && bar.high >= t.stopPrice && bar.low <= t.targetPrice) {
    return { closed: true, exitPrice: t.stopPrice, reason: 'STOP' };
  }
  if (long && bar.low <= t.stopPrice) return { closed: true, exitPrice: t.stopPrice, reason: 'STOP' };
  if (!long && bar.high >= t.stopPrice) return { closed: true, exitPrice: t.stopPrice, reason: 'STOP' };

  if (long && bar.high >= t.targetPrice) return { closed: true, exitPrice: t.targetPrice, reason: 'TARGET' };
  if (!long && bar.low <= t.targetPrice) return { closed: true, exitPrice: t.targetPrice, reason: 'TARGET' };

  if (risk.timeStopBars && t.durationBars + 1 >= risk.timeStopBars) {
    return { closed: true, exitPrice: bar.close, reason: 'TIME' };
  }

  if (risk.stopKind === 'TRAILING') {
    const trail = Math.max(t.stopPrice * 0.0005, (t.entryPrice * risk.stopValue) / 100);
    if (long) {
      pos.trailStop = Math.max(pos.trailStop, bar.close - trail);
      if (bar.low <= pos.trailStop) return { closed: true, exitPrice: pos.trailStop, reason: 'TRAIL' };
    } else {
      pos.trailStop = Math.min(pos.trailStop, bar.close + trail);
      if (bar.high >= pos.trailStop) return { closed: true, exitPrice: pos.trailStop, reason: 'TRAIL' };
    }
  }

  void exec;
  return { closed: false };
}

export function updateExcursion(trade: LabTrade, bar: MarketBar): void {
  const long = trade.direction === 'LONG';
  const best = long ? bar.high : bar.low;
  const worst = long ? bar.low : bar.high;
  const mfe = long ? best - trade.entryPrice : trade.entryPrice - best;
  const mae = long ? trade.entryPrice - worst : worst - trade.entryPrice;
  if (mfe > trade.mfe) trade.mfe = mfe;
  if (mae > trade.mae) trade.mae = mae;
  trade.mfePct = trade.entryPrice ? (trade.mfe / trade.entryPrice) * 100 : 0;
  trade.maePct = trade.entryPrice ? (trade.mae / trade.entryPrice) * 100 : 0;
  trade.durationBars += 1;
}

function stopDistance(
  risk: RiskConfig,
  snap: FeatureSnapshot,
  direction: TradeDirection,
  atr: number,
  price: number,
): number {
  switch (risk.stopKind) {
    case 'FIXED_PCT':
      return price * (risk.stopValue / 100);
    case 'ATR':
      return atr * risk.stopValue;
    case 'SWING':
    case 'STRUCTURE': {
      const lvl = direction === 'LONG' ? snap.structure.swingLow : snap.structure.swingHigh;
      if (lvl == null) return atr * 1.5;
      return Math.max(Math.abs(price - lvl), atr * 0.5);
    }
    case 'LIQUIDITY':
    case 'ABSORPTION':
      return atr * Math.max(1, risk.stopValue);
    case 'TRAILING':
      return price * (risk.stopValue / 100);
    case 'TIME':
      return atr * 1.5;
    default:
      return atr * 1.5;
  }
}

function positionSize(risk: RiskConfig, price: number, stopDist: number): number {
  if (price <= 0) return 0;
  switch (risk.sizing) {
    case 'FIXED_QTY':
      return risk.fixedQty;
    case 'FIXED_DOLLAR':
      return risk.fixedDollar / price;
    case 'PCT_EQUITY':
      return (risk.accountEquity * (risk.riskPct / 100)) / price;
    case 'RISK': {
      const loss = risk.accountEquity * (risk.riskPct / 100);
      if (stopDist <= 0) return 0;
      return loss / stopDist;
    }
    default:
      return risk.fixedDollar / price;
  }
}

export function applyPnl(
  trade: LabTrade,
  exitPrice: number,
  exec: ExecutionConfig,
  maker: boolean,
): void {
  const long = trade.direction === 'LONG';
  const raw = long ? (exitPrice - trade.entryPrice) * trade.size : (trade.entryPrice - exitPrice) * trade.size;
  const feeBps = maker ? exec.makerFeeBps : exec.takerFeeBps;
  const exitFee = exitPrice * trade.size * (feeBps / 10_000);
  const entryFee = trade.entryPrice * trade.size * (feeBps / 10_000);
  trade.fees = entryFee + exitFee;
  trade.pnl = raw - trade.fees - trade.slippage;
  trade.pnlPct = trade.entryPrice ? ((long ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice) / trade.entryPrice) * 100 : 0;
  const stopDist = Math.abs(trade.entryPrice - trade.stopPrice);
  trade.r = stopDist > 0 ? (long ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice) / stopDist : 0;
  trade.exitPrice = exitPrice;
  trade.open = false;
}
