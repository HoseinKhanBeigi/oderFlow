import { evalRule } from './conditions.js';
import {
  applyPnl,
  managePosition,
  planEntry,
  tryFill,
  type OpenPosition,
  type PendingOrder,
} from './execution.js';
import { FeatureBuilder, windowBars } from './features.js';
import { attachForwardReturns, bySignalType, equityCurve, summarizeTrades } from './stats.js';
import type {
  BacktestResult,
  BacktestRunConfig,
  DataCoverage,
  FeatureSnapshot,
  LabMode,
  LabSignal,
  LabTrade,
  MarketBar,
  SignalEvidence,
  SignalKind,
  Strategy,
} from './types.js';

export type ProgressFn = (info: { eventsProcessed: number; tradesFound: number; pct: number }) => void;

let seq = 1;
function nid(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

/**
 * Bar-close event loop. Features at bar i use bars 0..i only.
 * New orders are eligible to fill starting on bar i+1.
 */
export class MicrostructureBacktestEngine {
  run(
    bars: MarketBar[],
    strategy: Strategy,
    coverage: DataCoverage,
    config: BacktestRunConfig,
    onProgress?: ProgressFn,
  ): BacktestResult {
    const t0 = Date.now();
    const mode: LabMode = config.mode;
    const builder = new FeatureBuilder(windowBars(config.percentileWindow, config.tfMinutes));
    const snapshots: FeatureSnapshot[] = [];
    const signals: LabSignal[] = [];
    const trades: LabTrade[] = [];
    const pending: PendingOrder[] = [];
    let position: OpenPosition | null = null;
    let longArmed = false;
    let shortArmed = false;
    const equity0 = strategy.risk.accountEquity;
    const signalFrom = config.signalFromSec ?? bars[0]?.time ?? 0;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]!;

      if (position) {
        const m = managePosition(position, bar, strategy.risk, strategy.execution);
        if (m.closed && m.exitPrice != null) {
          closeTrade(position.trade, bar, m.exitPrice, m.reason ?? 'EXIT', strategy, signals, snapAt(snapshots, i));
          position = null;
        }
      }

      for (let p = pending.length - 1; p >= 0; p--) {
        const order = pending[p]!;
        if (i <= order.createdBar) continue;
        if (position) {
          pending.splice(p, 1);
          continue;
        }
        const fill = tryFill(order, bar, strategy.execution);
        if (!fill) continue;
        const trade = openTrade(order, bar, fill.price, fill.slippage, strategy);
        trades.push(trade);
        position = { trade, remainPct: 1, trailStop: trade.stopPrice };
        pending.splice(p, 1);
        longArmed = false;
        shortArmed = false;
        const sameBar = managePosition(position, bar, strategy.risk, strategy.execution);
        if (sameBar.closed && sameBar.exitPrice != null) {
          closeTrade(trade, bar, sameBar.exitPrice, sameBar.reason ?? 'EXIT', strategy, signals, snapAt(snapshots, i));
          position = null;
        }
      }

      const snap = builder.push(bar);
      snapshots.push(snap);

      if (snap.dataQuality < config.minDataQuality) {
        if (onProgress && i % 250 === 0) onProgress({ eventsProcessed: i + 1, tradesFound: trades.length, pct: (i / bars.length) * 100 });
        continue;
      }

      const hist = snapshots;
      const allowTrade = bar.time >= signalFrom;

      if (snap.sellerAbsorption || snap.buyerAbsorption) {
        pushSignal(signals, strategy, snap, snap.sellerAbsorption ? 'ABSORPTION' : 'ABSORPTION', evidenceFrom(snap), false);
      }
      if (snap.upsideVacuum || snap.downsideVacuum) {
        pushSignal(signals, strategy, snap, 'LIQUIDITY_VACUUM', evidenceFrom(snap), false);
      }
      if (snap.leverageDrivenRally) {
        pushSignal(signals, strategy, snap, 'LEVERAGE_DRIVEN_RALLY', evidenceFrom(snap), false);
      }
      if (snap.leverageDrivenSelloff) {
        pushSignal(signals, strategy, snap, 'LEVERAGE_DRIVEN_SELLOFF', evidenceFrom(snap), false);
      }

      if (strategy.context && evalRule(strategy.context, hist)) {
        pushSignal(signals, strategy, snap, 'CONTEXT', evidenceFrom(snap), false);
      }

      if (allowTrade && !position) {
        if (strategy.longSetup && evalRule(strategy.longSetup, hist)) {
          longArmed = true;
          pushSignal(signals, strategy, snap, 'LONG_SETUP', evidenceFrom(snap), false);
        }
        if (strategy.shortSetup && evalRule(strategy.shortSetup, hist)) {
          shortArmed = true;
          pushSignal(signals, strategy, snap, 'SHORT_SETUP', evidenceFrom(snap), false);
        }

        const longOk = strategy.longEntry && evalRule(strategy.longEntry, hist) && (strategy.longSetup ? longArmed : true);
        const shortOk = strategy.shortEntry && evalRule(strategy.shortEntry, hist) && (strategy.shortSetup ? shortArmed : true);

        if (longOk) {
          const sig = pushSignal(signals, strategy, snap, 'LONG_ENTRY', evidenceFrom(snap), true);
          pending.push(planEntry(strategy, snap, 'LONG', i, sig.id));
        } else if (shortOk) {
          const sig = pushSignal(signals, strategy, snap, 'SHORT_ENTRY', evidenceFrom(snap), true);
          pending.push(planEntry(strategy, snap, 'SHORT', i, sig.id));
        }
      }

      if (onProgress && (i % 200 === 0 || i === bars.length - 1)) {
        onProgress({ eventsProcessed: i + 1, tradesFound: trades.length, pct: ((i + 1) / bars.length) * 100 });
      }
    }

    if (position) {
      const last = bars[bars.length - 1]!;
      closeTrade(position.trade, last, last.close, 'EOD', strategy, signals, snapshots[snapshots.length - 1]);
    }

    attachForwardReturns(signals, bars, config.tfMinutes);
    const equity = equityCurve(trades, equity0, bars);
    const stats = summarizeTrades(trades, equity0, equity);

    let walkForward: BacktestResult['walkForward'];
    if (mode === 'WALK_FORWARD' && config.isFromSec != null && config.isToSec != null && config.oosFromSec != null) {
      const isTrades = trades.filter((t) => t.entryTime >= config.isFromSec! && t.entryTime <= config.isToSec!);
      const oosTrades = trades.filter((t) => t.entryTime >= config.oosFromSec!);
      const isEq = equityCurve(isTrades, equity0, bars.filter((b) => b.time >= config.isFromSec! && b.time <= config.isToSec!));
      const oosEq = equityCurve(oosTrades, equity0, bars.filter((b) => b.time >= config.oosFromSec!));
      const is = summarizeTrades(isTrades, equity0, isEq);
      const oos = summarizeTrades(oosTrades, equity0, oosEq);
      walkForward = {
        is,
        oos,
        overfitting: is.profitFactor > 1.4 && oos.profitFactor < 0.9 && oos.totalTrades >= 8,
      };
    }

    return {
      mode,
      strategy,
      coverage,
      stats,
      bySignalType: bySignalType(trades, signals),
      trades,
      signals,
      equity,
      snapshots: snapshots.length > 8_000 ? snapshots.filter((_, i) => i % 4 === 0) : snapshots,
      walkForward,
      elapsedMs: Date.now() - t0,
      eventsProcessed: bars.length,
    };
  }
}

function openTrade(
  order: PendingOrder,
  bar: MarketBar,
  price: number,
  slippage: number,
  strategy: Strategy,
): LabTrade {
  return {
    id: nid('t'),
    signalId: order.signalId,
    strategy: strategy.name,
    strategyVersion: strategy.version,
    direction: order.direction,
    entryTime: bar.time,
    entryPrice: price,
    exitTime: null,
    exitPrice: null,
    stopPrice: order.stopPrice,
    targetPrice: order.targetPrice,
    size: order.size,
    pnl: 0,
    pnlPct: 0,
    r: 0,
    mae: 0,
    mfe: 0,
    maePct: 0,
    mfePct: 0,
    fees: 0,
    slippage,
    durationBars: 0,
    confidence: order.confidence,
    exitReason: null,
    evidence: evidenceFrom(order.snapshot),
    open: true,
  };
}

function closeTrade(
  trade: LabTrade,
  bar: MarketBar,
  exitPrice: number,
  reason: string,
  strategy: Strategy,
  signals: LabSignal[],
  fallback: FeatureSnapshot | undefined,
): void {
  const maker = strategy.execution.orderType === 'LIMIT';
  applyPnl(trade, exitPrice, strategy.execution, maker);
  trade.exitTime = bar.time;
  trade.exitReason = reason;
  const kind: SignalKind =
    reason === 'STOP'
      ? trade.direction === 'LONG'
        ? 'LONG_STOP'
        : 'SHORT_STOP'
      : trade.direction === 'LONG'
        ? 'LONG_EXIT'
        : 'SHORT_EXIT';
  const snapshot = signals.find((s) => s.id === trade.signalId)?.snapshot ?? fallback;
  if (!snapshot) return;
  signals.push({
    id: nid('x'),
    kind,
    strategy: strategy.name,
    strategyVersion: strategy.version,
    timestamp: bar.time,
    barTime: bar.time,
    price: exitPrice,
    score: trade.confidence,
    confidence: trade.confidence,
    snapshot,
    evidence: trade.evidence,
    traded: true,
    forwardReturns: {},
  });
}

function snapAt(snapshots: FeatureSnapshot[], i: number): FeatureSnapshot | undefined {
  return snapshots[Math.min(i, snapshots.length - 1)] ?? snapshots[snapshots.length - 1];
}

function pushSignal(
  signals: LabSignal[],
  strategy: Strategy,
  snap: FeatureSnapshot,
  kind: SignalKind,
  evidence: SignalEvidence[],
  traded: boolean,
): LabSignal {
  const last = signals[signals.length - 1];
  if (last && last.kind === kind && last.barTime === snap.barTime) return last;
  const sig: LabSignal = {
    id: nid('s'),
    kind,
    strategy: strategy.name,
    strategyVersion: strategy.version,
    timestamp: snap.timestamp,
    barTime: snap.barTime,
    price: snap.price,
    score: snap.absorptionStrength || snap.dataQuality,
    confidence: snap.dataQuality,
    snapshot: snap,
    evidence,
    traded,
    forwardReturns: {},
  };
  signals.push(sig);
  return sig;
}

export function evidenceFrom(snap: FeatureSnapshot): SignalEvidence[] {
  return [
    { label: 'Aggressive buy', value: fmtUsd(snap.aggressiveBuy), percentile: snap.buyPercentile },
    { label: 'Aggressive sell', value: fmtUsd(snap.aggressiveSell), percentile: snap.sellPercentile },
    { label: 'Delta', value: fmtUsd(snap.delta), percentile: snap.deltaPercentile },
    { label: 'CVD', value: fmtUsd(snap.cvd) },
    { label: 'Bid replenishment', value: snap.bidReplenishment.toFixed(1) },
    { label: 'Ask replenishment', value: snap.askReplenishment.toFixed(1) },
    { label: 'Bid withdrawal', value: snap.bidWithdrawal.toFixed(1) },
    { label: 'Ask withdrawal', value: snap.askWithdrawal.toFixed(1) },
    { label: 'Seller absorption', value: snap.sellerAbsorption ? 'TRUE' : 'false', percentile: snap.absorptionPercentile },
    { label: 'Buyer absorption', value: snap.buyerAbsorption ? 'TRUE' : 'false' },
    { label: 'Downside efficiency', value: snap.downsideEfficiency.toFixed(1) },
    { label: 'Upside efficiency', value: snap.upsideEfficiency.toFixed(1) },
    { label: 'Spot delta', value: fmtUsd(snap.spotDelta) },
    { label: 'Futures delta', value: fmtUsd(snap.futuresDelta) },
    { label: 'OI change', value: `${snap.oiChange.toFixed(2)}%` },
    { label: 'Structure', value: snap.structure.shift.replace(/_/g, ' ') },
    { label: 'Data quality', value: String(Math.round(snap.dataQuality)) },
  ];
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}
