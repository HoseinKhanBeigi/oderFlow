import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type SeriesMarker,
} from 'lightweight-charts';
import type { FeatureSnapshot, LabSignal, LabTrade, MarketBar } from '../src/backtest/types.js';

export type OverlayId =
  | 'volume'
  | 'delta'
  | 'cvd'
  | 'spotCvd'
  | 'futuresCvd'
  | 'oi'
  | 'funding'
  | 'liquidations'
  | 'depthImbalance'
  | 'replenishment'
  | 'withdrawal'
  | 'absorption'
  | 'efficiency'
  | 'structure';

export interface OverlayDef {
  id: OverlayId;
  label: string;
  group: string;
}

const OVERLAYS: OverlayDef[] = [
  { id: 'volume', label: 'Volume', group: 'Price' },
  { id: 'delta', label: 'Delta', group: 'Order flow' },
  { id: 'cvd', label: 'CVD', group: 'Order flow' },
  { id: 'spotCvd', label: 'Spot CVD', group: 'Order flow' },
  { id: 'futuresCvd', label: 'Futures CVD', group: 'Order flow' },
  { id: 'oi', label: 'OI', group: 'Derivatives' },
  { id: 'funding', label: 'Funding', group: 'Derivatives' },
  { id: 'liquidations', label: 'Liquidations', group: 'Derivatives' },
  { id: 'depthImbalance', label: 'Depth imbalance', group: 'Book' },
  { id: 'replenishment', label: 'Replenishment', group: 'Book' },
  { id: 'withdrawal', label: 'Withdrawal', group: 'Book' },
  { id: 'absorption', label: 'Absorption', group: 'Microstructure' },
  { id: 'efficiency', label: 'Price efficiency', group: 'Microstructure' },
  { id: 'structure', label: 'Market structure', group: 'Microstructure' },
];

const LINE_GROUP: OverlayId[] = ['cvd', 'spotCvd', 'futuresCvd', 'oi', 'funding', 'depthImbalance', 'efficiency'];
const HIST_GROUP: OverlayId[] = ['delta', 'liquidations', 'replenishment', 'withdrawal'];

const MARKER_STYLE: Record<string, { position: 'aboveBar' | 'belowBar'; color: string; shape: SeriesMarker<UTCTimestamp>['shape']; text: string }> = {
  LONG_SETUP: { position: 'belowBar', color: '#4ade80', shape: 'circle', text: 'LS' },
  LONG_ENTRY: { position: 'belowBar', color: '#22c55e', shape: 'arrowUp', text: 'LONG' },
  LONG_EXIT: { position: 'aboveBar', color: '#86efac', shape: 'square', text: 'X' },
  LONG_STOP: { position: 'aboveBar', color: '#ef4444', shape: 'square', text: 'SL' },
  SHORT_SETUP: { position: 'aboveBar', color: '#fca5a5', shape: 'circle', text: 'SS' },
  SHORT_ENTRY: { position: 'aboveBar', color: '#ef4444', shape: 'arrowDown', text: 'SHORT' },
  SHORT_EXIT: { position: 'belowBar', color: '#fca5a5', shape: 'square', text: 'X' },
  SHORT_STOP: { position: 'belowBar', color: '#22c55e', shape: 'square', text: 'SL' },
  ABSORPTION: { position: 'belowBar', color: '#d4a84b', shape: 'circle', text: 'ABS' },
  LIQUIDITY_VACUUM: { position: 'aboveBar', color: '#22d3ee', shape: 'circle', text: 'VAC' },
  SHORT_SQUEEZE: { position: 'belowBar', color: '#c084fc', shape: 'arrowUp', text: 'SQZ' },
  LONG_SQUEEZE: { position: 'aboveBar', color: '#c084fc', shape: 'arrowDown', text: 'SQZ' },
  LEVERAGE_DRIVEN_RALLY: { position: 'belowBar', color: '#94a3b8', shape: 'circle', text: 'LEV' },
  LEVERAGE_DRIVEN_SELLOFF: { position: 'aboveBar', color: '#94a3b8', shape: 'circle', text: 'LEV' },
  CONTEXT: { position: 'aboveBar', color: '#64748b', shape: 'circle', text: '' },
};

export class LabChart {
  private readonly chart: IChartApi;
  private readonly candles: ISeriesApi<'Candlestick'>;
  private readonly volume: ISeriesApi<'Histogram'>;
  private readonly extra: ISeriesApi<'Histogram'>;
  private readonly line: ISeriesApi<'Line'>;
  private readonly tradePath: ISeriesApi<'Line'>;
  private readonly predSeries: ISeriesApi<'Candlestick'>[];
  private predLines: Array<{
    series: ISeriesApi<'Candlestick'>;
    line: ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>;
  }> = [];
  private lines: Array<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>> = [];
  private structureLines: Array<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>> = [];
  private overlays = new Set<OverlayId>(['volume']);
  private bars: MarketBar[] = [];
  private snaps: FeatureSnapshot[] = [];
  private signals: LabSignal[] = [];
  private simpleMarkers: Array<{ time: number; text: string; color: string; position: 'aboveBar' | 'belowBar'; shape: SeriesMarker<UTCTimestamp>['shape'] }> = [];
  private visibleCount: number | null = null;

  constructor(container: HTMLElement) {
    this.chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: '#07090d' },
        textColor: '#8b95a5',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#141a22' },
        horzLines: { color: '#141a22' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1c2430' },
      timeScale: { borderColor: '#1c2430', timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    this.candles = this.chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });
    this.volume = this.chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    this.extra = this.chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'delta',
    });
    this.extra.priceScale().applyOptions({ scaleMargins: { top: 0.72, bottom: 0.12 } });
    this.line = this.chart.addLineSeries({
      color: '#5b9fd4',
      lineWidth: 1,
      priceScaleId: 'overlay',
      lastValueVisible: false,
    });
    this.line.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.55 } });
    this.tradePath = this.chart.addLineSeries({
      color: '#5b9fd4',
      lineWidth: 2,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
    this.predSeries = [0, 1, 2, 3].map(() =>
      this.chart.addCandlestickSeries({
        upColor: '#d4a84b',
        downColor: '#d4a84b',
        borderVisible: true,
        lastValueVisible: false,
        priceLineVisible: false,
      }),
    );
  }

  overlayList(): OverlayDef[] {
    return OVERLAYS;
  }

  toggleOverlay(id: OverlayId, on: boolean): void {
    if (on) {
      if (LINE_GROUP.includes(id)) {
        for (const other of LINE_GROUP) this.overlays.delete(other);
      }
      if (HIST_GROUP.includes(id)) {
        for (const other of HIST_GROUP) this.overlays.delete(other);
      }
      this.overlays.add(id);
    } else {
      this.overlays.delete(id);
    }
    this.paintOverlays();
    this.setSignals(this.signals);
  }

  isOverlay(id: OverlayId): boolean {
    return this.overlays.has(id);
  }

  setBars(bars: MarketBar[], opts?: { reveal?: boolean; fit?: boolean }): void {
    this.bars = bars;
    this.visibleCount = opts?.reveal ? 0 : null;
    this.paintCandles();
    if (opts?.reveal) return;
    if (opts?.fit === false) {
      this.chart.timeScale().scrollToRealTime();
      return;
    }
    this.chart.timeScale().fitContent();
  }

  setVisibleRange(from: number, to: number): void {
    this.chart.timeScale().setVisibleRange({
      from: from as UTCTimestamp,
      to: to as UTCTimestamp,
    });
  }

  fit(): void {
    this.chart.timeScale().fitContent();
  }

  setPredictedPaths(items: Array<{ bar: MarketBar; color: string; label: string }> | null): void {
    for (const row of this.predLines) row.series.removePriceLine(row.line);
    this.predLines = [];
    for (let i = 0; i < this.predSeries.length; i++) {
      const series = this.predSeries[i]!;
      const item = items?.[i];
      series.setData([]);
      series.setMarkers([]);
      if (!item) continue;
      const { bar, color, label } = item;
      series.applyOptions({
        upColor: color,
        downColor: color,
        borderUpColor: color,
        borderDownColor: color,
        wickUpColor: color,
        wickDownColor: color,
      });
      series.setData([
        {
          time: bar.time as UTCTimestamp,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        },
      ]);
      const up = bar.close >= bar.open;
      series.setMarkers([
        {
          time: bar.time as UTCTimestamp,
          position: up ? 'aboveBar' : 'belowBar',
          color,
          shape: up ? 'arrowUp' : 'arrowDown',
          text: `${label} ${bar.close.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
        },
      ]);
      this.predLines.push({
        series,
        line: series.createPriceLine({
          price: bar.close,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: `${label} ${bar.close.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
          axisLabelVisible: true,
        }),
      });
    }
  }

  setPredictedCandle(bar: MarketBar | null): void {
    this.setPredictedPaths(bar ? [{ bar, color: '#d4a84b', label: 'PRED' }] : null);
  }

  revealUpTo(count: number): void {
    this.visibleCount = Math.max(0, Math.min(count, this.bars.length));
    this.paintCandles();
    this.chart.timeScale().scrollToRealTime();
  }

  setSimpleMarkers(
    markers: Array<{ time: number; text: string; position: 'aboveBar' | 'belowBar'; kind?: string }>,
  ): void {
    this.simpleMarkers = markers.map((m) => {
      const st = m.kind ? MARKER_STYLE[m.kind] : undefined;
      return {
        time: m.time,
        text: m.text,
        position: m.position,
        color: st?.color ?? '#d4a84b',
        shape: st?.shape ?? 'circle',
      };
    });
    this.paintMarkers();
  }

  private visibleBars(): MarketBar[] {
    return this.visibleCount == null ? this.bars : this.bars.slice(0, this.visibleCount);
  }

  private paintCandles(): void {
    const bars = this.visibleBars();
    this.candles.setData(
      bars.map((b) => ({
        time: b.time as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );
    this.paintOverlays();
    this.paintMarkers();
  }

  setSnapshots(snaps: FeatureSnapshot[]): void {
    this.snaps = snaps;
    this.paintOverlays();
  }

  setSignals(signals: LabSignal[], untilTime?: number): void {
    this.signals = signals;
    this.paintMarkers(untilTime);
  }

  showTrade(trade: LabTrade | null): void {
    for (const l of this.lines) this.candles.removePriceLine(l);
    this.lines = [];
    this.tradePath.setData([]);
    if (!trade) return;
    this.lines.push(
      this.candles.createPriceLine({
        price: trade.entryPrice,
        color: '#5b9fd4',
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        title: 'Entry',
        axisLabelVisible: true,
      }),
    );
    this.lines.push(
      this.candles.createPriceLine({
        price: trade.stopPrice,
        color: '#ef5350',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        title: 'Stop',
        axisLabelVisible: true,
      }),
    );
    this.lines.push(
      this.candles.createPriceLine({
        price: trade.targetPrice,
        color: '#26a69a',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        title: 'TP',
        axisLabelVisible: true,
      }),
    );
    const exitPx = trade.exitPrice ?? trade.entryPrice;
    const exitT = trade.exitTime ?? trade.entryTime;
    this.lines.push(
      this.candles.createPriceLine({
        price: exitPx,
        color: trade.r >= 0 ? '#26a69a' : '#ef5350',
        lineWidth: 1,
        lineStyle: LineStyle.SparseDotted,
        title: trade.r >= 0 ? `+${trade.r.toFixed(1)}R` : `${trade.r.toFixed(1)}R`,
        axisLabelVisible: true,
      }),
    );
    this.tradePath.applyOptions({ color: trade.r >= 0 ? '#26a69a' : '#ef5350' });
    this.tradePath.setData([
      { time: trade.entryTime as UTCTimestamp, value: trade.entryPrice },
      { time: exitT as UTCTimestamp, value: exitPx },
    ]);
    const from = trade.entryTime as UTCTimestamp;
    const to = (trade.exitTime ?? trade.entryTime + 3600) as UTCTimestamp;
    this.chart.timeScale().setVisibleRange({ from, to });
  }

  goTo(time: number): void {
    const pad = 40 * 60;
    this.chart.timeScale().setVisibleRange({
      from: (time - pad) as UTCTimestamp,
      to: (time + pad * 4) as UTCTimestamp,
    });
  }

  onCrosshair(handler: (time: number | null) => void): void {
    this.chart.subscribeCrosshairMove((param) => {
      const t = param.time;
      handler(typeof t === 'number' ? t : null);
    });
  }

  onClick(handler: (time: number | null) => void): void {
    this.chart.subscribeClick((param) => {
      const t = param.time;
      handler(typeof t === 'number' ? t : null);
    });
  }

  setReplayTime(time: number): void {
    this.goTo(time);
  }

  private paintMarkers(untilTime?: number): void {
    const last = this.visibleBars()[this.visibleBars().length - 1];
    const until = untilTime ?? last?.time;
    const seen = new Set<string>();
    const markers: SeriesMarker<UTCTimestamp>[] = [];
    for (const s of this.signals) {
      if (until != null && s.barTime > until) continue;
      if (s.kind === 'CONTEXT') continue;
      const key = `${s.barTime}:${s.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const st = MARKER_STYLE[s.kind];
      if (!st) continue;
      markers.push({
        time: s.barTime as UTCTimestamp,
        position: st.position,
        color: st.color,
        shape: st.shape,
        text: st.text,
      });
    }
    if (this.overlays.has('absorption')) {
      for (const snap of this.snaps) {
        if (until != null && snap.barTime > until) continue;
        if (!snap.sellerAbsorption && !snap.buyerAbsorption) continue;
        const key = `${snap.barTime}:ABS`;
        if (seen.has(key)) continue;
        seen.add(key);
        markers.push({
          time: snap.barTime as UTCTimestamp,
          position: snap.sellerAbsorption ? 'belowBar' : 'aboveBar',
          color: '#d4a84b',
          shape: 'circle',
          text: snap.sellerAbsorption ? 'S-ABS' : 'B-ABS',
        });
      }
    }
    if (this.overlays.has('structure')) {
      for (const snap of this.snaps) {
        if (until != null && snap.barTime > until) continue;
        if (snap.structure.shift === 'NONE') continue;
        const bull = snap.structure.shift.includes('BULLISH');
        markers.push({
          time: snap.barTime as UTCTimestamp,
          position: bull ? 'belowBar' : 'aboveBar',
          color: bull ? '#4ade80' : '#f87171',
          shape: 'square',
          text: snap.structure.shift.replace('_', ' ').slice(0, 12),
        });
      }
    }
    for (const m of this.simpleMarkers) {
      if (until != null && m.time > until) continue;
      markers.push({
        time: m.time as UTCTimestamp,
        position: m.position,
        color: m.color,
        shape: m.shape,
        text: m.text,
      });
    }
    this.candles.setMarkers(markers);
    this.paintStructureLevels();
  }

  private paintStructureLevels(): void {
    for (const l of this.structureLines) this.candles.removePriceLine(l);
    this.structureLines = [];
    if (!this.overlays.has('structure') || !this.snaps.length) return;
    const last = this.snaps[this.snaps.length - 1]!;
    if (last.structure.swingHigh != null) {
      this.structureLines.push(
        this.candles.createPriceLine({
          price: last.structure.swingHigh,
          color: '#ef535088',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: 'Swing high',
          axisLabelVisible: true,
        }),
      );
    }
    if (last.structure.swingLow != null) {
      this.structureLines.push(
        this.candles.createPriceLine({
          price: last.structure.swingLow,
          color: '#26a69a88',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: 'Swing low',
          axisLabelVisible: true,
        }),
      );
    }
  }

  private paintOverlays(): void {
    const bars = this.visibleBars();
    const until = bars[bars.length - 1]?.time;
    const snaps = until == null ? this.snaps : this.snaps.filter((s) => s.barTime <= until);
    const volOn = this.overlays.has('volume');
    this.volume.setData(
      volOn
        ? bars.map((b) => ({
            time: b.time as UTCTimestamp,
            value: b.aggressiveBuy + b.aggressiveSell || b.volume,
            color: b.close >= b.open ? '#26a69a55' : '#ef535055',
          }))
        : [],
    );

    const hist = HIST_GROUP.find((id) => this.overlays.has(id));
    if (!hist) {
      this.extra.setData([]);
    } else if (hist === 'delta') {
      this.extra.setData(
        bars.map((b) => {
          const d = b.aggressiveBuy - b.aggressiveSell;
          return { time: b.time as UTCTimestamp, value: d, color: d >= 0 ? '#26a69a99' : '#ef535099' };
        }),
      );
    } else if (hist === 'liquidations') {
      this.extra.setData(
        snaps.map((s) => {
          const d = s.shortLiquidations - s.longLiquidations;
          return { time: s.barTime as UTCTimestamp, value: d, color: d >= 0 ? '#c084fc99' : '#f59e0b99' };
        }),
      );
    } else if (hist === 'replenishment') {
      this.extra.setData(
        snaps.map((s) => ({
          time: s.barTime as UTCTimestamp,
          value: s.bidReplenishment - s.askReplenishment,
          color: s.bidReplenishment >= s.askReplenishment ? '#26a69a99' : '#ef535099',
        })),
      );
    } else {
      this.extra.setData(
        snaps.map((s) => ({
          time: s.barTime as UTCTimestamp,
          value: s.askWithdrawal - s.bidWithdrawal,
          color: s.askWithdrawal >= s.bidWithdrawal ? '#22d3ee99' : '#f9731699',
        })),
      );
    }

    const lineKey = LINE_GROUP.find((id) => this.overlays.has(id));
    if (!lineKey || !snaps.length) {
      this.line.setData([]);
    } else {
      const color =
        lineKey === 'oi' ? '#c084fc' : lineKey === 'funding' ? '#f59e0b' : lineKey === 'efficiency' ? '#22d3ee' : lineKey === 'depthImbalance' ? '#94a3b8' : '#5b9fd4';
      this.line.applyOptions({ color });
      this.line.setData(
        snaps.map((s) => ({
          time: s.barTime as UTCTimestamp,
          value: lineValue(s, lineKey),
        })),
      );
    }
  }

  destroy(): void {
    this.chart.remove();
  }
}

function lineValue(s: FeatureSnapshot, key: OverlayId): number {
  if (key === 'spotCvd') return s.spotCvd;
  if (key === 'futuresCvd') return s.futuresCvd;
  if (key === 'oi') return s.oi;
  if (key === 'funding') return s.funding;
  if (key === 'efficiency') return s.priceEfficiency;
  if (key === 'depthImbalance') {
    const tot = s.bidDepth + s.askDepth;
    return tot > 0 ? ((s.bidDepth - s.askDepth) / tot) * 100 : 0;
  }
  return s.cvd;
}
