/**
 * Market Battle panel — footprint attack vs passive defense.
 * Renders from window.marketBattle; TF tabs control the footprint window.
 */

const BATTLE_TFS = ['10s', '30s', '1m', '5m', '15m'];

const state = {
  summary: null,
  symbol: null,
  expectSymbol: null,
  tf: '10s',
  detail: null, // { side: 'buy'|'sell', battle: 'upside'|'downside' }
  numbers: { upside: false, downside: false },
};

/**
 * Plain-English reading for every battle state. `headline` is the answer, `plain`
 * says what is physically happening, `watch` says what it implies next. The raw
 * enum stays visible as a small tag so it still ties back to the engine.
 */
const UPSIDE_COPY = {
  BUYERS_WINNING: {
    icon: '▲',
    tone: 'buy',
    headline: 'Buyers are breaking through',
    plain: 'Aggressive buying is eating the sell orders faster than sellers can replace them, and price is following.',
    watch: 'Upside continuation while the sell wall keeps thinning.',
  },
  SELLERS_DEFENDING: {
    icon: '🛡',
    tone: 'abs',
    headline: 'Sellers are holding the line',
    plain: 'Buyers keep lifting the offer but sellers refill it every time. Price is capped here.',
    watch: 'Rejection unless buy pressure steps up — the wall is winning for now.',
  },
  SELLER_ABSORPTION: {
    icon: '⚠',
    tone: 'abs',
    headline: 'Buying is being absorbed',
    plain: 'Heavy buying is going in, but price is not moving. Someone large is quietly selling into it.',
    watch: 'Reversal risk — effort without result usually resolves downward.',
  },
  UPSIDE_VACUUM: {
    icon: '⇗',
    tone: 'vac',
    headline: 'Sellers stepped away',
    plain: 'Asks are being cancelled rather than traded. There is little left above to stop price.',
    watch: 'Price can slip up fast on small volume — moves here are thin, not strong.',
  },
  BALANCED: {
    icon: '·',
    tone: '',
    headline: 'Even fight above',
    plain: 'Buy pressure and the sell wall are roughly matched.',
    watch: 'No edge upside — wait for one side to break.',
  },
  NO_MEANINGFUL_BATTLE: {
    icon: '·',
    tone: '',
    headline: 'Nothing happening above',
    plain: 'Not enough aggressive buying to test the sell side.',
    watch: 'Ignore the upside until volume shows up.',
  },
  LOW_CONFIDENCE: {
    icon: '?',
    tone: 'warn',
    headline: 'Not enough clean data',
    plain: 'The footprint or the order book is delayed, so this read is not trustworthy.',
    watch: 'Do not trade this card right now.',
  },
};

const DOWNSIDE_COPY = {
  SELLERS_WINNING: {
    icon: '▼',
    tone: 'sell',
    headline: 'Sellers are breaking through',
    plain: 'Aggressive selling is eating the bids faster than buyers can replace them, and price is following.',
    watch: 'Downside continuation while the buy wall keeps thinning.',
  },
  BUYERS_DEFENDING: {
    icon: '🛡',
    tone: 'buy',
    headline: 'Buyers are holding the line',
    plain: 'Sellers keep hitting the bid but buyers refill it every time. Price has a floor here.',
    watch: 'Bounce risk for shorts — the wall is winning for now.',
  },
  BUYER_ABSORPTION: {
    icon: '⚠',
    tone: 'buy',
    headline: 'Selling is being absorbed',
    plain: 'Heavy selling is going in, but price is not dropping. Someone large is quietly buying it.',
    watch: 'Reversal risk upward — effort without result usually resolves the other way.',
  },
  DOWNSIDE_VACUUM: {
    icon: '⇘',
    tone: 'sell',
    headline: 'Buyers stepped away',
    plain: 'Bids are being cancelled rather than traded. There is little left below to catch price.',
    watch: 'Price can drop fast on small volume — air pocket, not real selling.',
  },
  BALANCED: {
    icon: '·',
    tone: '',
    headline: 'Even fight below',
    plain: 'Sell pressure and the buy wall are roughly matched.',
    watch: 'No edge downside — wait for one side to break.',
  },
  NO_MEANINGFUL_BATTLE: {
    icon: '·',
    tone: '',
    headline: 'Nothing happening below',
    plain: 'Not enough aggressive selling to test the buy side.',
    watch: 'Ignore the downside until volume shows up.',
  },
  LOW_CONFIDENCE: {
    icon: '?',
    tone: 'warn',
    headline: 'Not enough clean data',
    plain: 'The footprint or the order book is delayed, so this read is not trustworthy.',
    watch: 'Do not trade this card right now.',
  },
};

const SUMMARY_COPY = {
  BUYERS_IN_CONTROL: {
    bias: 'LONG',
    plain: 'Buyers are the ones moving price. They are taking offers and sellers are not standing in the way.',
  },
  SELLERS_IN_CONTROL: {
    bias: 'SHORT',
    plain: 'Sellers are the ones moving price. They are hitting bids and buyers are not standing in the way.',
  },
  PASSIVE_BUYERS_DEFENDING: {
    bias: 'LONG',
    plain: 'Sellers are pushing, but resting buy orders keep absorbing it. The floor is holding.',
  },
  PASSIVE_SELLERS_DEFENDING: {
    bias: 'SHORT',
    plain: 'Buyers are pushing, but resting sell orders keep absorbing it. The ceiling is holding.',
  },
  TWO_SIDED_DEFENSE: {
    bias: 'WAIT',
    plain: 'Both walls are holding. Price is being squeezed between them.',
  },
  TWO_SIDED_AGGRESSION: {
    bias: 'WAIT',
    plain: 'Both sides are hitting hard at once. Choppy and expensive — no clean edge.',
  },
  COMPRESSION: {
    bias: 'WAIT',
    plain: 'Volume is going in but price is not moving. Pressure is building for a break.',
  },
  NO_CLEAR_WINNER: {
    bias: 'WAIT',
    plain: 'Neither side has the upper hand right now.',
  },
};

/** Feed-health banner copy — says which failure it is, not just "untrusted". */
const HEALTH_COPY = {
  NO_TRADES: { icon: '⛔', tone: 'bad', title: 'No trades reaching the engine' },
  STALE_TRADES: { icon: '⏳', tone: 'warn', title: 'Trade feed has gone quiet' },
  BOOK_UNRELIABLE: { icon: '📖', tone: 'warn', title: 'Order book incomplete' },
};

function fmtAge(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`;
}

function copyFor(map, key) {
  return map[String(key ?? '')] ?? map.NO_MEANINGFUL_BATTLE ?? map.NO_CLEAR_WINNER;
}

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
  el.summaryPlain = $('mb-summary-plain');
  el.summaryBias = $('mb-summary-bias');
  el.summaryWhy = $('mb-summary-why');
  el.health = $('mb-health');
  el.tabs = $('mb-tf-tabs');
  el.detail = $('mb-detail');
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
      state.detail = null;
      el.tabs.querySelectorAll('.tf-tab').forEach((b) => b.classList.toggle('active', b === btn));
      if (typeof state.onTf === 'function') state.onTf(state.tf);
      render();
    });
  }

  el.grid?.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-mb-numbers]');
    if (toggle) {
      const key = toggle.dataset.mbNumbers;
      state.numbers[key] = !state.numbers[key];
      render();
      return;
    }
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
  if (!summary) {
    state.summary = null;
    state.symbol = null;
    state.detail = null;
    if (el.symbol) {
      el.symbol.textContent = state.expectSymbol
        ? String(state.expectSymbol).replace(/USDT$/i, '')
        : '—';
    }
    render();
    return;
  }
  // Ignore other coins' summaries so this tab stays locked to its URL coin.
  if (state.expectSymbol && summary.symbol !== state.expectSymbol) return;
  if (state.symbol && state.symbol !== summary.symbol) {
    state.detail = null;
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
    state.detail = null;
    render();
  }
}

function render() {
  if (!el.grid) return;
  const w = windowData(state.summary, state.tf);
  const mb = w?.marketBattle;
  if (!mb) {
    el.grid.innerHTML = `<div class="mb-empty">Waiting for market battle data…</div>`;
    if (el.summaryState) el.summaryState.textContent = '—';
    if (el.summaryPlain) el.summaryPlain.textContent = '';
    if (el.summaryWhy) el.summaryWhy.textContent = '';
    if (el.summaryBias) {
      el.summaryBias.textContent = '—';
      el.summaryBias.className = 'mb-bias';
    }
    if (el.detail) el.detail.innerHTML = '';
    renderHealth(null);
    return;
  }

  el.grid.innerHTML = `${renderBattleCard('upside', mb.upside)}${renderBattleCard('downside', mb.downside)}`;

  const summaryCopy = SUMMARY_COPY[String(mb.summary?.state ?? '')] ?? SUMMARY_COPY.NO_CLEAR_WINNER;
  if (el.summaryState) {
    el.summaryState.textContent = label(mb.summary?.state);
    el.summaryState.className = `mb-summary-state ${summaryTone(mb.summary?.state)}`;
  }
  if (el.summaryBias) {
    el.summaryBias.textContent = summaryCopy.bias;
    el.summaryBias.className = `mb-bias ${summaryCopy.bias.toLowerCase()}`;
  }
  if (el.summaryPlain) el.summaryPlain.textContent = summaryCopy.plain;
  if (el.summaryWhy) el.summaryWhy.textContent = mb.summary?.why ?? '';
  renderHealth(mb.dataHealth);
  renderDetail(mb);
}

/**
 * Feed-health banner. The engine already knows whether trades are absent, merely
 * stale, or fine-but-the-book-is-thin; showing which one turns a vague warning
 * into something actionable.
 */
function renderHealth(health) {
  if (!el.health) return;
  const status = String(health?.status ?? 'OK');
  if (!health || status === 'OK') {
    el.health.className = 'mb-health hidden';
    el.health.innerHTML = '';
    return;
  }
  const copy = HEALTH_COPY[status] ?? HEALTH_COPY.STALE_TRADES;
  const facts = [];
  if (health.tradeAgeMs > 0) facts.push(`last trade ${fmtAge(health.tradeAgeMs)} ago`);
  if (health.staleAfterMs > 0) facts.push(`stale after ${fmtAge(health.staleAfterMs)}`);
  if (health.medianTradeGapMs > 0) facts.push(`typical gap ${fmtAge(health.medianTradeGapMs)}`);
  if (!health.bookReliable) facts.push('book unreliable');
  el.health.className = `mb-health ${copy.tone}`;
  el.health.innerHTML = `
    <span class="mb-health-icon">${copy.icon}</span>
    <div>
      <div class="mb-health-title">${copy.title}</div>
      <div class="mb-health-detail">${health.detail ?? ''}</div>
      ${facts.length ? `<div class="mb-health-facts">${facts.join(' · ')}</div>` : ''}
    </div>`;
}

/**
 * One battle card. Reads top-down: what happened → the attack-vs-defense meter
 * that shows why → what to expect. Raw metrics only appear when asked for.
 */
function renderBattleCard(battle, data) {
  const upside = battle === 'upside';
  const agg = data.aggressive;
  const pas = data.passive;
  const side = upside ? 'buy' : 'sell';
  const attackSide = upside ? 'buy' : 'sell';
  const defenseSide = upside ? 'sell' : 'buy';
  const copy = copyFor(upside ? UPSIDE_COPY : DOWNSIDE_COPY, data.state);
  const resultTone = upside ? stateTone(data.state) : downsideStateTone(data.state);
  const attackOpen = state.detail?.battle === battle && state.detail?.side === side ? ' open' : '';
  const numbersOpen = state.numbers[battle];

  const attackPower = agg.hasData ? Math.round(agg.power) : null;
  const defensePower = pas.reliable ? Math.round(pas.defensePower) : null;
  const attackName = upside ? 'Aggressive buyers' : 'Aggressive sellers';
  const defenseName = upside ? 'Passive sellers' : 'Passive buyers';

  return `
  <div class="mb-card mb-${battle}">
    <div class="mb-card-head">
      <span class="mb-card-title">${upside ? 'ABOVE PRICE' : 'BELOW PRICE'}
        <em>${upside ? 'buyers attacking the sell wall' : 'sellers attacking the buy wall'}</em></span>
      <span class="mb-battle-score" title="How much is actually happening in this battle (0–100)">Intensity ${Math.round(data.battleScore)}</span>
    </div>

    <div class="mb-verdict ${copy.tone || resultTone}">
      <span class="mb-verdict-icon">${copy.icon}</span>
      <div class="mb-verdict-body">
        <div class="mb-verdict-headline">${copy.headline}</div>
        <p class="mb-verdict-plain">${copy.plain}</p>
      </div>
    </div>

    ${renderMeter(attackPower, defensePower, attackSide, defenseSide, attackName, defenseName, agg, pas, String(data.state) === 'LOW_CONFIDENCE')}

    <div class="mb-watch"><span>What it means</span>${copy.watch}</div>

    <div class="mb-card-foot">
      <span class="mb-state-tag ${resultTone}" title="Engine state">${label(data.state)}</span>
      <div class="mb-toggles">
        <button type="button" class="mb-toggle${numbersOpen ? ' open' : ''}" data-mb-numbers="${battle}">${numbersOpen ? 'Hide numbers' : 'Numbers'}</button>
        <button type="button" class="mb-toggle${attackOpen}" data-mb-attack="${side}" data-mb-battle="${battle}">Attack detail</button>
      </div>
    </div>

    ${
      numbersOpen
        ? `<div class="mb-numbers">
            <div class="mb-numbers-col">
              <div class="mb-block-tag ${attackSide}">ATTACK · footprint</div>
              ${renderAttackMetrics(agg, side)}
            </div>
            <div class="mb-numbers-col">
              <div class="mb-block-tag ${defenseSide}">DEFENSE · order book</div>
              ${renderDefenseMetrics(pas, upside ? 'ask' : 'bid')}
            </div>
            <div class="mb-metrics mb-numbers-wide">
              <div class="mb-metric"><span class="k">${upside ? 'Upside' : 'Downside'} price efficiency</span><span class="v ${intensityClass(data.price.efficiency)}">${Math.round(data.price.efficiencyScore)} / 100</span></div>
            </div>
          </div>`
        : ''
    }
  </div>`;
}

/**
 * Two-sided bar: attack power against defense power. Width is the share of the
 * fight each side holds, so the wider half is the side currently winning.
 */
function renderMeter(attack, defense, attackSide, defenseSide, attackName, defenseName, agg, pas, untrusted = false) {
  const a = attack ?? 0;
  const d = defense ?? 0;
  const total = a + d;
  const attackPct = total > 0 ? (a / total) * 100 : 50;
  const attackVal = attack == null ? 'NO DATA' : `${attack}`;
  const defenseVal = defense == null ? 'LOW CONF' : `${defense}`;
  const attackSub = agg.hasData ? `${fmtUsd(agg.volume)} executed` : 'footprint unavailable';
  const defenseSub = pas.reliable ? `${fmtUsd(pas.nearDepth)} resting near price` : 'order book unreliable';
  return `
    <div class="mb-meter${untrusted ? ' untrusted' : ''}">
      <div class="mb-meter-heads">
        <span class="${attackSide}">${attackName}</span>
        <span class="${defenseSide}">${defenseName}</span>
      </div>
      <div class="mb-meter-track" title="Attack ${attackVal} vs defense ${defenseVal} — the wider half is winning">
        <i class="${attackSide}" style="width:${attackPct.toFixed(1)}%"></i>
        <i class="${defenseSide}" style="width:${(100 - attackPct).toFixed(1)}%"></i>
      </div>
      <div class="mb-meter-vals">
        <span class="${attackSide}">${attackVal}<em>attack</em></span>
        <span class="${defenseSide}">${defenseVal}<em>defense</em></span>
      </div>
      <div class="mb-meter-subs">
        <span>${attackSub}</span>
        <span>${defenseSub}</span>
      </div>
    </div>`;
}

function renderAttackMetrics(agg, side) {
  if (!agg.hasData) {
    return `<div class="mb-side-sub warn">FOOTPRINT DATA UNAVAILABLE</div>`;
  }
  const delta = side === 'buy'
    ? `+${fmtUsd(agg.deltaContribution)}`
    : fmtUsd(agg.deltaContribution);
  const imbLabel = side === 'buy' ? 'Buy Imbalances' : 'Sell Imbalances';
  const largeLabel = side === 'buy' ? 'Large Buy Volume' : 'Large Sell Volume';
  const confNote = agg.lowConfidence
    ? `<div class="mb-side-sub warn">LOW CONFIDENCE · footprint delayed</div>`
    : `<div class="mb-side-sub">Power ${Math.round(agg.power)}/100 · open “Attack detail” for the breakdown</div>`;
  return `
    <div class="mb-mini">
      <div class="mb-metric"><span class="k">Percentile</span><span class="v">${Math.round(agg.percentile)}th</span></div>
      <div class="mb-metric"><span class="k">Delta Contribution</span><span class="v">${delta}</span></div>
      <div class="mb-metric"><span class="k">Execution Velocity</span><span class="v">${fmtVel(agg.velocityPerSec)}</span></div>
      <div class="mb-metric"><span class="k">${imbLabel}</span><span class="v">${agg.imbalanceCount}</span></div>
      <div class="mb-metric"><span class="k">${largeLabel}</span><span class="v">${fmtUsd(agg.largeVolume)}</span></div>
    </div>
    ${confNote}`;
}

function renderDefenseMetrics(pas, side) {
  if (!pas.reliable) {
    return `<div class="mb-side-meta warn">LOW CONFIDENCE</div>
            <div class="mb-side-sub">Order book unreliable</div>`;
  }
  const cons = side === 'ask' ? 'Ask Consumption' : 'Bid Consumption';
  const repl = side === 'ask' ? 'Ask Replenishment' : 'Bid Replenishment';
  const surv = side === 'ask' ? 'Ask Survival' : 'Bid Survival';
  const withd = side === 'ask' ? 'Ask Withdrawal' : 'Bid Withdrawal';
  return `
    <div class="mb-mini">
      <div class="mb-metric"><span class="k">${cons}</span><span class="v ${intensityClass(pas.consumption)}">${pas.consumption}</span></div>
      <div class="mb-metric"><span class="k">${repl}</span><span class="v ${intensityClass(pas.replenishment)}">${pas.replenishment}</span></div>
      <div class="mb-metric"><span class="k">${surv}</span><span class="v ${intensityClass(pas.survivalLabel)}">${pas.survivalLabel}</span></div>
      <div class="mb-metric"><span class="k">${withd}</span><span class="v ${intensityClass(pas.withdrawal)}">${pas.withdrawal}</span></div>
      <div class="mb-metric"><span class="k">Defense Power</span><span class="v">${Math.round(pas.defensePower)}/100</span></div>
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
