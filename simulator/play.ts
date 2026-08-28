import { LabChart } from './chart.js';
import { listPresets } from '../src/simulation/presets.js';
import type { ScenarioIntensity, ScenarioPresetId } from '../src/simulation/types.js';
import type { PlayChartData, PlayFrame } from './sim-candles.js';

const $ = (id: string) => document.getElementById(id)!;

const SLIDERS: Array<{ key: keyof ScenarioIntensity; label: string; min: number; max: number; kind: 'pct' | 'oi' | 'funding' }> = [
  { key: 'aggressiveBuy', label: 'Aggressive buy', min: 0, max: 100, kind: 'pct' },
  { key: 'aggressiveSell', label: 'Aggressive sell', min: 0, max: 100, kind: 'pct' },
  { key: 'bidDepth', label: 'Bid depth', min: 0, max: 100, kind: 'pct' },
  { key: 'askDepth', label: 'Ask depth', min: 0, max: 100, kind: 'pct' },
  { key: 'bidReplenishment', label: 'Bid replenishment', min: 0, max: 100, kind: 'pct' },
  { key: 'askReplenishment', label: 'Ask replenishment', min: 0, max: 100, kind: 'pct' },
  { key: 'bidWithdrawal', label: 'Bid withdrawal', min: 0, max: 100, kind: 'pct' },
  { key: 'askWithdrawal', label: 'Ask withdrawal', min: 0, max: 100, kind: 'pct' },
  { key: 'volatility', label: 'Volatility', min: 0, max: 100, kind: 'pct' },
  { key: 'oiChange', label: 'OI change', min: -100, max: 100, kind: 'oi' },
  { key: 'funding', label: 'Funding (bps)', min: -20, max: 20, kind: 'funding' },
  { key: 'longLiquidations', label: 'Long liquidations', min: 0, max: 100, kind: 'pct' },
  { key: 'shortLiquidations', label: 'Short liquidations', min: 0, max: 100, kind: 'pct' },
];

const SPEED_MS: Record<string, number> = { slow: 140, normal: 70, fast: 28 };

let presetId: ScenarioPresetId = 'SELLER_ABSORPTION';
let chart: LabChart;
let worker: Worker | null = null;
let playTimer: number | null = null;
let frames: PlayFrame[] = [];
let playing = false;

function boot(): void {
  chart = new LabChart($('tv-chart'));
  fillPresets();
  fillSliders();
  bind();
  applyPreset(presetId);

  const q = new URLSearchParams(location.search);
  const symbol = q.get('symbol');
  if (symbol) ($('play-symbol') as HTMLInputElement).value = symbol.toUpperCase();
  const wanted = q.get('preset') as ScenarioPresetId | null;
  if (wanted && listPresets().some((p) => p.id === wanted)) applyPreset(wanted);
}

function fillPresets(): void {
  const root = $('play-presets');
  root.innerHTML = '';
  for (const spec of listPresets()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = String(spec.id);
    b.textContent = spec.label;
    if (spec.id === presetId) b.classList.add('active');
    root.appendChild(b);
  }
}

function fillSliders(): void {
  const root = $('play-sliders');
  root.innerHTML = '';
  for (const s of SLIDERS) {
    const row = document.createElement('div');
    row.className = 'slider-row';
    row.innerHTML = `
      <label for="p-${s.key}">${s.label}</label>
      <span class="val" id="v-${s.key}">0</span>
      <input id="p-${s.key}" type="range" min="${s.min}" max="${s.max}" step="1" value="0" />
    `;
    root.appendChild(row);
    row.querySelector('input')!.addEventListener('input', () => paintSlider(s.key));
  }
}

function sliderEl(key: keyof ScenarioIntensity): HTMLInputElement {
  return $(`p-${key}`) as HTMLInputElement;
}

function intensityToSlider(key: keyof ScenarioIntensity, value: number): number {
  const def = SLIDERS.find((s) => s.key === key)!;
  if (def.kind === 'funding') return Math.round(value * 10_000);
  if (def.kind === 'oi') return Math.round(value * 100);
  return Math.round(value * 100);
}

function sliderToIntensity(key: keyof ScenarioIntensity, raw: number): number {
  const def = SLIDERS.find((s) => s.key === key)!;
  if (def.kind === 'funding') return raw / 10_000;
  if (def.kind === 'oi') return raw / 100;
  return raw / 100;
}

function paintSlider(key: keyof ScenarioIntensity): void {
  const el = sliderEl(key);
  const def = SLIDERS.find((s) => s.key === key)!;
  const n = Number(el.value);
  $(`v-${key}`).textContent = def.kind === 'funding' ? String(n) : String(n);
}

function applyPreset(id: ScenarioPresetId): void {
  presetId = id;
  const spec = listPresets().find((p) => p.id === id)!;
  for (const b of $('play-presets').querySelectorAll('button')) {
    b.classList.toggle('active', b.getAttribute('data-id') === id);
  }
  ($('play-price') as HTMLInputElement).value = String(spec.startPrice);
  for (const s of SLIDERS) {
    sliderEl(s.key).value = String(intensityToSlider(s.key, spec.intensity[s.key]));
    paintSlider(s.key);
  }
  setStatus(`Ready · ${spec.label}. Set the numbers, then Play.`);
}

function readIntensity(): ScenarioIntensity {
  const out = {} as ScenarioIntensity;
  for (const s of SLIDERS) {
    out[s.key] = sliderToIntensity(s.key, Number(sliderEl(s.key).value));
  }
  return out;
}

function bind(): void {
  $('play-presets').addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button');
    if (!btn?.dataset.id) return;
    stopPlay();
    applyPreset(btn.dataset.id as ScenarioPresetId);
  });
  $('btn-play').addEventListener('click', () => {
    if (playing) stopPlay();
    else void runPlay();
  });
  $('play-speed').addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button');
    if (!btn?.dataset.speed) return;
    for (const b of $('play-speed').querySelectorAll('button')) b.classList.toggle('active', b === btn);
  });
}

function activeSpeed(): number {
  const on = $('play-speed').querySelector('button.active') as HTMLButtonElement | null;
  return SPEED_MS[on?.dataset.speed ?? 'normal'] ?? SPEED_MS.normal;
}

function stopPlay(): void {
  playing = false;
  if (playTimer != null) {
    window.clearInterval(playTimer);
    playTimer = null;
  }
  $('btn-play').textContent = 'Play';
  ($('btn-play') as HTMLButtonElement).disabled = false;
}

async function runPlay(): Promise<void> {
  stopPlay();
  const spec = listPresets().find((p) => p.id === presetId)!;
  const startPrice = Number(($('play-price') as HTMLInputElement).value) || spec.startPrice;
  const symbol = (($('play-symbol') as HTMLInputElement).value || spec.symbol).toUpperCase();
  $('btn-play').textContent = 'Running…';
  ($('btn-play') as HTMLButtonElement).disabled = true;
  setStatus('Simulating order flow…');

  let data: PlayChartData;
  try {
    data = await runWorker({
      type: 'run',
      presetId,
      intensity: readIntensity(),
      startPrice,
      durationMs: spec.durationMs,
      symbol,
    });
  } catch (err) {
    stopPlay();
    setStatus(`Could not simulate: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  frames = data.frames;
  chart.setBars(data.bars, { reveal: true });
  chart.setSimpleMarkers(data.markers);
  chart.revealUpTo(0);

  playing = true;
  $('btn-play').textContent = 'Stop';
  ($('btn-play') as HTMLButtonElement).disabled = false;

  let i = 0;
  const step = (): void => {
    if (!playing) return;
    i += 1;
    chart.revealUpTo(i);
    const frame = frames[i - 1];
    if (frame) {
      setStatus(
        `${humanState(frame.marketState)} · $${fmt(frame.price)} · candle ${i}/${data.bars.length}`,
        frame.whyHeadline,
      );
    }
    if (i >= data.bars.length) {
      stopPlay();
      setStatus(
        `Done · ${spec.label} · $${fmt(frames[frames.length - 1]?.price ?? startPrice)}`,
        frames[frames.length - 1]?.whyHeadline ?? '',
      );
    }
  };
  playTimer = window.setInterval(step, activeSpeed());
  step();
}

function runWorker(msg: {
  type: 'run';
  presetId: ScenarioPresetId;
  intensity: ScenarioIntensity;
  startPrice: number;
  durationMs: number;
  symbol: string;
}): Promise<PlayChartData> {
  return new Promise((resolve, reject) => {
    worker?.terminate();
    worker = new Worker('/scenario.worker.js');
    worker.onmessage = (ev: MessageEvent<PlayChartData & { type: string; message?: string }>) => {
      if (ev.data.type === 'error') {
        reject(new Error(ev.data.message ?? 'Simulation failed'));
        return;
      }
      if (ev.data.type === 'done') resolve(ev.data);
    };
    worker.onerror = (err) => reject(err.error ?? new Error(err.message));
    worker.postMessage(msg);
  });
}

function humanState(state: string): string {
  return state.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
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
