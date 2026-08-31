const _noopEl = {
  textContent: '',
  innerHTML: '',
  className: '',
  style: {},
  value: '',
  hidden: false,
  disabled: false,
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  prepend() {},
  appendChild() { return null; },
  remove() {},
  closest() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  get children() { return []; },
  get lastChild() { return null; },
  get dataset() { return {}; },
};
const $ = (id) => document.getElementById(id) || _noopEl;

const MAX_TAPE = 150;
const MAX_EVENTS = 80;
let eventCount = 0;

let selectedTf = '10s';
let selectedSymbol = 'BTCUSDT';
let selectedExchange = 'all';
let dataMode = 'perp'; // perp | spot | compare
let imbalanceRatio = 3;
const SPOT_EXCHANGES = ['binance', 'bybit', 'okx', 'bitstamp'];
const summariesByMarket = { perp: {}, spot: {} };
const spotFlowBySymbol = {};
let lastSpotFlow = null;
const feedStatus = {
  perp: { connected: false, message: '' },
  spot: { connected: false, message: '' },
};

function footprintMarket() {
  return dataMode === 'perp' ? 'perp' : 'spot';
}

function isSpotView() {
  return dataMode !== 'perp';
}
let lastSummary = null;
const summaries = {};
const tapeBySymbol = {};
const eventsBySymbol = {};
let config = null;
const seenTradeIds = new Set();
const openTabs = []; // list of { symbol, label }

const STATE_META = {
  NO_SIGNAL: { title: 'Normal activity', help: 'Nothing unusually large or persistent in this window.' },
  LARGE_BUY_FLOW: { title: 'Heavy aggressive buying', help: 'Large buyers are hitting the ask. Check if price is actually rising (effective) or stalling (absorption).' },
  LARGE_SELL_FLOW: { title: 'Heavy aggressive selling', help: 'Large sellers are hitting the bid. Check price response.' },
  PERSISTENT_BUY_FLOW: { title: 'Sustained buying pressure', help: 'Aggressive buying continued over this window — not just one print.' },
  PERSISTENT_SELL_FLOW: { title: 'Sustained selling pressure', help: 'Aggressive selling continued over this window.' },
  BUY_BURST: { title: 'Buy burst', help: 'Many aggressive buys clustered in seconds — could be one order split into pieces.' },
  SELL_BURST: { title: 'Sell burst', help: 'Many aggressive sells clustered in seconds.' },
  BUYER_ABSORPTION: { title: 'Buyer absorption', help: 'Lots of aggressive buying but price barely rose. Passive sellers may be absorbing buyers.' },
  SELLER_ABSORPTION: { title: 'Seller absorption', help: 'Lots of aggressive selling but price barely fell. Passive buyers may be absorbing sellers.' },
  LIQUIDITY_VACUUM_UP: { title: 'Thin asks — price jumping', help: 'Buyers consuming limited ask liquidity; price moving up quickly.' },
  LIQUIDITY_VACUUM_DOWN: { title: 'Thin bids — price dropping', help: 'Sellers consuming limited bid liquidity; price moving down quickly.' },
  FLOW_EXHAUSTION_BUY: { title: 'Buy flow fading', help: 'Strong buying was happening but is now decelerating.' },
  FLOW_EXHAUSTION_SELL: { title: 'Sell flow fading', help: 'Strong selling was happening but is now decelerating.' },
};

const IMPACT_HELP = {
  LOW: 'Flow did not move price much — possible absorption',
  NORMAL: 'Typical price response for this asset',
  HIGH: 'Price moved more than usual for this flow',
  EXTREME: 'Unusually strong price reaction',
};

const TF_LABEL = {
  '10s': 'last 10 seconds',
  '30s': 'last 30 seconds',
  '1m': 'last 1 minute',
  '5m': 'last 5 minutes',
  '15m': 'last 15 minutes',
};


const EX_SHORT = { binance: 'BN', bybit: 'BY', okx: 'OKX', bitget: 'BG', hyperliquid: 'HL', dydx: 'DX', bitstamp: 'BS' };
const DEFAULT_EXCHANGES = ['binance', 'bybit', 'okx', 'bitget', 'hyperliquid', 'dydx', 'bitstamp'];

function fmtUsd(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

function fmtPrice(p) {
  return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTierUsd(n) {
  if (n >= 1e6) return `$${n / 1e6}M+`;
  if (n >= 1e3) return `$${n / 1e3}K+`;
  return `$${n}+`;
}

function stateClass(state) {
  if (!state || state === 'NO_SIGNAL') return '';
  if (state.includes('ABSORPTION')) return 'absorption';
  if (state.includes('BURST')) return 'burst';
  if (state.includes('BUY') || state.includes('UP')) return 'buy-flow';
  if (state.includes('SELL') || state.includes('DOWN')) return 'sell-flow';
  return '';
}

function decodeFlags(trade) {
  const badges = [];
  if (trade.tier) badges.push({ cls: 'tier', text: `T${trade.tier}`, tip: tierTip(trade.tier) });
  if (trade.relativeClass && trade.relativeClass !== 'NORMAL') {
    badges.push({ cls: 'rel', text: trade.relativeClass.replace('_', ' '), tip: relativeTip(trade.relativeClass) });
  }
  return badges;
}

function tierTip(t) {
  if (!config?.tiers) return '';
  const map = { 1: config.tiers.tier1, 2: config.tiers.tier2, 3: config.tiers.tier3, 4: config.tiers.tier4 };
  return `Single print ≥ ${fmtTierUsd(map[t] ?? 0)}`;
}

function relativeTip(cls) {
  const p = config?.relative;
  if (!p) return 'Unusually large vs recent trades on this symbol';
  if (cls === 'LARGE') return `Bigger than ~${p.large}% of recent prints`;
  if (cls === 'VERY_LARGE') return `Top ~${100 - p.veryLarge}% — bigger than ~${p.veryLarge}% of recent prints`;
  if (cls === 'EXTREME') return `Top ~${100 - p.extreme}% — extremely rare size for this symbol`;
  return '';
}

function renderTierLegend() {
  if (!config?.tiers) return;
  const t = config.tiers;
  $('tier-legend').innerHTML = [
    ['T1', t.tier1],
    ['T2', t.tier2],
    ['T3', t.tier3],
    ['T4', t.tier4],
  ]
    .map(([label, usd]) => `<li><strong>${label}</strong> ${fmtTierUsd(usd)} per print</li>`)
    .join('');
}

function coinStore(map, symbol) {
  if (!map[symbol]) map[symbol] = [];
  return map[symbol];
}

function tradeExchange(trade) {
  return trade.exchange || 'binance';
}

function coinIsEquity(symbol = selectedSymbol) {
  return config?.coins?.find((c) => c.symbol === symbol)?.venue === 'equity';
}

function activeExchanges() {
  if (isSpotView()) {
    const enabled = new Set(config?.spotExchanges ?? SPOT_EXCHANGES);
    return SPOT_EXCHANGES.filter((id) => enabled.has(id));
  }
  const ids = config?.exchanges?.length ? config.exchanges : DEFAULT_EXCHANGES;
  return coinIsEquity() ? ['binance'] : ids;
}

function tradeMarket(trade) {
  return trade?.market === 'spot' ? 'spot' : 'perp';
}

function tradeMatchesExchange(trade) {
  if (tradeMarket(trade) !== footprintMarket()) return false;
  if (coinIsEquity(trade.symbol)) return tradeExchange(trade) === 'binance';
  if (selectedExchange === 'all') return true;
  return tradeExchange(trade) === selectedExchange;
}

function klineExchange() {
  return selectedExchange === 'all' ? 'binance' : selectedExchange;
}

function addTapeRow(trade) {
  if (!trade.symbol) return;
  if (seenTradeIds.has(trade.id)) return;
  seenTradeIds.add(trade.id);
  if (seenTradeIds.size > MAX_TAPE * 8) seenTradeIds.clear();

  const list = coinStore(tapeBySymbol, trade.symbol);
  list.unshift(trade);
  if (list.length > MAX_TAPE) list.length = MAX_TAPE;

  if (trade.symbol === selectedSymbol && tradeMatchesExchange(trade)) appendTapeRow(trade);
}

function makeTapeRowEl(trade) {
  const div = document.createElement('div');
  div.className = `tape-row ${trade.side.toLowerCase()}`;
  div.dataset.id = trade.id;
  const sideLabel = trade.side === 'BUY' ? 'Aggressive BUY' : 'Aggressive SELL';
  const sideSub = trade.side === 'BUY' ? 'hit ask' : 'hit bid';
  const flags = decodeFlags(trade)
    .map((b) => `<span class="flag ${b.cls}" title="${b.tip}">${b.text}</span>`)
    .join('');
  const ex = tradeExchange(trade);
  const exLabel = EX_SHORT[ex] ?? ex;
  div.innerHTML =
    `<span class="time">${fmtTime(trade.timestamp)}</span>` +
    `<span class="ex-badge" title="${ex}">${exLabel}</span>` +
    `<span class="action"><span class="action-main side-${trade.side.toLowerCase()}">${sideLabel}</span><span class="action-sub">${sideSub}</span></span>` +
    `<span class="price">${fmtPrice(trade.price)}</span>` +
    `<span class="notional">${fmtUsd(trade.quoteValue)}</span>` +
    `<span class="flags">${flags || '<span class="flag dim">—</span>'}</span>`;
  return div;
}

function appendTapeRow(trade) {
  const container = $('tape');
  container.prepend(makeTapeRowEl(trade));
  while (container.children.length > MAX_TAPE) container.lastChild.remove();
  $('tape-count').textContent = `${container.children.length} shown`;
}

function renderTape() {
  const container = $('tape');
  container.innerHTML = '';
  const list = (tapeBySymbol[selectedSymbol] ?? []).filter(tradeMatchesExchange);
  for (const trade of list) container.appendChild(makeTapeRowEl(trade));
  $('tape-count').textContent = `${list.length} shown`;
}

const EVENT_ICONS = { burst: '⚡', alert: '⚠', large: '◆', state: '◉', absorption: '⊘', move: '◎', info: '·' };

function addEvent(opts) {
  if (!opts || !opts.symbol || opts.symbol === '*') return;
  if (opts.market && opts.market !== footprintMarket()) return;

  const item = {
    kind: opts.kind,
    title: opts.title,
    detail: opts.detail || '',
    cls: opts.cls || opts.kind,
    symbol: opts.symbol,
    time: Date.now(),
  };

  const list = coinStore(eventsBySymbol, item.symbol);
  list.unshift(item);
  if (list.length > MAX_EVENTS) list.length = MAX_EVENTS;

  if (item.symbol === selectedSymbol) appendEvent(item);
}

function makeEventEl(item) {
  const div = document.createElement('div');
  div.className = `event-card ${item.cls}`;
  div.innerHTML =
    `<div class="event-icon">${EVENT_ICONS[item.kind] ?? '·'}</div>` +
    `<div class="event-body">` +
      `<div class="event-top"><span class="event-kind">${item.kind.toUpperCase()}</span><span class="event-time">${fmtTime(item.time)}</span></div>` +
      `<div class="event-title">${item.title}</div>` +
      (item.detail ? `<div class="event-detail">${item.detail}</div>` : '') +
    `</div>`;
  return div;
}

function appendEvent(item) {
  const container = $('events');
  container.prepend(makeEventEl(item));
  while (container.children.length > MAX_EVENTS) container.lastChild.remove();
  $('events-count').textContent = `${container.children.length} events`;
}

function renderEvents() {
  const container = $('events');
  container.innerHTML = '';
  const list = eventsBySymbol[selectedSymbol] ?? [];
  for (const item of list) container.appendChild(makeEventEl(item));
  $('events-count').textContent = `${list.length} events`;
}

function clearMainPanels() {
  lastSummary = null;
  $('price').textContent = '—';
  $('price-change').textContent = '—';
  $('price-change').className = 'price-change';
  $('state-badge').textContent = 'NO_SIGNAL';
  $('state-badge').className = 'state-badge';
  $('state-title').textContent = 'Waiting for this coin…';
  $('state-help').textContent = 'Each coin has its own tape, events, and price. Nothing is mixed.';
  $('delta').textContent = '$0';
  $('delta').className = 'value';
  $('delta-pct').textContent = '—';
  $('score').textContent = '0';
  $('score').style.color = 'inherit';
  $('impact').textContent = '—';
  $('confidence').textContent = '—';
  $('buy-vol').textContent = '$0';
  $('sell-vol').textContent = '$0';
  $('buy-bar').style.width = '50%';
  $('sell-bar').style.width = '50%';
  $('compare-row').innerHTML = '';
  $('absorption-box').classList.add('hidden');
  if ($('battle-winner')) $('battle-winner').textContent = '—';
  if ($('battle-state')) $('battle-state').textContent = '—';
  if ($('battle-evidence')) $('battle-evidence').textContent = '';
  if ($('battle-agg-buy')) $('battle-agg-buy').textContent = '0';
  renderLiquidityResponse();
  if ($('battle-pas-sell')) $('battle-pas-sell').textContent = '0';
  if ($('battle-agg-sell')) $('battle-agg-sell').textContent = '0';
  if ($('battle-pas-buy')) $('battle-pas-buy').textContent = '0';
}

function syncExchangeTabs() {
  const enabled = new Set(activeExchanges());
  const equity = coinIsEquity();
  const spot = isSpotView();
  if (equity && selectedExchange !== 'binance') selectedExchange = 'binance';
  if (!equity && selectedExchange !== 'all' && !enabled.has(selectedExchange)) selectedExchange = 'all';
  document.querySelectorAll('#chart-ex-tabs [data-ex]').forEach((btn) => {
    const id = btn.dataset.ex;
    const allowed = id === 'all' ? !equity && enabled.size > 1 : enabled.has(id);
    btn.hidden = !allowed;
    btn.disabled = !allowed;
    btn.classList.toggle('active', id === selectedExchange);
  });
}

function applySymbolFilter() {
  document.querySelectorAll('.coin-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.symbol === selectedSymbol);
  });
  lastSummary = summaries[selectedSymbol] ?? null;
  lastSpotFlow = spotFlowBySymbol[selectedSymbol] ?? null;
  if (isSpotView()) updateSpotUi();
  else if (lastSummary) updateUi();
  else clearMainPanels();
  syncExchangeTabs();
  renderTape();
  renderEvents();
  rebuildChart();
  seedFootprintKlines();
  subscribeFootprint();
  renderSpotCompare();
}

function chipHtml(c) {
  return `
    <button class="coin-chip ${c.symbol === selectedSymbol ? 'active' : ''}" data-symbol="${c.symbol}" type="button">
      <span class="coin-label">${c.label}</span>
      <span class="coin-delta" id="delta-${c.symbol}">—</span>
    </button>`;
}

let coinNavBound = false;
function renderCoinBar(assets) {
  const crypto = assets.filter((c) => c.venue !== 'equity');
  const stocks = assets.filter((c) => c.venue === 'equity');
  $('crypto-bar').innerHTML = crypto.map(chipHtml).join('');
  $('stock-bar').innerHTML = stocks.map(chipHtml).join('');

  if (!coinNavBound) {
    coinNavBound = true;
    document.querySelector('.asset-nav')?.addEventListener('click', (e) => {
      const chip = e.target.closest('.coin-chip');
      if (!chip) return;
      const sym = chip.dataset.symbol;
      const coin = config?.coins?.find((c) => c.symbol === sym);
      openTab(sym, coin?.label ?? sym.replace('USDT', ''));
      chip.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
}

function openTab(symbol, label) {
  if (isSpotView() && config?.coins?.find((c) => c.symbol === symbol)?.venue === 'equity') {
    applyDataMode('perp');
  }
  if (!openTabs.find((t) => t.symbol === symbol)) {
    openTabs.push({ symbol, label });
  }
  selectedSymbol = symbol;
  liveLastPrice = 0;
  liveLastPriceAt = 0;
  renderOpenTabs();
  applySymbolFilter();
}

function closeTab(symbol) {
  const idx = openTabs.findIndex((t) => t.symbol === symbol);
  if (idx < 0) return;
  openTabs.splice(idx, 1);
  if (selectedSymbol === symbol) {
    if (openTabs.length > 0) {
      const next = openTabs[Math.min(idx, openTabs.length - 1)];
      selectedSymbol = next.symbol;
    } else {
      const first = config?.coins?.[0];
      if (first) {
        openTabs.push({ symbol: first.symbol, label: first.label });
        selectedSymbol = first.symbol;
      }
    }
  }
  renderOpenTabs();
  applySymbolFilter();
}

function renderOpenTabs() {
  const container = $('open-tabs');
  if (!container) return;
  container.innerHTML = openTabs
    .map((t) => `
      <div class="open-tab ${t.symbol === selectedSymbol ? 'active' : ''}" data-symbol="${t.symbol}">
        <span class="open-tab-label">${t.label}</span>
        <span class="open-tab-delta" id="tab-delta-${t.symbol}">—</span>
        ${openTabs.length > 1 ? `<button class="open-tab-close" data-close="${t.symbol}" title="Close tab">×</button>` : ''}
      </div>`)
    .join('');

  container.onclick = (e) => {
    const closeBtn = e.target.closest('.open-tab-close');
    if (closeBtn) {
      e.stopPropagation();
      closeTab(closeBtn.dataset.close);
      return;
    }
    const tab = e.target.closest('.open-tab');
    if (tab) {
      selectedSymbol = tab.dataset.symbol;
      renderOpenTabs();
      applySymbolFilter();
    }
  };
}

function updateOverview(coins, market = 'perp') {
  if (market === 'spot' && !isSpotView()) return;
  if (market !== 'spot' && isSpotView()) return;
  for (const c of coins) {
    const el = $(`delta-${c.symbol}`);
    if (el) {
      el.textContent = fmtUsd(c.delta10s);
      el.className = `coin-delta ${c.delta10s > 0 ? 'pos' : c.delta10s < 0 ? 'neg' : ''}`;
    }
    const chip = document.querySelector(`.coin-chip[data-symbol="${c.symbol}"]`);
    if (chip) chip.classList.toggle('hot', c.state10s && c.state10s !== 'NO_SIGNAL');
    // Update open tab delta
    const tabEl = $(`tab-delta-${c.symbol}`);
    if (tabEl) {
      tabEl.textContent = fmtUsd(c.delta10s);
      tabEl.className = `open-tab-delta ${c.delta10s > 0 ? 'pos' : c.delta10s < 0 ? 'neg' : ''}`;
    }
  }
}

function windowData(summary, tf) {
  return summary?.windows?.[tf] ?? summary?.windows?.['10s'];
}

function tfShort(tf = chartTfMinutes) {
  if (tf >= 1440 && tf % 1440 === 0) return `${tf / 1440}D`;
  if (tf % 60 === 0) return `${tf / 60}h`;
  return `${tf}m`;
}

function updateUi() {
  if (isSpotView()) return;
  if (!lastSummary || lastSummary.symbol !== selectedSymbol) return;
  const w = windowData(lastSummary, selectedTf);
  if (!w) return;

  const meta = STATE_META[w.state] ?? { title: w.state, help: '' };

  $('price').textContent = lastSummary.price > 0 ? `$${fmtPrice(lastSummary.price)}` : '—';
  const coin = config?.coins?.find((c) => c.symbol === lastSummary.symbol);
  const venue =
    coin?.venue === 'equity'
      ? 'Binance TradFi perp'
      : selectedExchange === 'all'
        ? 'multi-exchange'
        : selectedExchange;
  $('symbol-label').textContent = `${coin?.label ?? lastSummary.symbol} · ${venue} · tape ≥ ${fmtUsd(coin?.minUsd ?? 0)}`;
  $('state-badge').textContent = w.state.replace(/_/g, ' ');
  $('state-badge').className = `state-badge ${stateClass(w.state)}`;
  $('state-title').textContent = meta.title;
  $('state-help').textContent = meta.help;

  const ch = w.priceChangePercent;
  const chEl = $('price-change');
  chEl.textContent = `${ch >= 0 ? '+' : ''}${ch.toFixed(3)}% in ${selectedTf}`;
  chEl.className = `price-change ${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}`;

  $('flow-window-label').textContent = TF_LABEL[selectedTf] ?? selectedTf;

  const deltaEl = $('delta');
  deltaEl.textContent = fmtUsd(w.delta);
  deltaEl.className = `value ${w.delta >= 0 ? 'pos' : 'neg'}`;

  const dp = (w.deltaPercent * 100).toFixed(0);
  $('delta-pct').textContent = w.delta >= 0 ? `${dp}% buy-side dominance` : `${Math.abs(dp)}% sell-side dominance`;

  $('score').textContent = w.largeFlowDirectionalScore;
  $('score').style.color = w.largeFlowDirectionalScore > 0 ? 'var(--buy)' : w.largeFlowDirectionalScore < 0 ? 'var(--sell)' : 'inherit';

  $('impact').textContent = w.priceImpactEfficiency;
  $('impact-help').textContent = IMPACT_HELP[w.priceImpactEfficiency] ?? '';

  $('confidence').textContent = `${Math.round(w.confidence * 100)}%`;

  const mult = w.delta >= 0 ? w.flowMultipleBuy : w.flowMultipleSell;
  $('flow-multiple').textContent =
    mult > 1 ? `${mult.toFixed(1)}× normal ${w.delta >= 0 ? 'buy' : 'sell'} flow` : 'Near normal volume';

  const total = w.aggressiveBuyVolume + w.aggressiveSellVolume || 1;
  $('buy-bar').style.width = `${(w.aggressiveBuyVolume / total) * 100}%`;
  $('sell-bar').style.width = `${(w.aggressiveSellVolume / total) * 100}%`;
  $('buy-vol').textContent = fmtUsd(w.aggressiveBuyVolume);
  $('sell-vol').textContent = fmtUsd(w.aggressiveSellVolume);

  const absBox = $('absorption-box');
  if (w.absorption.detected) {
    absBox.classList.remove('hidden');
    $('absorption-title').textContent = w.absorption.type?.replace(/_/g, ' ') ?? 'Absorption';
    $('absorption-text').textContent =
      w.absorption.type === 'BUYER_ABSORPTION'
        ? 'Heavy buying but price is not rising — sellers may be absorbing.'
        : 'Heavy selling but price is not falling — buyers may be absorbing.';
  } else {
    absBox.classList.add('hidden');
  }

  renderFlowBattle(w);
  renderCompare(lastSummary);
  renderLiquidityResponse();
}

function battleLabel(s) {
  return (s ?? '—').replace(/_/g, ' ');
}

function renderFlowBattle(w) {
  const b = w?.flowBattle;
  if (!b) {
    if ($('battle-winner')) $('battle-winner').textContent = '—';
    return;
  }
  const set = (id, v) => { if ($(id)) $(id).textContent = v; };
  set('battle-agg-buy', Math.round(b.battle?.aggressiveBuyerStrength ?? 0));
  set('battle-pas-sell', Math.round(b.battle?.passiveSellerStrength ?? 0));
  set('battle-agg-sell', Math.round(b.battle?.aggressiveSellerStrength ?? 0));
  set('battle-pas-buy', Math.round(b.battle?.passiveBuyerStrength ?? 0));
  set('battle-winner', `Winner: ${battleLabel(b.winner?.winner)}`);
  set('battle-state', battleLabel(b.state));
  const conf = Math.round((b.winner?.confidence ?? 0) * 100);
  set('battle-conf', `Confidence ${conf}% · not a probability`);
  const ev = (b.winner?.evidence ?? []).slice(0, 3).join(' · ');
  if ($('battle-evidence')) $('battle-evidence').textContent = ev;
}

function renderCompare(summary) {
  const impulse = summary.windows['10s'];
  const sustained = summary.windows['5m'];
  if (!impulse || !sustained) return;

  const rows = [
    { label: '10s impulse', w: impulse, desc: 'Right now' },
    { label: '5m sustained', w: sustained, desc: 'Still going?' },
  ];

  $('compare-row').innerHTML = rows
    .map(({ label, w, desc }) => {
      const meta = STATE_META[w.state]?.title ?? w.state;
      return `
      <div class="compare-card">
        <div class="compare-label">${label} <span class="muted">${desc}</span></div>
        <div class="compare-state ${stateClass(w.state)}">${meta}</div>
        <div class="compare-delta" style="color:${w.delta >= 0 ? 'var(--buy)' : 'var(--sell)'}">${fmtUsd(w.delta)} net</div>
        <div class="compare-sub">${(w.deltaPercent * 100).toFixed(0)}% side dominance · ${w.priceImpactEfficiency} impact</div>
      </div>`;
    })
    .join('');
}

function isCompareMode() {
  return dataMode === 'compare';
}

function lrLabel(value) {
  return String(value ?? '—').replace(/_/g, ' ');
}

function currentLiquidityResponse() {
  const tfKey = String(chartTfMinutes);
  if (isSpotView()) {
    const base = lastSpotFlow?.liquidityResponse;
    if (!base) return null;
    const tf = base.byTf?.[tfKey] ?? base.byTf?.[chartTfMinutes];
    return tf ? { ...base, ...tf } : base;
  }
  const w = lastSummary?.windows?.['1m'] ?? lastSummary?.windows?.[selectedTf] ?? lastSummary?.windows?.['10s'];
  const base = w?.liquidityResponse;
  if (!base) return null;
  const tf = base.byTf?.[tfKey] ?? base.byTf?.[chartTfMinutes];
  return tf && chartTfMinutes >= 1 ? { ...base, ...tf } : base;
}

function lrTone(state) {
  if (!state) return '';
  if (state.includes('ABSORB') || state.includes('DEFEND')) return 'abs';
  if (state.includes('VACUUM')) return 'vac';
  if (state.includes('BUY')) return 'buy';
  if (state.includes('SELL')) return 'sell';
  return '';
}

function lrMetric(label, value, cls = '') {
  return `<div class="lr-metric"><span class="k">${label}</span><span class="v ${cls}">${value}</span></div>`;
}

function lrTip(text, title) {
  if (!title) return text;
  return `<span class="lr-tip" title="${String(title).replace(/"/g, '&quot;')}">${text}</span>`;
}

function depthChangeLabel(depth) {
  if (!depth || depth.changePercent == null) {
    return depth?.changeReason ? `UNKNOWN · ${String(depth.changeReason).replace(/_/g, ' ')}` : 'UNKNOWN';
  }
  const n = depth.changePercent;
  return `${n >= 0 ? '+' : ''}${n.toFixed(0)}%`;
}

function renderLiquidityResponse() {
  const el = $('lr-metrics');
  if (!el) return;
  const lr = currentLiquidityResponse();
  const stateEl = $('lr-state');
  const confEl = $('lr-conf');
  const whyEl = $('lr-why');
  const revEl = $('lr-reversal');
  const primaryEl = $('lr-primary');
  if (!lr) {
    if (stateEl) {
      stateEl.textContent = 'BALANCED';
      stateEl.className = 'lr-state';
    }
    if (confEl) {
      confEl.textContent = 'LOW';
      confEl.className = 'lr-conf';
    }
    if (primaryEl) primaryEl.innerHTML = '';
    el.innerHTML = lrMetric('Aggression', '—') + lrMetric('Executed', '—') + lrMetric('Delta', '—');
    if (whyEl) whyEl.classList.add('hidden');
    if (revEl) revEl.classList.add('hidden');
    return;
  }
  const score = Number.isFinite(lr.confidenceScore) ? Math.round(lr.confidenceScore) : (lr.confidence === 'HIGH' ? 80 : lr.confidence === 'MEDIUM' ? 55 : 22);
  const confLabel = lr.confidence ?? (score >= 70 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW');
  const mechanics = lr.marketMechanics ?? lr.state ?? 'BALANCED';
  if (stateEl) {
    stateEl.textContent = lrLabel(mechanics);
    stateEl.className = `lr-state ${lrTone(mechanics)}`;
  }
  if (confEl) {
    confEl.textContent = `${confLabel} · ${score} / 100`;
    confEl.className = `lr-conf ${String(confLabel).toLowerCase()}`;
  }
  const cross = isCompareMode() && lr.compare
    ? lrLabel(lr.compare.note || lr.compare.relation)
    : 'N/A';
  if (primaryEl) {
    primaryEl.innerHTML = [
      lrMetric('State', lrLabel(lr.state), lrTone(lr.state)),
      lrMetric('Confidence', `${score} / 100`, String(confLabel).toLowerCase()),
      lrMetric('Data quality', `${Math.round(lr.dataQuality ?? 0)} / 100`),
      lrMetric('Data consistency', `${Math.round(lr.dataConsistency ?? lr.consistency?.score ?? 0)} / 100`),
      lrMetric('Effort vs result', lrLabel(lr.effort)),
      lrMetric('Cross-market', cross),
      lrMetric('Entry context', lrLabel(lr.entryContext ?? 'NO_ENTRY')),
    ].join('');
  }
  const px = lr.priceMovePercent ?? 0;
  const buyPct = lr.norms?.aggressiveBuy?.percentile;
  const sellPct = lr.norms?.aggressiveSell?.percentile;
  const movePct = lr.norms?.priceDisplacement?.percentile;
  const ask = lr.askDepth;
  const bid = lr.bidDepth;
  const da = lr.deltaAnalysis;
  el.innerHTML = `
    <div class="lr-section">
      <h3>Aggression</h3>
      ${lrMetric('Aggressive buy', buyPct == null ? '—' : lrTip(`${Math.round(buyPct)}th · ${lrLabel(percentileBandUi(buyPct))}`, percentileTip(buyPct)))}
      ${lrMetric('Aggressive sell', sellPct == null ? '—' : lrTip(`${Math.round(sellPct)}th · ${lrLabel(percentileBandUi(sellPct))}`, percentileTip(sellPct)))}
      ${lrMetric('Delta', `${fmtUsd(lr.delta ?? 0)}${da?.direction ? ` · ${da.direction}` : ''}`, (lr.delta ?? 0) >= 0 ? 'pos' : 'neg')}
    </div>
    <div class="lr-section">
      <h3>Ask response</h3>
      ${lrMetric('Current depth', fmtUsd(ask?.current ?? 0))}
      ${lrMetric('Depth percentile', ask?.currentPercentile == null ? '—' : lrTip(`${Math.round(ask.currentPercentile)}th`, percentileTip(ask.currentPercentile)))}
      ${lrMetric('Depth change', lrTip(depthChangeLabel(ask), askChangeTip(ask)))}
      ${lrMetric('Consumed', fmtUsd(ask?.consumed ?? 0))}
      ${lrMetric('Cancelled', fmtUsd(ask?.cancelled ?? 0))}
      ${lrMetric('Replenished', fmtUsd(ask?.replenished ?? 0))}
      ${lrMetric('State', lrLabel(ask?.changeState ?? lr.askResponse ?? '—'))}
    </div>
    <div class="lr-section">
      <h3>Bid response</h3>
      ${lrMetric('Current depth', fmtUsd(bid?.current ?? 0))}
      ${lrMetric('Depth percentile', bid?.currentPercentile == null ? '—' : lrTip(`${Math.round(bid.currentPercentile)}th`, percentileTip(bid.currentPercentile)))}
      ${lrMetric('Depth change', lrTip(depthChangeLabel(bid), askChangeTip(bid)))}
      ${lrMetric('Consumed', fmtUsd(bid?.consumed ?? 0))}
      ${lrMetric('Cancelled', fmtUsd(bid?.cancelled ?? 0))}
      ${lrMetric('Replenished', fmtUsd(bid?.replenished ?? 0))}
      ${lrMetric('State', lrLabel(bid?.changeState ?? lr.bidResponse ?? '—'))}
    </div>
    <div class="lr-section">
      <h3>Price response</h3>
      ${lrMetric('Move', `${px >= 0 ? '+' : ''}${px.toFixed(2)}%`, px > 0 ? 'pos' : px < 0 ? 'neg' : '')}
      ${lrMetric('Displacement', movePct == null ? '—' : lrTip(`${Math.round(movePct)}th percentile`, percentileTip(movePct)))}
      ${lrMetric('Efficiency', lr.efficiency ?? '—')}
    </div>`;
  if (whyEl) {
    const facts = [...(lr.why ?? [])];
    if (isCompareMode() && lr.compare) {
      facts.push({
        label: 'Spot/Futures confirmation',
        value: lr.compare.confirmed ? 'YES' : lr.compare.relation.replace(/_/g, ' '),
      });
    }
    whyEl.classList.toggle('hidden', !facts.length);
    whyEl.innerHTML = facts.length
      ? `<strong>WHY?</strong><ul>${facts.map((f) => `<li>${lrTip(`${f.label}: ${f.value}`, f.tooltip || f.detail || '')}</li>`).join('')}</ul>`
      : '';
  }
  if (revEl) {
    const rev = lr.reversal;
    if (rev?.detected) {
      revEl.classList.remove('hidden');
      revEl.textContent = `POTENTIAL REVERSAL CONDITIONS DETECTED · ${(rev.kind ?? '').toLowerCase()} · ${(rev.reasons ?? []).join(' · ')}`;
    } else {
      revEl.classList.add('hidden');
      revEl.textContent = '';
    }
  }
}

function percentileBandUi(p) {
  if (p < 20) return 'VERY_LOW';
  if (p < 40) return 'LOW';
  if (p < 60) return 'NORMAL';
  if (p < 80) return 'ELEVATED';
  if (p < 95) return 'HIGH';
  return 'EXTREME';
}

function percentileTip(p) {
  const n = Math.round(Number(p) || 0);
  return `This value is higher than ${n}% and lower than ${100 - n}% of comparable historical observations.`;
}

function askChangeTip(depth) {
  if (!depth) return '';
  if (depth.changePercent == null) {
    return 'Displayed band depth change is unknown because the previous snapshot was missing, reset, or unsynchronized.';
  }
  const dir = depth.changePercent >= 0 ? 'increased' : 'decreased';
  return `Displayed ask/bid liquidity inside the configured price band ${dir} ${Math.abs(depth.changePercent).toFixed(0)}% relative to the previous valid snapshot.`;
}

function updateSummary(s) {
  const market = s.market === 'spot' ? 'spot' : 'perp';
  summariesByMarket[market][s.symbol] = s;
  if (market === 'perp') {
    summaries[s.symbol] = s;
    if (s.symbol === selectedSymbol && !isSpotView()) {
      lastSummary = s;
      updateUi();
    }
  }
}

function setStatus(connected, message) {
  const el = $('status');
  el.textContent = connected ? (message || 'Live') : message;
  el.className = `status ${connected ? 'live' : message.includes('Connect') || message.includes('Reconnect') ? 'connecting' : 'offline'}`;
}

function refreshStatus() {
  const s = feedStatus[footprintMarket()] ?? feedStatus.perp;
  setStatus(s.connected, s.message || (s.connected ? 'Live' : 'Connecting…'));
}

function setupDataMode() {
  $('data-mode-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    applyDataMode(btn.dataset.mode);
  });
  $('imb-ratio')?.addEventListener('change', () => {
    const n = Number($('imb-ratio').value);
    if (Number.isFinite(n) && n >= 1.2) imbalanceRatio = n;
    scheduleDraw();
  });
}

function applyDataMode(mode) {
  if (mode !== 'perp' && mode !== 'spot') return;
  dataMode = mode;
  document.querySelectorAll('#data-mode-tabs [data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  const spot = isSpotView();
  $('chart-title').textContent = mode === 'perp' ? 'Order flow footprint' : 'Spot order flow footprint';
  $('chart-hint').textContent =
    'Stop hunt: sweep high/low then reverse. Distribution at highs: liquidity grabbed then reverse. Vacuum: asks/bids pulled and price ran. Blue = live price.';
  $('imb-cfg').classList.toggle('hidden', !spot);
  refreshStatus();
  initChart();
  const coins = visibleCoins();
  if (coins.length) selectedSymbol = coins[0].symbol;
  $('symbol-label').textContent = `${coins.length} charts · ${mode}`;
  seedFootprintKlines();
  scheduleDraw();
}

function spotWindow(snap, tfMinutes = chartTfMinutes) {
  return snap?.windows?.[String(tfMinutes)] ?? snap?.windows?.['1'] ?? snap?.windows?.[1] ?? null;
}

function flowTitle(flow) {
  if (!flow) return 'SPOT';
  if (flow.includes('BUYING')) return 'SPOT BUYERS';
  if (flow.includes('SELLING')) return 'SPOT SELLERS';
  return 'SPOT BALANCED';
}

function updateSpotUi() {
  const snap = lastSpotFlow;
  if (!snap || snap.symbol !== selectedSymbol) {
    renderSpotHud(null);
    renderSpotCompare();
    renderLiquidityResponse();
    return;
  }
  const w = spotWindow(snap) ?? snap.aggregated;
  const coin = config?.coins?.find((c) => c.symbol === snap.symbol);
  const venue = selectedExchange === 'all' ? 'multi-exchange spot' : `${selectedExchange} spot`;
  $('symbol-label').textContent = `${coin?.label ?? snap.symbol} · ${venue}`;
  if (w && $('price')) {
    $('price').textContent = snap.price > 0 ? `$${fmtPrice(snap.price)}` : '—';
    const ch = w.efficiency?.priceChangePercent ?? 0;
    const chEl = $('price-change');
    chEl.textContent = `${ch >= 0 ? '+' : ''}${ch.toFixed(3)}% in ${tfShort(chartTfMinutes)}`;
    chEl.className = `price-change ${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}`;
    $('state-badge').textContent = (w.flow ?? 'BALANCED').replace(/_/g, ' ');
    $('state-badge').className = `state-badge ${w.flow?.includes('BUY') ? 'buy-flow' : w.flow?.includes('SELL') ? 'sell-flow' : w.flags?.length ? 'absorption' : ''}`;
    $('state-title').textContent = flowTitle(w.flow);
    const flags = (w.flags ?? []).map((f) => f.replace(/_/g, ' ')).join(' · ');
    $('state-help').textContent = flags
      ? flags
      : 'Spot footprint measures executed aggressive buys and sells — not resting limit orders.';
    $('delta').textContent = fmtUsd(w.delta);
    $('delta').className = `value ${w.delta >= 0 ? 'pos' : 'neg'}`;
    $('delta-pct').textContent = `${w.deltaPercent >= 0 ? '+' : ''}${(w.deltaPercent * 100).toFixed(1)}% delta`;
    $('impact').textContent = w.efficiency?.rank ?? '—';
    $('impact-help').textContent = (w.efficiency?.effortVsResult ?? '').replace(/_/g, ' ');
    $('score').textContent = w.cvdDirection === 'UP' ? 'CVD ↑' : w.cvdDirection === 'DOWN' ? 'CVD ↓' : 'CVD →';
    $('score').style.color = w.cvdDirection === 'UP' ? 'var(--buy)' : w.cvdDirection === 'DOWN' ? 'var(--sell)' : 'inherit';
    $('confidence').textContent = w.absorption?.detected ? `${Math.round(w.absorption.confidence * 100)}%` : '—';
    $('flow-multiple').textContent = w.absorption?.type ? w.absorption.type.replace(/_/g, ' ') : 'No absorption';
    const total = (w.aggressiveBuyVolume ?? 0) + (w.aggressiveSellVolume ?? 0) || 1;
    $('buy-bar').style.width = `${((w.aggressiveBuyVolume ?? 0) / total) * 100}%`;
    $('sell-bar').style.width = `${((w.aggressiveSellVolume ?? 0) / total) * 100}%`;
    $('buy-vol').textContent = fmtUsd(w.aggressiveBuyVolume ?? 0);
    $('sell-vol').textContent = fmtUsd(w.aggressiveSellVolume ?? 0);
    const absBox = $('absorption-box');
    if (w.absorption?.detected) {
      absBox.classList.remove('hidden');
      $('absorption-title').textContent = w.absorption.type.replace(/_/g, ' ');
      $('absorption-text').textContent = w.absorption.type === 'PASSIVE_SELL_ABSORPTION'
        ? 'Aggressive spot buying is not lifting price — passive sellers appear to be absorbing. Not a trade signal.'
        : 'Aggressive spot selling is not dropping price — passive buyers appear to be absorbing. Not a trade signal.';
    } else {
      absBox.classList.add('hidden');
    }
  }
  renderSpotHud(snap);
  renderSpotCompare();
  renderLiquidityResponse();
}

function renderSpotHud(snap) {
  const el = $('spot-hud');
  if (!el) return;
  if (!snap) {
    el.innerHTML = '';
    return;
  }
  const w = spotWindow(snap) ?? snap.aggregated;
  const title = flowTitle(w.flow);
  const cls = title.includes('BUY') ? 'buy' : title.includes('SELL') ? 'sell' : 'neutral';
  const cvd = w.cvdDirection === 'UP' ? '↑' : w.cvdDirection === 'DOWN' ? '↓' : '→';
  const venueBits = SPOT_EXCHANGES.map((id) => {
    const v = snap.exchanges?.[id];
    if (!v) return `${id}: —`;
    return `${id[0].toUpperCase()}${id.slice(1)} ${fmtUsd(v.delta)}`;
  });
  el.innerHTML = `
    <div class="spot-hud-title ${cls}">${title}</div>
    <div class="spot-hud-metric"><span class="label">Agg Buy</span><span class="value pos">${fmtUsd(w.aggressiveBuyVolume)}</span></div>
    <div class="spot-hud-metric"><span class="label">Agg Sell</span><span class="value neg">${fmtUsd(w.aggressiveSellVolume)}</span></div>
    <div class="spot-hud-metric"><span class="label">Delta</span><span class="value ${w.delta >= 0 ? 'pos' : 'neg'}">${fmtUsd(w.delta)}</span></div>
    <div class="spot-hud-metric"><span class="label">Delta %</span><span class="value ${w.delta >= 0 ? 'pos' : 'neg'}">${w.deltaPercent >= 0 ? '+' : ''}${(w.deltaPercent * 100).toFixed(1)}%</span></div>
    <div class="spot-hud-metric"><span class="label">CVD</span><span class="value">${cvd}</span></div>
    <div class="spot-hud-metric"><span class="label">Efficiency</span><span class="value">${w.efficiency?.rank ?? '—'}</span></div>
    <div class="spot-hud-ex">${venueBits.join(' · ')} · Agg ${fmtUsd(snap.aggregated?.delta ?? w.delta)}</div>`;
}

function sfRow(k, v, cls = '') {
  return `<div class="sf-row"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
}

function renderSpotCompare() {
  const panel = $('spot-compare-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  const snap = lastSpotFlow;
  const w = snap ? spotWindow(snap) : null;
  const cmp = snap?.comparison;
  const fut = summaries[selectedSymbol]?.windows?.['1m'] ?? summaries[selectedSymbol]?.windows?.['5m'];
  const futLr = fut?.liquidityResponse;
  const cmpLr = snap?.liquidityResponse?.compare;
  const priceCh = w?.efficiency?.priceChangePercent ?? 0;
  $('sf-price').textContent = snap?.price ? `${priceCh >= 0 ? '+' : ''}${priceCh.toFixed(2)}%` : '—';
  const interp = lrLabel(cmpLr?.note || cmpLr?.relation || cmp?.interpretation || 'UNRESOLVED');
  const interpEl = $('sf-interpretation');
  interpEl.textContent = interp;
  interpEl.className = `sf-interpretation ${
    interp.includes('DIVERGENCE') || interp.includes('COVERING') || interp.includes('LIQUIDATION') || interp.includes('INEFFICIENT') ? 'warn'
      : interp.includes('SELL') ? 'sell'
      : interp.includes('BUY') ? 'buy' : ''
  }`;

  const spotLeg = cmpLr?.spot;
  const futLeg = cmpLr?.futures;
  const spotLr = snap?.liquidityResponse;
  $('sf-spot').innerHTML = `<h3>Spot</h3>
    ${sfRow('State', lrLabel(spotLeg?.state ?? spotLr?.state ?? w?.flow ?? '—'))}
    ${sfRow('Agg Buy', fmtUsd(w?.aggressiveBuyVolume ?? 0), 'pos')}
    ${sfRow('Agg Sell', fmtUsd(w?.aggressiveSellVolume ?? 0), 'neg')}
    ${sfRow('Delta', fmtUsd(spotLeg?.delta ?? w?.delta ?? 0), (spotLeg?.delta ?? w?.delta ?? 0) >= 0 ? 'pos' : 'neg')}
    ${sfRow('CVD', (spotLeg?.cvdDirection ?? w?.cvdDirection) === 'UP' ? '↑' : (spotLeg?.cvdDirection ?? w?.cvdDirection) === 'DOWN' ? '↓' : '→')}
    ${sfRow('Efficiency', spotLeg?.efficiency ?? w?.efficiency?.rank ?? '—')}
    ${sfRow('Liquidity', lrLabel(spotLeg?.bookResponse ?? spotLr?.askResponse ?? '—'))}`;

  const oi = futLeg?.oiChangePercent ?? futLr?.oiChangePercent;
  const shortLiq = futLeg?.shortLiquidationUsd ?? fut?.forcedBuyVolume ?? 0;
  const longLiq = futLeg?.longLiquidationUsd ?? fut?.forcedSellVolume ?? 0;
  $('sf-futures').innerHTML = `<h3>Futures</h3>
    ${sfRow('State', lrLabel(futLeg?.state ?? futLr?.state ?? '—'))}
    ${sfRow('Agg Buy', fmtUsd(fut?.aggressiveBuyVolume ?? 0), 'pos')}
    ${sfRow('Agg Sell', fmtUsd(fut?.aggressiveSellVolume ?? 0), 'neg')}
    ${sfRow('Delta', fmtUsd(futLeg?.delta ?? fut?.delta ?? 0), (futLeg?.delta ?? fut?.delta ?? 0) >= 0 ? 'pos' : 'neg')}
    ${sfRow('OI', oi == null ? '—' : `${oi >= 0 ? '+' : ''}${oi.toFixed(2)}%`)}
    ${sfRow('OI context', lrLabel(futLeg?.oiInterpretation ?? futLr?.oiInterpretation ?? '—'))}
    ${sfRow('Short liq', fmtUsd(shortLiq))}
    ${sfRow('Long liq', fmtUsd(longLiq))}
    ${sfRow('Efficiency', futLeg?.efficiency ?? futLr?.efficiency ?? '—')}`;

  const combinedEl = $('sf-combined');
  if (combinedEl) {
    const conf = cmpLr?.confidenceScore ?? 0;
    combinedEl.innerHTML = `<h3>Combined</h3>
      ${sfRow('Cross-market', interp)}
      ${sfRow('Confidence', `${Math.round(conf)} / 100`)}
      ${sfRow('Confirmed', cmpLr?.confirmed ? 'YES' : 'NO')}
      ${sfRow('Entry', lrLabel(spotLr?.entryContext ?? 'NO_ENTRY'))}`;
  }

  const bits = SPOT_EXCHANGES.map((id) => {
    const v = snap?.exchanges?.[id];
    return v ? `${id}: ${fmtUsd(v.delta)}` : null;
  }).filter(Boolean);
  $('sf-exchanges').textContent = bits.length ? `Venue delta · ${bits.join(' · ')}` : '';

  const sfLiq = $('sf-liquidity');
  if (sfLiq) {
    if (!cmpLr) {
      sfLiq.textContent = 'Cross-market confirmation: waiting for independent spot and futures books…';
    } else {
      sfLiq.innerHTML = `<strong>${interp}</strong>
        · Spot ${lrLabel(cmpLr.spot.aggression)} · ${lrLabel(cmpLr.spot.bookResponse)} · ${cmpLr.spot.efficiency} efficiency
        · Futures ${lrLabel(cmpLr.futures.aggression)} · ${lrLabel(cmpLr.futures.bookResponse)} · ${cmpLr.futures.efficiency} efficiency
        ${cmpLr.futures.oiChangePercent == null ? '' : ` · OI ${cmpLr.futures.oiChangePercent >= 0 ? '+' : ''}${cmpLr.futures.oiChangePercent.toFixed(2)}%`}
        ${cmpLr.inefficient ? ' · inefficient' : ''}`;
    }
  }
}

function ingestSpotFlow(snapshot) {
  if (!snapshot?.symbol) return;
  spotFlowBySymbol[snapshot.symbol] = snapshot;
  const w = spotWindow(snapshot, 1) ?? snapshot.aggregated;
  if (isSpotView()) {
    const el = $(`delta-${snapshot.symbol}`);
    if (el && w) {
      el.textContent = fmtUsd(w.delta);
      el.className = `coin-delta ${w.delta > 0 ? 'pos' : w.delta < 0 ? 'neg' : ''}`;
    }
    const tabEl = $(`tab-delta-${snapshot.symbol}`);
    if (tabEl && w) {
      tabEl.textContent = fmtUsd(w.delta);
      tabEl.className = `open-tab-delta ${w.delta > 0 ? 'pos' : w.delta < 0 ? 'neg' : ''}`;
    }
  }
  if (snapshot.symbol === selectedSymbol) {
    lastSpotFlow = snapshot;
    if (isSpotView()) updateSpotUi();
  }
}

function setupTabs() {
  $('tf-tabs')?.addEventListener?.('click', (e) => {
    const btn = e.target.closest('.tf-tab');
    if (!btn) return;
    selectedTf = btn.dataset.tf;
    document.querySelectorAll('#tf-tabs .tf-tab').forEach((b) => b.classList.toggle('active', b === btn));
    if (isSpotView()) updateSpotUi();
    else updateUi();
  });
}

// ═══════ Footprint / Order Flow Chart (canvas-based) ═══════

const CHART_TFS = [1, 5, 15, 30, 45, 60, 120, 240, 1440];
let chartTfMinutes = 15;
/** Current in-progress 1m bar per `symbol_exchange_1`, pushed by the server. */
const footprintStore = {};
/** Persisted bars from /api/footprint, already rolled up to the active timeframe. */
const fpHistoryStore = {};
const fpKlineSeed = {};
let fpKlineReq = 0;
let fpHistoryReq = 0;
let fpHistoryEnabled = false;
let fpRetentionDays = 30;
let fpLiveSocket = null;
let fpLastLiveMinuteBySymbol = {};
/** @type {Map<string, { canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, panBars: number, livePrice: number, liveAt: number, dragging: boolean, dragX: number, card: HTMLElement }>} */
const fpViews = new Map();
let fpDrawRaf = 0;
const fpDirty = new Set();
let fpDirtyAll = false;
let fpGridBound = false;

function visibleCoins() {
  const coins = config?.coins ?? [];
  if (isSpotView()) return coins.filter((c) => c.venue !== 'equity');
  return coins;
}

function noteLivePrice(symbol, price) {
  if (!Number.isFinite(price) || price <= 0) return;
  const view = fpViews.get(symbol);
  if (view) {
    view.livePrice = price;
    view.liveAt = Date.now();
  }
}

function latestLivePrice(symbol, fallback) {
  const view = fpViews.get(symbol);
  if (view?.livePrice > 0 && Date.now() - view.liveAt < 90_000) return view.livePrice;
  return fallback;
}

function fpLayout(cssWidth) {
  const leftPad = 8;
  const priceAxisWidth = 70;
  const candleW = 6;
  const cellW = 88;
  const gap = 6;
  const barWidth = candleW + cellW;
  const stride = barWidth + gap;
  const availW = Math.max(1, cssWidth - priceAxisWidth - leftPad);
  const visibleBars = Math.max(1, Math.floor(availW / stride));
  return { leftPad, priceAxisWidth, candleW, cellW, barWidth, gap, stride, visibleBars };
}

function clampFpPan(view, storeSize, cssWidth) {
  const { visibleBars } = fpLayout(cssWidth);
  const maxPan = Math.max(0, storeSize - visibleBars);
  view.panBars = Math.max(0, Math.min(view.panBars, maxPan));
  return maxPan;
}

function cssChartWidth(view) {
  if (!view?.canvas) return 0;
  return view.canvas.width / devicePixelRatio;
}

function scheduleDraw(symbol) {
  if (symbol) fpDirty.add(symbol);
  else fpDirtyAll = true;
  if (fpDrawRaf) return;
  fpDrawRaf = requestAnimationFrame(() => {
    fpDrawRaf = 0;
    if (fpDirtyAll) {
      for (const sym of fpViews.keys()) drawFootprint(sym);
      fpDirty.clear();
      fpDirtyAll = false;
      return;
    }
    for (const sym of fpDirty) drawFootprint(sym);
    fpDirty.clear();
  });
}

function snapChartToLive() {
  for (const view of fpViews.values()) view.panBars = 0;
  scheduleDraw();
}

function resizeFpView(symbol) {
  const view = fpViews.get(symbol);
  if (!view?.canvas?.parentElement) return;
  const rect = view.canvas.parentElement.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  view.canvas.width = w * devicePixelRatio;
  view.canvas.height = h * devicePixelRatio;
  view.ctx = view.canvas.getContext('2d');
  view.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

function resizeAllFpViews() {
  for (const symbol of fpViews.keys()) resizeFpView(symbol);
  scheduleDraw();
}

function bindFpCanvas(symbol, canvas) {
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const view = fpViews.get(symbol);
    if (!view) return;
    const W = cssChartWidth(view);
    const bars = footprintBars(symbol);
    const { stride } = fpLayout(W);
    view.panBars += (e.deltaX + e.deltaY) / stride;
    clampFpPan(view, bars.length, W);
    scheduleDraw(symbol);
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    const view = fpViews.get(symbol);
    if (!view) return;
    view.dragging = true;
    view.dragX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    const view = fpViews.get(symbol);
    if (!view?.dragging) return;
    const W = cssChartWidth(view);
    const bars = footprintBars(symbol);
    const { stride } = fpLayout(W);
    view.panBars += (e.clientX - view.dragX) / stride;
    view.dragX = e.clientX;
    clampFpPan(view, bars.length, W);
    scheduleDraw(symbol);
  });
  const endDrag = () => {
    const view = fpViews.get(symbol);
    if (!view) return;
    view.dragging = false;
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
}

function buildFpGrid() {
  const grid = document.getElementById('fp-grid');
  if (!grid) return;
  const coins = visibleCoins();
  fpViews.clear();
  grid.innerHTML = '';
  for (const coin of coins) {
    const card = document.createElement('section');
    card.className = 'fp-card';
    card.dataset.symbol = coin.symbol;
    card.id = `fp-card-${coin.symbol}`;
    card.innerHTML = `
      <header class="fp-card-head">
        <span class="fp-card-title">${coin.label}</span>
        <span class="fp-card-meta" data-fp-meta>—</span>
      </header>
      <div class="fp-card-canvas"></div>
    `;
    const host = card.querySelector('.fp-card-canvas');
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    grid.appendChild(card);
    fpViews.set(coin.symbol, {
      canvas,
      ctx: canvas.getContext('2d'),
      panBars: 0,
      livePrice: 0,
      liveAt: 0,
      dragging: false,
      dragX: 0,
      card,
    });
    bindFpCanvas(coin.symbol, canvas);
  }
  $('symbol-label').textContent = `${coins.length} charts · ${footprintMarket()}`;
  resizeAllFpViews();
}

function initChart() {
  if (!fpGridBound) {
    fpGridBound = true;
    window.addEventListener('resize', resizeAllFpViews);
    document.getElementById('chart-tf-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ctf]');
      if (!btn) return;
      chartTfMinutes = Number(btn.dataset.ctf);
      document.querySelectorAll('#chart-tf-tabs .chart-tf-tab').forEach((b) => b.classList.toggle('active', b === btn));
      snapChartToLive();
      seedFootprintKlines();
    });
    document.getElementById('chart-ex-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ex]');
      if (!btn || btn.disabled) return;
      selectedExchange = btn.dataset.ex;
      syncExchangeTabs();
      snapChartToLive();
      seedFootprintKlines();
      subscribeFootprint();
    });
    document.getElementById('chart-live-btn')?.addEventListener('click', snapChartToLive);
  }
  buildFpGrid();
}

function getFootprintStore(symbol, tf = chartTfMinutes, exchange = 'binance') {
  const key = `${footprintMarket()}_${symbol}_${exchange}_${tf}`;
  if (!footprintStore[key]) footprintStore[key] = new Map();
  return footprintStore[key];
}

function historyKey(symbol, tf, exchange) {
  return `${footprintMarket()}_${symbol}_${exchange}_${tf}`;
}

function getFpHistory(symbol = selectedSymbol, tf = chartTfMinutes, exchange = selectedExchange) {
  return fpHistoryStore[historyKey(symbol, tf, exchange)] ?? new Map();
}

function getFpKlineSeed(symbol, tf = chartTfMinutes, exchange = klineExchange()) {
  const key = `${footprintMarket()}_${symbol}_${exchange}_${tf}`;
  if (!fpKlineSeed[key]) fpKlineSeed[key] = new Map();
  return fpKlineSeed[key];
}

function cloneFpBar(bar) {
  const levels = new Map();
  for (const [k, v] of bar.levels.entries()) {
    levels.set(k, { price: v.price, buy: v.buy, sell: v.sell });
  }
  return {
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    closeTime: bar.closeTime ?? bar.time,
    totalBuy: bar.totalBuy,
    totalSell: bar.totalSell,
    buyTrades: bar.buyTrades ?? 0,
    sellTrades: bar.sellTrades ?? 0,
    largestBuy: bar.largestBuy ?? 0,
    largestSell: bar.largestSell ?? 0,
    levels,
  };
}

function fpKlineInterval(tf = chartTfMinutes) {
  if (tf === 1440) return '1d';
  if (tf === 240) return '4h';
  if (tf === 120) return '2h';
  if (tf === 60) return '1h';
  if (tf === 45) return '15m';
  return `${tf}m`;
}

function wireBarToFp(w) {
  const levels = new Map();
  for (const [price, buy, sell] of w.lv ?? []) {
    levels.set(price.toFixed(6), { price, buy, sell });
  }
  return {
    time: w.t,
    open: w.o,
    high: w.h,
    low: w.l,
    close: w.c,
    totalBuy: w.tb ?? 0,
    totalSell: w.ts ?? 0,
    buyTrades: w.bt ?? 0,
    sellTrades: w.st ?? 0,
    largestBuy: w.lb ?? 0,
    largestSell: w.ls ?? 0,
    levels,
  };
}

/**
 * Run async work over items with a hard concurrency cap.
 * Avoids bursting 2×N requests when the grid has many coins.
 */
async function mapPool(items, concurrency, worker) {
  const list = [...items];
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, async () => {
    while (cursor < list.length) {
      const idx = cursor++;
      await worker(list[idx], idx);
    }
  });
  await Promise.all(runners);
}

/**
 * Loads stored footprint history for every visible symbol/timeframe.
 * Caps parallel fetches, then only pulls klines for charts still short on history.
 */
async function loadFootprintHistory() {
  const tf = chartTfMinutes;
  const exchange = selectedExchange;
  const market = footprintMarket();
  const req = ++fpHistoryReq;
  const coins = visibleCoins();
  let enabled = fpHistoryEnabled;

  await mapPool(coins, 4, async (coin) => {
    if (req !== fpHistoryReq) return;
    try {
      const params = new URLSearchParams({
        symbol: coin.symbol,
        exchange,
        tf: String(tf),
        limit: '600',
        days: String(Math.min(fpRetentionDays, 14)),
        market,
      });
      const data = await fetch(`/api/footprint?${params}`).then((r) => r.json());
      if (req !== fpHistoryReq) return;
      if (!data?.enabled) {
        enabled = false;
        return;
      }
      enabled = true;
      const map = new Map();
      for (const w of data.bars ?? []) map.set(w.t, wireBarToFp(w));
      fpHistoryStore[historyKey(coin.symbol, tf, exchange)] = map;
      scheduleDraw(coin.symbol);
    } catch {
      /* keep whatever history we already had */
    }
  });

  if (req !== fpHistoryReq) return;
  fpHistoryEnabled = enabled;
}

function seedFootprintKlines() {
  void (async () => {
    if (fpHistoryEnabled) await loadFootprintHistory();
    await seedFromKlines();
  })();
}

async function seedFromKlines() {
  const tf = chartTfMinutes;
  const exchange = klineExchange();
  const market = footprintMarket();
  if (tf < 15) {
    scheduleDraw();
    return;
  }
  const req = ++fpKlineReq;
  // Prefer Postgres history when present — only backfill empty/thin charts with klines.
  const coins = visibleCoins().filter((coin) => {
    const hist = getFpHistory(coin.symbol, tf, selectedExchange);
    return hist.size < 24;
  });
  if (!coins.length) {
    scheduleDraw();
    return;
  }

  await mapPool(coins, 3, async (coin) => {
    if (req !== fpKlineReq || tf !== chartTfMinutes || klineExchange() !== exchange) return;
    try {
      const rows = await fetch(
        `/api/klines?symbol=${encodeURIComponent(coin.symbol)}&interval=${fpKlineInterval(tf)}&exchange=${encodeURIComponent(exchange)}&market=${encodeURIComponent(market)}&limit=300`,
      ).then((r) => r.json());
      if (req !== fpKlineReq || tf !== chartTfMinutes || klineExchange() !== exchange) return;
      if (!Array.isArray(rows) || !rows.length) return;
      let candles = rows
        .map((k) => ({
          time: Math.floor(Number(k[0]) / 1000),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5] ?? 0),
          quote: Number(k[7] ?? k[6] ?? 0),
          takerBuy: Number(k[10] ?? k[9] ?? NaN),
        }))
        .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.close));
      if (tf === 45) candles = aggregateToMinutes(candles, 45);
      const seed = getFpKlineSeed(coin.symbol, tf, exchange);
      seed.clear();
      for (const c of candles) {
        const bar = {
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          levels: new Map(),
          totalBuy: 0,
          totalSell: 0,
        };
        fillKlineProxyLevels(bar, c.volume, c.quote, c.takerBuy);
        seed.set(c.time, bar);
      }
      scheduleDraw(coin.symbol);
    } catch {
      /* live 1m rollup still works */
    }
  });
}

function klineQuoteUsd(volume, quote, high, low, close) {
  const typical = (high + low + close) / 3;
  if (Number.isFinite(quote) && quote > 0) return quote;
  if (!Number.isFinite(volume) || volume <= 0 || !Number.isFinite(typical) || typical <= 0) return 0;
  return volume * typical;
}

function fillKlineProxyLevels(bar, volume, quote, takerBuy) {
  const usd = klineQuoteUsd(volume, quote, bar.high, bar.low, bar.close);
  if (usd <= 0) return bar;
  const range = Math.max(bar.high - bar.low, tickSize((bar.high + bar.low) / 2));
  const body = range > 0 ? Math.abs(bar.close - bar.open) / range : 0;
  let buyFrac = 0.5;
  if (Number.isFinite(takerBuy) && takerBuy >= 0 && volume > 0) {
    buyFrac = Math.min(0.9, Math.max(0.1, takerBuy / volume));
  } else if (bar.close > bar.open) {
    buyFrac = 0.52 + 0.28 * Math.min(1, body);
  } else if (bar.close < bar.open) {
    buyFrac = 0.48 - 0.28 * Math.min(1, body);
  }
  const buyUsd = usd * buyFrac;
  const sellUsd = usd - buyUsd;
  const tick = tickSize((bar.high + bar.low) / 2);
  let lo = priceToTick(bar.low, tick);
  let hi = priceToTick(bar.high, tick);
  if (hi < lo) {
    const swap = lo;
    lo = hi;
    hi = swap;
  }
  const n = Math.max(1, Math.round((hi - lo) / tick) + 1);
  const step = n <= 14 ? tick : tick * Math.max(1, Math.ceil(n / 14));
  const prices = [];
  for (let p = lo; p <= hi + step * 0.001; p += step) {
    prices.push(priceToTick(p, step));
  }
  if (!prices.length) prices.push(priceToTick(bar.close, tick));
  const peak = priceToTick(bar.close, step);
  const span = Math.max(hi - lo, step);
  const weights = prices.map((p) => Math.max(0.12, 1 - Math.abs(p - peak) / span));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  bar.levels = new Map();
  bar.totalBuy = buyUsd;
  bar.totalSell = sellUsd;
  prices.forEach((p, i) => {
    const w = weights[i] / wsum;
    bar.levels.set(p.toFixed(6), { price: p, buy: buyUsd * w, sell: sellUsd * w });
  });
  return bar;
}

function levelCoverage(bar) {
  if (!bar.levels?.size) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const lv of bar.levels.values()) {
    if ((lv.buy + lv.sell) <= 0) continue;
    if (lv.price < lo) lo = lv.price;
    if (lv.price > hi) hi = lv.price;
  }
  if (!Number.isFinite(lo)) return 0;
  return (hi - lo) / Math.max(bar.high - bar.low, 1e-9);
}

function mergeFootprintBar(target, src) {
  target.high = Math.max(target.high, src.high);
  target.low = Math.min(target.low, src.low);
  const srcT = src.closeTime ?? src.time ?? 0;
  const tgtT = target.closeTime ?? target.time ?? 0;
  if (srcT >= tgtT) {
    target.close = src.close;
    target.closeTime = srcT;
  }
  target.totalBuy += src.totalBuy;
  target.totalSell += src.totalSell;
  target.buyTrades = (target.buyTrades ?? 0) + (src.buyTrades ?? 0);
  target.sellTrades = (target.sellTrades ?? 0) + (src.sellTrades ?? 0);
  target.largestBuy = Math.max(target.largestBuy ?? 0, src.largestBuy ?? 0);
  target.largestSell = Math.max(target.largestSell ?? 0, src.largestSell ?? 0);
  for (const lv of src.levels.values()) {
    const k = lv.price.toFixed(6);
    if (!target.levels.has(k)) target.levels.set(k, { price: lv.price, buy: 0, sell: 0 });
    const d = target.levels.get(k);
    d.buy += lv.buy;
    d.sell += lv.sell;
  }
}

function aggregateFrom1m(symbol, tfMinutes) {
  const venues = selectedExchange === 'all' ? activeExchanges() : [selectedExchange];
  const out = new Map();
  const bucket = tfMinutes * 60;
  for (const ex of venues) {
    for (const bar of getFootprintStore(symbol, 1, ex).values()) {
      const t = bar.time - (bar.time % bucket);
      if (!out.has(t)) {
        out.set(t, {
          time: t,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          levels: new Map(),
          totalBuy: 0,
          totalSell: 0,
          buyTrades: 0,
          sellTrades: 0,
          largestBuy: 0,
          largestSell: 0,
        });
      }
      mergeFootprintBar(out.get(t), bar);
    }
  }
  return out;
}

function live1mStore(symbol) {
  if (selectedExchange !== 'all') return getFootprintStore(symbol, 1, selectedExchange);
  const venues = activeExchanges();
  if (venues.length === 1) return getFootprintStore(symbol, 1, venues[0]);
  const out = new Map();
  for (const ex of venues) {
    for (const bar of getFootprintStore(symbol, 1, ex).values()) {
      if (!out.has(bar.time)) out.set(bar.time, cloneFpBar(bar));
      else mergeFootprintBar(out.get(bar.time), bar);
    }
  }
  return out;
}

function footprintBars(symbol = selectedSymbol, tf = chartTfMinutes) {
  const live = tf === 1 ? live1mStore(symbol) : aggregateFrom1m(symbol, tf);
  const hist = fpHistoryEnabled ? getFpHistory(symbol, tf, selectedExchange) : new Map();
  const kline = tf >= 15 ? getFpKlineSeed(symbol, tf) : new Map();
  if (hist.size === 0 && kline.size === 0 && live.size === 0) return [];

  const out = new Map();
  for (const bar of hist.values()) out.set(bar.time, cloneFpBar(bar));
  for (const bar of live.values()) {
    if (!out.has(bar.time)) out.set(bar.time, cloneFpBar(bar));
    else mergeFootprintBar(out.get(bar.time), bar);
  }
  for (const k of kline.values()) {
    const existing = out.get(k.time);
    if (!existing) {
      out.set(k.time, cloneFpBar(k));
    } else if ((k.totalBuy + k.totalSell) > 0 && levelCoverage(existing) < 0.5) {
      for (const [key, lv] of k.levels) {
        if (!existing.levels.has(key)) {
          existing.levels.set(key, { price: lv.price, buy: lv.buy, sell: lv.sell });
          existing.totalBuy += lv.buy;
          existing.totalSell += lv.sell;
        }
      }
    }
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

function fpCandleTime(ts, tf = chartTfMinutes) {
  const s = Math.floor(ts / 1000);
  return s - (s % (tf * 60));
}

function tickSize(price) {
  if (price >= 10000) return 10;
  if (price >= 1000) return 1;
  if (price >= 100) return 0.5;
  if (price >= 10) return 0.1;
  if (price >= 1) return 0.01;
  return 0.001;
}

function priceToTick(price, tick) {
  return Math.round(price / tick) * tick;
}

function ingestTradeToChart(trade) {
  // Server aggregator owns the live bar and pushes it over WS. The tape is
  // filtered to large prints, so building from it here would understate volume.
  if (fpLiveSocket?.readyState === WebSocket.OPEN) return;
  if (tradeMarket(trade) !== footprintMarket()) return;
  const tick = tickSize(trade.price);
  const level = priceToTick(trade.price, tick);
  const lk = level.toFixed(6);
  const store = getFootprintStore(trade.symbol, 1, tradeExchange(trade));
  const t = fpCandleTime(trade.timestamp, 1);
  if (!store.has(t)) {
    store.set(t, {
      time: t, open: trade.price, high: trade.price, low: trade.price, close: trade.price,
      levels: new Map(), totalBuy: 0, totalSell: 0,
    });
  }
  const bar = store.get(t);
  bar.high = Math.max(bar.high, trade.price);
  bar.low = Math.min(bar.low, trade.price);
  bar.close = trade.price;
  bar.closeTime = t;
  noteLivePrice(trade.symbol, trade.price);
  if (!bar.levels.has(lk)) bar.levels.set(lk, { price: level, buy: 0, sell: 0 });
  const lv = bar.levels.get(lk);
  if (trade.side === 'BUY') { lv.buy += trade.quoteValue; bar.totalBuy += trade.quoteValue; }
  else { lv.sell += trade.quoteValue; bar.totalSell += trade.quoteValue; }
  if (trade.symbol && tradeMatchesExchange(trade)) {
    scheduleDraw(trade.symbol);
  }
}

function displayBucket(high, low, chartH) {
  const raw = tickSize((high + low) / 2);
  const range = Math.max(high - low, raw);
  const maxRows = Math.max(8, Math.floor(chartH / 20));
  let bucket = raw;
  while (range / bucket > maxRows) bucket *= 2;
  return bucket;
}

function bucketBarLevels(bar, bucket) {
  const map = new Map();
  for (const lv of bar.levels.values()) {
    const p = priceToTick(lv.price, bucket);
    const k = p.toFixed(8);
    if (!map.has(k)) map.set(k, { price: p, buy: 0, sell: 0 });
    const b = map.get(k);
    b.buy += lv.buy;
    b.sell += lv.sell;
  }
  return [...map.values()];
}

function liveFlowBattle(symbol = selectedSymbol) {
  const snap = summaries[symbol];
  return snap?.windows?.[selectedTf]?.flowBattle
    ?? snap?.windows?.['10s']?.flowBattle
    ?? null;
}

function fpBarWinner(bar) {
  const delta = (bar.totalBuy ?? 0) - (bar.totalSell ?? 0);
  const mid = (bar.high + bar.low) / 2 || bar.close;
  const move = mid ? (bar.close - bar.open) / mid : 0;
  const range = bar.high - bar.low;
  const body = Math.abs(bar.close - bar.open);
  const stalled = Math.abs(move) < 0.00045 || (range > 0 && body / range < 0.3);
  if (delta > 0 && stalled) return { id: 'PASSIVE_SELLERS', short: 'P.SELL', color: '#fbbf24' };
  if (delta < 0 && stalled) return { id: 'PASSIVE_BUYERS', short: 'P.BUY', color: '#60a5fa' };
  if (delta > 0 && move > 0) return { id: 'AGGRESSIVE_BUYERS', short: 'A.BUY', color: '#22c55e' };
  if (delta < 0 && move < 0) return { id: 'AGGRESSIVE_SELLERS', short: 'A.SELL', color: '#ef4444' };
  return { id: 'BALANCED', short: '', color: '#8b949e' };
}

function barAbsorbed(bar) {
  const vol = (bar.totalBuy ?? 0) + (bar.totalSell ?? 0);
  const delta = (bar.totalBuy ?? 0) - (bar.totalSell ?? 0);
  const range = Math.max(bar.high - bar.low, 1e-9);
  const closePos = (bar.close - bar.low) / range;
  const dominated = vol > 0 && Math.abs(delta / vol) >= 0.25;
  if (dominated && delta < 0 && closePos >= 0.55) return 'SELLERS';
  if (dominated && delta > 0 && closePos <= 0.45) return 'BUYERS';
  return null;
}

function priorSwingLevels(prior) {
  if (!prior.length) return { support: null, resistance: null };
  const recent = prior.slice(-16);
  let resistance = -Infinity;
  let support = Infinity;
  for (const b of recent) {
    if (b.high > resistance) resistance = b.high;
    if (b.low < support) support = b.low;
  }
  if (!Number.isFinite(resistance) || !Number.isFinite(support)) return { support: null, resistance: null };
  return { support, resistance };
}

function barLocationFromPrior(bar, prior) {
  const { support, resistance } = priorSwingLevels(prior);
  if (support == null || resistance == null || resistance <= support) return 'UNKNOWN';
  const band = Math.max((resistance - support) * 0.12, (bar.close || 1) * 0.0015);
  if (bar.close > resistance + band * 0.15) return 'ABOVE_RESISTANCE';
  if (bar.close < support - band * 0.15) return 'BELOW_SUPPORT';
  if (bar.high >= resistance - band) return 'AT_RESISTANCE';
  if (bar.low <= support + band) return 'AT_SUPPORT';
  return 'MID_RANGE';
}

function recentBarAtr(prior, bar) {
  const look = prior.slice(-8);
  if (!look.length) return Math.max(bar.high - bar.low, (bar.close || 1) * 0.002);
  let s = 0;
  for (const b of look) s += Math.max(b.high - b.low, 0);
  return s / look.length || Math.max(bar.high - bar.low, (bar.close || 1) * 0.002);
}

function barVacuumKind(bar, prior) {
  const buy = bar.totalBuy ?? 0;
  const sell = bar.totalSell ?? 0;
  const vol = buy + sell;
  const range = bar.high - bar.low;
  if (range <= 0) return null;
  const atr = recentBarAtr(prior, bar);
  const closePos = (bar.close - bar.low) / range;
  const move = bar.close - bar.open;
  const expanded = range >= atr * 1.15;
  const ran = Math.abs(move) >= atr * 0.45;
  if (!expanded && !ran) return null;
  const deltaPct = vol > 0 ? (buy - sell) / vol : (move > 0 ? 0.3 : move < 0 ? -0.3 : 0);
  if (deltaPct >= 0.18 && move > 0 && closePos >= 0.62) return 'UPSIDE';
  if (deltaPct <= -0.18 && move < 0 && closePos <= 0.38) return 'DOWNSIDE';
  if (move > 0 && closePos >= 0.72 && range >= atr * 1.35) return 'UPSIDE';
  if (move < 0 && closePos <= 0.28 && range >= atr * 1.35) return 'DOWNSIDE';
  return null;
}

function absorptionReversalKind(bar, next) {
  const abs = barAbsorbed(bar);
  if (abs === 'SELLERS') {
    const reversed = bar.close >= bar.open || (next && next.close > bar.close);
    if (reversed) return 'SELLER';
  }
  if (abs === 'BUYERS') {
    const reversed = bar.close <= bar.open || (next && next.close < bar.close);
    if (reversed) return 'BUYER';
  }
  return null;
}

/** Sweep of prior swing high/low (stop liquidity), then close back through the level. */
function stopHuntKind(bar, prior) {
  const { support, resistance } = priorSwingLevels(prior);
  if (support == null || resistance == null || resistance <= support) return null;
  const atr = recentBarAtr(prior, bar);
  const range = bar.high - bar.low;
  if (range <= 0) return null;
  const closePos = (bar.close - bar.low) / range;
  const band = Math.max((resistance - support) * 0.08, atr * 0.35);
  // Sweep highs → reverse down
  if (bar.high >= resistance + band * 0.2 && bar.close < resistance && closePos <= 0.42) return 'HIGH';
  // Sweep lows → reverse up
  if (bar.low <= support - band * 0.2 && bar.close > support && closePos >= 0.58) return 'LOW';
  return null;
}

/** Distribution near highs: liquidity taken above resistance, buyers fade, reverse down. */
function distributionAtHighsKind(bar, next, prior) {
  const location = barLocationFromPrior(bar, prior);
  if (location !== 'AT_RESISTANCE' && location !== 'ABOVE_RESISTANCE') return null;
  const { resistance } = priorSwingLevels(prior);
  const range = bar.high - bar.low;
  if (resistance == null || range <= 0) return null;
  const closePos = (bar.close - bar.low) / range;
  const absorbed = barAbsorbed(bar);
  const grabbed = bar.high >= resistance && closePos <= 0.48;
  const buyersFaded =
    absorbed === 'BUYERS'
    || ((bar.totalBuy ?? 0) >= (bar.totalSell ?? 0) * 0.9 && bar.close <= bar.open);
  const reversed = bar.close < bar.open || (next && next.close < bar.close);
  if (grabbed && buyersFaded && reversed) return 'DISTRIBUTION';
  return null;
}

function strategyStoryForBar(allBars, idx) {
  const bar = allBars[idx];
  const prior = allBars.slice(Math.max(0, idx - 20), idx);
  const next = allBars[idx + 1];
  const win = fpBarWinner(bar);
  const absorbed = barAbsorbed(bar);
  const location = barLocationFromPrior(bar, prior);
  const vol = (bar.totalBuy ?? 0) + (bar.totalSell ?? 0);
  const deltaPct = vol > 0 ? ((bar.totalBuy ?? 0) - (bar.totalSell ?? 0)) / vol : 0;
  let score = 0;
  if (absorbed === 'SELLERS') score += 20;
  else if (absorbed === 'BUYERS') score -= 20;
  else score += Math.max(-28, Math.min(28, deltaPct * 40));
  if (location === 'AT_SUPPORT') score += 18;
  else if (location === 'AT_RESISTANCE') score -= 18;
  else if (location === 'ABOVE_RESISTANCE') score += 14;
  else if (location === 'BELOW_SUPPORT') score -= 14;
  const bias = Math.abs(score) < 12 ? 'WAIT' : score > 0 ? 'LONG' : 'SHORT';
  let setup = 'MID_RANGE';
  if (location === 'AT_SUPPORT' && (absorbed === 'SELLERS' || score > 0)) setup = 'SUPPORT_HOLD';
  else if (location === 'AT_RESISTANCE' && (absorbed === 'BUYERS' || score < 0)) setup = 'RESISTANCE_REJECT';
  else if (location === 'ABOVE_RESISTANCE' && score > 0) setup = 'BREAKOUT_UP';
  else if (location === 'BELOW_SUPPORT' && score < 0) setup = 'BREAKDOWN';
  else if (location === 'MID_RANGE' && Math.abs(score) >= 28) setup = 'FLOW_CONTINUATION';

  const hunt = stopHuntKind(bar, prior);
  if (hunt === 'HIGH') return { badge: 'SHORT', line1: 'Stop hunt', line2: 'swept high · reverse', color: '#e879f9' };
  if (hunt === 'LOW') return { badge: 'LONG', line1: 'Stop hunt', line2: 'swept low · reverse', color: '#e879f9' };

  const dist = distributionAtHighsKind(bar, next, prior);
  if (dist) return { badge: 'SHORT', line1: 'Distribution at highs', line2: 'liq grabbed · reverse', color: '#c084fc' };

  const rev = absorptionReversalKind(bar, next);
  if (rev === 'SELLER') return { badge: 'LONG', line1: 'Sellers absorbed', line2: 'then reversed up', color: '#7dd3fc' };
  if (rev === 'BUYER') return { badge: 'SHORT', line1: 'Buyers absorbed', line2: 'then reversed down', color: '#fbbf24' };
  const vac = barVacuumKind(bar, prior);
  if (vac === 'UPSIDE') return { badge: 'LONG', line1: 'Asks pulled', line2: 'price ran up', color: '#22d3ee' };
  if (vac === 'DOWNSIDE') return { badge: 'SHORT', line1: 'Bids pulled', line2: 'price dumped', color: '#fb923c' };

  if (setup === 'SUPPORT_HOLD') return { badge: 'LONG', line1: 'Held support', line2: 'buyers defended', color: '#22c55e' };
  if (setup === 'RESISTANCE_REJECT') return { badge: 'SHORT', line1: 'Rejected resist', line2: 'sellers capped', color: '#ef4444' };
  if (setup === 'BREAKOUT_UP') return { badge: 'LONG', line1: 'Broke resistance', line2: 'held above', color: '#22c55e' };
  if (setup === 'BREAKDOWN') return { badge: 'SHORT', line1: 'Broke support', line2: 'held below', color: '#ef4444' };
  if (setup === 'FLOW_CONTINUATION' && bias === 'LONG') return { badge: 'LONG', line1: 'Buyers in control', line2: 'price followed', color: '#22c55e' };
  if (setup === 'FLOW_CONTINUATION' && bias === 'SHORT') return { badge: 'SHORT', line1: 'Sellers in control', line2: 'price followed', color: '#ef4444' };
  if (absorbed === 'SELLERS') return { badge: bias === 'WAIT' ? 'WAIT' : bias, line1: 'Sellers absorbed', line2: 'price held up', color: '#7dd3fc' };
  if (absorbed === 'BUYERS') return { badge: bias === 'WAIT' ? 'WAIT' : bias, line1: 'Buyers absorbed', line2: 'price stalled', color: '#fbbf24' };
  if (win.id === 'AGGRESSIVE_BUYERS') return { badge: 'LONG', line1: 'Buyers in control', line2: 'price followed', color: '#22c55e' };
  if (win.id === 'AGGRESSIVE_SELLERS') return { badge: 'SHORT', line1: 'Sellers in control', line2: 'price followed', color: '#ef4444' };
  if (win.id === 'PASSIVE_SELLERS') return { badge: 'WAIT', line1: 'Buyers absorbed', line2: 'price stalled', color: '#fbbf24' };
  if (win.id === 'PASSIVE_BUYERS') return { badge: 'WAIT', line1: 'Sellers absorbed', line2: 'price held up', color: '#7dd3fc' };
  return { badge: 'WAIT', line1: 'No clear edge', line2: '', color: '#8b949e' };
}

function drawBarStrategyTitle(ctx, story, cx, maxW) {
  if (!story) return;
  const title = story.line1 || '';
  const sub = story.line2 || '';
  const maxTextW = Math.max(72, Math.min(maxW, 132));
  const top = 14;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const drawLine = (text, y, font, color) => {
    if (!text) return;
    ctx.font = font;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.lineJoin = 'round';
    ctx.strokeText(text, cx, y, maxTextW);
    ctx.fillStyle = color;
    ctx.fillText(text, cx, y, maxTextW);
  };
  drawLine(story.badge, top, 'bold 11px Inter, system-ui, sans-serif', story.color);
  drawLine(title, top + 15, '600 11px Inter, system-ui, sans-serif', '#f4f6f9');
  if (sub) drawLine(sub, top + 29, '500 10px Inter, system-ui, sans-serif', '#c5ccd6');
  ctx.restore();
}

function drawBattleHud(ctx, leftPad, plotRight, symbol = selectedSymbol) {
  ctx.font = 'bold 10px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let text;
  let color = '#8b949e';
  if (isSpotView()) {
    const snap = spotFlowBySymbol[symbol];
    const w = snap ? spotWindow(snap) : null;
    if (w) {
      color = w.flow?.includes('BUY') ? '#22c55e' : w.flow?.includes('SELL') ? '#ef4444' : '#8b949e';
      text = `${(w.flow ?? 'BALANCED').replace(/_/g, ' ')}  ·  Δ ${fmtUsd(w.delta)}`;
    } else {
      text = 'Spot flow waiting…';
    }
  } else {
    const b = liveFlowBattle(symbol);
    if (b?.winner?.winner) {
      const w = b.winner.winner;
      color = w.includes('PASSIVE_SELL') ? '#fbbf24'
        : w.includes('PASSIVE_BUY') ? '#60a5fa'
        : w.includes('AGGRESSIVE_BUY') ? '#22c55e'
        : w.includes('AGGRESSIVE_SELL') ? '#ef4444'
        : '#8b949e';
      text = battleLabel(w);
    } else {
      text = 'Flow battle waiting…';
    }
  }
  ctx.fillStyle = 'rgba(13, 17, 23, 0.88)';
  ctx.fillRect(leftPad, 18, Math.min(plotRight - leftPad, 420), 14);
  ctx.fillStyle = color;
  ctx.fillText(text, leftPad + 4, 25);
}

function fmtPriceAxis(p) {
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(3);
  return p.toFixed(5);
}

function drawFootprint(symbol = selectedSymbol) {
  const view = fpViews.get(symbol);
  if (!view?.ctx || !view.canvas) return;
  const W = view.canvas.width / devicePixelRatio;
  const H = view.canvas.height / devicePixelRatio;
  const ctx = view.ctx;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  const liveBtn = document.getElementById('chart-live-btn');
  const bars = footprintBars(symbol);
  if (bars.length === 0) {
    liveBtn?.classList.add('hidden');
    ctx.fillStyle = '#8b949e';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for footprint…', W / 2, H / 2);
    const meta = view.card?.querySelector('[data-fp-meta]');
    if (meta) meta.textContent = 'loading';
    return;
  }

  const { leftPad, priceAxisWidth, candleW, cellW, barWidth, stride, visibleBars } = fpLayout(W);
  const topPad = 72;
  const bottomPad = 36;
  const chartH = H - topPad - bottomPad;
  clampFpPan(view, bars.length, W);
  liveBtn?.classList.toggle('hidden', [...fpViews.values()].every((v) => v.panBars < 0.15));

  const pan = Math.round(view.panBars);
  const endIdx = bars.length - pan;
  const startIdx = Math.max(0, endIdx - visibleBars);
  const visible = bars.slice(startIdx, endIdx);

  if (visible.length === 0) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No footprint bars yet', W / 2, H / 2);
    return;
  }

  let globalHigh = -Infinity, globalLow = Infinity;
  for (const bar of visible) {
    if (bar.high > globalHigh) globalHigh = bar.high;
    if (bar.low < globalLow) globalLow = bar.low;
  }
  const lastBar = visible[visible.length - 1];
  const livePx = latestLivePrice(symbol, lastBar?.close ?? 0);
  const nowBucket = fpCandleTime(Date.now(), chartTfMinutes);
  const lastIsLive = pan < 0.15 && lastBar?.time === nowBucket;
  if (livePx) {
    globalHigh = Math.max(globalHigh, livePx);
    globalLow = Math.min(globalLow, livePx);
  }
  const bucket = displayBucket(globalHigh, globalLow, chartH);
  globalHigh = priceToTick(globalHigh, bucket) + bucket * 2;
  globalLow = priceToTick(globalLow, bucket) - bucket * 2;
  const priceRange = globalHigh - globalLow || bucket;
  const numRows = Math.max(1, Math.round(priceRange / bucket));
  const rowH = chartH / numRows;

  function yForPrice(p) {
    return topPad + ((globalHigh - p) / priceRange) * chartH;
  }

  const bucketed = visible.map((bar) => bucketBarLevels(bar, bucket));
  let maxSide = 0;
  for (const levels of bucketed) {
    for (const lv of levels) {
      if (lv.buy > maxSide) maxSide = lv.buy;
      if (lv.sell > maxSide) maxSide = lv.sell;
    }
  }

  ctx.textBaseline = 'middle';

  const plotRight = W - priceAxisWidth;
  const steps = Math.floor(priceRange / bucket);
  const labelEvery = Math.max(1, Math.floor(steps / 16));
  ctx.font = 'bold 11px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  for (let i = 0; i <= steps; i += labelEvery) {
    const p = globalLow + i * bucket;
    const y = yForPrice(p);
    if (y < topPad || y > topPad + chartH) continue;
    ctx.strokeStyle = '#1c2128';
    ctx.beginPath();
    ctx.moveTo(leftPad, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.fillStyle = '#d0d7e2';
    ctx.fillText(fmtPriceAxis(p), W - 4, y);
  }

  ctx.font = '8px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#8b949e';
  if (view.panBars >= 0.15) {
    ctx.fillText('drag / scroll · Latest jumps to live', leftPad + 2, 8);
  } else {
    ctx.fillText('Stop hunt · distribution · vacuum', leftPad + 2, 8);
  }

  for (let i = 0; i < visible.length; i++) {
    const bar = visible[i];
    const levels = bucketed[i];
    const x = plotRight - (visible.length - i) * stride;
    const cellX = x + candleW + 2;
    const half = cellW / 2;
    const cx = x + barWidth / 2;
    const isLiveBar = lastIsLive && i === visible.length - 1;
    if (!isLiveBar) {
      drawBarStrategyTitle(ctx, strategyStoryForBar(bars, startIdx + i), cx, barWidth - 4);
    } else {
      drawBarStrategyTitle(ctx, { badge: 'NOW', line1: 'This candle', line2: 'still forming', color: '#60a5fa' }, cx, barWidth - 4);
    }
    const poc = levels.reduce((best, lv) => (lv.buy + lv.sell > best.vol ? { vol: lv.buy + lv.sell, price: lv.price } : best), { vol: 0, price: 0 });

    ctx.fillStyle = '#12171f';
    ctx.fillRect(cellX, topPad, cellW, chartH);

    const liveEdge = lastIsLive && i === visible.length - 1 && livePx;
    const up = (liveEdge ? livePx : bar.close) >= bar.open;
    const wickX = x + candleW / 2;
    const barHigh = liveEdge ? Math.max(bar.high, livePx) : bar.high;
    const barLow = liveEdge ? Math.min(bar.low, livePx) : bar.low;
    const barClose = liveEdge ? livePx : bar.close;
    ctx.strokeStyle = up ? '#22c55e' : '#ef4444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(wickX, yForPrice(barHigh));
    ctx.lineTo(wickX, yForPrice(barLow));
    ctx.stroke();
    const bodyTop = yForPrice(Math.max(bar.open, barClose));
    const bodyBot = yForPrice(Math.min(bar.open, barClose));
    ctx.fillStyle = up ? '#22c55e' : '#ef4444';
    ctx.fillRect(x + 1, bodyTop, candleW - 2, Math.max(2, bodyBot - bodyTop));

    ctx.strokeStyle = '#2a3342';
    ctx.beginPath();
    ctx.moveTo(cellX + half, topPad);
    ctx.lineTo(cellX + half, topPad + chartH);
    ctx.stroke();

    const rh = Math.max(1, rowH - 1);
    const sellBox = half - 2;
    const buyBox = cellW - half - 2;
    for (const lv of levels) {
      const y = yForPrice(lv.price);
      const total = lv.buy + lv.sell;
      if (total <= 0) continue;
      if (lv.sell > 0) {
        const a = 0.22 + 0.58 * (lv.sell / Math.max(maxSide, 1));
        ctx.fillStyle = `rgba(239, 68, 68, ${a})`;
        ctx.fillRect(cellX + 1, y - rh / 2, sellBox, rh);
      }
      if (lv.buy > 0) {
        const a = 0.22 + 0.58 * (lv.buy / Math.max(maxSide, 1));
        ctx.fillStyle = `rgba(34, 197, 94, ${a})`;
        ctx.fillRect(cellX + half + 1, y - rh / 2, buyBox, rh);
      }
      if (poc.vol > 0 && lv.price === poc.price) {
        ctx.strokeStyle = '#fbbf24';
        ctx.strokeRect(cellX + 1, y - rh / 2 + 0.5, cellW - 2, rh - 1);
      }
      if (lv.sell > 0) {
        drawFpCellText(ctx, fmtVolShort(lv.sell), cellX + 1, y, sellBox, rh, 'right', '#fff1f2');
      }
      if (lv.buy > 0) {
        drawFpCellText(ctx, fmtVolShort(lv.buy), cellX + half + 1, y, buyBox, rh, 'left', '#ecfdf5');
      }
    }

    ctx.font = 'bold 11px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#c6cdd8';
    const d = new Date(bar.time * 1000);
    let timeLabel;
    if (chartTfMinutes >= 1440) {
      timeLabel = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    } else {
      timeLabel = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    }
    ctx.fillText(timeLabel, cx, topPad + chartH + 14);

    const delta = bar.totalBuy - bar.totalSell;
    const barUsd = bar.totalBuy + bar.totalSell;
    if (barUsd > 0) {
      ctx.font = 'bold 11px JetBrains Mono, monospace';
      ctx.fillStyle = delta >= 0 ? '#4ade80' : '#f87171';
      ctx.fillText(`${delta >= 0 ? '+' : '-'}${fmtVolShort(Math.abs(delta))}`, x + barWidth / 2, topPad + chartH + 28);
    }
  }

  if (livePx) {
    drawChartPriceLine(ctx, yForPrice(livePx), '#60a5fa', `LIVE ${fmtPriceAxis(livePx)}`, leftPad, plotRight);
  }

  const storyIdx = Math.max(0, bars.length - (lastIsLive && bars.length > 1 ? 2 : 1));
  const story = bars.length ? strategyStoryForBar(bars, storyIdx) : null;
  const meta = view.card?.querySelector('[data-fp-meta]');
  if (meta) {
    const px = livePx || lastBar?.close || 0;
    meta.textContent = story?.line1
      ? `${fmtPriceAxis(px)} · ${story.line1}`
      : fmtPriceAxis(px);
  }
  ctx.lineWidth = 1;
}

function drawChartPriceLine(ctx, y, color, label, leftPad, plotRight, labelOffset = 0) {
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(leftPad, y);
  ctx.lineTo(plotRight, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = 'bold 11px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const padX = 7;
  const padY = 4;
  const tw = ctx.measureText(label).width;
  const bx = leftPad + 4;
  const by = y - 12 - labelOffset;
  const bw = tw + padX * 2;
  const bh = 18;
  ctx.fillStyle = 'rgba(8, 11, 16, 0.92)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const r = 5;
  ctx.moveTo(bx + r, by);
  ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
  ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
  ctx.arcTo(bx, by + bh, bx, by, r);
  ctx.arcTo(bx, by, bx + bw, by, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(label, bx + padX, by + bh / 2);
  ctx.restore();
}

function drawLiveLiquidityMarks(ctx, { cellX, half, cellW, yForPrice, rh, topPad, chartH }) {
  const marks = currentLiquidityResponse()?.levels ?? [];
  if (!marks.length) return;
  ctx.save();
  ctx.lineWidth = 1;
  for (const mark of marks) {
    const y = yForPrice(mark.price);
    if (y < topPad + 1 || y > topPad + chartH - 1) continue;
    if (mark.restingBid > 0) {
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = '#22d3ee';
      ctx.strokeRect(cellX + 1, y - rh / 2 + 0.5, half - 2, Math.max(2, rh - 1));
    }
    if (mark.restingAsk > 0) {
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = '#fb923c';
      ctx.strokeRect(cellX + half, y - rh / 2 + 0.5, half - 2, Math.max(2, rh - 1));
    }
    ctx.setLineDash([]);
    if (String(mark.event).startsWith('REPLENISH')) {
      ctx.setLineDash([1, 2]);
      ctx.strokeStyle = '#a78bfa';
      ctx.strokeRect(cellX + 3, y - rh / 2 + 2, cellW - 6, Math.max(1, rh - 4));
      ctx.setLineDash([]);
    }
    if (String(mark.event).startsWith('WITHDRAW')) {
      ctx.strokeStyle = '#94a3b8';
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(cellX + 4, y - Math.min(4, rh / 2));
      ctx.lineTo(cellX + cellW - 4, y + Math.min(4, rh / 2));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (String(mark.event).startsWith('ABSORPTION')) {
      ctx.strokeStyle = mark.event === 'ABSORPTION_ASK' ? '#fbbf24' : '#60a5fa';
      ctx.strokeRect(cellX + 2, y - rh / 2 + 1, cellW - 4, Math.max(2, rh - 2));
    }
  }
  ctx.restore();
}

function updateFpLevNow(livePx) {
  const el = document.getElementById('fp-lev-now');
  if (!el) return;
  el.textContent = livePx ? `live ${fmtPriceAxis(livePx)}` : 'live —';
  el.className = 'fp-lev-now';
  el.title = 'Live last price';
}

function fmtVolLabel(v) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}

function fmtVolShort(v) {
  const n = Math.abs(v);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`;
  if (n >= 100_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

function drawFpCellText(ctx, text, x, y, w, h, align, fill = '#ffffff') {
  if (!text || h < 8 || w < 12) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 1, y - h / 2 + 0.5, Math.max(1, w - 2), Math.max(1, h - 1));
  ctx.clip();
  const fs = Math.min(12, Math.max(9, Math.floor(h * 0.72)));
  ctx.font = `700 ${fs}px JetBrains Mono, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  const maxW = Math.max(10, w - 6);
  const tx = align === 'right' ? x + w - 3 : x + 3;
  ctx.lineWidth = Math.max(2.5, fs * 0.28);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeText(text, tx, y, maxW);
  ctx.fillStyle = fill;
  ctx.fillText(text, tx, y, maxW);
  ctx.restore();
}

function rebuildChart() {
  snapChartToLive();
}

function subscribeFootprint() {
  // Live 1m bars for every coin arrive via footprint_tick broadcast.
  // Keep a single sub so the server still pushes focused live updates for the first chart.
  if (fpLiveSocket?.readyState !== WebSocket.OPEN) return;
  const first = visibleCoins()[0];
  if (!first) return;
  fpLiveSocket.send(JSON.stringify({
    type: 'sub_footprint',
    symbol: first.symbol,
    exchange: selectedExchange,
    market: footprintMarket(),
  }));
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Applies the server's in-progress 1m bar. Only the current minute is kept:
 * once it closes it belongs to persisted history, so we refetch instead of
 * holding it locally and counting it twice.
 */
function applyLiveFootprint(ev) {
  if (!ev?.symbol || !fpViews.has(ev.symbol)) return;
  if (ev.market && ev.market !== footprintMarket()) return;
  const bars = ev.bars ?? [];
  if (!bars.length) return;

  const minute = bars[0].bar.t;
  if (minute !== fpLastLiveMinuteBySymbol[ev.symbol]) {
    fpLastLiveMinuteBySymbol[ev.symbol] = minute;
    const prefix = `${footprintMarket()}_${ev.symbol}_`;
    for (const key of Object.keys(footprintStore)) {
      if (key.startsWith(prefix) && key.endsWith('_1')) delete footprintStore[key];
    }
  }

  for (const { exchange, bar } of bars) {
    const store = getFootprintStore(ev.symbol, 1, exchange);
    store.clear();
    store.set(bar.t, wireBarToFp(bar));
    ingestAlertBar(ev.symbol, exchange, bar);
    noteLivePrice(ev.symbol, bar.c);
  }
  evaluateSymbolAlerts(ev.symbol);
  scheduleDraw(ev.symbol);
}

function applyFootprintTick(ev) {
  if (ev.market && ev.market !== footprintMarket()) return;
  const rows = ev.bars ?? [];
  if (!rows.length) return;
  const touched = new Set();
  for (const row of rows) {
    if (!row?.symbol || !row?.bar || !row?.exchange) continue;
    const store = getFootprintStore(row.symbol, 1, row.exchange);
    const t = row.bar.t;
    // Keep only the live minute in the in-progress store.
    if (!store.has(t) || store.size > 1) {
      for (const key of [...store.keys()]) {
        if (key !== t) store.delete(key);
      }
    }
    store.set(t, wireBarToFp(row.bar));
    ingestAlertBar(row.symbol, row.exchange, row.bar);
    noteLivePrice(row.symbol, row.bar.c);
    touched.add(row.symbol);
  }
  for (const symbol of touched) {
    evaluateSymbolAlerts(symbol);
    scheduleDraw(symbol);
  }
}

// ═══════ Footprint Alerts (session toasts, all coins) ═══════

const ALERT_TF_MINUTES = 60; // alerts always evaluate on 1h bars
const ALERT_KEEP_1M = 720; // ~12h of 1m bars → enough prior for 1h vacuum context
const ALERT_MAX_SESSION = 80;
const ALERT_TOAST_MS = 7000;
const alertFpStore = {};
const alertSeen = new Map();
const sessionAlerts = [];
let alertUiBound = false;

function alertStoreKey(symbol, exchange) {
  return `${footprintMarket()}_${symbol}_${exchange}_1`;
}

function getAlertStore(symbol, exchange) {
  const key = alertStoreKey(symbol, exchange);
  if (!alertFpStore[key]) alertFpStore[key] = new Map();
  return alertFpStore[key];
}

function trimAlertStore(store) {
  if (store.size <= ALERT_KEEP_1M) return;
  const times = [...store.keys()].sort((a, b) => a - b);
  const drop = times.length - ALERT_KEEP_1M;
  for (let i = 0; i < drop; i++) store.delete(times[i]);
}

function ingestAlertBar(symbol, exchange, wire) {
  const store = getAlertStore(symbol, exchange);
  const bar = wireBarToFp(wire);
  store.set(bar.time, bar);
  trimAlertStore(store);
  noteLivePrice(symbol, bar.close);
}

function alertBarsForSymbol(symbol, tf = chartTfMinutes) {
  const exchanges = selectedExchange === 'all' ? activeExchanges() : [selectedExchange];
  if (tf === 1) {
    const out = new Map();
    for (const ex of exchanges) {
      for (const bar of getAlertStore(symbol, ex).values()) {
        if (!out.has(bar.time)) out.set(bar.time, cloneFpBar(bar));
        else mergeFootprintBar(out.get(bar.time), bar);
      }
    }
    return [...out.values()].sort((a, b) => a.time - b.time);
  }
  const bucket = tf * 60;
  const out = new Map();
  for (const ex of exchanges) {
    for (const bar of getAlertStore(symbol, ex).values()) {
      const t = bar.time - (bar.time % bucket);
      if (!out.has(t)) {
        const c = cloneFpBar(bar);
        c.time = t;
        out.set(t, c);
      } else {
        mergeFootprintBar(out.get(t), bar);
      }
    }
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

function countImbalanceLevels(bar, ratio = imbalanceRatio) {
  let buyDom = 0;
  let sellDom = 0;
  if (!bar?.levels) return { buyDom, sellDom };
  for (const lv of bar.levels.values()) {
    const buy = lv.buy ?? 0;
    const sell = lv.sell ?? 0;
    const hi = Math.max(buy, sell);
    const lo = Math.min(buy, sell);
    if (hi < 800) continue;
    if (lo <= 0) {
      if (buy > sell) buyDom += 1;
      else if (sell > buy) sellDom += 1;
      continue;
    }
    if (hi / lo < ratio) continue;
    if (buy > sell) buyDom += 1;
    else sellDom += 1;
  }
  return { buyDom, sellDom };
}

function alertLabel(symbol) {
  return config?.coins?.find((c) => c.symbol === symbol)?.label ?? symbol.replace('USDT', '');
}

function canFireAlert(key, cooldownMs = 90_000) {
  const now = Date.now();
  const last = alertSeen.get(key) ?? 0;
  if (now - last < cooldownMs) return false;
  alertSeen.set(key, now);
  if (alertSeen.size > 400) {
    const cutoff = now - 10 * 60_000;
    for (const [k, t] of alertSeen) {
      if (t < cutoff) alertSeen.delete(k);
    }
  }
  return true;
}

function barIsVolatile(bar, prior = []) {
  if (!bar) return false;
  const mid = bar.close || bar.open || 0;
  if (!(mid > 0)) return false;
  const range = Math.max(0, (bar.high ?? bar.close) - (bar.low ?? bar.close));
  const body = Math.abs((bar.close ?? mid) - (bar.open ?? mid));
  const rangePct = (range / mid) * 100;
  const bodyPct = (body / mid) * 100;
  if (bodyPct >= 0.35) return true;
  if (rangePct >= 0.6) return true;
  const sample = prior.slice(-14);
  if (sample.length >= 5) {
    const atr = sample.reduce((s, b) => s + Math.max(0, (b.high ?? b.close) - (b.low ?? b.close)), 0) / sample.length;
    if (atr > 0 && range >= atr * 1.25) return true;
  }
  return false;
}

function pingVolatility(alert) {
  if (typeof Notification === 'undefined') return;
  const title = alert.title || 'Volatility';
  const body = alert.detail || '';
  const tag = `vol-${alert.symbol}`;
  const show = () => {
    try {
      new Notification(title, { body, tag, silent: false });
    } catch { /* ignore */ }
  };
  if (Notification.permission === 'granted') show();
  else if (Notification.permission === 'default') {
    Notification.requestPermission().then((p) => { if (p === 'granted') show(); });
  }
}

function pushFpAlert(alert) {
  sessionAlerts.unshift(alert);
  if (sessionAlerts.length > ALERT_MAX_SESSION) sessionAlerts.length = ALERT_MAX_SESSION;
  renderAlertList();
  showAlertToast(alert);
  pingVolatility(alert);
}

function evaluateSymbolAlerts(symbol) {
  const bars = alertBarsForSymbol(symbol, ALERT_TF_MINUTES);
  if (!bars.length) return;
  const idx = bars.length - 1;
  const bar = bars[idx];
  if (!barIsVolatile(bar, bars.slice(0, idx))) return;
  const story = strategyStoryForBar(bars, idx);
  if (!story) return;
  const kind =
    story.line1 === 'Buyers in control' ? { key: 'buyers', side: 'buy' }
      : story.line1 === 'Sellers in control' ? { key: 'sellers', side: 'sell' }
        : story.line1 === 'Stop hunt' ? { key: story.line2.includes('low') ? 'hunt-low' : 'hunt-high', side: story.badge === 'LONG' ? 'buy' : 'sell' }
          : story.line1 === 'Distribution at highs' ? { key: 'distribution', side: 'sell' }
            : null;
  if (!kind) return;

  const label = alertLabel(symbol);
  const tf = tfShort(ALERT_TF_MINUTES);
  const barKey = bar.time;
  if (!canFireAlert(`${symbol}:story:${kind.key}:${barKey}`, 120_000)) return;

  pushFpAlert({
    id: `${symbol}-${kind.key}-${barKey}`,
    symbol,
    kind: kind.key,
    side: kind.side,
    title: `${label} · ${story.line1}`,
    detail: `${story.line2 || 'setup'} · ${tf} · range expanding`,
    at: Date.now(),
  });
}

function setupAlertUi() {
  if (alertUiBound) return;
  alertUiBound = true;
  const bell = document.getElementById('alert-bell');
  const panel = document.getElementById('alert-panel');
  const clearBtn = document.getElementById('alert-clear');
  const list = document.getElementById('alert-list');
  const toasts = document.getElementById('alert-toasts');
  bell?.addEventListener('click', (e) => {
    e.stopPropagation();
    panel?.classList.toggle('hidden');
  });
  clearBtn?.addEventListener('click', () => {
    sessionAlerts.length = 0;
    renderAlertList();
  });
  list?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-alert-symbol]');
    if (!row) return;
    openAlertSymbol(row.dataset.alertSymbol);
  });
  toasts?.addEventListener('click', (e) => {
    const toast = e.target.closest('[data-alert-symbol]');
    if (!toast) return;
    openAlertSymbol(toast.dataset.alertSymbol);
  });
  document.addEventListener('click', (e) => {
    if (!panel || panel.classList.contains('hidden')) return;
    if (panel.contains(e.target) || bell?.contains(e.target)) return;
    panel.classList.add('hidden');
  });
}

function openAlertSymbol(symbol) {
  if (!symbol) return;
  selectedSymbol = symbol;
  const card = document.getElementById(`fp-card-${symbol}`);
  if (card) {
    document.querySelectorAll('.fp-card.focus').forEach((el) => el.classList.remove('focus'));
    card.classList.add('focus');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  document.getElementById('alert-panel')?.classList.add('hidden');
}

function renderAlertList() {
  const list = document.getElementById('alert-list');
  const count = document.getElementById('alert-count');
  if (count) count.textContent = String(sessionAlerts.length);
  if (!list) return;
  if (!sessionAlerts.length) {
    list.innerHTML = '<div class="alert-empty">No alerts yet — ping only when the 1h range is expanding</div>';
    return;
  }
  list.innerHTML = sessionAlerts.map((a) => `
    <button type="button" class="alert-row ${a.side}" data-alert-symbol="${a.symbol}">
      <span class="alert-row-kind">${a.kind}</span>
      <span class="alert-row-title">${escapeHtml(a.title)}</span>
      <span class="alert-row-detail">${escapeHtml(a.detail)}</span>
      <span class="alert-row-time">${fmtTime(a.at)}</span>
    </button>
  `).join('');
}

function showAlertToast(alert) {
  const host = document.getElementById('alert-toasts');
  if (!host) return;
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `alert-toast ${alert.side}`;
  el.dataset.alertSymbol = alert.symbol;
  el.innerHTML = `
    <span class="alert-toast-kind">${alert.kind}</span>
    <span class="alert-toast-title">${escapeHtml(alert.title)}</span>
    <span class="alert-toast-detail">${escapeHtml(alert.detail)}</span>
  `;
  host.prepend(el);
  while (host.children.length > 5) host.lastChild?.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 280);
  }, ALERT_TOAST_MS);
}

// ═══════ End Footprint Chart ═══════

async function init() {
  setupTabs();
  setupDataMode();
  setupAlertUi();
  try {
    config = await fetch('/api/config').then((r) => r.json());
    fpHistoryEnabled = Boolean(config.history?.enabled);
    fpRetentionDays = Number(config.history?.retentionDays) || 30;
    imbalanceRatio = Number(config.imbalanceRatio) || 3;
    if ($('imb-ratio') !== _noopEl) $('imb-ratio').value = String(imbalanceRatio);
    if (config.coins?.length) selectedSymbol = config.coins[0].symbol;
    applyDataMode(config.market === 'spot' ? 'spot' : 'perp');
  } catch {
    initChart();
  }
  renderAlertList();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  fpLiveSocket = ws;

  ws.onopen = () => {
    setStatus(true, 'Live');
    subscribeFootprint();
  };
  ws.onclose = () => setStatus(false, 'Reconnecting…');
  ws.onerror = () => setStatus(false, 'Connection error');

  ws.onmessage = (msg) => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch {
      return;
    }

    switch (ev.type) {
      case 'status': {
        const m = ev.market === 'spot' ? 'spot' : 'perp';
        feedStatus[m] = { connected: Boolean(ev.connected), message: ev.message ?? '' };
        refreshStatus();
        break;
      }
      case 'trade':
        if (ev.trade && ev.market) ev.trade.market = ev.market;
        if (ev.trade) noteLivePrice(ev.trade.symbol, ev.trade.price);
        ingestTradeToChart(ev.trade);
        if (ev.trade?.symbol) scheduleDraw(ev.trade.symbol);
        break;
      case 'footprint_live':
        applyLiveFootprint(ev);
        break;
      case 'footprint_tick':
        applyFootprintTick(ev);
        break;
      case 'spot_flow':
        ingestSpotFlow(ev.snapshot);
        break;
      case 'summary':
        if (ev.summary && ev.market) ev.summary.market = ev.market;
        updateSummary(ev.summary);
        if (ev.summary?.symbol) scheduleDraw(ev.summary.symbol);
        break;
      case 'overview':
        updateOverview(ev.coins, ev.market === 'spot' ? 'spot' : 'perp');
        break;
      default:
        break;
    }
  };
}

init();
