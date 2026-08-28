import { FORWARD_HORIZONS_MIN, type BacktestResult, type EquityPoint, type LabSignal, type LabTrade, type PerformanceStats, type SignalTypeStats } from './types.js';
import type { MarketBar } from './types.js';

const MIN_SAMPLE = 20;

export function summarizeTrades(
  trades: LabTrade[],
  equity0: number,
  equity: EquityPoint[],
): PerformanceStats {
  const closed = trades.filter((t) => !t.open && t.exitPrice != null);
  const pnls = closed.map((t) => t.pnl);
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLossAbs = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const net = pnls.reduce((s, n) => s + n, 0);
  const rs = closed.map((t) => t.r).sort((a, b) => a - b);
  const maxDd = equity.reduce((m, p) => Math.max(m, p.drawdownPct), 0);
  const rets = barReturns(equity);
  const sharpe = ratio(rets, 0);
  const sortino = ratio(rets, 0, true);
  const calmar = maxDd > 0 ? ((net / Math.max(equity0, 1)) * 100) / maxDd : 0;

  return {
    netPnl: net,
    grossPnl: grossWin,
    returnPct: equity0 > 0 ? (net / equity0) * 100 : 0,
    totalTrades: closed.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: grossLossAbs > 0 ? grossWin / grossLossAbs : grossWin > 0 ? 99 : 0,
    expectancy: closed.length ? net / closed.length : 0,
    averageWin: wins.length ? grossWin / wins.length : 0,
    averageLoss: losses.length ? -grossLossAbs / losses.length : 0,
    largestWin: wins.reduce((m, t) => Math.max(m, t.pnl), 0),
    largestLoss: losses.reduce((m, t) => Math.min(m, t.pnl), 0),
    maxDrawdown: maxDd * (equity0 / 100),
    maxDrawdownPct: maxDd,
    sharpe,
    sortino,
    calmar,
    averageR: rs.length ? rs.reduce((s, n) => s + n, 0) / rs.length : 0,
    medianR: rs.length ? percentile(rs, 50) : 0,
    maxConsecWins: streak(closed, true),
    maxConsecLosses: streak(closed, false),
    feesPaid: closed.reduce((s, t) => s + t.fees, 0),
    estimatedSlippage: closed.reduce((s, t) => s + t.slippage, 0),
    sampleSize: closed.length,
    insufficientSample: closed.length < MIN_SAMPLE,
  };
}

export function equityCurve(trades: LabTrade[], startEquity: number, bars: MarketBar[]): EquityPoint[] {
  const byTime = new Map<number, number>();
  for (const t of trades) {
    if (t.exitTime == null) continue;
    byTime.set(t.exitTime, (byTime.get(t.exitTime) ?? 0) + t.pnl);
  }
  let eq = startEquity;
  let peak = startEquity;
  const out: EquityPoint[] = [];
  for (const bar of bars) {
    eq += byTime.get(bar.time) ?? 0;
    peak = Math.max(peak, eq);
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    out.push({ time: bar.time, equity: eq, drawdownPct: dd });
  }
  return out;
}

export function bySignalType(trades: LabTrade[], signals: LabSignal[]): SignalTypeStats[] {
  const keys = new Map<string, LabTrade[]>();
  for (const t of trades) {
    const sig = signals.find((s) => s.id === t.signalId);
    const kind = sig?.kind.startsWith('LONG') || sig?.kind.startsWith('SHORT')
      ? contextLabel(sig)
      : t.strategy;
    const arr = keys.get(kind) ?? [];
    arr.push(t);
    keys.set(kind, arr);
  }
  return [...keys.entries()].map(([kind, list]) => {
    const closed = list.filter((t) => !t.open);
    const wins = closed.filter((t) => t.pnl > 0).length;
    return {
      kind,
      trades: closed.length,
      winRate: closed.length ? (wins / closed.length) * 100 : 0,
      avgR: closed.length ? closed.reduce((s, t) => s + t.r, 0) / closed.length : 0,
      netPnl: closed.reduce((s, t) => s + t.pnl, 0),
    };
  });
}

function contextLabel(sig: LabSignal): string {
  const abs = sig.snapshot.sellerAbsorption ? 'Seller Absorption' : sig.snapshot.buyerAbsorption ? 'Buyer Absorption' : null;
  if (abs) return abs;
  if (sig.snapshot.upsideVacuum || sig.snapshot.downsideVacuum) return 'Liquidity Vacuum';
  if (sig.snapshot.spotLed) return 'Spot-led';
  if (sig.snapshot.futuresLed) return 'Futures-led';
  return sig.strategy;
}

export function attachForwardReturns(signals: LabSignal[], bars: MarketBar[], tfMinutes: number): void {
  const times = bars.map((b) => b.time);
  const closes = bars.map((b) => b.close);
  for (const sig of signals) {
    const i = times.findIndex((t) => t === sig.barTime);
    const px = i >= 0 ? closes[i] : undefined;
    const out: Record<string, number | null> = {};
    for (const h of FORWARD_HORIZONS_MIN) {
      const key = horizonKey(h);
      if (px == null || i < 0) {
        out[key] = null;
        continue;
      }
      const need = Math.max(1, Math.round(h / tfMinutes));
      const j = i + need;
      const later = closes[j];
      out[key] = later == null ? null : ((later - px) / px) * 100;
    }
    sig.forwardReturns = out;
  }
}

export function horizonKey(min: number): string {
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${min / 60}h`;
  return `${min / 1440}d`;
}

function streak(trades: LabTrade[], win: boolean): number {
  let best = 0;
  let cur = 0;
  for (const t of trades) {
    const ok = t.pnl > 0;
    if (ok === win) {
      cur += 1;
      best = Math.max(best, cur);
    } else cur = 0;
  }
  return best;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (idx - lo);
}

function barReturns(equity: EquityPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!.equity;
    const cur = equity[i]!.equity;
    if (prev > 0) out.push((cur - prev) / prev);
  }
  return out;
}

function ratio(rets: number[], rf: number, downside = false): number {
  const sample = downside ? rets.filter((r) => r < rf) : rets;
  if (sample.length < 2) return 0;
  const mean = rets.reduce((s, n) => s + n, 0) / rets.length - rf;
  const varSum = sample.reduce((s, n) => s + (n - mean) * (n - mean), 0);
  const std = Math.sqrt(varSum / sample.length);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(365);
}

export function emptyResultPatch(): Pick<BacktestResult, 'bySignalType'> {
  return { bySignalType: [] };
}
