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
  | 'futuresCvd';

const OVERLAYS: Array<{ id: OverlayId; label: string }> = [
  { id: 'volume', label: 'Volume' },
  { id: 'delta', label: 'Delta' },
  { id: 'cvd', label: 'CVD' },
  { id: 'spotCvd', label: 'Spot CVD' },
  { id: 'futuresCvd', label: 'Futures CVD' },
];

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
  private readonly cvd: ISeriesApi<'Line'>;
  private lines: Array<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>> = [];
  private overlays = new Set<OverlayId>(['volume']);
  private bars: MarketBar[] = [];
  private snaps: FeatureSnapshot[] = [];

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
    this.cvd = this.chart.addLineSeries({
      color: '#5b9fd4',
      lineWidth: 1,
      priceScaleId: 'cvd',
      lastValueVisible: false,
    });
    this.cvd.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.55 } });
  }

  overlayList(): typeof OVERLAYS {
    return OVERLAYS;
  }

  toggleOverlay(id: OverlayId, on: boolean): void {
    if (on) this.overlays.add(id);
    else this.overlays.delete(id);
    this.paintOverlays();
  }

  isOverlay(id: OverlayId): boolean {
    return this.overlays.has(id);
  }

  setBars(bars: MarketBar[]): void {
    this.bars = bars;
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
    this.chart.timeScale().fitContent();
  }

  setSnapshots(snaps: FeatureSnapshot[]): void {
    this.snaps = snaps;
    this.paintOverlays();
  }

  setSignals(signals: LabSignal[], untilTime?: number): void {
    const seen = new Set<string>();
    const markers: SeriesMarker<UTCTimestamp>[] = [];
    for (const s of signals) {
      if (untilTime != null && s.barTime > untilTime) continue;
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
    this.candles.setMarkers(markers);
  }

  showTrade(trade: LabTrade | null): void {
    for (const l of this.lines) this.candles.removePriceLine(l);
    this.lines = [];
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
    if (trade.exitPrice != null) {
      this.lines.push(
        this.candles.createPriceLine({
          price: trade.exitPrice,
          color: '#94a3b8',
          lineWidth: 1,
          lineStyle: LineStyle.SparseDotted,
          title: trade.r >= 0 ? `+${trade.r.toFixed(1)}R` : `${trade.r.toFixed(1)}R`,
          axisLabelVisible: true,
        }),
      );
    }
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

  setReplayTime(time: number): void {
    this.goTo(time);
  }

  private paintOverlays(): void {
    const volOn = this.overlays.has('volume');
    this.volume.setData(
      volOn
        ? this.bars.map((b) => ({
            time: b.time as UTCTimestamp,
            value: b.aggressiveBuy + b.aggressiveSell || b.volume,
            color: b.close >= b.open ? '#26a69a55' : '#ef535055',
          }))
        : [],
    );
    const deltaOn = this.overlays.has('delta');
    this.extra.setData(
      deltaOn
        ? this.bars.map((b) => {
            const d = b.aggressiveBuy - b.aggressiveSell;
            return { time: b.time as UTCTimestamp, value: d, color: d >= 0 ? '#26a69a99' : '#ef535099' };
          })
        : [],
    );
    const cvdKey = this.overlays.has('cvd')
      ? 'cvd'
      : this.overlays.has('spotCvd')
        ? 'spotCvd'
        : this.overlays.has('futuresCvd')
          ? 'futuresCvd'
          : null;
    if (!cvdKey || !this.snaps.length) {
      this.cvd.setData([]);
      return;
    }
    this.cvd.setData(
      this.snaps.map((s) => ({
        time: s.barTime as UTCTimestamp,
        value: cvdKey === 'spotCvd' ? s.spotCvd : cvdKey === 'futuresCvd' ? s.futuresCvd : s.cvd,
      })),
    );
  }

  destroy(): void {
    this.chart.remove();
  }
}
