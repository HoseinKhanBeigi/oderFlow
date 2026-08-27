import {
  createScenarioPlayer,
  DEFAULT_TICK_MS,
  formatUsd,
  getPreset,
  listPresets,
  ReplayEngine,
  SimulationClock,
  type MarketSimulationState,
  type PlaybackSpeed,
  type ScenarioIntensity,
  type ScenarioPresetId,
  type ScenarioSpec,
  type SimulationChannel,
  type SimulationMode,
  type TrailWindowId,
} from '../src/simulation/index.js';
import { PhaserRenderer } from './phaser-renderer.js';

const SPEEDS: PlaybackSpeed[] = [0.25, 0.5, 1, 2, 5, 10];
const TRAILS: TrailWindowId[] = ['1s', '5s', '30s', '1m', '5m'];

const $ = (id: string) => document.getElementById(id)!;

let mode: SimulationMode = 'synthetic';
let channel: SimulationChannel = 'futures';
let trail: TrailWindowId = '30s';
let renderer: PhaserRenderer;
let clock = new SimulationClock({ tickMs: DEFAULT_TICK_MS, startTime: 0 });
let player = createScenarioPlayer(getPreset('STRONG_BUY_BREAKOUT'));
let latest: MarketSimulationState | null = null;
let ws: WebSocket | null = null;
let replay = new ReplayEngine();
let realtimeSymbol = 'BTCUSDT';
let worker: Worker | null = null;

function boot(): void {
  const params = new URLSearchParams(location.search);
  if (params.get('symbol')) realtimeSymbol = params.get('symbol')!.toUpperCase();
  ($('sim-symbol') as HTMLInputElement).value = realtimeSymbol;
  const qMarket = params.get('market');
  if (qMarket === 'spot' || qMarket === 'futures' || qMarket === 'combined' || qMarket === 'perp') {
    channel = qMarket === 'perp' ? 'futures' : qMarket;
    const btn = document.querySelector(`#markets [data-market="${channel}"]`) as HTMLElement | null;
    if (btn) markActive('#markets [data-market]', btn);
  }

  renderer = new PhaserRenderer($('sim-canvas'));
  fillPresets();
  bindControls();
  clock.onTick((t) => onTick(t));
  $('disclaimer').textContent =
    'Market microstructure simulation — it does not predict the exact future price. It shows how aggressive flow interacts with passive liquidity.';
  connectRealtime();

  if (params.get('mode') === 'realtime') {
    mode = 'realtime';
    markActive('#modes [data-mode]', document.querySelector('#modes [data-mode="realtime"]') as HTMLElement);
    clock.pause();
    setPlayingUi(false);
  } else {
    clock.play();
  }
}

function onTick(t: number): void {
  if (mode === 'synthetic') {
    if (t > player.spec.durationMs) {
      clock.pause();
      setPlayingUi(false);
      return;
    }
    latest = player.step(t);
    player.engine.setTrailWindow(trail);
    renderer.setState(latest);
    renderPanels(latest);
    return;
  }
  if (mode === 'replay') {
    const engine = player.engine;
    engine.setTrailWindow(trail);
    for (const ev of replay.drainUntil(t)) engine.ingest(ev);
    latest = engine.tick(t);
    renderer.setState(latest);
    renderPanels(latest);
    if (replay.done()) {
      clock.pause();
      setPlayingUi(false);
    }
  }
}

function bindControls(): void {
  $('btn-play').addEventListener('click', () => {
    clock.play();
    setPlayingUi(true);
  });
  $('btn-pause').addEventListener('click', () => {
    clock.pause();
    setPlayingUi(false);
  });
  $('btn-step').addEventListener('click', () => {
    clock.pause();
    setPlayingUi(false);
    clock.step();
  });
  $('btn-reset').addEventListener('click', () => resetCurrent());

  $('speeds').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-speed]') as HTMLElement | null;
    if (!btn) return;
    const speed = Number(btn.dataset.speed) as PlaybackSpeed;
    clock.setSpeed(speed);
    markActive('#speeds [data-speed]', btn);
  });

  $('modes').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-mode]') as HTMLElement | null;
    if (!btn) return;
    mode = btn.dataset.mode as SimulationMode;
    markActive('#modes [data-mode]', btn);
    if (mode === 'replay') void loadReplay();
    else if (mode === 'synthetic') resetCurrent();
    else {
      clock.pause();
      setPlayingUi(true);
      subscribeSim();
    }
  });

  $('markets').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-market]') as HTMLElement | null;
    if (!btn) return;
    channel = btn.dataset.market as SimulationChannel;
    markActive('#markets [data-market]', btn);
    subscribeSim();
  });

  $('trails').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-trail]') as HTMLElement | null;
    if (!btn) return;
    trail = btn.dataset.trail as TrailWindowId;
    player.engine.setTrailWindow(trail);
    markActive('#trails [data-trail]', btn);
  });

  $('btn-run').addEventListener('click', () => {
    mode = 'synthetic';
    markActive('#modes [data-mode]', document.querySelector('#modes [data-mode="synthetic"]') as HTMLElement);
    startScenario(specFromForm());
  });

  $('presets').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-preset]') as HTMLElement | null;
    if (!btn) return;
    mode = 'synthetic';
    markActive('#modes [data-mode]', document.querySelector('#modes [data-mode="synthetic"]') as HTMLElement);
    startScenario(getPreset(btn.dataset.preset as ScenarioPresetId));
    paintForm(player.spec);
  });

  $('sim-symbol').addEventListener('change', () => {
    realtimeSymbol = ($('sim-symbol') as HTMLInputElement).value.toUpperCase() || 'BTCUSDT';
    subscribeSim();
  });
}

function startScenario(spec: ScenarioSpec): void {
  clock.pause();
  clock = new SimulationClock({ tickMs: DEFAULT_TICK_MS, startTime: 0 });
  clock.setSpeed(readSpeed());
  clock.onTick((t) => onTick(t));
  player = createScenarioPlayer(spec);
  player.engine.setTrailWindow(trail);
  latest = player.engine.tick(0);
  renderer.setState(latest);
  renderPanels(latest);
  clock.play();
  setPlayingUi(true);
}

function resetCurrent(): void {
  if (mode === 'synthetic') {
    startScenario(player.spec);
    clock.pause();
    setPlayingUi(false);
    return;
  }
  if (mode === 'replay') {
    replay.rewind();
    player.engine.reset(player.spec.startPrice);
    clock.reset();
    return;
  }
}

function specFromForm(): ScenarioSpec {
  const base = getPreset('BALANCED_MARKET');
  const intensity: ScenarioIntensity = {
    aggressiveBuy: num('in-buy'),
    aggressiveSell: num('in-sell'),
    askDepth: num('in-ask-depth'),
    bidDepth: num('in-bid-depth'),
    askReplenishment: num('in-ask-repl'),
    bidReplenishment: num('in-bid-repl'),
    askWithdrawal: num('in-ask-wd'),
    bidWithdrawal: num('in-bid-wd'),
    volatility: num('in-vol'),
    oiChange: num('in-oi'),
    funding: num('in-funding'),
    longLiquidations: num('in-long-liq'),
    shortLiquidations: num('in-short-liq'),
  };
  return {
    ...base,
    id: 'custom',
    label: 'Custom scenario',
    seed: Number(($('in-seed') as HTMLInputElement).value) || 12345,
    intensity,
  };
}

function paintForm(spec: ScenarioSpec): void {
  const i = spec.intensity;
  setNum('in-buy', i.aggressiveBuy);
  setNum('in-sell', i.aggressiveSell);
  setNum('in-ask-depth', i.askDepth);
  setNum('in-bid-depth', i.bidDepth);
  setNum('in-ask-repl', i.askReplenishment);
  setNum('in-bid-repl', i.bidReplenishment);
  setNum('in-ask-wd', i.askWithdrawal);
  setNum('in-bid-wd', i.bidWithdrawal);
  setNum('in-vol', i.volatility);
  setNum('in-oi', i.oiChange);
  setNum('in-funding', i.funding);
  setNum('in-long-liq', i.longLiquidations);
  setNum('in-short-liq', i.shortLiquidations);
  ($('in-seed') as HTMLInputElement).value = String(spec.seed);
}

function fillPresets(): void {
  const root = $('presets');
  root.innerHTML = '';
  for (const spec of listPresets()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.preset = String(spec.id);
    b.textContent = spec.label;
    root.appendChild(b);
  }
}

function renderPanels(s: MarketSimulationState): void {
  $('st-price').textContent = fmtPx(s.price);
  $('st-buy').textContent = formatUsd(s.aggressiveBuy);
  $('st-sell').textContent = formatUsd(s.aggressiveSell);
  $('st-delta').textContent = formatUsd(s.delta);
  $('st-ask-depth').textContent = formatUsd(s.askDepth);
  $('st-bid-depth').textContent = formatUsd(s.bidDepth);
  $('st-ask-cons').textContent = intensityWord(s.askConsumption, s.askDepth);
  $('st-ask-repl').textContent = intensityWord(s.askReplenishment, s.askConsumption || s.askDepth);
  $('st-ask-wd').textContent = intensityWord(s.askWithdrawal, s.askDepth);
  $('st-eff').textContent = s.priceEfficiency;
  $('st-oi').textContent = s.oiChangePercent != null ? `${s.oiChangePercent >= 0 ? '+' : ''}${s.oiChangePercent.toFixed(2)}%` : '—';
  $('st-funding').textContent = s.fundingRate != null ? `${(s.fundingRate * 100).toFixed(4)}%` : '—';
  $('st-short-liq').textContent = s.shortLiquidations != null ? formatUsd(s.shortLiquidations) : '—';
  $('st-state').textContent = s.marketState.replace(/_/g, ' ');
  $('st-mechanics').textContent = s.mechanics;
  $('st-effort').textContent = s.effortVsResult.replace(/_/g, ' ');

  const needle = $('pressure-needle');
  const pct = ((s.pressure.net + 1) / 2) * 100;
  needle.style.left = `${pct}%`;
  $('pressure-label').textContent = s.pressure.net >= 0 ? 'BUY PRESSURE' : 'SELL PRESSURE';

  $('why-headline').textContent = s.whyHeadline;
  $('why-list').innerHTML = s.why.map((f) => `<li>${escapeHtml(f.text)}</li>`).join('');

  if (s.visual.absorptionAsk || s.visual.absorptionBid) {
    $('abs-box').classList.remove('hidden');
    $('abs-exec').textContent = formatUsd(s.visual.absorptionAsk ? s.askConsumption : s.bidConsumption);
    $('abs-repl').textContent = formatUsd(s.visual.absorptionAsk ? s.askReplenishment : s.bidReplenishment);
    $('abs-impact').textContent = `${s.priceChangeBps.toFixed(1)} bps`;
    $('abs-eff').textContent = s.priceEfficiency === 'LOW' ? 'LOW' : s.priceEfficiency;
  } else {
    $('abs-box').classList.add('hidden');
  }
}

function connectRealtime(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener('open', () => subscribeSim());
  ws.addEventListener('message', (ev) => {
    let msg: { type?: string; state?: MarketSimulationState; events?: unknown };
    try {
      msg = JSON.parse(String(ev.data)) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'sim_state' && msg.state && mode === 'realtime') {
      latest = msg.state;
      renderer.setState(latest);
      renderPanels(latest);
    }
  });
  ws.addEventListener('close', () => {
    setTimeout(connectRealtime, 2000);
  });
}

function subscribeSim(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'sub_sim', symbol: realtimeSymbol, market: channel }));
}

async function loadReplay(): Promise<void> {
  const market = channel === 'spot' ? 'spot' : 'perp';
  const res = await fetch(`/api/simulation/replay?symbol=${encodeURIComponent(realtimeSymbol)}&market=${market}&minutes=60`);
  const data = (await res.json()) as { events?: Parameters<ReplayEngine['load']>[0] };
  replay = new ReplayEngine();
  replay.load(data.events ?? []);
  player.engine.reset();
  player.engine.setFillMode('print');
  player.engine.setTrailWindow(trail);
  clock = new SimulationClock({ tickMs: DEFAULT_TICK_MS, startTime: replay.peek()?.timestamp ?? 0 });
  clock.setSpeed(readSpeed());
  clock.onTick((t) => onTick(t));
  clock.play();
  setPlayingUi(true);
}

function tryWorker(): void {
  try {
    worker = new Worker('/sim.worker.js');
    worker.postMessage({ type: 'init', symbol: 'BTCUSDT', marketType: 'perp', tickSize: 50, fillMode: 'walk' });
  } catch {
    worker = null;
  }
}

function intensityWord(value: number, ref: number): string {
  if (ref <= 0 && value <= 0) return 'LOW';
  const r = value / Math.max(ref, 1);
  if (r >= 0.7) return 'EXTREME';
  if (r >= 0.35) return 'HIGH';
  if (r <= 0.08) return 'LOW';
  return 'NORMAL';
}

function num(id: string): number {
  return Number(($(id) as HTMLInputElement).value) || 0;
}
function setNum(id: string, v: number): void {
  ($(id) as HTMLInputElement).value = String(v);
}
function readSpeed(): PlaybackSpeed {
  const active = document.querySelector('#speeds [data-speed].active') as HTMLElement | null;
  const n = Number(active?.dataset.speed ?? 1);
  return (SPEEDS.includes(n as PlaybackSpeed) ? n : 1) as PlaybackSpeed;
}
function markActive(sel: string, btn: HTMLElement): void {
  document.querySelectorAll(sel).forEach((el) => el.classList.toggle('active', el === btn));
}
function setPlayingUi(playing: boolean): void {
  $('btn-play').classList.toggle('active', playing);
  $('btn-pause').classList.toggle('active', !playing);
}
function fmtPx(n: number): string {
  return n >= 1000 ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${n.toFixed(2)}`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

tryWorker();
boot();
