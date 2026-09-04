/**
 * Market Battle panel — footprint attack vs passive defense.
 * Renders from window.marketBattle; TF tabs control the footprint window.
 */

const BATTLE_TFS = ['10s', '30s', '1m', '5m', '15m'];

const state = {
  summary: null,
  symbol: null,
  tf: '10s',
  detail: null, // { side: 'buy'|'sell', battle: 'upside'|'downside' }
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

function fmtVel(value) {
  const n = Number(value) || 0;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M/s`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K/s`;
  return `$${n.toFixed(0)}/s`;
}

function label(value) {
  return String(value ?? '—').replace(/_/g, ' ');
}

function intensityClass(v) {
  const s = String(v ?? '');
  if (s === 'EXTREME' || s === 'HIGH') return 'high';
  if (s === 'LOW' || s === 'WEAK') return 'low';
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
  el.detail = $('mb-detail');
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
      state.detail = null;
      el.tabs.querySelectorAll('.tf-tab').forEach((b) => b.classList.toggle('active', b === btn));
      if (typeof state.onTf === 'function') state.onTf(state.tf);
      render();
    });
  }

  el.grid?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mb-attack]');
    if (!btn) return;
    const side = btn.dataset.mbAttack;
    const battle = btn.dataset.mbBattle;
    if (state.detail?.side === side && state.detail?.battle === battle) {
      state.detail = null;
    } else {
      state.detail = { side, battle };
    }
    render();
  });

  el.detail?.addEventListener('click', (e) => {
    if (e.target.closest('[data-mb-close]')) {
      state.detail = null;
      render();
    }
  });
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
    if (el.detail) el.detail.innerHTML = '';
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
  renderDetail(mb);
}

function renderUpsideCard(up) {
  const agg = up.aggressive;
  const pas = up.passive;
  const resultTone = stateTone(up.state);
  const attackOpen = state.detail?.battle === 'upside' && state.detail?.side === 'buy' ? ' open' : '';

  return `
  <div class="mb-card mb-upside">
    <div class="mb-card-head">
      <span>UPSIDE BATTLE</span>
      <span class="mb-battle-score" title="Upside battle intensity">${Math.round(up.battleScore)}</span>
    </div>

    <button type="button" class="mb-block mb-attack${attackOpen}" data-mb-attack="buy" data-mb-battle="upside">
      <div class="mb-block-tag buy">ATTACK · Footprint</div>
      <div class="mb-side-row">
        <span class="mb-side-label">Aggressive Buyers</span>
        <span class="mb-side-score buy">${agg.hasData ? `${Math.round(agg.power)} / 100` : '—'}</span>
      </div>
      ${renderAttackMetrics(agg, 'buy')}
    </button>

    <div class="mb-vs">VS</div>

    <div class="mb-block mb-defense">
      <div class="mb-block-tag sell">DEFENSE · Order book</div>
      <div class="mb-side-row">
        <span class="mb-side-label">Passive Sellers</span>
        <span class="mb-side-score sell">${pas.reliable ? `${Math.round(pas.defensePower)} / 100` : '—'}</span>
      </div>
      ${renderDefenseMetrics(pas, 'ask')}
    </div>

    <div class="mb-result ${resultTone}">${label(up.state)}</div>
    <div class="mb-metrics">
      <div class="mb-metric"><span class="k">Price Efficiency</span><span class="v ${intensityClass(up.price.efficiency)}">${Math.round(up.price.efficiencyScore)} / 100</span></div>
    </div>
  </div>`;
}

function renderDownsideCard(dn) {
  const agg = dn.aggressive;
  const pas = dn.passive;
  const resultTone = downsideStateTone(dn.state);
  const attackOpen = state.detail?.battle === 'downside' && state.detail?.side === 'sell' ? ' open' : '';

  return `
  <div class="mb-card mb-downside">
    <div class="mb-card-head">
      <span>DOWNSIDE BATTLE</span>
      <span class="mb-battle-score" title="Downside battle intensity">${Math.round(dn.battleScore)}</span>
    </div>

    <button type="button" class="mb-block mb-attack${attackOpen}" data-mb-attack="sell" data-mb-battle="downside">
      <div class="mb-block-tag sell">ATTACK · Footprint</div>
      <div class="mb-side-row">
        <span class="mb-side-label">Aggressive Sellers</span>
        <span class="mb-side-score sell">${agg.hasData ? `${Math.round(agg.power)} / 100` : '—'}</span>
      </div>
      ${renderAttackMetrics(agg, 'sell')}
    </button>

    <div class="mb-vs">VS</div>

    <div class="mb-block mb-defense">
      <div class="mb-block-tag buy">DEFENSE · Order book</div>
      <div class="mb-side-row">
        <span class="mb-side-label">Passive Buyers</span>
        <span class="mb-side-score buy">${pas.reliable ? `${Math.round(pas.defensePower)} / 100` : '—'}</span>
      </div>
      ${renderDefenseMetrics(pas, 'bid')}
    </div>

    <div class="mb-result ${resultTone}">${label(dn.state)}</div>
    <div class="mb-metrics">
      <div class="mb-metric"><span class="k">Downside Efficiency</span><span class="v ${intensityClass(dn.price.efficiency)}">${Math.round(dn.price.efficiencyScore)} / 100</span></div>
    </div>
  </div>`;
}

function renderAttackMetrics(agg, side) {
  if (!agg.hasData) {
    return `<div class="mb-side-meta warn">FOOTPRINT DATA UNAVAILABLE</div>
            <div class="mb-side-sub">Click disabled · no executed tape</div>`;
  }
  if (agg.lowConfidence) {
    return `<div class="mb-side-meta warn">LOW CONFIDENCE</div>
            <div class="mb-side-sub">Footprint delayed or incomplete</div>`;
  }
  const delta = side === 'buy'
    ? `+${fmtUsd(agg.deltaContribution)}`
    : fmtUsd(agg.deltaContribution);
  const imbLabel = side === 'buy' ? 'Buy Imbalances' : 'Sell Imbalances';
  const largeLabel = side === 'buy' ? 'Large Buy Volume' : 'Large Sell Volume';
  return `
    <div class="mb-mini">
      <div class="mb-metric"><span class="k">Executed</span><span class="v">${fmtUsd(agg.volume)}</span></div>
      <div class="mb-metric"><span class="k">Percentile</span><span class="v">${Math.round(agg.percentile)}th</span></div>
      <div class="mb-metric"><span class="k">Delta Contribution</span><span class="v">${delta}</span></div>
      <div class="mb-metric"><span class="k">Execution Velocity</span><span class="v">${fmtVel(agg.velocityPerSec)}</span></div>
      <div class="mb-metric"><span class="k">${imbLabel}</span><span class="v">${agg.imbalanceCount}</span></div>
      <div class="mb-metric"><span class="k">${largeLabel}</span><span class="v">${fmtUsd(agg.largeVolume)}</span></div>
    </div>
    <div class="mb-side-sub">Click for power contributions · footprint levels</div>`;
}

function renderDefenseMetrics(pas, side) {
  if (!pas.reliable) {
    return `<div class="mb-side-meta warn">LOW CONFIDENCE</div>
            <div class="mb-side-sub">Order book unreliable</div>`;
  }
  const nearLabel = side === 'ask' ? 'Near Ask Depth' : 'Near Bid Depth';
  const cons = side === 'ask' ? 'Ask Consumption' : 'Bid Consumption';
  const repl = side === 'ask' ? 'Ask Replenishment' : 'Bid Replenishment';
  const surv = side === 'ask' ? 'Ask Survival' : 'Bid Survival';
  const withd = side === 'ask' ? 'Ask Withdrawal' : 'Bid Withdrawal';
  return `
    <div class="mb-mini">
      <div class="mb-metric"><span class="k">${nearLabel}</span><span class="v">${fmtUsd(pas.nearDepth)}</span></div>
      <div class="mb-metric"><span class="k">${cons}</span><span class="v ${intensityClass(pas.consumption)}">${pas.consumption}</span></div>
      <div class="mb-metric"><span class="k">${repl}</span><span class="v ${intensityClass(pas.replenishment)}">${pas.replenishment}</span></div>
      <div class="mb-metric"><span class="k">${surv}</span><span class="v ${intensityClass(pas.survivalLabel)}">${pas.survivalLabel}</span></div>
      <div class="mb-metric"><span class="k">${withd}</span><span class="v ${intensityClass(pas.withdrawal)}">${pas.withdrawal}</span></div>
    </div>`;
}

function renderDetail(mb) {
  if (!el.detail) return;
  if (!state.detail) {
    el.detail.innerHTML = '';
    el.detail.classList.add('hidden');
    return;
  }
  const battle = state.detail.battle === 'upside' ? mb.upside : mb.downside;
  const agg = battle.aggressive;
  const title = state.detail.side === 'buy' ? 'Aggressive Buyers' : 'Aggressive Sellers';
  const powerLabel = state.detail.side === 'buy' ? 'Aggressive Buy Power' : 'Aggressive Sell Power';

  if (!agg.hasData) {
    el.detail.classList.remove('hidden');
    el.detail.innerHTML = `
      <div class="mb-detail-head">
        <strong>${title}</strong>
        <button type="button" class="mb-detail-close" data-mb-close>Close</button>
      </div>
      <p class="mb-detail-empty">FOOTPRINT DATA UNAVAILABLE</p>`;
    return;
  }

  const contribRows = (agg.contributions ?? [])
    .map(
      (c) => `
      <div class="mb-metric">
        <span class="k">${c.label}</span>
        <span class="v">+${Math.round(c.points)} <span class="muted">(${Math.round(c.normalized)} × ${(c.weight * 100).toFixed(0)}%)</span></span>
      </div>`,
    )
    .join('');

  const levelRows = (agg.topLevels ?? [])
    .slice(0, 10)
    .map((lv) => {
      const executed = state.detail.side === 'buy' ? lv.buyExecuted : lv.sellExecuted;
      const ratio = lv.imbalanceRatio >= 99 ? '∞' : `${lv.imbalanceRatio.toFixed(1)}x`;
      return `<tr><td>${lv.price}</td><td>${fmtUsd(executed)}</td><td>${ratio}</td></tr>`;
    })
    .join('');

  el.detail.classList.remove('hidden');
  el.detail.innerHTML = `
    <div class="mb-detail-head">
      <strong>${title}</strong>
      <button type="button" class="mb-detail-close" data-mb-close>Close</button>
    </div>
    <div class="mb-detail-power">${powerLabel}: <span>${Math.round(agg.power)}</span></div>
    <div class="mb-detail-section">
      <div class="mb-detail-label">Contributions</div>
      ${contribRows || '<div class="muted">No contribution breakdown</div>'}
    </div>
    <div class="mb-detail-section">
      <div class="mb-detail-label">Footprint price levels</div>
      ${
        levelRows
          ? `<table class="mb-level-table"><thead><tr><th>Price</th><th>${state.detail.side === 'buy' ? 'Buy Executed' : 'Sell Executed'}</th><th>Imbalance</th></tr></thead><tbody>${levelRows}</tbody></table>`
          : '<div class="muted">No imbalanced levels in this window</div>'
      }
    </div>`;
}
