/**
 * Market Battle panel — aggressive vs passive microstructure battles.
 * Renders from window.marketBattle on each summary; TF tabs share selectedTf.
 */

const BATTLE_TFS = ['10s', '30s', '1m', '5m', '15m'];

const state = {
  summary: null,
  symbol: null,
  tf: '10s',
};

const el = {};

function $(id) {
  return document.getElementById(id);
}

function fmtUsd(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function label(value) {
  return String(value ?? '—').replace(/_/g, ' ');
}

function intensityClass(v) {
  const s = String(v ?? '');
  if (s === 'EXTREME' || s === 'HIGH') return 'high';
  if (s === 'LOW') return 'low';
  return '';
}

function stateTone(s) {
  const v = String(s ?? '');
  if (v === 'BUYERS_WINNING') return 'buy';
  if (v === 'UPSIDE_VACUUM') return 'vac';
  if (v === 'SELLERS_DEFENDING' || v === 'SELLER_ABSORPTION') return 'abs';
  if (v === 'LOW_CONFIDENCE') return 'warn';
  return '';
}

function downsideStateTone(s) {
  const v = String(s ?? '');
  if (v === 'SELLERS_WINNING' || v === 'DOWNSIDE_VACUUM') return 'sell';
  if (v === 'BUYERS_DEFENDING' || v === 'BUYER_ABSORPTION') return 'buy';
  if (v === 'LOW_CONFIDENCE') return 'warn';
  return '';
}

function summaryTone(s) {
  const v = String(s ?? '');
  if (v === 'BUYERS_IN_CONTROL' || v === 'PASSIVE_BUYERS_DEFENDING') return 'buy';
  if (v === 'SELLERS_IN_CONTROL' || v === 'PASSIVE_SELLERS_DEFENDING') return 'sell';
  if (v === 'TWO_SIDED_DEFENSE' || v === 'COMPRESSION') return 'abs';
  if (v === 'TWO_SIDED_AGGRESSION') return 'vac';
  return '';
}

function survivalLabel(n) {
  const v = Number(n) || 0;
  if (v >= 65) return 'HIGH';
  if (v >= 35) return 'MODERATE';
  return 'LOW';
}

function windowData(summary, tf) {
  return summary?.windows?.[tf] ?? summary?.windows?.['10s'] ?? null;
}

export function initMarketBattle() {
  el.panel = $('mb-panel');
  el.grid = $('mb-grid');
  el.summary = $('mb-summary');
  el.summaryState = $('mb-summary-state');
  el.summaryWhy = $('mb-summary-why');
  el.tabs = $('mb-tf-tabs');
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
      render();
    });
  }
}

export function setMarketBattleTf(tf) {
  if (!BATTLE_TFS.includes(tf)) return;
  state.tf = tf;
  el.tabs?.querySelectorAll('.tf-tab').forEach((b) => b.classList.toggle('active', b.dataset.tf === tf));
  render();
}

export function onMarketBattleTf(handler) {
  state.onTf = handler;
}

export function getMarketBattleTf() {
  return state.tf;
}

export function ingestMarketBattle(summary) {
  if (!summary) return;
  state.summary = summary;
  state.symbol = summary.symbol;
  render();
}

function render() {
  if (!el.grid) return;
  const w = windowData(state.summary, state.tf);
  const mb = w?.marketBattle;
  if (!mb) {
    el.grid.innerHTML = `<div class="mb-empty">Waiting for market battle data…</div>`;
    if (el.summaryState) el.summaryState.textContent = '—';
    if (el.summaryWhy) el.summaryWhy.textContent = '';
    return;
  }

  el.grid.innerHTML = `${renderUpsideCard(mb.upside)}${renderDownsideCard(mb.downside)}`;

  if (el.summaryState) {
    el.summaryState.textContent = label(mb.summary?.state);
    el.summaryState.className = `mb-summary-state ${summaryTone(mb.summary?.state)}`;
  }
  if (el.summaryWhy) {
    el.summaryWhy.textContent = mb.summary?.why ?? '';
  }
}

function renderUpsideCard(up) {
  const agg = up.aggressive;
  const pas = up.passive;
  const aggVol = agg.hasData ? fmtUsd(agg.volume) : 'NO DATA';
  const aggPct = agg.hasData ? `${Math.round(agg.percentile)}th percentile` : '—';
  const pasDepth = pas.reliable ? `${fmtUsd(pas.nearDepth)} near liquidity` : 'LOW CONFIDENCE';
  const resultTone = stateTone(up.state);

  return `
  <div class="mb-card mb-upside">
    <div class="mb-card-head">
      <span>UPSIDE BATTLE</span>
      <span class="mb-battle-score" title="Upside battle intensity (independent of downside)">${Math.round(up.battleScore)}</span>
    </div>
    <div class="mb-side mb-agg">
      <div class="mb-side-row">
        <span class="mb-side-label">Aggressive Buyers</span>
        <span class="mb-side-score buy">${agg.hasData ? Math.round(agg.score) : '—'}</span>
      </div>
      <div class="mb-side-meta buy">${aggVol}</div>
      <div class="mb-side-sub">${aggPct}</div>
    </div>
    <div class="mb-vs">VS</div>
    <div class="mb-side mb-pas">
      <div class="mb-side-row">
        <span class="mb-side-label">Passive Sellers</span>
        <span class="mb-side-score sell">${pas.reliable ? Math.round(pas.score) : '—'}</span>
      </div>
      <div class="mb-side-meta sell">${pasDepth}</div>
      <div class="mb-side-sub">Seller Strength: ${pas.reliable ? `${Math.round(pas.strength)}/100` : 'LOW CONFIDENCE'}</div>
    </div>
    <div class="mb-result ${resultTone}">${label(up.state)}</div>
    <div class="mb-metrics">
      <div class="mb-metric"><span class="k">Price Efficiency</span><span class="v ${intensityClass(up.price.efficiency)}">${Math.round(up.price.efficiencyScore)}</span></div>
      <div class="mb-metric"><span class="k">Ask Consumption</span><span class="v ${intensityClass(pas.consumption)}">${pas.consumption}</span></div>
      <div class="mb-metric"><span class="k">Ask Replenishment</span><span class="v ${intensityClass(pas.replenishment)}">${pas.replenishment}</span></div>
      <div class="mb-metric"><span class="k">Ask Survival</span><span class="v">${survivalLabel(pas.survival)}</span></div>
    </div>
  </div>`;
}

function renderDownsideCard(dn) {
  const agg = dn.aggressive;
  const pas = dn.passive;
  const aggVol = agg.hasData ? fmtUsd(agg.volume) : 'NO DATA';
  const aggPct = agg.hasData ? `${Math.round(agg.percentile)}th percentile` : '—';
  const pasDepth = pas.reliable ? `${fmtUsd(pas.nearDepth)} near liquidity` : 'LOW CONFIDENCE';
  const resultTone = downsideStateTone(dn.state);

  return `
  <div class="mb-card mb-downside">
    <div class="mb-card-head">
      <span>DOWNSIDE BATTLE</span>
      <span class="mb-battle-score" title="Downside battle intensity (independent of upside)">${Math.round(dn.battleScore)}</span>
    </div>
    <div class="mb-side mb-agg">
      <div class="mb-side-row">
        <span class="mb-side-label">Aggressive Sellers</span>
        <span class="mb-side-score sell">${agg.hasData ? Math.round(agg.score) : '—'}</span>
      </div>
      <div class="mb-side-meta sell">${aggVol}</div>
      <div class="mb-side-sub">${aggPct}</div>
    </div>
    <div class="mb-vs">VS</div>
    <div class="mb-side mb-pas">
      <div class="mb-side-row">
        <span class="mb-side-label">Passive Buyers</span>
        <span class="mb-side-score buy">${pas.reliable ? Math.round(pas.score) : '—'}</span>
      </div>
      <div class="mb-side-meta buy">${pasDepth}</div>
      <div class="mb-side-sub">Buyer Strength: ${pas.reliable ? `${Math.round(pas.strength)}/100` : 'LOW CONFIDENCE'}</div>
    </div>
    <div class="mb-result ${resultTone}">${label(dn.state)}</div>
    <div class="mb-metrics">
      <div class="mb-metric"><span class="k">Price Efficiency</span><span class="v ${intensityClass(dn.price.efficiency)}">${Math.round(dn.price.efficiencyScore)}</span></div>
      <div class="mb-metric"><span class="k">Bid Replenishment</span><span class="v ${intensityClass(pas.replenishment)}">${pas.replenishment}</span></div>
      <div class="mb-metric"><span class="k">Bid Survival</span><span class="v">${survivalLabel(pas.survival)}</span></div>
      <div class="mb-metric"><span class="k">Bid Consumption</span><span class="v ${intensityClass(pas.consumption)}">${pas.consumption}</span></div>
    </div>
  </div>`;
}
