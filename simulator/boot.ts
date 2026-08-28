import { LabChart, type OverlayId } from './chart.js';
import {
  cloneStrategy,
  coverageGate,
  emptyCustomStrategy,
  getStrategyPreset,
  listStrategyPresets,
  METRICS,
  OPERATORS,
  STUDY_PRESETS,
} from '../src/backtest/index.js';
import type {
  BacktestResult,
  BacktestRunConfig,
  Condition,
  ConditionGroup,
  LabMode,
  LabSignal,
  LabTrade,
  MarketBar,
  RuleNode,
  Strategy,
} from '../src/backtest/types.js';
import type { SignalStudyResult } from '../src/backtest/signal-study.js';

const $ = (id: string) => document.getElementById(id)!;
const TFS = [1, 5, 15, 30, 45, 60, 120, 240];
const TF_LABEL: Record<number, string> = { 1: '1m', 5: '5m', 15: '15m', 30: '30m', 45: '45m', 60: '1h', 120: '2h', 240: '4h' };

let symbol = 'BTCUSDT';
let market: 'spot' | 'perp' = 'perp';
let exchange = 'binance';
let tf = 15;
let mode: LabMode = 'BACKTEST';
let strategy = getStrategyPreset('SELLER_ABSORPTION');
let chart: LabChart;
let result: BacktestResult | null = null;
let bars: MarketBar[] = [];
let signalFromSec = 0;
let replayTimer: number | null = null;
let worker: Worker | null = null;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function boot(): void {
  chart = new LabChart($('tv-chart'));
  fillTf();
  fillPresets();
  fillOverlays();
  fillStudyPresets();
  setRangeDays(30);
  bind();
  paintStrategy();
  const q = new URLSearchParams(location.search);
  if (q.get('symbol')) {
    symbol = q.get('symbol')!.toUpperCase();
    ($('lab-symbol') as HTMLInputElement).value = symbol;
  }
  if (q.get('market') === 'spot') setMarket('spot');
}

function fillTf(): void {
  const root = $('lab-tf');
  root.innerHTML = '';
  for (const n of TFS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tf = String(n);
    b.textContent = TF_LABEL[n] ?? `${n}m`;
    if (n === tf) b.classList.add('active');
    root.appendChild(b);
  }
}

function fillPresets(): void {
  const sel = $('lab-preset') as HTMLSelectElement;
  sel.innerHTML = '';
  for (const s of listStrategyPresets()) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    sel.appendChild(o);
  }
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = 'Custom';
  sel.appendChild(custom);
  for (const saved of loadSaved()) {
    const o = document.createElement('option');
    o.value = `saved:${saved.id}`;
    o.textContent = saved.name;
    sel.appendChild(o);
  }
  sel.value = strategy.id;
}

function fillOverlays(): void {
  const root = $('overlay-menu');
  root.innerHTML = '';
  let group = '';
  for (const o of chart.overlayList()) {
    if (o.group !== group) {
      group = o.group;
      const lab = document.createElement('span');
      lab.className = 'ov-group';
      lab.textContent = group;
      root.appendChild(lab);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.overlay = o.id;
    b.textContent = o.label;
    if (chart.isOverlay(o.id)) b.classList.add('active');
    root.appendChild(b);
  }
}

function fillStudyPresets(): void {
  const sel = $('study-preset') as HTMLSelectElement;
  sel.innerHTML = '';
  for (const p of STUDY_PRESETS) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.label;
    sel.appendChild(o);
  }
}

function syncOverlayButtons(): void {
  $('overlay-menu').querySelectorAll('[data-overlay]').forEach((btn) => {
    const id = (btn as HTMLElement).dataset.overlay as OverlayId;
    btn.classList.toggle('active', chart.isOverlay(id));
  });
}

function bind(): void {
  $('lab-tf').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-tf]') as HTMLElement | null;
    if (!btn) return;
    tf = Number(btn.dataset.tf);
    mark('#lab-tf [data-tf]', btn);
  });
  $('lab-market').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-market]') as HTMLElement | null;
    if (!btn) return;
    setMarket(btn.dataset.market === 'spot' ? 'spot' : 'perp');
  });
  $('lab-mode').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-mode]') as HTMLElement | null;
    if (!btn) return;
    mode = btn.dataset.mode as LabMode;
    mark('#lab-mode [data-mode]', btn);
    $('btn-run').textContent = runLabel();
    updateBanner();
  });
  $('lab-range').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-range]') as HTMLElement | null;
    if (!btn) return;
    setRangeDays(Number(btn.dataset.range));
    mark('#lab-range [data-range]', btn);
  });
  $('overlay-menu').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-overlay]') as HTMLElement | null;
    if (!btn) return;
    const id = btn.dataset.overlay as OverlayId;
    const on = !chart.isOverlay(id);
    chart.toggleOverlay(id, on);
    syncOverlayButtons();
  });
  $('lab-preset').addEventListener('change', () => {
    const v = ($('lab-preset') as HTMLSelectElement).value;
    if (v === 'custom') strategy = emptyCustomStrategy();
    else if (v.startsWith('saved:')) {
      const found = loadSaved().find((s) => s.id === v.slice(6));
      if (found) strategy = cloneStrategy(found);
    } else strategy = getStrategyPreset(v);
    paintStrategy();
  });
  $('btn-run').addEventListener('click', () => void run());
  $('btn-save').addEventListener('click', saveCurrent);
  $('btn-study').addEventListener('click', () => void runStudy());
  $('inspect-close').addEventListener('click', () => $('inspect-panel').classList.add('hidden'));
  $('side-rules').addEventListener('click', onRuleClick);
  $('side-rules').addEventListener('change', () => syncRulesFromDom());
  document.querySelector('.side-tabs')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-side]') as HTMLElement | null;
    if (!btn) return;
    document.querySelectorAll('.side-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    const id = btn.dataset.side;
    $('side-rules').classList.toggle('hidden', id !== 'rules');
    $('side-exec').classList.toggle('hidden', id !== 'exec');
    $('side-risk').classList.toggle('hidden', id !== 'risk');
  });
  $('bottom-tabs').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null;
    if (!btn) return;
    document.querySelectorAll('#bottom-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    for (const id of ['trades', 'equity', 'signals', 'study', 'types', 'coverage', 'explain']) {
      $(`tab-${id}`).classList.toggle('hidden', id !== btn.dataset.tab);
    }
  });
  $('lab-exchange').addEventListener('change', () => {
    exchange = ($('lab-exchange') as HTMLSelectElement).value;
  });
  $('lab-symbol').addEventListener('change', () => {
    symbol = ($('lab-symbol') as HTMLInputElement).value.toUpperCase() || 'BTCUSDT';
  });
  chart.onClick((time) => {
    if (time == null || !result) return;
    const sig = pickSignal(result.signals, time);
    const trade = result.trades.find((t) => t.signalId === sig?.id) ?? result.trades.find((t) => t.entryTime === time);
    if (sig) openInspect(sig, trade);
    if (trade) {
      chart.showTrade(trade);
      chart.goTo(trade.entryTime);
    } else if (sig) chart.goTo(sig.barTime);
  });
  chart.onCrosshair((time) => {
    if (time == null || !result) return;
    const sig = pickSignal(result.signals, time);
    const tip = $('hover-tip');
    if (!sig) {
      tip.classList.add('hidden');
      return;
    }
    tip.classList.remove('hidden');
    tip.innerHTML = tooltipHtml(sig);
  });
}

function setMarket(m: 'spot' | 'perp'): void {
  market = m;
  document.querySelectorAll('#lab-market [data-market]').forEach((el) => {
    el.classList.toggle('active', (el as HTMLElement).dataset.market === m);
  });
}

function setRangeDays(days: number): void {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  ($('lab-from') as HTMLInputElement).value = isoDate(from);
  ($('lab-to') as HTMLInputElement).value = isoDate(to);
}

function runLabel(): string {
  if (mode === 'REPLAY') return 'Run replay';
  if (mode === 'FORWARD_TEST') return 'Start forward test';
  if (mode === 'WALK_FORWARD') return 'Run walk-forward';
  return 'Run backtest';
}

function updateBanner(): void {
  const text: Record<LabMode, string> = {
    BACKTEST: 'Strategy rules vs historical bars. Features at T use only information at or before T.',
    REPLAY: 'Replay closed bars in time order. Markers appear as that timestamp is reached.',
    FORWARD_TEST: 'Paper mode: evaluate only after the start date. Changing rules creates a new strategy version — v1 results stay locked.',
    WALK_FORWARD: 'Same rules on an in-sample window then an unseen out-of-sample window. Collapse OOS is flagged as possible overfitting.',
  };
  $('lab-banner').textContent = text[mode];
}

async function run(): Promise<void> {
  stopReplay();
  readExecRisk();
  const from = dateSec($('lab-from') as HTMLInputElement);
  const to = dateSec($('lab-to') as HTMLInputElement) + 86_400;
  $('btn-run').setAttribute('disabled', 'true');
  showProgress(true, 2, 'Loading historical data…');
  try {
    const url = `/api/lab/dataset?symbol=${encodeURIComponent(symbol)}&market=${market}&exchange=${encodeURIComponent(exchange)}&tf=${tf}&from=${from}&to=${to}&window=500`;
    const data = (await (await fetch(url)).json()) as {
      bars?: MarketBar[];
      coverage?: BacktestResult['coverage'];
      signalFromSec?: number;
      error?: string;
    };
    if (!data.bars?.length) throw new Error(data.error || 'No candles returned for this range.');
    bars = data.bars;
    signalFromSec = data.signalFromSec ?? from;
    chart.setBars(bars);
    const gate = coverageGate(strategy, data.coverage!);
    paintCoverage({ ...data.coverage!, warnings: gate.warnings });
    if (gate.reject) {
      $('lab-banner').textContent = gate.warnings.join(' ');
      showTab('coverage');
      throw new Error(gate.warnings[gate.warnings.length - 1] ?? 'Required data is missing.');
    }
    if (gate.warnings.length) {
      $('lab-banner').textContent = gate.warnings[gate.warnings.length - 1] ?? '';
    }
    const config: BacktestRunConfig = {
      mode,
      tfMinutes: tf,
      percentileWindow: '500',
      minDataQuality: 0,
      signalFromSec,
    };
    if (mode === 'WALK_FORWARD' && bars.length > 20) {
      const evalBars = bars.filter((b) => b.time >= signalFromSec);
      const split = evalBars[Math.floor(evalBars.length * 0.7)]?.time ?? signalFromSec;
      config.isFromSec = signalFromSec;
      config.isToSec = split;
      config.oosFromSec = split;
      config.oosToSec = bars[bars.length - 1]!.time;
    }
    if (mode === 'FORWARD_TEST') {
      lockVersion(strategy);
    }
    await runEngine(bars, data.coverage!, config);
  } catch (err) {
    $('lab-banner').textContent = err instanceof Error ? err.message : String(err);
  } finally {
    $('btn-run').removeAttribute('disabled');
    showProgress(false, 100, '');
  }
}

function runEngine(marketBars: MarketBar[], coverage: BacktestResult['coverage'], config: BacktestRunConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    worker?.terminate();
    worker = new Worker('/backtest.worker.js');
    worker.onmessage = (ev: MessageEvent<{ type: string; result?: BacktestResult; message?: string; pct?: number; eventsProcessed?: number; tradesFound?: number }>) => {
      const msg = ev.data;
      if (msg.type === 'progress') {
        showProgress(true, msg.pct ?? 0, `${msg.eventsProcessed ?? 0} bars · ${msg.tradesFound ?? 0} trades`);
        return;
      }
      if (msg.type === 'error') {
        reject(new Error(msg.message));
        return;
      }
      if (msg.type === 'result' && msg.result) {
        result = msg.result;
        applyResult(msg.result);
        if (mode === 'REPLAY') startReplay(msg.result);
        resolve();
      }
    };
    worker.onerror = (e) => reject(e.error ?? new Error('Worker failed'));
    worker.postMessage({ type: 'run', bars: marketBars, strategy, coverage, config });
  });
}

function applyResult(r: BacktestResult): void {
  chart.setSnapshots(r.snapshots);
  chart.setSignals(r.signals);
  const s = r.stats;
  setKpi('k-pnl', money(s.netPnl), s.netPnl);
  setKpi('k-ret', `${s.returnPct.toFixed(2)}%`, s.returnPct);
  $('k-pf').textContent = s.profitFactor.toFixed(2);
  $('k-wr').textContent = `${s.winRate.toFixed(1)}%`;
  setKpi('k-dd', `${s.maxDrawdownPct.toFixed(2)}%`, -s.maxDrawdownPct);
  $('k-n').textContent = String(s.totalTrades) + (s.insufficientSample ? ' ⚠' : '');
  setKpi('k-exp', money(s.expectancy), s.expectancy);
  $('k-sh').textContent = s.sharpe.toFixed(2);
  paintTrades(r.trades);
  paintEquity(r);
  paintSignals(r.signals);
  paintTypes(r);
  paintExplain(r);
  if (r.walkForward?.overfitting) {
    $('lab-banner').textContent = 'POSSIBLE OVERFITTING — in-sample profit factor collapsed out of sample.';
  }
}

function paintTrades(trades: LabTrade[]): void {
  $('tab-trades').innerHTML = table(
    ['Time', 'Dir', 'Strategy', 'Entry', 'Exit', 'Stop', 'Size', 'PnL', 'R', 'MAE', 'MFE', 'Fees', 'Dur'],
    trades.map((t) => [
      fmtTime(t.entryTime),
      t.direction,
      t.strategy,
      t.entryPrice.toFixed(2),
      t.exitPrice != null ? t.exitPrice.toFixed(2) : '—',
      t.stopPrice.toFixed(2),
      t.size.toFixed(4),
      money(t.pnl),
      t.r.toFixed(2),
      `${t.maePct.toFixed(2)}%`,
      `${t.mfePct.toFixed(2)}%`,
      money(t.fees),
      String(t.durationBars),
    ]),
    'tab-trades',
    (i) => {
      const t = trades[i];
      if (!t) return;
      chart.showTrade(t);
      chart.goTo(t.entryTime);
      const sig = result?.signals.find((s) => s.id === t.signalId);
      if (sig) openInspect(sig, t);
    },
  );
}

function paintSignals(signals: LabSignal[]): void {
  const rows = signals.filter((s) => s.kind !== 'CONTEXT').slice(-400);
  $('tab-signals').innerHTML = table(
    ['Time', 'Kind', 'Price', 'Fwd 15m', 'Fwd 1h', 'Fwd 4h', 'Traded'],
    rows.map((s) => [
      fmtTime(s.barTime),
      s.kind.replace(/_/g, ' '),
      s.price.toFixed(2),
      fmtFwd(s.forwardReturns['15m']),
      fmtFwd(s.forwardReturns['1h']),
      fmtFwd(s.forwardReturns['4h']),
      s.traded ? 'yes' : '',
    ]),
    'tab-signals',
    (i) => {
      const s = rows[i];
      if (!s) return;
      chart.goTo(s.barTime);
      const trade = result?.trades.find((t) => t.signalId === s.id);
      openInspect(s, trade);
      if (trade) chart.showTrade(trade);
    },
  );
}

function paintTypes(r: BacktestResult): void {
  $('tab-types').innerHTML = table(
    ['Type', 'Trades', 'Win rate', 'Avg R', 'Net PnL'],
    r.bySignalType.map((t) => [t.kind, String(t.trades), `${t.winRate.toFixed(1)}%`, t.avgR.toFixed(2), money(t.netPnl)]),
    'tab-types',
  );
}

function paintCoverage(c: BacktestResult['coverage'] | undefined): void {
  if (!c) {
    $('tab-coverage').textContent = 'Load a range to see coverage.';
    return;
  }
  const cell = (label: string, v: number) =>
    `<div class="cov"><span>${label}</span><strong>${v.toFixed(0)}%</strong></div>`;
  $('tab-coverage').innerHTML =
    `<div class="coverage-grid">${cell('Candles', c.candles)}${cell('Trades / footprint', c.trades)}${cell('L2 book', c.l2)}${cell('OI', c.oi)}${cell('Funding', c.funding)}${cell('Liquidations', c.liquidations)}${cell('Spot', c.spot)}${cell('Futures', c.futures)}</div>` +
    (c.warnings.length ? `<ul class="warn-list">${c.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '');
}

function paintEquity(r: BacktestResult): void {
  const eq = r.equity;
  if (!eq.length) {
    $('tab-equity').textContent = 'No equity series.';
    return;
  }
  const min = Math.min(...eq.map((p) => p.equity));
  const max = Math.max(...eq.map((p) => p.equity));
  const span = max - min || 1;
  const w = 800;
  const h = 110;
  const pts = eq.map((p, i) => {
    const x = (i / Math.max(1, eq.length - 1)) * w;
    const y = h - 8 - ((p.equity - min) / span) * (h - 16);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const wf = r.walkForward
    ? `<p class="oos-flag">IS win ${r.walkForward.is?.winRate.toFixed(1)}% · PF ${r.walkForward.is?.profitFactor.toFixed(2)} · OOS win ${r.walkForward.oos?.winRate.toFixed(1)}% · PF ${r.walkForward.oos?.profitFactor.toFixed(2)}${r.walkForward.overfitting ? ' · POSSIBLE OVERFITTING' : ''}</p>`
    : '';
  $('tab-equity').innerHTML = `${wf}<svg class="eq-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="#5b9fd4" stroke-width="1.6" points="${pts.join(' ')}" /></svg>`;
}

function paintExplain(r: BacktestResult): void {
  const last = r.trades[r.trades.length - 1];
  const sample = r.stats.insufficientSample ? '<p class="oos-flag">INSUFFICIENT SAMPLE — treat win rate as noise.</p>' : '';
  const ev = last?.evidence.map((e) => `<div>${esc(e.label)}: ${esc(e.value)}${e.percentile != null ? ` (${e.percentile.toFixed(0)}p)` : ''}</div>`).join('') ?? 'Run a test to store per-trade evidence.';
  $('tab-explain').innerHTML = `${sample}<p class="hint">${r.eventsProcessed} bars in ${r.elapsedMs}ms · strategy ${esc(r.strategy.name)} v${r.strategy.version}</p>${ev}`;
}

function paintStrategy(): void {
  $('strat-notes').textContent = strategy.notes ?? '';
  $('side-rules').innerHTML =
    block('Long setup', strategy.longSetup) +
    block('Long entry', strategy.longEntry) +
    block('Short setup', strategy.shortSetup) +
    block('Short entry', strategy.shortEntry) +
    block('Context (no auto entry)', strategy.context);
  $('side-exec').innerHTML = `
    <div class="exec-grid">
      <label>Order <select id="ex-type"><option>MARKET</option><option>LIMIT</option><option>STOP</option></select></label>
      <label>Fill model <select id="ex-fill"><option>OPTIMISTIC</option><option>REALISTIC</option><option>CONSERVATIVE</option></select></label>
      <label>Limit offset (bps) <input id="ex-off" type="number" value="${strategy.execution.limitOffsetBps}" /></label>
      <label>Conservative bps <input id="ex-cons" type="number" value="${strategy.execution.conservativeBps}" /></label>
      <label>Maker fee bps <input id="ex-maker" type="number" value="${strategy.execution.makerFeeBps}" /></label>
      <label>Taker fee bps <input id="ex-taker" type="number" value="${strategy.execution.takerFeeBps}" /></label>
      <label>Slippage bps <input id="ex-slip" type="number" value="${strategy.execution.slippageBps}" /></label>
      <label>Latency ms <input id="ex-lat" type="number" value="${strategy.execution.latencyMs}" /></label>
    </div>`;
  ($('ex-type') as HTMLSelectElement).value = strategy.execution.orderType;
  ($('ex-fill') as HTMLSelectElement).value = strategy.execution.fillModel;
  $('side-risk').innerHTML = `
    <div class="risk-grid">
      <label>Stop <select id="rk-stop"><option>FIXED_PCT</option><option>ATR</option><option>SWING</option><option>STRUCTURE</option><option>TRAILING</option><option>TIME</option></select></label>
      <label>Stop value <input id="rk-sv" type="number" step="0.1" value="${strategy.risk.stopValue}" /></label>
      <label>TP R:R <input id="rk-rr" type="number" step="0.1" value="${strategy.risk.takeProfits[0]?.value ?? 2}" /></label>
      <label>Sizing <select id="rk-sz"><option>RISK</option><option>FIXED_DOLLAR</option><option>FIXED_QTY</option><option>PCT_EQUITY</option></select></label>
      <label>Account $ <input id="rk-eq" type="number" value="${strategy.risk.accountEquity}" /></label>
      <label>Risk % <input id="rk-pct" type="number" step="0.1" value="${strategy.risk.riskPct}" /></label>
    </div>`;
  ($('rk-stop') as HTMLSelectElement).value = strategy.risk.stopKind;
  ($('rk-sz') as HTMLSelectElement).value = strategy.risk.sizing;
}

function block(title: string, node?: RuleNode): string {
  const body = node
    ? renderNode(node.type === 'group' ? node : { type: 'group', bool: 'AND', children: [node] })
    : `<div class="cond-group"><button type="button" class="bool-toggle" data-bool>AND</button></div>`;
  return `<div class="rule-block" data-title="${esc(title)}"><header>${title}</header>${body}<div class="add-row"><button type="button" data-add="${esc(title)}">+ condition</button><button type="button" data-add-group="${esc(title)}">+ group</button></div></div>`;
}

function renderNode(node: RuleNode): string {
  if (node.type === 'group') {
    return `<div class="cond-group"><button type="button" class="bool-toggle" data-bool>${node.not ? 'NOT ' : ''}${node.bool}</button>${node.children.map(renderNode).join('')}</div>`;
  }
  return condRow(node);
}

function condRow(c: Condition): string {
  const metrics = METRICS.map((m) => `<option value="${m.id}" ${m.id === c.metric ? 'selected' : ''}>${m.label}</option>`).join('');
  const ops = OPERATORS.map((o) => `<option value="${o.id}" ${o.id === c.op ? 'selected' : ''}>${o.label}</option>`).join('');
  return `<div class="cond-row" data-cond="1"><select data-k="metric">${metrics}</select><select data-k="op">${ops}</select><input data-k="value" type="number" step="0.1" value="${c.value}" /><button type="button" data-del="1">×</button></div>`;
}

function onRuleClick(e: Event): void {
  const t = e.target as HTMLElement;
  if (t.closest('[data-del]')) {
    t.closest('.cond-row')?.remove();
    syncRulesFromDom();
    return;
  }
  const add = t.closest('[data-add]') as HTMLElement | null;
  if (add) {
    const wrap = add.closest('.rule-block');
    const group = wrap?.querySelector(':scope > .cond-group') ?? wrap?.querySelector('.cond-group');
    if (!group) return;
    group.insertAdjacentHTML('beforeend', condRow({ type: 'cond', metric: 'aggressiveSell', op: 'percentile_above', value: 85 }));
    syncRulesFromDom();
    return;
  }
  const addGroup = t.closest('[data-add-group]') as HTMLElement | null;
  if (addGroup) {
    const wrap = addGroup.closest('.rule-block');
    const group = wrap?.querySelector(':scope > .cond-group');
    if (!group) return;
    group.insertAdjacentHTML(
      'beforeend',
      `<div class="cond-group"><button type="button" class="bool-toggle" data-bool>OR</button>${condRow({ type: 'cond', metric: 'spotDelta', op: 'turns_positive', value: 0 })}</div>`,
    );
    syncRulesFromDom();
    return;
  }
  const boolBtn = t.closest('[data-bool]') as HTMLElement | null;
  if (boolBtn) {
    const not = boolBtn.textContent?.includes('NOT');
    const or = boolBtn.textContent?.includes('OR');
    boolBtn.textContent = `${not ? 'NOT ' : ''}${or ? 'AND' : 'OR'}`;
    syncRulesFromDom();
  }
}

function pickSignal(signals: LabSignal[], time: number): LabSignal | undefined {
  const at = signals.filter((s) => s.barTime === time && s.kind !== 'CONTEXT');
  return at.find((s) => s.kind.includes('ENTRY')) ?? at.find((s) => s.kind.includes('SETUP')) ?? at[at.length - 1];
}

function openInspect(sig: LabSignal, trade?: LabTrade): void {
  const snap = sig.snapshot;
  $('inspect-panel').classList.remove('hidden');
  $('inspect-title').textContent = sig.kind.replace(/_/g, ' ');
  const rows: Array<[string, string]> = [
    ['Timestamp', fmtTime(sig.timestamp || sig.barTime)],
    ['Price', snap.price.toFixed(2)],
    ['Strategy', `${sig.strategy} v${sig.strategyVersion}`],
    ['Score', sig.score.toFixed(0)],
    ['Confidence', `${sig.confidence.toFixed(0)} / 100`],
    ['Delta', snap.delta.toFixed(0)],
    ['CVD', snap.cvd.toFixed(0)],
    ['Spot delta', snap.spotDelta.toFixed(0)],
    ['Futures delta', snap.futuresDelta.toFixed(0)],
    ['OI', snap.oi ? snap.oi.toFixed(0) : '—'],
    ['Funding', snap.funding ? snap.funding.toFixed(4) : '—'],
    ['Bid repl.', `${snap.bidReplenishment.toFixed(0)}p`],
    ['Ask repl.', `${snap.askReplenishment.toFixed(0)}p`],
    ['Bid wdr.', `${snap.bidWithdrawal.toFixed(0)}p`],
    ['Ask wdr.', `${snap.askWithdrawal.toFixed(0)}p`],
    ['Seller abs.', snap.sellerAbsorption ? 'TRUE' : '—'],
    ['Buyer abs.', snap.buyerAbsorption ? 'TRUE' : '—'],
    ['Structure', snap.structure.shift.replace(/_/g, ' ')],
    ['Data quality', snap.dataQuality.toFixed(0)],
    ['Fwd 15m', fmtFwd(sig.forwardReturns['15m'])],
    ['Fwd 1h', fmtFwd(sig.forwardReturns['1h'])],
    ['Fwd 4h', fmtFwd(sig.forwardReturns['4h'])],
  ];
  if (trade) {
    rows.push(
      ['Exit', trade.exitPrice != null ? trade.exitPrice.toFixed(2) : 'open'],
      ['PnL', money(trade.pnl)],
      ['R', trade.r.toFixed(2)],
      ['MAE', `${trade.maePct.toFixed(2)}%`],
      ['MFE', `${trade.mfePct.toFixed(2)}%`],
    );
  }
  const ev = sig.evidence.map((e) => `${esc(e.label)}: ${esc(e.value)}${e.percentile != null ? ` (${e.percentile.toFixed(0)}p)` : ''}`).join('<br/>');
  $('inspect-body').innerHTML =
    `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>` +
    (ev ? `<div class="inspect-ev">${ev}</div>` : '');
}

function showTab(id: string): void {
  document.querySelectorAll('#bottom-tabs button').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tab === id));
  for (const t of ['trades', 'equity', 'signals', 'study', 'types', 'coverage', 'explain']) {
    $(`tab-${t}`).classList.toggle('hidden', t !== id);
  }
}

async function ensureBars(): Promise<void> {
  if (bars.length) return;
  const from = dateSec($('lab-from') as HTMLInputElement);
  const to = dateSec($('lab-to') as HTMLInputElement) + 86_400;
  const url = `/api/lab/dataset?symbol=${encodeURIComponent(symbol)}&market=${market}&exchange=${encodeURIComponent(exchange)}&tf=${tf}&from=${from}&to=${to}&window=500`;
  const data = (await (await fetch(url)).json()) as { bars?: MarketBar[]; coverage?: BacktestResult['coverage']; signalFromSec?: number; error?: string };
  if (!data.bars?.length) throw new Error(data.error || 'No candles returned for this range.');
  bars = data.bars;
  signalFromSec = data.signalFromSec ?? from;
  chart.setBars(bars);
  paintCoverage(data.coverage);
}

async function runStudy(): Promise<void> {
  $('btn-study').setAttribute('disabled', 'true');
  showProgress(true, 4, 'Loading bars for signal study…');
  try {
    await ensureBars();
    showTab('study');
    await new Promise<void>((resolve, reject) => {
      worker?.terminate();
      worker = new Worker('/backtest.worker.js');
      worker.onmessage = (ev: MessageEvent<{ type: string; result?: SignalStudyResult; message?: string }>) => {
        const msg = ev.data;
        if (msg.type === 'error') {
          reject(new Error(msg.message));
          return;
        }
        if (msg.type === 'study' && msg.result) {
          paintStudy(msg.result);
          resolve();
        }
      };
      worker.onerror = (e) => reject(e.error ?? new Error('Study worker failed'));
      worker.postMessage({
        type: 'study',
        bars,
        presetId: ($('study-preset') as HTMLSelectElement).value,
        tfMinutes: tf,
        window: '500',
        signalFromSec,
      });
    });
  } catch (err) {
    $('study-body').textContent = err instanceof Error ? err.message : String(err);
  } finally {
    $('btn-study').removeAttribute('disabled');
    showProgress(false, 100, '');
  }
}

function paintStudy(study: SignalStudyResult): void {
  const flag = study.insufficientSample
    ? `<p class="oos-flag">INSUFFICIENT SAMPLE (${study.occurrences} occurrences). Treat edge as noise.</p>`
    : '';
  const kpis = `<div class="study-kpis"><span>Occurrences <strong>${study.occurrences}</strong></span></div>`;
  const rows = study.horizons.map((h) => [
    h.horizon,
    String(h.count),
    `${h.avg >= 0 ? '+' : ''}${h.avg.toFixed(2)}%`,
    `${h.median >= 0 ? '+' : ''}${h.median.toFixed(2)}%`,
    `${h.posPct.toFixed(1)}%`,
    `${h.negPct.toFixed(1)}%`,
    `${h.baselinePosPct.toFixed(1)}%`,
    `<span class="${h.edge >= 0 ? 'edge-pos' : 'edge-neg'}">${h.count ? `${h.edge >= 0 ? '+' : ''}${h.edge.toFixed(1)} pp` : '—'}</span>`,
    `${h.avgMae.toFixed(2)}%`,
    `${h.avgMfe.toFixed(2)}%`,
  ]);
  $('study-body').innerHTML =
    `<p class="hint">${esc(study.label)} — forward returns after the condition vs every bar in the same window (baseline). Edge is the difference in probability that price is higher.</p>${flag}${kpis}` +
    table(['Horizon', 'n', 'Avg', 'Median', 'P(up)', 'P(down)', 'Baseline P(up)', 'Edge', 'MAE', 'MFE'], rows, 'study-body');
}

function syncRulesFromDom(): void {
  strategy.longSetup = nodeFromBlock('Long setup');
  strategy.longEntry = nodeFromBlock('Long entry');
  strategy.shortSetup = nodeFromBlock('Short setup');
  strategy.shortEntry = nodeFromBlock('Short entry');
  strategy.context = nodeFromBlock('Context (no auto entry)');
}

function nodeFromBlock(title: string): RuleNode | undefined {
  const blockEl = [...document.querySelectorAll('#side-rules .rule-block')].find((el) => el.querySelector('header')?.textContent === title);
  if (!blockEl) return undefined;
  const group = blockEl.querySelector(':scope > .cond-group');
  if (group) {
    const parsed = parseGroup(group);
    if (!parsed.children.length) return undefined;
    return parsed.children.length === 1 && !parsed.not ? parsed.children[0] : parsed;
  }
  return undefined;
}

function parseGroup(el: Element): ConditionGroup {
  const toggle = el.querySelector(':scope > [data-bool]');
  const text = toggle?.textContent ?? 'AND';
  const children: RuleNode[] = [];
  for (const child of el.children) {
    if ((child as HTMLElement).classList.contains('cond-row')) children.push(parseCond(child as HTMLElement));
    else if ((child as HTMLElement).classList.contains('cond-group')) children.push(parseGroup(child));
  }
  return {
    type: 'group',
    bool: text.includes('OR') ? 'OR' : 'AND',
    not: text.includes('NOT') || undefined,
    children,
  };
}

function parseCond(row: HTMLElement): Condition {
  return {
    type: 'cond',
    metric: (row.querySelector('[data-k="metric"]') as HTMLSelectElement).value as Condition['metric'],
    op: (row.querySelector('[data-k="op"]') as HTMLSelectElement).value as Condition['op'],
    value: Number((row.querySelector('[data-k="value"]') as HTMLInputElement).value) || 0,
  };
}

function readExecRisk(): void {
  const type = document.getElementById('ex-type') as HTMLSelectElement | null;
  if (!type) return;
  strategy.execution.orderType = type.value as Strategy['execution']['orderType'];
  strategy.execution.fillModel = ($('ex-fill') as HTMLSelectElement).value as Strategy['execution']['fillModel'];
  strategy.execution.limitOffsetBps = num('ex-off');
  strategy.execution.conservativeBps = num('ex-cons');
  strategy.execution.makerFeeBps = num('ex-maker');
  strategy.execution.takerFeeBps = num('ex-taker');
  strategy.execution.slippageBps = num('ex-slip');
  strategy.execution.latencyMs = num('ex-lat');
  strategy.risk.stopKind = ($('rk-stop') as HTMLSelectElement).value as Strategy['risk']['stopKind'];
  strategy.risk.stopValue = num('rk-sv');
  strategy.risk.takeProfits = [{ kind: 'FIXED_RR', value: num('rk-rr') || 2, closePct: 1 }];
  strategy.risk.sizing = ($('rk-sz') as HTMLSelectElement).value as Strategy['risk']['sizing'];
  strategy.risk.accountEquity = num('rk-eq') || 100_000;
  strategy.risk.riskPct = num('rk-pct') || 0.5;
}

function startReplay(r: BacktestResult): void {
  stopReplay();
  const times = bars.map((b) => b.time);
  let i = 0;
  const tick = () => {
    const t = times[i];
    if (t == null) return;
    chart.setReplayTime(t);
    chart.setSignals(r.signals, t);
    i += 1;
    if (i < times.length) replayTimer = window.setTimeout(tick, 40);
  };
  tick();
}

function stopReplay(): void {
  if (replayTimer != null) window.clearTimeout(replayTimer);
  replayTimer = null;
}

function lockVersion(s: Strategy): void {
  const key = 'orderflow.lab.locked';
  const locks = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, number>;
  if (locks[s.id] && locks[s.id] !== s.version) {
    s.version += 1;
    s.name = s.name.replace(/ v\d+$/, '') + ` v${s.version}`;
  }
  locks[s.id] = s.version;
  localStorage.setItem(key, JSON.stringify(locks));
}

function saveCurrent(): void {
  readExecRisk();
  syncRulesFromDom();
  const name = ($('save-name') as HTMLInputElement).value.trim() || strategy.name;
  strategy.name = name;
  strategy.createdAt = Date.now();
  const all = loadSaved().filter((s) => s.id !== strategy.id);
  if (strategy.id === 'custom' || listStrategyPresets().some((p) => p.id === strategy.id)) {
    strategy = cloneStrategy({ ...strategy, id: `saved_${Date.now()}`, version: 1 });
  }
  all.push(strategy);
  localStorage.setItem('orderflow.lab.strategies', JSON.stringify(all));
  fillPresets();
  ($('lab-preset') as HTMLSelectElement).value = `saved:${strategy.id}`;
}

function loadSaved(): Strategy[] {
  try {
    const raw = JSON.parse(localStorage.getItem('orderflow.lab.strategies') || '[]') as Strategy[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function tooltipHtml(s: LabSignal): string {
  const snap = s.snapshot;
  const ev = s.evidence.slice(0, 6).map((e) => `${esc(e.label)}: ${esc(e.value)}`).join('<br/>');
  return `<strong>${esc(s.kind.replace(/_/g, ' '))}</strong>${fmtTime(s.barTime)} · ${s.price.toFixed(2)}<br/>score ${s.score.toFixed(0)} · conf ${s.confidence.toFixed(0)}<br/>Δ ${snap.delta.toFixed(0)} · CVD ${snap.cvd.toFixed(0)} · OI ${snap.oi ? snap.oi.toFixed(0) : '—'}<br/>${ev}`;
}

function table(headers: string[], rows: string[][], paneId: string, onRow?: (i: number) => void): string {
  const thead = `<tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>`;
  const body = rows.map((r, i) => `<tr data-i="${i}">${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  const html = `<table><thead>${thead}</thead><tbody>${body}</tbody></table>`;
  queueMicrotask(() => {
    if (!onRow) return;
    $(paneId).querySelectorAll('tbody tr').forEach((tr) => {
      tr.addEventListener('click', () => {
        $(paneId).querySelectorAll('tbody tr').forEach((x) => x.classList.remove('selected'));
        tr.classList.add('selected');
        onRow(Number((tr as HTMLElement).dataset.i));
      });
    });
  });
  return html;
}

function showProgress(on: boolean, pct: number, text: string): void {
  $('run-progress').classList.toggle('hidden', !on);
  ($('run-bar') as HTMLElement).style.width = `${Math.max(0, Math.min(100, pct))}%`;
  $('run-meta').textContent = text;
}

function setKpi(id: string, text: string, n: number): void {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('pos', n > 0);
  el.classList.toggle('neg', n < 0);
}

function dateSec(el: HTMLInputElement): number {
  return Math.floor(new Date(el.value + 'T00:00:00Z').getTime() / 1000);
}
function num(id: string): number {
  return Number(($(id) as HTMLInputElement).value) || 0;
}
function mark(sel: string, btn: HTMLElement): void {
  document.querySelectorAll(sel).forEach((el) => el.classList.toggle('active', el === btn));
}
function money(n: number): string {
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
function fmtTime(sec: number): string {
  return new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16);
}
function fmtFwd(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

boot();
