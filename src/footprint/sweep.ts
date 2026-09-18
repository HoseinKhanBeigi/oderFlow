/**
 * Liquidity sweep / rejection detector.
 *
 * Levels come only from prior completed candles. A wick beyond those levels
 * is a sweep only if the close rejects back inside; a close beyond the level
 * is acceptance, not an automatic breakout or trade.
 */

export type SweepState =
  | 'NO_EVENT'
  | 'NO_DATA'
  | 'STALE'
  | 'LOW_CONFIDENCE'
  | 'HIGH_SWEEP'
  | 'LOW_SWEEP'
  | 'UPSIDE_ACCEPTANCE'
  | 'DOWNSIDE_ACCEPTANCE'
  | 'HIGH_SWEEP_CONFIRMED'
  | 'LOW_SWEEP_CONFIRMED'
  | 'FAILED_HIGH_SWEEP'
  | 'FAILED_LOW_SWEEP';

export type SweepBias =
  | 'BEARISH_REJECTION'
  | 'BULLISH_REJECTION'
  | 'UPSIDE_ACCEPTANCE'
  | 'DOWNSIDE_ACCEPTANCE'
  | null;

export interface SweepCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  totalBuy?: number;
  totalSell?: number;
}

export interface SweepConfig {
  lookback: number;
  epsilon: number;
  closePosHighSweepMax: number;
  closePosLowSweepMin: number;
  breakoutBufferBps: number;
  volFilter: 'median' | 'atr';
  medianRangeN: number;
  medianRangeMultiplier: number;
  atrPeriod: number;
  atrMultiplier: number;
  minBodyShare: number;
  minPenetrationBps: number;
  minQuality: number;
  minQualityForAlert: number;
  volumePercentileMin: number | null;
  staleTfMultiple: number;
}

export interface SweepFlow {
  delta: number;
  deltaPct: number;
  aggression: 'buy' | 'sell' | 'balanced';
  absorbed: 'BUYERS' | 'SELLERS' | null;
  note: string;
}

export interface SweepRead {
  state: SweepState;
  bias: SweepBias;
  timeframeMinutes: number;
  support: number | null;
  resistance: number | null;
  open: number;
  high: number;
  low: number;
  close: number;
  closePosition: number | null;
  highSweepPenetrationBps: number | null;
  lowSweepPenetrationBps: number | null;
  rejectionDepthBps: number | null;
  rangeExpansion: number | null;
  sweepQuality: number | null;
  volumePercentile: number | null;
  flow: SweepFlow | null;
  alertable: boolean;
  why: string;
}

export const DEFAULT_SWEEP_CONFIG: SweepConfig = {
  lookback: 16,
  epsilon: 1e-9,
  closePosHighSweepMax: 0.4,
  closePosLowSweepMin: 0.6,
  breakoutBufferBps: 8,
  volFilter: 'median',
  medianRangeN: 20,
  medianRangeMultiplier: 1.15,
  atrPeriod: 14,
  atrMultiplier: 1.15,
  minBodyShare: 0.35,
  minPenetrationBps: 5,
  minQuality: 40,
  minQualityForAlert: 50,
  volumePercentileMin: null,
  staleTfMultiple: 2,
};

const ALERT_STATES: SweepState[] = [
  'HIGH_SWEEP',
  'LOW_SWEEP',
  'UPSIDE_ACCEPTANCE',
  'DOWNSIDE_ACCEPTANCE',
  'HIGH_SWEEP_CONFIRMED',
  'LOW_SWEEP_CONFIRMED',
];

export function detectLiquiditySweep(
  bars: SweepCandle[] | undefined,
  options: {
    timeframeMinutes?: number;
    config?: Partial<SweepConfig>;
    nowMs?: number;
  } = {},
): SweepRead {
  const cfg: SweepConfig = { ...DEFAULT_SWEEP_CONFIG, ...options.config };
  const tf = options.timeframeMinutes ?? 5;
  const nowMs = options.nowMs ?? Date.now();

  if (!bars?.length || bars.length < cfg.lookback + 1) {
    return baseRead({
      state: 'NO_DATA',
      timeframeMinutes: tf,
      why: `Need ${cfg.lookback} completed bars before the current candle`,
    });
  }

  const idx = bars.length - 1;
  const current = classifyBar(bars, idx, cfg, tf, nowMs);
  if (idx < cfg.lookback + 1) return current;

  const prev = classifyBar(bars, idx - 1, cfg, tf, nowMs);
  if (current.state === 'NO_DATA' || current.state === 'STALE') return current;
  if (isPrimaryEvent(current.state)) return current;
  const follow = followThrough(prev, bars[idx]!, cfg);
  return follow ?? current;
}

function classifyBar(
  bars: SweepCandle[],
  idx: number,
  cfg: SweepConfig,
  tf: number,
  nowMs: number,
): SweepRead {
  const bar = bars[idx];
  if (!bar) {
    return baseRead({ state: 'NO_DATA', timeframeMinutes: tf, why: 'Missing candle' });
  }
  const prior = bars.slice(Math.max(0, idx - Math.max(cfg.lookback, cfg.medianRangeN, cfg.atrPeriod)), idx);
  const levelBars = prior.slice(-cfg.lookback);
  if (levelBars.length < cfg.lookback) {
    return baseRead({
      state: 'NO_DATA',
      timeframeMinutes: tf,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      why: `Need ${cfg.lookback} completed bars before the current candle`,
    });
  }

  if (isStale(bar, tf, cfg, nowMs)) {
    return baseRead({
      state: 'STALE',
      timeframeMinutes: tf,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      why: 'Candle is stale relative to its timeframe',
    });
  }

  const { support, resistance } = swingLevels(levelBars);
  if (support == null || resistance == null || !(resistance > support)) {
    return baseRead({
      state: 'NO_DATA',
      timeframeMinutes: tf,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      why: 'Invalid support / resistance from prior bars',
    });
  }

  const range = Math.max(bar.high - bar.low, cfg.epsilon);
  const closePosition = (bar.close - bar.low) / range;
  const body = Math.abs(bar.close - bar.open);
  const expansion = rangeExpansion(bar, prior, cfg);
  const expanded = expansion.ok;
  const volumePercentile = volumePct(bar, prior);
  const volOk = cfg.volumePercentileMin == null || (volumePercentile != null && volumePercentile >= cfg.volumePercentileMin);
  const highPen = bps(bar.high - resistance, resistance);
  const lowPen = bps(support - bar.low, support);
  const buffer = resistance * (cfg.breakoutBufferBps / 10_000);
  const supportBuffer = support * (cfg.breakoutBufferBps / 10_000);
  const flow = enrichFlow(bar);

  const common = {
    timeframeMinutes: tf,
    support,
    resistance,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    closePosition,
    highSweepPenetrationBps: highPen,
    lowSweepPenetrationBps: lowPen,
    rangeExpansion: expansion.ratio,
    volumePercentile,
    flow,
  };

  if (!expanded) {
    return {
      ...baseRead({ state: 'NO_EVENT', ...common, why: 'Range not expanded — quiet wick ignored' }),
      ...common,
    };
  }
  if (!volOk) {
    return {
      ...baseRead({ state: 'NO_EVENT', ...common, why: 'Volume below optional percentile filter' }),
      ...common,
    };
  }

  const highSweep =
    bar.high > resistance
    && bar.close < resistance
    && closePosition <= cfg.closePosHighSweepMax;
  const lowSweep =
    bar.low < support
    && bar.close > support
    && closePosition >= cfg.closePosLowSweepMin;
  const upside =
    bar.close > resistance + buffer
    && body / range >= cfg.minBodyShare;
  const downside =
    bar.close < support - supportBuffer
    && body / range >= cfg.minBodyShare;

  if (highSweep) {
    const rejectionDepthBps = bps(resistance - bar.close, resistance);
    const quality = sweepQuality({
      kind: 'high',
      closePosition,
      penetrationBps: highPen,
      rejectionDepthBps,
      expansion: expansion.ratio,
      volumePercentile,
    });
    const tiny = highPen < cfg.minPenetrationBps;
    const state: SweepState = tiny || quality < cfg.minQuality ? 'LOW_CONFIDENCE' : 'HIGH_SWEEP';
    return {
      ...baseRead({
        state,
        bias: 'BEARISH_REJECTION',
        ...common,
        rejectionDepthBps,
        sweepQuality: quality,
        alertable: state === 'HIGH_SWEEP' && quality >= cfg.minQualityForAlert,
        why: tiny
          ? 'High wick beyond resistance is too small to count as a sweep'
          : 'Traded above prior resistance, closed back inside toward the low',
      }),
      ...common,
      rejectionDepthBps,
      sweepQuality: quality,
    };
  }

  if (lowSweep) {
    const rejectionDepthBps = bps(bar.close - support, support);
    const quality = sweepQuality({
      kind: 'low',
      closePosition,
      penetrationBps: lowPen,
      rejectionDepthBps,
      expansion: expansion.ratio,
      volumePercentile,
    });
    const tiny = lowPen < cfg.minPenetrationBps;
    const state: SweepState = tiny || quality < cfg.minQuality ? 'LOW_CONFIDENCE' : 'LOW_SWEEP';
    return {
      ...baseRead({
        state,
        bias: 'BULLISH_REJECTION',
        ...common,
        rejectionDepthBps,
        sweepQuality: quality,
        alertable: state === 'LOW_SWEEP' && quality >= cfg.minQualityForAlert,
        why: tiny
          ? 'Low wick beyond support is too small to count as a sweep'
          : 'Traded below prior support, closed back inside toward the high',
      }),
      ...common,
      rejectionDepthBps,
      sweepQuality: quality,
    };
  }

  if (upside) {
    const quality = acceptQuality({
      beyondBps: bps(bar.close - resistance, resistance),
      closePosition,
      expansion: expansion.ratio,
      bodyShare: body / range,
      volumePercentile,
      upside: true,
    });
    const state: SweepState = quality < cfg.minQuality ? 'LOW_CONFIDENCE' : 'UPSIDE_ACCEPTANCE';
    return {
      ...baseRead({
        state,
        bias: 'UPSIDE_ACCEPTANCE',
        ...common,
        sweepQuality: quality,
        alertable: state === 'UPSIDE_ACCEPTANCE' && quality >= cfg.minQualityForAlert,
        why: 'Closed beyond prior resistance by more than the breakout buffer',
      }),
      ...common,
      sweepQuality: quality,
    };
  }

  if (downside) {
    const quality = acceptQuality({
      beyondBps: bps(support - bar.close, support),
      closePosition,
      expansion: expansion.ratio,
      bodyShare: body / range,
      volumePercentile,
      upside: false,
    });
    const state: SweepState = quality < cfg.minQuality ? 'LOW_CONFIDENCE' : 'DOWNSIDE_ACCEPTANCE';
    return {
      ...baseRead({
        state,
        bias: 'DOWNSIDE_ACCEPTANCE',
        ...common,
        sweepQuality: quality,
        alertable: state === 'DOWNSIDE_ACCEPTANCE' && quality >= cfg.minQualityForAlert,
        why: 'Closed beyond prior support by more than the breakout buffer',
      }),
      ...common,
      sweepQuality: quality,
    };
  }

  return {
    ...baseRead({ state: 'NO_EVENT', ...common, why: 'No sweep or acceptance vs prior completed levels' }),
    ...common,
  };
}

function followThrough(prev: SweepRead, next: SweepCandle, cfg: SweepConfig): SweepRead | null {
  if (prev.state === 'HIGH_SWEEP' && prev.resistance != null) {
    if (next.close < prev.resistance) {
      return {
        ...prev,
        state: 'HIGH_SWEEP_CONFIRMED',
        bias: 'BEARISH_REJECTION',
        alertable: (prev.sweepQuality ?? 0) >= cfg.minQualityForAlert,
        why: 'High sweep held — next candle did not reclaim prior resistance',
      };
    }
    if (next.close > prev.resistance) {
      return {
        ...prev,
        state: 'FAILED_HIGH_SWEEP',
        bias: null,
        alertable: false,
        why: 'High sweep failed — next candle reclaimed prior resistance',
      };
    }
  }
  if (prev.state === 'LOW_SWEEP' && prev.support != null) {
    if (next.close > prev.support) {
      return {
        ...prev,
        state: 'LOW_SWEEP_CONFIRMED',
        bias: 'BULLISH_REJECTION',
        alertable: (prev.sweepQuality ?? 0) >= cfg.minQualityForAlert,
        why: 'Low sweep held — next candle stayed above prior support',
      };
    }
    if (next.close < prev.support) {
      return {
        ...prev,
        state: 'FAILED_LOW_SWEEP',
        bias: null,
        alertable: false,
        why: 'Low sweep failed — next candle lost prior support',
      };
    }
  }
  return null;
}

function swingLevels(prior: SweepCandle[]): { support: number | null; resistance: number | null } {
  let resistance = -Infinity;
  let support = Infinity;
  for (const b of prior) {
    if (b.high > resistance) resistance = b.high;
    if (b.low < support) support = b.low;
  }
  if (!Number.isFinite(resistance) || !Number.isFinite(support)) return { support: null, resistance: null };
  return { support, resistance };
}

function rangeExpansion(bar: SweepCandle, prior: SweepCandle[], cfg: SweepConfig): { ok: boolean; ratio: number } {
  const range = Math.max(bar.high - bar.low, 0);
  if (cfg.volFilter === 'atr') {
    const sample = prior.slice(-cfg.atrPeriod);
    const atr = avg(sample.map((b) => Math.max(b.high - b.low, 0)));
    const ratio = atr > 0 ? range / atr : 0;
    return { ok: atr > 0 && range >= atr * cfg.atrMultiplier, ratio };
  }
  const sample = prior.slice(-cfg.medianRangeN).map((b) => Math.max(b.high - b.low, 0));
  const med = median(sample);
  const ratio = med > 0 ? range / med : 0;
  return { ok: med > 0 && range > med * cfg.medianRangeMultiplier, ratio };
}

function volumeOf(bar: SweepCandle): number {
  if (bar.volume != null && bar.volume > 0) return bar.volume;
  return Math.max(0, (bar.totalBuy ?? 0) + (bar.totalSell ?? 0));
}

function volumePct(bar: SweepCandle, prior: SweepCandle[]): number | null {
  const vols = prior.map(volumeOf).filter((v) => v > 0);
  const cur = volumeOf(bar);
  if (!vols.length || !(cur > 0)) return null;
  const below = vols.filter((v) => v <= cur).length;
  return (below / vols.length) * 100;
}

function sweepQuality(input: {
  kind: 'high' | 'low';
  closePosition: number;
  penetrationBps: number;
  rejectionDepthBps: number;
  expansion: number;
  volumePercentile: number | null;
}): number {
  const closeScore = input.kind === 'high'
    ? clamp((0.4 - input.closePosition) / 0.4, 0, 1)
    : clamp((input.closePosition - 0.6) / 0.4, 0, 1);
  const pen = clamp(input.penetrationBps / 40, 0, 1);
  const rej = clamp(input.rejectionDepthBps / 40, 0, 1);
  const exp = clamp((input.expansion - 1) / 1, 0, 1);
  const vol = input.volumePercentile != null ? clamp(input.volumePercentile / 100, 0, 1) : 0.5;
  return Math.round(pen * 25 + rej * 25 + closeScore * 20 + exp * 20 + vol * 10);
}

function acceptQuality(input: {
  beyondBps: number;
  closePosition: number;
  expansion: number;
  bodyShare: number;
  volumePercentile: number | null;
  upside: boolean;
}): number {
  const beyond = clamp(input.beyondBps / 30, 0, 1);
  const closeScore = input.upside ? clamp(input.closePosition, 0, 1) : clamp(1 - input.closePosition, 0, 1);
  const exp = clamp((input.expansion - 1) / 1, 0, 1);
  const body = clamp(input.bodyShare, 0, 1);
  const vol = input.volumePercentile != null ? clamp(input.volumePercentile / 100, 0, 1) : 0.5;
  return Math.round(beyond * 25 + closeScore * 20 + exp * 20 + body * 25 + vol * 10);
}

function enrichFlow(bar: SweepCandle): SweepFlow | null {
  const buy = bar.totalBuy ?? 0;
  const sell = bar.totalSell ?? 0;
  const vol = buy + sell;
  if (!(vol > 0)) return null;
  const delta = buy - sell;
  const deltaPct = delta / vol;
  const range = Math.max(bar.high - bar.low, 1e-9);
  const closePos = (bar.close - bar.low) / range;
  const dominated = Math.abs(deltaPct) >= 0.25;
  const absorbed = dominated && delta > 0 && closePos <= 0.45
    ? 'BUYERS' as const
    : dominated && delta < 0 && closePos >= 0.55
      ? 'SELLERS' as const
      : null;
  const aggression = deltaPct >= 0.18 ? 'buy' : deltaPct <= -0.18 ? 'sell' : 'balanced';
  const note = absorbed === 'BUYERS'
    ? 'Aggressive buy into the high, close stalled — seller defense'
    : absorbed === 'SELLERS'
      ? 'Aggressive sell into the low, close held — buyer defense'
      : aggression === 'buy'
        ? 'Buy aggression on the candle'
        : aggression === 'sell'
          ? 'Sell aggression on the candle'
          : 'Balanced aggression';
  return { delta, deltaPct, aggression, absorbed, note };
}

function isStale(bar: SweepCandle, tf: number, cfg: SweepConfig, nowMs: number): boolean {
  if (!(tf > 0) || !(cfg.staleTfMultiple > 0)) return false;
  const openMs = bar.time > 1e12 ? bar.time : bar.time * 1000;
  return nowMs - openMs > tf * 60_000 * cfg.staleTfMultiple;
}

function isPrimaryEvent(state: SweepState): boolean {
  return state === 'HIGH_SWEEP'
    || state === 'LOW_SWEEP'
    || state === 'UPSIDE_ACCEPTANCE'
    || state === 'DOWNSIDE_ACCEPTANCE';
}

function bps(distance: number, ref: number): number {
  if (!(ref > 0)) return 0;
  return (distance / ref) * 10_000;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function baseRead(partial: Partial<SweepRead> & { state: SweepState; why: string }): SweepRead {
  return {
    state: partial.state,
    bias: partial.bias ?? null,
    timeframeMinutes: partial.timeframeMinutes ?? 5,
    support: partial.support ?? null,
    resistance: partial.resistance ?? null,
    open: partial.open ?? 0,
    high: partial.high ?? 0,
    low: partial.low ?? 0,
    close: partial.close ?? 0,
    closePosition: partial.closePosition ?? null,
    highSweepPenetrationBps: partial.highSweepPenetrationBps ?? null,
    lowSweepPenetrationBps: partial.lowSweepPenetrationBps ?? null,
    rejectionDepthBps: partial.rejectionDepthBps ?? null,
    rangeExpansion: partial.rangeExpansion ?? null,
    sweepQuality: partial.sweepQuality ?? null,
    volumePercentile: partial.volumePercentile ?? null,
    flow: partial.flow ?? null,
    alertable: partial.alertable ?? false,
    why: partial.why,
  };
}

export function isSweepAlertState(state: SweepState): boolean {
  return ALERT_STATES.includes(state);
}

export function sweepStory(read: SweepRead | null | undefined): {
  badge: string;
  line1: string;
  line2: string;
  color: string;
} | null {
  if (!read) return null;
  switch (read.state) {
    case 'HIGH_SWEEP':
      return { badge: 'SWEEP', line1: 'High sweep', line2: 'bearish rejection', color: '#e879f9' };
    case 'LOW_SWEEP':
      return { badge: 'SWEEP', line1: 'Low sweep', line2: 'bullish rejection', color: '#e879f9' };
    case 'UPSIDE_ACCEPTANCE':
      return { badge: 'ACCEPT', line1: 'Upside acceptance', line2: 'held above resist', color: '#22c55e' };
    case 'DOWNSIDE_ACCEPTANCE':
      return { badge: 'ACCEPT', line1: 'Downside acceptance', line2: 'held below support', color: '#ef4444' };
    case 'HIGH_SWEEP_CONFIRMED':
      return { badge: 'HELD', line1: 'High sweep held', line2: 'resist not reclaimed', color: '#c084fc' };
    case 'LOW_SWEEP_CONFIRMED':
      return { badge: 'HELD', line1: 'Low sweep held', line2: 'support held', color: '#c084fc' };
    case 'FAILED_HIGH_SWEEP':
      return { badge: 'FAIL', line1: 'High sweep failed', line2: 'resist reclaimed', color: '#8b949e' };
    case 'FAILED_LOW_SWEEP':
      return { badge: 'FAIL', line1: 'Low sweep failed', line2: 'support lost', color: '#8b949e' };
    default:
      return null;
  }
}

export function formatSweepAlert(read: SweepRead, label: string): {
  kind: string;
  side: 'buy' | 'sell';
  title: string;
  detail: string;
} | null {
  if (!read.alertable || !isSweepAlertState(read.state)) return null;
  const story = sweepStory(read);
  if (!story) return null;
  const tf = read.timeframeMinutes % 60 === 0 ? `${read.timeframeMinutes / 60}h` : `${read.timeframeMinutes}m`;
  const kind =
    read.state === 'HIGH_SWEEP' ? 'high-sweep'
      : read.state === 'LOW_SWEEP' ? 'low-sweep'
        : read.state === 'UPSIDE_ACCEPTANCE' ? 'upside-accept'
          : read.state === 'DOWNSIDE_ACCEPTANCE' ? 'downside-accept'
            : read.state === 'HIGH_SWEEP_CONFIRMED' ? 'high-held'
              : 'low-held';
  const side: 'buy' | 'sell' =
    read.state === 'LOW_SWEEP' || read.state === 'LOW_SWEEP_CONFIRMED' || read.state === 'UPSIDE_ACCEPTANCE'
      ? 'buy'
      : 'sell';
  const bits = [story.line2, tf];
  if (read.state === 'HIGH_SWEEP' || read.state === 'HIGH_SWEEP_CONFIRMED') {
    if (read.resistance != null) bits.push(`R ${fmtPx(read.resistance)}`);
    bits.push(`H ${fmtPx(read.high)}`, `C ${fmtPx(read.close)}`);
    if (read.highSweepPenetrationBps != null) bits.push(`pen +${read.highSweepPenetrationBps.toFixed(1)}bps`);
  } else if (read.state === 'LOW_SWEEP' || read.state === 'LOW_SWEEP_CONFIRMED') {
    if (read.support != null) bits.push(`S ${fmtPx(read.support)}`);
    bits.push(`L ${fmtPx(read.low)}`, `C ${fmtPx(read.close)}`);
    if (read.lowSweepPenetrationBps != null) bits.push(`pen ${read.lowSweepPenetrationBps.toFixed(1)}bps`);
  }
  if (read.closePosition != null) bits.push(`close ${read.closePosition.toFixed(2)}`);
  if (read.rangeExpansion != null) bits.push(`${read.rangeExpansion.toFixed(2)}x med`);
  if (read.sweepQuality != null) bits.push(`Q${read.sweepQuality}`);
  return {
    kind,
    side,
    title: `${label} · ${story.line1}`,
    detail: bits.join(' · '),
  };
}

function fmtPx(p: number): string {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}
