import { LabChart } from './chart.js';
import type { MarketBar } from '../src/backtest/types.js';
import {
  TF_OPTIONS,
  candlesToBars,
  closedHistory,
  nextBarTime,
  scaleFromHistory,
} from './sim-candles.js';
import { pathsFromFlow, readFlow } from './flow-paths.js';

const $ = (id: string) => document.getElementById(id)!;

let tfMinutes = 240;
let market: 'spot' | 'perp' = 'perp';
let chart: LabChart;
let worker: Worker | null = null;
let history: MarketBar[] = [];
let loadSeq = 0;

function boot(): void {
  chart = new LabChart($('tv-chart'));
  fillTf();
  bind();

  const q = new URLSearchParams(location.search);
  const symbol = q.get('symbol');
  if (symbol) ($('play-symbol') as HTMLInputElement).value = symbol.toUpperCase();
  if (q.get('market') === 'spot') setMarket('spot');
  const tfRaw = Number(q.get('tf'));
  if (TF_OPTIONS.some((t) => t.minutes === tfRaw)) setTf(tfRaw);
  void loadHistory();
}

function fillTf(): void {
  const root = $('play-tf');
  root.innerHTML = '';
  for (const t of TF_OPTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tf = String(t.minutes);
    b.textContent = t.label;
    if (t.minutes === tfMinutes) b.classList.add('active');
    root.appendChild(b);
  }
}

function setMarket(next: 'spot' | 'perp'): void {
  market = next;
  for (const b of $('play-market').querySelectorAll('button')) {
    b.classList.toggle('active', b.getAttribute('data-market') === next);
  }
}

function setTf(minutes: number): void {
  tfMinutes = minutes;
  for (const b of $('play-tf').querySelectorAll('button')) {
    b.classList.toggle('active', Number(b.getAttribute('data-tf')) === minutes);
  }
}

function tfMeta() {
  return TF_OPTIONS.find((t) => t.minutes === tfMinutes) ?? TF_OPTIONS[2]!;
}

function symbol(): string {
  return (($('play-symbol') as HTMLInputElement).value || 'BTCUSDT').toUpperCase();
}

function bind(): void {
  $('play-tf').addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button');
    if (!btn?.dataset.tf) return;
    setTf(Number(btn.dataset.tf));
    void loadHistory();
  });
  $('play-market').addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button');
    if (!btn?.dataset.market) return;
    setMarket(btn.dataset.market as 'spot' | 'perp');
    void loadHistory();
  });
  $('play-symbol').addEventListener('change', () => {
    void loadHistory();
  });
  $('btn-play').addEventListener('click', () => {
    void runPlay();
  });
}

type KlineRow = [number, string, string, string, string, string];

function parseKlines(raw: KlineRow[]): MarketBar[] {
  return closedHistory(
    candlesToBars(
      raw.map((r) => ({
        time: Math.floor(Number(r[0]) / 1000),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5] ?? 0),
      })),
    ),
    tfMinutes,
  );
}

async function fetchHistory(): Promise<MarketBar[]> {
  const tf = tfMeta();
  const sym = symbol();
  const now = Math.floor(Date.now() / 1000);
  const from = now - 90 * 86_400;
  const labTf = Math.min(tfMinutes, 240);

  try {
    const data = (await (await fetch(
      `/api/lab/dataset?symbol=${encodeURIComponent(sym)}&market=${market}&exchange=binance&tf=${labTf}&from=${from}&to=${now}&window=500`,
    )).json()) as { bars?: MarketBar[] };
    if (data.bars && data.bars.length >= 8) return closedHistory(data.bars, labTf);
  } catch {
    /* try klines */
  }

  try {
    const raw = (await (await fetch(
      `/api/klines?symbol=${encodeURIComponent(sym)}&interval=${tf.interval}&limit=150&market=${market}`,
    )).json()) as KlineRow[] | { error?: string };
    if (Array.isArray(raw) && raw.length >= 8) return parseKlines(raw);
  } catch {
    /* try Binance */
  }

  const base = market === 'spot' ? 'https://api.binance.com/api/v3/klines' : 'https://fapi.binance.com/fapi/v1/klines';
  const raw = (await (await fetch(`${base}?symbol=${encodeURIComponent(sym)}&interval=${tf.interval}&limit=150`)).json()) as KlineRow[];
  if (!Array.isArray(raw) || raw.length < 8) return [];
  return parseKlines(raw);
}

function paintChart(bars: MarketBar[], extraTo?: number): void {
  chart.setBars(bars);
  const last = bars[bars.length - 1];
  const from = bars[Math.max(0, bars.length - 80)];
  requestAnimationFrame(() => {
    if (last && from) chart.setVisibleRange(from.time, extraTo ?? last.time + tfMinutes * 60);
    else chart.fit();
  });
}

async function loadHistory(): Promise<void> {
  const seq = ++loadSeq;
  const tf = tfMeta();
  const sym = symbol();
  setStatus(`Loading ${tf.label} chart for ${sym}…`);
  try {
    const bars = await fetchHistory();
    if (seq !== loadSeq) return;
    history = bars;
    if (history.length < 8) {
      chart.setBars([]);
      chart.setPredictedPaths(null);
      setStatus('Could not load the chart.', 'No candles came back for this symbol / timeframe.');
      return;
    }
    paintChart(history);
    chart.setPredictedPaths(null);
    const last = history[history.length - 1]!;
    chart.setSimpleMarkers([{ time: last.time, text: 'LAST', position: 'aboveBar', kind: 'CONTEXT' }]);
    paintHistoryStatus();
  } catch (err) {
    if (seq !== loadSeq) return;
    history = [];
    setStatus('Could not load the chart.', err instanceof Error ? err.message : String(err));
  }
}

function paintHistoryStatus(): void {
  const last = history[history.length - 1];
  if (!last) return;
  const tf = tfMeta();
  const flow = readFlow(history);
  const src = flow.hasFootprint ? 'footprint' : 'candle delta';
  const book = flow.hasBook ? ' + book' : '';
  setStatus(
    `${history.length} × ${tf.label} · last $${fmt(last.close)}`,
    `${src}${book} · buy ${(flow.buyShare * 100).toFixed(0)}% / sell ${(flow.sellShare * 100).toFixed(0)}%. Draw next shows 4 possible candles.`,
  );
}

async function runPlay(): Promise<void> {
  if (!history.length) await loadHistory();
  if (!history.length) {
    setStatus('Need previous candles before drawing the next bar.');
    return;
  }

  const last = history[history.length - 1]!;
  const scale = scaleFromHistory(history);
  const nextTime = nextBarTime(last.time, tfMinutes);
  const gapSec = Math.max(60, Math.floor(tfMinutes * 60) / 5);
  const tf = tfMeta();
  const paths = pathsFromFlow(history);
  const btn = $('btn-play') as HTMLButtonElement;
  btn.textContent = 'Drawing…';
  btn.disabled = true;
  setStatus(`Drawing 4 next ${tf.label} paths from $${fmt(last.close)}…`);

  let candles: Array<{ id: string; label: string; color: string; bar: MarketBar }>;
  try {
    candles = await runWorker({
      type: 'paths',
      startPrice: scale.startPrice,
      durationMs: 8_000,
      symbol: symbol(),
      tickSize: scale.tickSize,
      levelStep: scale.levelStep,
      nextTime,
      gapSec,
      paths,
    });
  } catch (err) {
    btn.textContent = 'Draw next';
    btn.disabled = false;
    setStatus(`Could not simulate: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  btn.textContent = 'Draw next';
  btn.disabled = false;
  if (!candles.length) {
    setStatus('Simulation produced no candles.');
    return;
  }

  const lastPred = candles[candles.length - 1]!.bar.time;
  paintChart(history, lastPred + gapSec);
  chart.setPredictedPaths(candles);
  chart.setSimpleMarkers([{ time: last.time, text: 'LAST', position: 'aboveBar', kind: 'CONTEXT' }]);
  paintLegend(candles);
  setStatus(
    `Next ${tf.label} · 4 paths from $${fmt(last.close)}`,
    candles.map((c) => `${c.label} $${fmt(c.bar.close)}`).join('   ·   '),
  );
}

function paintLegend(candles: Array<{ label: string; color: string; bar: MarketBar }>): void {
  const root = $('path-legend');
  if (!root) return;
  root.innerHTML = candles
    .map(
      (c) =>
        `<div class="path-item"><i style="background:${c.color}"></i><span>${c.label}</span><strong>$${fmt(c.bar.close)}</strong></div>`,
    )
    .join('');
}

function runWorker(msg: {
  type: 'paths';
  startPrice: number;
  durationMs: number;
  symbol: string;
  tickSize: number;
  levelStep: number;
  nextTime: number;
  gapSec: number;
  paths: ReturnType<typeof pathsFromFlow>;
}): Promise<Array<{ id: string; label: string; color: string; bar: MarketBar }>> {
  return new Promise((resolve, reject) => {
    worker?.terminate();
    worker = new Worker('/scenario.worker.js');
    worker.onmessage = (
      ev: MessageEvent<{ type: string; message?: string; candles?: Array<{ id: string; label: string; color: string; bar: MarketBar }> }>,
    ) => {
      if (ev.data.type === 'error') {
        reject(new Error(ev.data.message ?? 'Simulation failed'));
        return;
      }
      if (ev.data.type === 'done') resolve(ev.data.candles ?? []);
    };
    worker.onerror = (err) => reject(err.error ?? new Error(err.message));
    worker.postMessage(msg);
  });
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function setStatus(line: string, sub = ''): void {
  $('play-status-line').textContent = line;
  $('play-status-sub').textContent = sub;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
