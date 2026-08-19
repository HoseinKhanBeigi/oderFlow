const $ = (id) => document.getElementById(id);

const MAX_TAPE = 150;
const MAX_EVENTS = 80;
let eventCount = 0;

let selectedTf = '10s';
let selectedSymbol = 'BTCUSDT';
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

function addTapeRow(trade) {
  if (!trade.symbol) return;
  if (seenTradeIds.has(trade.id)) return;
  seenTradeIds.add(trade.id);
  if (seenTradeIds.size > MAX_TAPE * 8) seenTradeIds.clear();

  const list = coinStore(tapeBySymbol, trade.symbol);
  list.unshift(trade);
  if (list.length > MAX_TAPE) list.length = MAX_TAPE;

  if (trade.symbol === selectedSymbol) appendTapeRow(trade);
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
  div.innerHTML =
    `<span class="time">${fmtTime(trade.timestamp)}</span>` +
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
  const list = tapeBySymbol[selectedSymbol] ?? [];
  for (const trade of list) container.appendChild(makeTapeRowEl(trade));
  $('tape-count').textContent = `${list.length} shown`;
}

const EVENT_ICONS = { burst: '⚡', alert: '⚠', large: '◆', state: '◉', absorption: '⊘', info: '·' };

function addEvent(opts) {
  if (!opts || !opts.symbol || opts.symbol === '*') return;

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
}

function applySymbolFilter() {
  document.querySelectorAll('.coin-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.symbol === selectedSymbol);
  });
  lastSummary = summaries[selectedSymbol] ?? null;
  if (lastSummary) updateUi();
  else clearMainPanels();
  renderTape();
  renderEvents();
  rebuildChart();
}

function chipHtml(c) {
  return `
    <button class="coin-chip ${c.symbol === selectedSymbol ? 'active' : ''}" data-symbol="${c.symbol}" type="button">
      <span class="coin-label">${c.label}</span>
      <span class="coin-delta" id="delta-${c.symbol}">—</span>
    </button>`;
}

function renderCoinBar(assets) {
  const crypto = assets.filter((c) => c.venue !== 'equity');
  const stocks = assets.filter((c) => c.venue === 'equity');
  $('crypto-bar').innerHTML = crypto.map(chipHtml).join('');
  $('stock-bar').innerHTML = stocks.map(chipHtml).join('');

  document.querySelector('.asset-nav')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.coin-chip');
    if (!chip) return;
    const sym = chip.dataset.symbol;
    const coin = config?.coins?.find((c) => c.symbol === sym);
    openTab(sym, coin?.label ?? sym.replace('USDT', ''));
  });
}

function openTab(symbol, label) {
  if (!openTabs.find((t) => t.symbol === symbol)) {
    openTabs.push({ symbol, label });
  }
  selectedSymbol = symbol;
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

function updateOverview(coins) {
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

function updateUi() {
  if (!lastSummary || lastSummary.symbol !== selectedSymbol) return;
  const w = windowData(lastSummary, selectedTf);
  if (!w) return;

  const meta = STATE_META[w.state] ?? { title: w.state, help: '' };

  $('price').textContent = lastSummary.price > 0 ? `$${fmtPrice(lastSummary.price)}` : '—';
  const coin = config?.coins?.find((c) => c.symbol === lastSummary.symbol);
  const venue =
    coin?.venue === 'equity' ? 'Binance equity perp' : lastSummary.market === 'perp' ? 'Binance perp' : lastSummary.market;
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

  renderCompare(lastSummary);
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

function updateSummary(s) {
  summaries[s.symbol] = s;
  if (s.symbol === selectedSymbol) {
    lastSummary = s;
    updateUi();
  }
}

function setStatus(connected, message) {
  const el = $('status');
  el.textContent = connected ? 'Live · Binance' : message;
  el.className = `status ${connected ? 'live' : message.includes('Connect') || message.includes('Reconnect') ? 'connecting' : 'offline'}`;
}

function setupTabs() {
  $('tf-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tf-tab');
    if (!btn) return;
    selectedTf = btn.dataset.tf;
    document.querySelectorAll('.tf-tab').forEach((b) => b.classList.toggle('active', b === btn));
    updateUi();
  });
}

// ═══════ Footprint / Order Flow Chart (canvas-based) ═══════

let chartTfMinutes = 1;
const footprintStore = {};
let fpCanvas = null;
let fpCtx = null;
/** How many bars back from live (right edge). 0 = latest candles. */
let fpPanBars = 0;
let fpDragging = false;
let fpDragLastX = 0;

function fpLayout(storeSize, cssWidth) {
  const leftPad = 10;
  const priceAxisWidth = 70;
  const barWidth = Math.max(90, Math.min(160, (cssWidth - 80) / 6));
  const gap = 6;
  const stride = barWidth + gap;
  const availW = Math.max(1, cssWidth - priceAxisWidth - leftPad);
  const visibleBars = Math.max(1, Math.floor(availW / stride));
  const maxPan = Math.max(0, storeSize - visibleBars);
  return { leftPad, priceAxisWidth, barWidth, gap, stride, availW, visibleBars, maxPan };
}

function clampFpPan(storeSize, cssWidth) {
  const { maxPan } = fpLayout(storeSize, cssWidth);
  fpPanBars = Math.max(0, Math.min(fpPanBars, maxPan));
  return maxPan;
}

function cssChartWidth() {
  if (!fpCanvas) return 0;
  return fpCanvas.width / devicePixelRatio;
}

function initChart() {
  const container = document.getElementById('tv-chart');
  if (!container) return;
  container.innerHTML = '';
  fpCanvas = document.createElement('canvas');
  fpCanvas.style.width = '100%';
  fpCanvas.style.height = '100%';
  fpCanvas.style.display = 'block';
  fpCanvas.style.position = 'absolute';
  fpCanvas.style.top = '0';
  fpCanvas.style.left = '0';
  fpCanvas.style.touchAction = 'none';
  fpCanvas.style.cursor = 'grab';
  container.appendChild(fpCanvas);
  resizeFpCanvas();
  window.addEventListener('resize', resizeFpCanvas);

  fpCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const W = cssChartWidth();
    const store = getFootprintStore(selectedSymbol);
    const { stride } = fpLayout(store.size, W);
    const axis = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : 0;
    // Scroll / swipe left → older bars. Scroll right → back to live.
    fpPanBars += -axis / stride;
    if (axis === 0 && e.shiftKey) fpPanBars += e.deltaY / stride;
    clampFpPan(store.size, W);
    drawFootprint();
  }, { passive: false });

  fpCanvas.addEventListener('pointerdown', (e) => {
    fpDragging = true;
    fpDragLastX = e.clientX;
    fpCanvas.setPointerCapture(e.pointerId);
    fpCanvas.style.cursor = 'grabbing';
  });
  fpCanvas.addEventListener('pointermove', (e) => {
    if (!fpDragging) return;
    const W = cssChartWidth();
    const store = getFootprintStore(selectedSymbol);
    const { stride } = fpLayout(store.size, W);
    fpPanBars += -(e.clientX - fpDragLastX) / stride;
    fpDragLastX = e.clientX;
    clampFpPan(store.size, W);
    drawFootprint();
  });
  const endDrag = () => {
    fpDragging = false;
    if (fpCanvas) fpCanvas.style.cursor = 'grab';
  };
  fpCanvas.addEventListener('pointerup', endDrag);
  fpCanvas.addEventListener('pointercancel', endDrag);

  document.getElementById('chart-tf-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.chart-tf-tab');
    if (!btn) return;
    chartTfMinutes = Number(btn.dataset.ctf);
    document.querySelectorAll('.chart-tf-tab').forEach((b) => b.classList.toggle('active', b === btn));
    fpPanBars = 0;
    drawFootprint();
  });
}

function resizeFpCanvas() {
  if (!fpCanvas) return;
  const rect = fpCanvas.parentElement.getBoundingClientRect();
  fpCanvas.width = rect.width * devicePixelRatio;
  fpCanvas.height = rect.height * devicePixelRatio;
  fpCtx = fpCanvas.getContext('2d');
  fpCtx.scale(devicePixelRatio, devicePixelRatio);
  drawFootprint();
}

function getFootprintStore(symbol) {
  const key = `${symbol}_${chartTfMinutes}`;
  if (!footprintStore[key]) footprintStore[key] = new Map();
  return footprintStore[key];
}

function fpCandleTime(ts) {
  const s = Math.floor(ts / 1000);
  return s - (s % (chartTfMinutes * 60));
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
  const store = getFootprintStore(trade.symbol);
  const t = fpCandleTime(trade.timestamp);
  if (!store.has(t)) {
    store.set(t, { time: t, open: trade.price, high: trade.price, low: trade.price, close: trade.price, levels: new Map(), totalBuy: 0, totalSell: 0 });
  }
  const bar = store.get(t);
  bar.high = Math.max(bar.high, trade.price);
  bar.low = Math.min(bar.low, trade.price);
  bar.close = trade.price;

  const tick = tickSize(trade.price);
  const level = priceToTick(trade.price, tick);
  const lk = level.toFixed(6);
  if (!bar.levels.has(lk)) bar.levels.set(lk, { price: level, buy: 0, sell: 0 });
  const lv = bar.levels.get(lk);
  if (trade.side === 'BUY') { lv.buy += trade.quoteValue; bar.totalBuy += trade.quoteValue; }
  else { lv.sell += trade.quoteValue; bar.totalSell += trade.quoteValue; }

  if (trade.symbol === selectedSymbol) drawFootprint();
}

function drawFootprint() {
  if (!fpCtx || !fpCanvas) return;
  const W = fpCanvas.width / devicePixelRatio;
  const H = fpCanvas.height / devicePixelRatio;
  const ctx = fpCtx;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  const store = getFootprintStore(selectedSymbol);
  if (store.size === 0) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for trades to build footprint…', W / 2, H / 2);
    return;
  }

  const bars = [...store.values()].sort((a, b) => a.time - b.time);
  const { leftPad, priceAxisWidth, barWidth, gap, visibleBars } = fpLayout(bars.length, W);
  const topPad = 28;
  const bottomPad = 36;
  const chartH = H - topPad - bottomPad;
  clampFpPan(bars.length, W);
  const endIdx = Math.max(visibleBars, Math.min(bars.length, bars.length - Math.round(fpPanBars)));
  const startIdx = Math.max(0, endIdx - visibleBars);
  const visible = bars.slice(startIdx, endIdx);

  if (visible.length === 0) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No footprint bars yet', W / 2, H / 2);
    return;
  }

  let globalHigh = -Infinity, globalLow = Infinity;
  for (const bar of visible) {
    if (bar.high > globalHigh) globalHigh = bar.high;
    if (bar.low < globalLow) globalLow = bar.low;
  }
  const tick = tickSize((globalHigh + globalLow) / 2);
  globalHigh = priceToTick(globalHigh, tick) + tick * 2;
  globalLow = priceToTick(globalLow, tick) - tick * 2;
  const priceRange = globalHigh - globalLow || 1;
  const numRows = Math.round(priceRange / tick);
  const rowH = chartH / Math.max(1, numRows);

  function yForPrice(p) {
    return topPad + ((globalHigh - p) / priceRange) * chartH;
  }

  let maxVol = 0;
  for (const bar of visible) {
    for (const lv of bar.levels.values()) {
      const v = Math.max(lv.buy, lv.sell);
      if (v > maxVol) maxVol = v;
    }
  }

  ctx.textBaseline = 'middle';

  // Draw price axis
  ctx.fillStyle = '#8b949e';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  const steps = Math.floor(priceRange / tick);
  const labelEvery = Math.max(1, Math.floor(steps / 18));
  for (let i = 0; i <= steps; i += labelEvery) {
    const p = globalLow + i * tick;
    const y = yForPrice(p);
    if (y < topPad || y > topPad + chartH) continue;
    ctx.fillText(p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p.toFixed(5), W - 3, y);
    ctx.strokeStyle = '#1c2128';
    ctx.beginPath();
    ctx.moveTo(leftPad, y);
    ctx.lineTo(W - priceAxisWidth, y);
    ctx.stroke();
  }

  // Draw bars
  for (let i = 0; i < visible.length; i++) {
    const bar = visible[i];
    const x = leftPad + i * (barWidth + gap) + gap;
    const halfBar = barWidth / 2;

    // Column background
    ctx.fillStyle = '#161b22';
    ctx.fillRect(x, topPad, barWidth, chartH);

    // Sell = left half, Buy = right half
    for (const lv of bar.levels.values()) {
      const y = yForPrice(lv.price);
      const maxBarW = halfBar - 2;
      const buyW = maxVol > 0 ? (lv.buy / maxVol) * maxBarW : 0;
      const sellW = maxVol > 0 ? (lv.sell / maxVol) * maxBarW : 0;
      const rh = rowH - 3;

      // Sell bar (left, grows leftward from center)
      if (sellW > 0) {
        const intense = lv.sell > maxVol * 0.5;
        ctx.fillStyle = intense ? '#e2b93d' : '#ef5350';
        ctx.globalAlpha = intense ? 1 : 0.7;
        ctx.fillRect(x + halfBar - sellW, y - rh / 2, sellW, rh);
        ctx.globalAlpha = 1;
      }
      // Buy bar (right, grows rightward from center)
      if (buyW > 0) {
        const intense = lv.buy > maxVol * 0.5;
        ctx.fillStyle = intense ? '#e2b93d' : '#26a69a';
        ctx.globalAlpha = intense ? 1 : 0.7;
        ctx.fillRect(x + halfBar, y - rh / 2, buyW, rh);
        ctx.globalAlpha = 1;
      }

      // Volume labels — only if row is tall enough to not overlap
      if (rowH >= 14) {
        ctx.font = `${Math.min(10, rowH - 4)}px JetBrains Mono, monospace`;
        if (lv.sell >= 500 && sellW > 12) {
          ctx.textAlign = 'left';
          ctx.fillStyle = '#fff';
          ctx.fillText(fmtVolShort(lv.sell), Math.max(x + 2, x + halfBar - sellW + 2), y);
        }
        if (lv.buy >= 500 && buyW > 12) {
          ctx.textAlign = 'left';
          ctx.fillStyle = '#fff';
          ctx.fillText(fmtVolShort(lv.buy), x + halfBar + 2, y);
        }
      }
    }

    // Center divider line
    ctx.strokeStyle = '#484f58';
    ctx.beginPath();
    ctx.moveTo(x + halfBar, topPad);
    ctx.lineTo(x + halfBar, topPad + chartH);
    ctx.stroke();

    // Column labels: SELL | BUY at top
    ctx.font = '9px Inter, sans-serif';
    ctx.fillStyle = '#ef5350';
    ctx.textAlign = 'right';
    ctx.fillText('SELL ←', x + halfBar - 3, topPad - 10);
    ctx.fillStyle = '#26a69a';
    ctx.textAlign = 'left';
    ctx.fillText('→ BUY', x + halfBar + 3, topPad - 10);

    // Time label at bottom
    ctx.fillStyle = '#8b949e';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    const d = new Date(bar.time * 1000);
    ctx.fillText(`${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`, x + halfBar, topPad + chartH + 14);

    // Net delta below time
    const delta = bar.totalBuy - bar.totalSell;
    ctx.fillStyle = delta >= 0 ? '#26a69a' : '#ef5350';
    ctx.font = 'bold 11px JetBrains Mono, monospace';
    const deltaLabel = delta >= 0 ? `+${fmtVolLabel(delta)}` : `-${fmtVolLabel(Math.abs(delta))}`;
    ctx.fillText(deltaLabel, x + halfBar, topPad + chartH + 28);
  }

  if (fpPanBars > 0.05) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('← older   ·   drag or scroll right to return to live', leftPad + 8, topPad + 12);
  }
}

function fmtVolLabel(v) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}

function fmtVolShort(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1_000)}K`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

function rebuildChart() {
  fpPanBars = 0;
  drawFootprint();
}

// ═══════ End Footprint Chart ═══════

async function init() {
  setupTabs();
  initChart();
  try {
    config = await fetch('/api/config').then((r) => r.json());
    if (config.coins?.length) {
      selectedSymbol = config.coins[0].symbol;
      renderCoinBar(config.coins);
      openTab(config.coins[0].symbol, config.coins[0].label);
    }
    renderTierLegend();
    $('symbol-label').textContent = `${selectedSymbol.replace('USDT', '')} · ${config.market}`;
  } catch { /* ignore */ }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => setStatus(true, 'Live');
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
      case 'status':
        setStatus(ev.connected, ev.message);
        break;
      case 'trade':
        addTapeRow(ev.trade);
        ingestTradeToChart(ev.trade);
        break;
      case 'summary':
        updateSummary(ev.summary);
        break;
      case 'overview':
        updateOverview(ev.coins);
        break;
      case 'large_trade':
        addEvent({
          kind: 'large',
          symbol: ev.symbol,
          title: `${ev.symbol.replace('USDT', '')} large ${ev.side} — ${fmtUsd(ev.quoteValue)}`,
          detail: `@ ${fmtPrice(ev.price)}${ev.tier ? ` · Tier ${ev.tier}` : ''}${ev.relativeClass !== 'NORMAL' ? ` · ${ev.relativeClass.replace('_', ' ')}` : ''}`,
          cls: ev.side === 'BUY' ? 'buy' : 'sell',
        });
        break;
      case 'state_change': {
        const meta = STATE_META[ev.state] ?? { title: ev.state, help: '' };
        addEvent({
          kind: ev.state.includes('ABSORPTION') ? 'absorption' : 'state',
          symbol: ev.symbol,
          title: `${ev.symbol.replace('USDT', '')} ${ev.window} → ${meta.title}`,
          detail: `${meta.help} Net delta ${fmtUsd(ev.delta)}.`,
          cls: stateClass(ev.state),
        });
        break;
      }
      case 'burst':
        addEvent({
          kind: 'burst',
          symbol: ev.symbol,
          title: `${ev.symbol.replace('USDT', '')} ${ev.side} burst`,
          detail: `${fmtUsd(ev.totalQuoteValue)} across ${ev.tradeCount} prints in ${(ev.durationMs / 1000).toFixed(1)}s — possible split order`,
          cls: ev.side === 'BUY' ? 'buy' : 'sell',
        });
        break;
      case 'alert':
        addEvent({
          kind: 'alert',
          symbol: ev.symbol,
          title: ev.alertType,
          detail: ev.message,
          cls: 'alert',
        });
        break;
    }
  };
}

init();
