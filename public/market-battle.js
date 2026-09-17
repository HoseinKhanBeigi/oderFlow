/**
 * Market Battle panel — Attack vs Defense time series (from fight battle-viz).
 * Reads window.marketBattle; TF tabs select the model window.
 */

import {
  BATTLE_CHART_MS,
  createBattleVizState,
  ensureBattleVizShell,
  ingestBattleViz,
  paintBattleViz,
} from './battle-viz.js';

const BATTLE_TFS = ['10s', '30s', '1m', '5m', '15m'];
const TF_SEC = { '10s': 10, '30s': 30, '1m': 60, '5m': 300, '15m': 900 };

const state = {
  summary: null,
  symbol: null,
  expectSymbol: null,
  tf: '1m',
  viz: createBattleVizState(),
  paintAt: 0,
  onTf: null,
};

const el = {};

function $(id) {
  return document.getElementById(id);
}

function modelSec() {
  return TF_SEC[state.tf] ?? 60;
}

function modelLabel() {
  return state.tf;
}

function battleFromSummary(summary) {
  if (!summary) return null;
  const w = summary.windows?.[state.tf];
  return w?.marketBattle ?? null;
}

function paint() {
  if (!el.viz) return;
  ensureBattleVizShell(el.viz, state.viz, modelLabel(), () => {
    state.paintAt = 0;
    paint();
  });
  paintBattleViz(state.viz, modelLabel());
}

function renderHealth(mb) {
  if (!el.health) return;
  const h = mb?.dataHealth;
  if (!h || h.status === 'OK') {
    el.health.classList.add('hidden');
    el.health.innerHTML = '';
    return;
  }
  const titles = {
    NO_TRADES: 'No trades reaching the engine',
    STALE_TRADES: 'Trade feed has gone quiet',
    BOOK_UNRELIABLE: 'Order book incomplete',
  };
  el.health.classList.remove('hidden');
  el.health.className = `mb-health ${h.status === 'NO_TRADES' ? 'bad' : 'warn'}`;
  el.health.textContent = `${titles[h.status] || h.status}${h.detail ? ` — ${h.detail}` : ''}`;
}

function render() {
  const mb = battleFromSummary(state.summary);
  renderHealth(mb);

  if (!mb) {
    if (el.viz) {
      el.viz.innerHTML =
        '<div class="mb-empty">Waiting for market battle data…</div>';
      el.viz.dataset.ready = '';
    }
    return;
  }

  const payload = {
    marketBattle: mb,
    price: state.summary?.price ?? 0,
  };
  ingestBattleViz(state.viz, payload, modelSec());
  const now = Date.now();
  if (now - state.paintAt < BATTLE_CHART_MS && el.viz?.dataset.ready === '1') {
    // Still refresh scores lightly via paint at throttle boundary.
  }
  state.paintAt = now;
  paint();
}

export function initMarketBattle() {
  el.panel = $('mb-panel');
  el.health = $('mb-health');
  el.tabs = $('mb-tf-tabs');
  el.viz = $('mb-viz');
  el.symbol = $('mb-symbol');
  if (!el.panel) return;

  if (el.tabs) {
    el.tabs.innerHTML = BATTLE_TFS.map(
      (tf) =>
        `<button type="button" class="tf-tab${tf === state.tf ? ' active' : ''}" data-tf="${tf}">${tf}</button>`,
    ).join('');
    el.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tf-tab');
      if (!btn) return;
      state.tf = btn.dataset.tf;
      el.tabs.querySelectorAll('.tf-tab').forEach((b) => b.classList.toggle('active', b === btn));
      if (typeof state.onTf === 'function') state.onTf(state.tf);
      // Reset viz history when model TF changes so EMA/history stay coherent.
      state.viz = createBattleVizState();
      if (el.viz) el.viz.dataset.ready = '';
      render();
    });
  }
}

export function setMarketBattleTf(tf) {
  if (!BATTLE_TFS.includes(tf)) return;
  state.tf = tf;
  el.tabs?.querySelectorAll('.tf-tab').forEach((b) => b.classList.toggle('active', b.dataset.tf === tf));
  state.viz = createBattleVizState();
  if (el.viz) el.viz.dataset.ready = '';
  render();
}

export function onMarketBattleTf(handler) {
  state.onTf = handler;
}

export function getMarketBattleTf() {
  return state.tf;
}

export function ingestMarketBattle(summary) {
  if (!summary) {
    state.summary = null;
    state.symbol = null;
    state.viz = createBattleVizState();
    if (el.viz) el.viz.dataset.ready = '';
    if (el.symbol) {
      el.symbol.textContent = state.expectSymbol
        ? String(state.expectSymbol).replace(/USDT$/i, '')
        : '—';
    }
    render();
    return;
  }
  if (state.expectSymbol && summary.symbol !== state.expectSymbol) return;
  if (state.symbol && state.symbol !== summary.symbol) {
    state.viz = createBattleVizState();
    if (el.viz) el.viz.dataset.ready = '';
  }
  state.summary = summary;
  state.symbol = summary.symbol;
  if (el.symbol) {
    const labelSym = state.expectSymbol || summary.symbol;
    el.symbol.textContent = String(labelSym).replace(/USDT$/i, '') || labelSym;
  }
  render();
}

/** Lock the panel to the dashboard / URL coin. */
export function setMarketBattleSymbol(symbol) {
  state.expectSymbol = symbol || null;
  if (el.symbol) {
    el.symbol.textContent = symbol ? String(symbol).replace(/USDT$/i, '') : '—';
  }
  if (state.summary && symbol && state.summary.symbol !== symbol) {
    state.summary = null;
    state.symbol = null;
    state.viz = createBattleVizState();
    if (el.viz) el.viz.dataset.ready = '';
    render();
  }
}
