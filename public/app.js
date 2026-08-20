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
const booksBySymbol = {};
const BOOK_LEVELS = 12;
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

let levBrackets = {};

function leverageForUsd(symbol, usd) {
  const spec = levBrackets[symbol];
  if (!spec?.brackets?.length || !Number.isFinite(usd) || usd <= 0) return null;
  const b = spec.brackets.find((x) => usd >= x.floor && usd < x.cap) ?? spec.brackets[spec.brackets.length - 1];
  return {
    minLev: b.minLev,
    maxLev: b.maxLev,
    margin: usd / Math.max(b.maxLev, 1),
    symbolMax: spec.max,
  };
}

function levBand(maxLev) {
  if (maxLev >= 75) return 'high';
  if (maxLev >= 50) return '50';
  if (maxLev >= 25) return '25';
  if (maxLev >= 10) return '10';
  return 'whale';
}

function levColor(maxLev) {
  if (maxLev >= 75) return '#8b949e';
  if (maxLev >= 50) return '#fbbf24';
  if (maxLev >= 25) return '#fb923c';
  if (maxLev >= 10) return '#f87171';
  return '#c084fc';
}

function levLabel(info) {
  return info ? `≤${info.maxLev}x` : '—';
}

function levTitle(usd, info) {
  if (!info) return 'Leverage brackets not loaded yet';
  return `${fmtUsd(usd)} notional fits Binance’s ${info.minLev}–${info.maxLev}x bracket (max ≤${info.maxLev}x). Margin at that max ≈ ${fmtUsd(info.margin)}. Public trades do not include the trader’s actual leverage.`;
}

async function loadLeverageBrackets() {
  try {
    levBrackets = await fetch('/api/leverage-brackets').then((r) => r.json());
  } catch {
    levBrackets = {};
  }
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
  const lev = leverageForUsd(trade.symbol, trade.quoteValue);
  const levHtml = lev
    ? `<span class="lev lev-${levBand(lev.maxLev)}" title="${levTitle(trade.quoteValue, lev)}">${levLabel(lev)}</span>`
    : '<span class="lev lev-high">—</span>';
  div.innerHTML =
    `<span class="time">${fmtTime(trade.timestamp)}</span>` +
    `<span class="action"><span class="action-main side-${trade.side.toLowerCase()}">${sideLabel}</span><span class="action-sub">${sideSub}</span></span>` +
    `<span class="price">${fmtPrice(trade.price)}</span>` +
    `<span class="notional">${fmtUsd(trade.quoteValue)}</span>` +
    levHtml +
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

function updateBook(book) {
  if (!book?.symbol) return;
  booksBySymbol[book.symbol] = book;
  if (book.symbol === selectedSymbol) {
    updateBookLegend(book);
    applySupportResistance(book, false);
  }
}

function updateBookLegend(book) {
  const spread = book.spread ?? 0;
  const spreadPct = book.mid ? (spread / book.mid) * 100 : 0;
  const bidTotal = book.bidTotal ?? 0;
  const askTotal = book.askTotal ?? 0;
  const tot = bidTotal + askTotal || 1;
  const bidPct = Math.round((bidTotal / tot) * 100);
  if ($('book-spread')) {
    $('book-spread').textContent = `spread ${fmtBookPrice(spread)} (${spreadPct.toFixed(4)}%)`;
  }
  if ($('book-imbalance')) {
    $('book-imbalance').textContent = bidPct >= 50 ? `${bidPct}% bid heavy` : `${100 - bidPct}% ask heavy`;
    $('book-imbalance').className = bidPct >= 50 ? 'book-imbalance pos' : 'book-imbalance neg';
  }
}

function fmtBookPrice(p) {
  if (!Number.isFinite(p)) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(8);
}

function fmtCompact(qty) {
  const abs = Math.abs(qty);
  const trim = (v, d = 2) => v.toFixed(d).replace(/\.?0+$/, '');
  if (abs >= 1e9) return `${trim(qty / 1e9)}B`;
  if (abs >= 1e6) return `${trim(qty / 1e6)}M`;
  if (abs >= 1e3) return `${trim(qty / 1e3)}K`;
  if (abs >= 1) return trim(qty, 2);
  return trim(qty, 4);
}

let tvChart = null;
let tvSeries = null;
let tvReady = false;
let tvKlineReq = 0;
let tvLastSr = 0;
let tvSrSymbol = '';
let depthTimer = null;
let pendingSrBook = null;
const tvPriceLines = [];
const tvLastCandle = {};
const WALL_COUNT = 12;
let lastSrWalls = [];
let lastSrWallsSymbol = '';

let tvTfMinutes = 15;

function tvIntervalParam() {
  if (tvTfMinutes === 1440) return '1d';
  if (tvTfMinutes === 240) return '4h';
  if (tvTfMinutes === 60) return '1h';
  if (tvTfMinutes === 45) return '15m';
  return `${tvTfMinutes}m`;
}

function tvIntervalSeconds() {
  return (tvTfMinutes === 45 ? 45 : tvTfMinutes) * 60;
}

function decimalsFor(price) {
  if (price >= 1000) return 2;
  if (price >= 1) return 3;
  if (price >= 0.1) return 4;
  if (price >= 0.01) return 5;
  if (price >= 0.0001) return 6;
  return 8;
}

function makeCandleSeries() {
  return tvChart.addCandlestickSeries({
    upColor: '#0ecb81',
    downColor: '#f6465d',
    borderVisible: false,
    wickUpColor: '#0ecb81',
    wickDownColor: '#f6465d',
  });
}

function resetTvSeries() {
  clearTvPriceLines();
  if (tvChart && tvSeries) {
    try {
      tvChart.removeSeries(tvSeries);
    } catch {
      /* ignore */
    }
  }
  if (tvChart) tvSeries = makeCandleSeries();
}

function initTvChart() {
  const wrap = $('tv-price-chart');
  if (!wrap || !window.LightweightCharts) return;

  tvChart = LightweightCharts.createChart(wrap, {
    width: Math.max(wrap.clientWidth, 320),
    height: Math.max(wrap.clientHeight, 440),
    layout: {
      background: { color: '#141820' },
      textColor: '#848e9c',
      fontFamily: 'Inter, system-ui, sans-serif',
    },
    grid: {
      vertLines: { color: '#1e2430' },
      horzLines: { color: '#1e2430' },
    },
    rightPriceScale: { borderColor: '#1e2430' },
    timeScale: { borderColor: '#1e2430', timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });
  tvSeries = makeCandleSeries();

  const resize = () => {
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w < 80 || h < 80) return;
    tvChart.applyOptions({ width: w, height: h });
  };
  new ResizeObserver(resize).observe(wrap);
  window.addEventListener('resize', resize);
  loadTvCandles();
  startDepthPoll();

  document.getElementById('sr-tf-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-stf]');
    if (!btn) return;
    tvTfMinutes = Number(btn.dataset.stf);
    document.querySelectorAll('#sr-tf-tabs .chart-tf-tab').forEach((b) => b.classList.toggle('active', b === btn));
    loadTvCandles();
  });
}

function clearTvPriceLines() {
  if (!tvSeries) return;
  for (const line of tvPriceLines.splice(0)) {
    try {
      tvSeries.removePriceLine(line);
    } catch {
      /* series may have been reset */
    }
  }
}

function aggregateToMinutes(candles, minutes) {
  const bucket = minutes * 60;
  const map = new Map();
  for (const c of candles) {
    const t = c.time - (c.time % bucket);
    const prev = map.get(t);
    if (!prev) {
      map.set(t, { time: t, open: c.open, high: c.high, low: c.low, close: c.close });
    } else {
      prev.high = Math.max(prev.high, c.high);
      prev.low = Math.min(prev.low, c.low);
      prev.close = c.close;
    }
  }
  return [...map.values()];
}

async function loadTvCandles() {
  if (!tvChart) return;
  const req = ++tvKlineReq;
  const symbol = selectedSymbol;
  const tf = tvTfMinutes;
  tvReady = false;
  tvLastSr = 0;
  tvSrSymbol = '';
  pendingSrBook = booksBySymbol[symbol] ?? null;
  resetTvSeries();

  try {
    const [rowRes, depthRes] = await Promise.all([
      fetch(`/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${tvIntervalParam()}`).then((r) => r.json()),
      fetch(`/api/depth?symbol=${encodeURIComponent(symbol)}`).then((r) => r.json()).catch(() => null),
    ]);
    if (req !== tvKlineReq || symbol !== selectedSymbol || tf !== tvTfMinutes) return;

    const rows = rowRes;
    if (!Array.isArray(rows) || !rows.length) return;

    let candles = rows
      .map((k) => ({
        time: Math.floor(Number(k[0]) / 1000),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
      }))
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.close));
    if (tvTfMinutes === 45) candles = aggregateToMinutes(candles, 45);
    if (!candles.length) return;

    tvSeries.setData(candles);
    tvLastCandle[`${symbol}_${tf}`] = candles[candles.length - 1] ?? null;

    const ref = candles[candles.length - 1].close;
    const precision = decimalsFor(ref);
    tvSeries.applyOptions({
      priceFormat: {
        type: 'price',
        precision,
        minMove: Number((10 ** -precision).toFixed(precision)),
      },
    });

    tvChart.timeScale().fitContent();
    tvReady = true;

    if (depthRes?.bids) {
      const toLevels = (rowsIn) =>
        (rowsIn ?? [])
          .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
          .filter((l) => l.price > 0 && l.quantity > 0);
      const bids = toLevels(depthRes.bids).sort((a, b) => b.price - a.price);
      const asks = toLevels(depthRes.asks).sort((a, b) => a.price - b.price);
      const bestBid = bids[0]?.price ?? 0;
      const bestAsk = asks[0]?.price ?? 0;
      const book = {
        symbol,
        bids,
        asks,
        mid: bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk,
        spread: bestBid && bestAsk ? bestAsk - bestBid : 0,
        bidTotal: bids.reduce((s, l) => s + l.quantity, 0),
        askTotal: asks.reduce((s, l) => s + l.quantity, 0),
      };
      booksBySymbol[symbol] = book;
      updateBookLegend(book);
      pendingSrBook = book;
    }

    const book = booksBySymbol[selectedSymbol] ?? pendingSrBook;
    requestAnimationFrame(() => {
      if (req !== tvKlineReq) return;
      applySupportResistance(book, true);
    });
  } catch {
    tvReady = req === tvKlineReq;
  }
}

function ingestTradeToTv(trade) {
  if (!tvReady || !tvSeries || trade.symbol !== selectedSymbol) return;
  const key = `${trade.symbol}_${tvTfMinutes}`;
  const bucket = Math.floor(Date.now() / 1000 / tvIntervalSeconds()) * tvIntervalSeconds();
  let c = tvLastCandle[key];
  if (c && bucket < c.time) return;
  if (!c || bucket > c.time) {
    c = { time: bucket, open: trade.price, high: trade.price, low: trade.price, close: trade.price };
  } else {
    c = {
      ...c,
      close: trade.price,
      high: Math.max(c.high, trade.price),
      low: Math.min(c.low, trade.price),
    };
  }
  tvLastCandle[key] = c;
  try {
    tvSeries.update(c);
  } catch {
    /* ignore */
  }
}

function startDepthPoll() {
  if (depthTimer) clearInterval(depthTimer);
  pullDepth();
  depthTimer = setInterval(pullDepth, 250);
}

async function pullDepth() {
  const symbol = selectedSymbol;
  try {
    const data = await fetch(`/api/depth?symbol=${encodeURIComponent(symbol)}`).then((r) => r.json());
    if (symbol !== selectedSymbol || !data?.bids) return;
    const toLevels = (rows) =>
      (rows ?? [])
        .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
        .filter((l) => l.price > 0 && l.quantity > 0);
    const bids = toLevels(data.bids).sort((a, b) => b.price - a.price);
    const asks = toLevels(data.asks).sort((a, b) => a.price - b.price);
    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;
    updateBook({
      symbol,
      bids,
      asks,
      mid: bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk,
      spread: bestBid && bestAsk ? bestAsk - bestBid : 0,
      bidTotal: bids.reduce((s, l) => s + l.quantity, 0),
      askTotal: asks.reduce((s, l) => s + l.quantity, 0),
    });
  } catch {
    /* ignore */
  }
}

function withCumulative(levels) {
  let running = 0;
  return levels.map((l, i) => {
    running += l.quantity;
    return { ...l, idx: i + 1, cumulative: running };
  });
}

function srWallsFromBook(book) {
  if (!book) return [];
  const bids = withCumulative([...(book.bids ?? [])].sort((a, b) => b.price - a.price));
  const asks = withCumulative([...(book.asks ?? [])].sort((a, b) => a.price - b.price));
  const mid = book.mid || 0;
  const toWalls = (rows, side) =>
    rows
      .filter((l) => (side === 'bid' ? l.price < mid : l.price > mid))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, WALL_COUNT)
      .map((l) => ({
        price: l.price,
        color: side === 'bid' ? '#0ecb81' : '#f6465d',
        title: `L${l.idx} · ${fmtBookPrice(l.price)} · ${fmtCompact(l.quantity)} · Σ${fmtCompact(l.cumulative)}`,
        short: `L${l.idx} ${fmtCompact(l.quantity)}`,
      }));
  return [...toWalls(bids, 'bid'), ...toWalls(asks, 'ask')];
}

function applySupportResistance(book, force = false) {
  if (!book || book.symbol !== selectedSymbol) {
    if (book) pendingSrBook = book;
    return;
  }
  const now = Date.now();
  if (!force && tvSrSymbol === selectedSymbol && now - tvLastSr < 250) return;
  tvLastSr = now;
  tvSrSymbol = selectedSymbol;
  lastSrWalls = srWallsFromBook(book);
  lastSrWallsSymbol = book.symbol;

  if (!tvReady || !tvSeries) {
    pendingSrBook = book;
    return;
  }

  clearTvPriceLines();
  const Dashed = LightweightCharts.LineStyle?.Dashed ?? 2;
  for (const level of lastSrWalls) {
    try {
      tvPriceLines.push(
        tvSeries.createPriceLine({
          price: level.price,
          color: level.color,
          lineWidth: 2,
          lineStyle: Dashed,
          axisLabelVisible: true,
          title: level.title,
        }),
      );
    } catch {
      /* ignore */
    }
  }
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
  lastSrWalls = [];
  lastSrWallsSymbol = '';
  document.querySelectorAll('.coin-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.symbol === selectedSymbol);
  });
  lastSummary = summaries[selectedSymbol] ?? null;
  if (lastSummary) updateUi();
  else clearMainPanels();
  renderTape();
  renderEvents();
  loadTvCandles();
  startDepthPoll();
  rebuildChart();
  seedFootprintKlines();
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
  $('symbol-label').textContent = `${coin?.label ?? lastSummary.symbol} · ${venue} · tape ≥ ${fmtUsd(coin?.minUsd ?? 0)}${levBrackets[lastSummary.symbol]?.max ? ` · max ${levBrackets[lastSummary.symbol].max}x` : ''}`;
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

const CHART_TFS = [1, 5, 15, 30, 45, 60, 120, 240];
let chartTfMinutes = 1;
const footprintStore = {};
const fpKlineSeed = {};
let fpKlineReq = 0;
let fpCanvas = null;
let fpCtx = null;
/** Bars back from the live (right) edge. 0 = latest candle pinned right. */
let fpPanBars = 0;
let fpDragging = false;
let fpDragLastX = 0;

function fpLayout(cssWidth) {
  const leftPad = 8;
  const priceAxisWidth = 72;
  const candleW = 7;
  const cellW = 108;
  const gap = 6;
  const barWidth = candleW + cellW;
  const stride = barWidth + gap;
  const availW = Math.max(1, cssWidth - priceAxisWidth - leftPad);
  const visibleBars = Math.max(1, Math.floor(availW / stride));
  return { leftPad, priceAxisWidth, candleW, cellW, barWidth, gap, stride, visibleBars };
}

function clampFpPan(storeSize, cssWidth) {
  const { visibleBars } = fpLayout(cssWidth);
  const maxPan = Math.max(0, storeSize - visibleBars);
  fpPanBars = Math.max(0, Math.min(fpPanBars, maxPan));
  return maxPan;
}

function cssChartWidth() {
  if (!fpCanvas) return 0;
  return fpCanvas.width / devicePixelRatio;
}

function snapChartToLive() {
  fpPanBars = 0;
  drawFootprint();
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
    const bars = footprintBars(selectedSymbol);
    const { stride } = fpLayout(W);
    fpPanBars += (e.deltaX + e.deltaY) / stride;
    clampFpPan(bars.length, W);
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
    const bars = footprintBars(selectedSymbol);
    const { stride } = fpLayout(W);
    fpPanBars += (e.clientX - fpDragLastX) / stride;
    fpDragLastX = e.clientX;
    clampFpPan(bars.length, W);
    drawFootprint();
  });
  const endDrag = () => {
    fpDragging = false;
    if (fpCanvas) fpCanvas.style.cursor = 'grab';
  };
  fpCanvas.addEventListener('pointerup', endDrag);
  fpCanvas.addEventListener('pointercancel', endDrag);

  document.getElementById('chart-tf-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ctf]');
    if (!btn) return;
    chartTfMinutes = Number(btn.dataset.ctf);
    document.querySelectorAll('#chart-tf-tabs .chart-tf-tab').forEach((b) => b.classList.toggle('active', b === btn));
    snapChartToLive();
    seedFootprintKlines();
  });
  document.getElementById('chart-live-btn')?.addEventListener('click', snapChartToLive);
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

function getFootprintStore(symbol, tf = chartTfMinutes) {
  const key = `${symbol}_${tf}`;
  if (!footprintStore[key]) footprintStore[key] = new Map();
  return footprintStore[key];
}

function getFpKlineSeed(symbol, tf = chartTfMinutes) {
  const key = `${symbol}_${tf}`;
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
    totalBuy: bar.totalBuy,
    totalSell: bar.totalSell,
    levels,
  };
}

function fpKlineInterval(tf = chartTfMinutes) {
  if (tf === 240) return '4h';
  if (tf === 120) return '2h';
  if (tf === 60) return '1h';
  if (tf === 45) return '15m';
  return `${tf}m`;
}

async function seedFootprintKlines() {
  const tf = chartTfMinutes;
  const symbol = selectedSymbol;
  if (tf < 15) {
    drawFootprint();
    return;
  }
  const req = ++fpKlineReq;
  try {
    const rows = await fetch(
      `/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${fpKlineInterval(tf)}`,
    ).then((r) => r.json());
    if (req !== fpKlineReq || symbol !== selectedSymbol || tf !== chartTfMinutes) return;
    if (!Array.isArray(rows) || !rows.length) {
      drawFootprint();
      return;
    }
    let candles = rows
      .map((k) => ({
        time: Math.floor(Number(k[0]) / 1000),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
      }))
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.close));
    if (tf === 45) candles = aggregateToMinutes(candles, 45);
    const seed = getFpKlineSeed(symbol, tf);
    seed.clear();
    for (const c of candles) {
      seed.set(c.time, {
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        levels: new Map(),
        totalBuy: 0,
        totalSell: 0,
      });
    }
  } catch {
    /* live 1m rollup still works */
  }
  if (req === fpKlineReq) drawFootprint();
}

function mergeFootprintBar(target, src) {
  target.high = Math.max(target.high, src.high);
  target.low = Math.min(target.low, src.low);
  target.close = src.close;
  target.totalBuy += src.totalBuy;
  target.totalSell += src.totalSell;
  for (const lv of src.levels.values()) {
    const k = lv.price.toFixed(6);
    if (!target.levels.has(k)) target.levels.set(k, { price: lv.price, buy: 0, sell: 0 });
    const d = target.levels.get(k);
    d.buy += lv.buy;
    d.sell += lv.sell;
  }
}

function aggregateFrom1m(symbol, tfMinutes) {
  const base = getFootprintStore(symbol, 1);
  const out = new Map();
  const bucket = tfMinutes * 60;
  for (const bar of base.values()) {
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
      });
    }
    mergeFootprintBar(out.get(t), bar);
  }
  return out;
}

function footprintBars(symbol = selectedSymbol, tf = chartTfMinutes) {
  const live = tf === 1
    ? getFootprintStore(symbol, 1)
    : aggregateFrom1m(symbol, tf);
  const seed = tf >= 15 ? getFpKlineSeed(symbol, tf) : new Map();
  if (seed.size === 0 && live.size === 0) return [];

  const out = new Map();
  for (const bar of seed.values()) out.set(bar.time, cloneFpBar(bar));
  for (const bar of live.values()) {
    if (!out.has(bar.time)) out.set(bar.time, cloneFpBar(bar));
    else mergeFootprintBar(out.get(bar.time), bar);
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
  const tick = tickSize(trade.price);
  const level = priceToTick(trade.price, tick);
  const lk = level.toFixed(6);
  const store = getFootprintStore(trade.symbol, 1);
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
  if (!bar.levels.has(lk)) bar.levels.set(lk, { price: level, buy: 0, sell: 0 });
  const lv = bar.levels.get(lk);
  if (trade.side === 'BUY') { lv.buy += trade.quoteValue; bar.totalBuy += trade.quoteValue; }
  else { lv.sell += trade.quoteValue; bar.totalSell += trade.quoteValue; }
  if (trade.symbol === selectedSymbol) {
    drawFootprint();
    ingestTradeToTv(trade);
  }
}

function displayBucket(high, low, chartH) {
  const raw = tickSize((high + low) / 2);
  const range = Math.max(high - low, raw);
  const maxRows = Math.max(8, Math.floor(chartH / 16));
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

function fmtPriceAxis(p) {
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(3);
  return p.toFixed(5);
}

function drawFootprint() {
  if (!fpCtx || !fpCanvas) return;
  const W = fpCanvas.width / devicePixelRatio;
  const H = fpCanvas.height / devicePixelRatio;
  const ctx = fpCtx;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  const liveBtn = document.getElementById('chart-live-btn');
  const bars = footprintBars(selectedSymbol);
  if (bars.length === 0) {
    liveBtn?.classList.add('hidden');
    ctx.fillStyle = '#8b949e';
    ctx.font = '13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for trades to build footprint…', W / 2, H / 2);
    if (chartTfMinutes >= 15) {
      ctx.font = '12px Inter, sans-serif';
      ctx.fillText('Loading candle history for this timeframe…', W / 2, H / 2 + 22);
    }
    updateFpLevNow(0);
    return;
  }

  const { leftPad, priceAxisWidth, candleW, cellW, barWidth, stride, visibleBars } = fpLayout(W);
  const topPad = 22;
  const bottomPad = 42;
  const chartH = H - topPad - bottomPad;
  clampFpPan(bars.length, W);
  liveBtn?.classList.toggle('hidden', fpPanBars < 0.15);

  const pan = Math.round(fpPanBars);
  const endIdx = bars.length - pan;
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
  let maxVol = 0;
  for (const levels of bucketed) {
    for (const lv of levels) {
      const v = lv.buy + lv.sell;
      if (v > maxVol) maxVol = v;
    }
  }

  ctx.textBaseline = 'middle';

  const plotRight = W - priceAxisWidth;
  const steps = Math.floor(priceRange / bucket);
  const labelEvery = Math.max(1, Math.floor(steps / 16));
  ctx.font = '10px JetBrains Mono, monospace';
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
    ctx.fillStyle = '#8b949e';
    ctx.fillText(fmtPriceAxis(p), W - 4, y);
  }

  ctx.font = '9px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ef5350';
  ctx.fillText('SELL', leftPad + 2, 10);
  ctx.fillStyle = '#22c55e';
  ctx.fillText('BUY', leftPad + 46, 10);
  if (fpPanBars >= 0.15) {
    ctx.fillStyle = '#8b949e';
    ctx.fillText('drag / scroll · Latest jumps to live', leftPad + 86, 10);
  }

  for (let i = 0; i < visible.length; i++) {
    const bar = visible[i];
    const levels = bucketed[i];
    const x = plotRight - (visible.length - i) * stride;
    const cellX = x + candleW + 2;
    const half = cellW / 2;
    const poc = levels.reduce((best, lv) => (lv.buy + lv.sell > best.vol ? { vol: lv.buy + lv.sell, price: lv.price } : best), { vol: 0, price: 0 });

    ctx.fillStyle = '#12171f';
    ctx.fillRect(cellX, topPad, cellW, chartH);

    const up = bar.close >= bar.open;
    const wickX = x + candleW / 2;
    ctx.strokeStyle = up ? '#22c55e' : '#ef4444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(wickX, yForPrice(bar.high));
    ctx.lineTo(wickX, yForPrice(bar.low));
    ctx.stroke();
    const bodyTop = yForPrice(Math.max(bar.open, bar.close));
    const bodyBot = yForPrice(Math.min(bar.open, bar.close));
    ctx.fillStyle = up ? '#22c55e' : '#ef4444';
    ctx.fillRect(x + 1, bodyTop, candleW - 2, Math.max(2, bodyBot - bodyTop));

    ctx.strokeStyle = '#2a3342';
    ctx.beginPath();
    ctx.moveTo(cellX + half, topPad);
    ctx.lineTo(cellX + half, topPad + chartH);
    ctx.stroke();

    const rh = Math.max(1, rowH - 1);
    for (const lv of levels) {
      const y = yForPrice(lv.price);
      const total = lv.buy + lv.sell;
      if (total <= 0) continue;
      const alpha = 0.12 + 0.55 * (total / Math.max(maxVol, 1));
      const buyWins = lv.buy >= lv.sell;
      ctx.fillStyle = buyWins ? `rgba(34, 197, 94, ${alpha})` : `rgba(239, 68, 68, ${alpha})`;
      ctx.fillRect(cellX + 1, y - rh / 2, cellW - 2, rh);
      const lev = leverageForUsd(selectedSymbol, total);
      if (lev && lev.maxLev <= 50) {
        ctx.fillStyle = levColor(lev.maxLev);
        ctx.fillRect(cellX + 1, y - rh / 2, 3, rh);
      }

      const imbBuy = lv.buy >= lv.sell * 3 && lv.buy > maxVol * 0.15;
      const imbSell = lv.sell >= lv.buy * 3 && lv.sell > maxVol * 0.15;
      if (imbBuy) {
        ctx.strokeStyle = '#22c55e';
        ctx.strokeRect(cellX + half, y - rh / 2 + 0.5, half - 1, rh - 1);
      } else if (imbSell) {
        ctx.strokeStyle = '#ef4444';
        ctx.strokeRect(cellX + 1, y - rh / 2 + 0.5, half - 1, rh - 1);
      }
      if (poc.vol > 0 && lv.price === poc.price) {
        ctx.strokeStyle = '#fbbf24';
        ctx.strokeRect(cellX + 1, y - rh / 2 + 0.5, cellW - 2, rh - 1);
      }

      if (rowH >= 13) {
        const fs = Math.min(10, Math.max(8, rowH - 6));
        ctx.font = `${fs}px JetBrains Mono, monospace`;
        ctx.fillStyle = lv.sell > 0 ? '#fca5a5' : '#4b5563';
        ctx.textAlign = 'right';
        ctx.fillText(lv.sell > 0 ? fmtVolShort(lv.sell) : '–', cellX + half - 4, y);
        ctx.fillStyle = lv.buy > 0 ? '#86efac' : '#4b5563';
        ctx.textAlign = 'left';
        ctx.fillText(lv.buy > 0 ? fmtVolShort(lv.buy) : '–', cellX + half + 4, y);
      }
    }

    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8b949e';
    const d = new Date(bar.time * 1000);
    const cx = x + barWidth / 2;
    ctx.fillText(`${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`, cx, topPad + chartH + 13);

    const delta = bar.totalBuy - bar.totalSell;
    const barUsd = bar.totalBuy + bar.totalSell;
    if (barUsd > 0) {
      const barLev = leverageForUsd(selectedSymbol, barUsd);
      ctx.fillStyle = delta >= 0 ? '#22c55e' : '#ef4444';
      ctx.font = 'bold 10px JetBrains Mono, monospace';
      const deltaLabel = `${delta >= 0 ? '+' : '-'}${fmtVolLabel(Math.abs(delta))}${barLev ? ` ${levLabel(barLev)}` : ''}`;
      ctx.fillText(deltaLabel, cx, topPad + chartH + 27);
    }
  }

  const liveBar = visible[visible.length - 1];
  updateFpLevNow((liveBar?.totalBuy ?? 0) + (liveBar?.totalSell ?? 0));

  ctx.lineWidth = 1;
}

function updateFpLevNow(flowUsd) {
  const el = document.getElementById('fp-lev-now');
  if (!el) return;
  const spec = levBrackets[selectedSymbol];
  const tf = chartTfMinutes % 60 === 0 ? `${chartTfMinutes / 60}h` : `${chartTfMinutes}m`;
  const info = leverageForUsd(selectedSymbol, flowUsd);
  if (info) {
    el.textContent = `${tf} flow ${fmtUsd(flowUsd)} · ${levLabel(info)} · margin ≈ ${fmtUsd(info.margin)} at that max`;
    el.className = `fp-lev-now lev-${levBand(info.maxLev)}`;
    el.title = levTitle(flowUsd, info);
  } else if (spec?.max) {
    el.textContent = `${tf} · symbol max ${spec.max}x · waiting for dollar flow`;
    el.className = 'fp-lev-now';
    el.title = '';
  } else {
    el.textContent = 'Leverage brackets loading…';
    el.className = 'fp-lev-now';
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
  snapChartToLive();
}

// ═══════ End Footprint Chart ═══════

async function init() {
  setupTabs();
  initChart();
  initTvChart();
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
  await loadLeverageBrackets();
  seedFootprintKlines();
  drawFootprint();
  renderTape();

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
      case 'book':
        updateBook(ev);
        break;
      case 'large_trade': {
        const lev = leverageForUsd(ev.symbol, ev.quoteValue);
        addEvent({
          kind: 'large',
          symbol: ev.symbol,
          title: `${ev.symbol.replace('USDT', '')} large ${ev.side} — ${fmtUsd(ev.quoteValue)}${lev ? ` · ${levLabel(lev)}` : ''}`,
          detail: `@ ${fmtPrice(ev.price)}${ev.tier ? ` · Tier ${ev.tier}` : ''}${ev.relativeClass !== 'NORMAL' ? ` · ${ev.relativeClass.replace('_', ' ')}` : ''}${lev ? ` · margin ≈ ${fmtUsd(lev.margin)} at ${levLabel(lev)}` : ''}`,
          cls: ev.side === 'BUY' ? 'buy' : 'sell',
        });
        break;
      }
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
