const $ = (id) => document.getElementById(id);

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
let lastDailySignal = null;
let dailySignalReq = 0;
let dailySignalTimer = null;
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
  '1D': 'this daily bar',
};

const DAILY_SETUP_META = {
  SUPPORT_HOLD: 'Support is holding',
  RESISTANCE_REJECT: 'Resistance is rejecting',
  BREAKOUT_UP: 'Holding above resistance',
  BREAKDOWN: 'Trading below support',
  FLOW_CONTINUATION: 'Daily flow continuation',
  MID_RANGE: 'No daily level in play',
  INSUFFICIENT: 'Not enough daily history',
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
  const lev = leverageForUsd(trade.symbol, trade.quoteValue);
  const levHtml = lev
    ? `<span class="lev lev-${levBand(lev.maxLev)}" title="${levTitle(trade.quoteValue, lev)}">${levLabel(lev)}</span>`
    : '<span class="lev lev-high">—</span>';
  const ex = tradeExchange(trade);
  const exLabel = EX_SHORT[ex] ?? ex;
  div.innerHTML =
    `<span class="time">${fmtTime(trade.timestamp)}</span>` +
    `<span class="ex-badge" title="${ex}">${exLabel}</span>` +
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

function fmtMovePrice(p) {
  if (!Number.isFinite(p)) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (p >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return p.toPrecision(4);
}

const booksBySymbol = {};
const liqEstBySymbol = {};
const liqAnchor = { symbol: '', mid: 0 };
const liqHits = {};
let liqEstTimer = null;

function quoteOf(level) {
  if (Number.isFinite(level.quoteValue) && level.quoteValue > 0) return level.quoteValue;
  const p = Number(level.price);
  const q = Number(level.quantity ?? level.qty);
  return p > 0 && q > 0 ? p * q : 0;
}

function bandStep(mid) {
  if (mid >= 10_000) return Math.max(25, Math.round(mid * 0.0015));
  if (mid >= 100) return Math.max(0.5, mid * 0.002);
  if (mid >= 1) return mid * 0.003;
  return mid * 0.004;
}

function bookNear(levels, price, mid) {
  const band = Math.max(mid * 0.0025, bandStep(mid));
  let usd = 0;
  for (const lvl of levels ?? []) {
    if (Math.abs(Number(lvl.price) - price) <= band) usd += quoteOf(lvl);
  }
  return usd;
}

function liqWipeFrac(lev) {
  return 1 / Math.max(lev, 1);
}

function levSteps(maxLev) {
  const all = [125, 100, 75, 50, 25, 20, 10, 5];
  const out = all.filter((l) => l <= maxLev && l >= 5);
  if (maxLev >= 5 && !out.includes(maxLev)) out.unshift(maxLev);
  return [...new Set(out)].sort((a, b) => b - a).slice(0, 6);
}

function levWeight(lev, steps) {
  const raw = steps.map((l) => {
    if (l >= 75) return 0.08;
    if (l >= 50) return 0.14;
    if (l >= 25) return 0.18;
    if (l >= 20) return 0.16;
    if (l >= 10) return 0.22;
    return 0.22;
  });
  const i = steps.indexOf(lev);
  const sum = raw.reduce((s, x) => s + x, 0) || 1;
  return (raw[i] ?? 1) / sum;
}

function buildLevBands(mid, side, est, book) {
  const maxLev = levBrackets[selectedSymbol]?.max || 25;
  const steps = levSteps(maxLev);
  const ratio = side === 'ask' ? (est?.shortRatio ?? 0.5) : (est?.longRatio ?? 0.5);
  const oi = est?.oiUsd ?? 0;
  const levels = side === 'ask' ? book?.asks : book?.bids;
  return steps
    .map((lev) => {
      const dist = liqWipeFrac(lev);
      const price = side === 'ask' ? mid * (1 + dist) : mid * (1 - dist);
      const bookUsd = bookNear(levels, price, mid);
      const cluster = oi * ratio * levWeight(lev, steps) * 0.1;
      return {
        price,
        lev,
        wipe: dist,
        usd: cluster,
        book: bookUsd,
      };
    })
    .filter((r) => r.price > 0)
    .sort((a, b) => (side === 'ask' ? a.price - b.price : b.price - a.price));
}

function fmtGapPct(gap) {
  if (!(gap > 0)) return '0%';
  const pct = gap * 100;
  return `${pct.toFixed(2)}%`;
}

function tagBandState(row, now, side) {
  const key = `${selectedSymbol}:${side}:${row.lev}`;
  const crossed = side === 'ask' ? now >= row.price : now <= row.price;
  const gap = Math.abs(now - row.price) / now;
  const orig = Math.abs((liqAnchor.mid || now) - row.price) / now;
  const close = !crossed && (gap <= 0.0025 || (orig > 0 && gap / orig <= 0.35));
  if (crossed) liqHits[key] = Date.now();
  const held = liqHits[key] && Date.now() - liqHits[key] < 20_000;
  if (crossed || held) return { ...row, side, gap, state: 'hit', label: 'LIQUIDATED' };
  if (close) return { ...row, side, gap, state: 'close', label: `${fmtGapPct(gap)} left` };
  return { ...row, side, gap, state: '', label: `${fmtGapPct(gap)} left` };
}

function forcedConfirms(side) {
  const w = lastSummary?.windows?.['10s'];
  if (!w) return false;
  const usd = side === 'ask' ? w.forcedBuyVolume : w.forcedSellVolume;
  return Number(usd) > 25_000;
}

function liveAbsorption() {
  if (selectedTf === '1D') {
    const abs = lastDailySignal?.flow?.absorbed;
    if (!abs) return null;
    const buyer = abs === 'BUYERS';
    return {
      buyer,
      title: buyer ? 'Buyer absorption' : 'Seller absorption',
      text: buyer
        ? 'Daily buyer absorption — aggressive buying, daily high still capping price'
        : 'Daily seller absorption — aggressive selling, daily low still holding',
    };
  }
  const w = lastSummary?.windows?.[selectedTf] || lastSummary?.windows?.['10s'];
  const a = w?.absorption;
  if (!a?.detected) return null;
  const buyer = a.type === 'BUYER_ABSORPTION';
  return {
    buyer,
    title: buyer ? 'Buyer absorption' : 'Seller absorption',
    text: buyer
      ? 'Buyer absorption — heavy buying, price not rising (sellers absorbing)'
      : 'Seller absorption — heavy selling, price not falling (buyers absorbing)',
  };
}

function renderLiqBands(el, rows, maxUsd) {
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div class="liq-empty">Waiting for open interest…</div>';
    return;
  }
  const peak = Math.max(maxUsd, 1);
  el.innerHTML = rows
    .map((r) => {
      const pct = Math.max(8, Math.round((r.usd / peak) * 100));
      const hot = r.usd >= peak * 0.6 && !r.state ? ' hot' : '';
      const who = r.side === 'ask' ? 'shorts' : 'longs';
      const tip = r.state === 'hit'
        ? `≤${r.lev}x ${who} LIQUIDATED at ${fmtMovePrice(r.price)} · est ${fmtUsd(r.usd)} from Binance OI`
        : `≤${r.lev}x ${who} · ${fmtGapPct(r.gap)} left · est ${fmtUsd(r.usd)} from OI${r.book > 0 ? ` · resting book ${fmtUsd(r.book)}` : ''}`;
      return `<div class="liq-band${hot}${r.state ? ` ${r.state}` : ''}" title="${tip}">
        <span class="px">${fmtMovePrice(r.price)}</span>
        <span class="lev">≤${r.lev}x</span>
        <span class="usd">${fmtUsd(r.usd)}</span>
        <span class="st">${r.label}</span>
        <span class="liq-heat"><i style="width:${pct}%"></i></span>
      </div>`;
    })
    .join('');
}

function renderLiqAlert(asks, bids) {
  const el = $('liq-alert');
  if (!el) return;
  const hits = [...asks, ...bids].filter((r) => r.state === 'hit');
  const rest = [...asks, ...bids].filter((r) => r.state !== 'hit').sort((a, b) => a.gap - b.gap);
  const sideWord = (r) => (r.side === 'ask' ? 'shorts' : 'longs');
  if (hits.length) {
    const r = hits.sort((a, b) => a.lev - b.lev)[0];
    el.className = 'liq-alert hit';
    el.textContent = `≤${r.lev}x ${sideWord(r)} LIQUIDATED at ${fmtMovePrice(r.price)}`;
    return;
  }
  if (rest[0]) {
    el.className = rest[0].state === 'close' ? 'liq-alert close' : 'liq-alert';
    el.textContent = `≤${rest[0].lev}x ${sideWord(rest[0])} · ${fmtGapPct(rest[0].gap)} left`;
    return;
  }
  el.className = 'liq-alert';
  el.textContent = 'Watching liquidation bands…';
}

function renderLiqAbs() {
  const el = $('liq-abs');
  if (!el) return;
  const abs = liveAbsorption();
  if (!abs) {
    el.className = 'liq-abs hidden';
    el.textContent = '';
    return;
  }
  el.className = `liq-abs ${abs.buyer ? 'buy' : 'sell'}`;
  el.textContent = abs.text;
}

function taggedLiqBands() {
  const book = booksBySymbol[selectedSymbol];
  const est = liqEstBySymbol[selectedSymbol];
  const now = lastSummary?.price || book?.mid || est?.price || 0;
  if (!now) return { now: 0, asks: [], bids: [] };
  if (liqAnchor.symbol !== selectedSymbol) {
    liqAnchor.symbol = selectedSymbol;
    liqAnchor.mid = now;
    for (const k of Object.keys(liqHits)) delete liqHits[k];
  } else if (Math.abs(now - liqAnchor.mid) / now > 0.035) {
    liqAnchor.mid = now;
    for (const k of Object.keys(liqHits)) if (k.startsWith(`${selectedSymbol}:`)) delete liqHits[k];
  }
  const center = liqAnchor.mid || now;
  const tagSide = (side) =>
    buildLevBands(center, side, est, book).map((r) => {
      const tagged = tagBandState(r, now, side);
      if (tagged.state !== 'hit' && forcedConfirms(side) && tagged.gap <= 0.004) {
        tagged.state = 'hit';
        tagged.label = 'LIQUIDATED';
        liqHits[`${selectedSymbol}:${side}:${r.lev}`] = Date.now();
      }
      return tagged;
    });
  return { now, asks: tagSide('ask'), bids: tagSide('bid') };
}

function renderLiquidityMap() {
  const { now, asks, bids } = taggedLiqBands();
  if (!now) {
    if ($('liq-now')) $('liq-now').textContent = '—';
    return;
  }
  const peak = Math.max(1, ...asks.map((r) => r.usd), ...bids.map((r) => r.usd));
  const est = liqEstBySymbol[selectedSymbol];
  const longPct = est?.longRatio > 0 ? ` · longs ${(est.longRatio * 100).toFixed(0)}%` : '';
  const oiTxt = est?.oiUsd ? ` · OI ${fmtUsd(est.oiUsd)}${longPct}` : '';
  if ($('liq-now')) $('liq-now').textContent = `now ${fmtMovePrice(now)}${oiTxt}`;
  renderLiqBands($('liq-asks'), asks, peak);
  renderLiqBands($('liq-bids'), bids, peak);
  renderLiqAlert(asks, bids);
  renderLiqAbs();
  scheduleFpLiqDraw();
}

function ingestBook(book) {
  if (!book?.symbol) return;
  if (book.market === 'spot') return;
  booksBySymbol[book.symbol] = book;
  if (book.symbol === selectedSymbol) renderLiquidityMap();
}

function levelsFromDepth(rows) {
  return (rows ?? [])
    .map((row) => {
      const price = Number(row[0] ?? row.price);
      const quantity = Number(row[1] ?? row.quantity);
      return { price, quantity, quoteValue: price * quantity };
    })
    .filter((l) => l.price > 0 && l.quantity > 0);
}

async function seedBook(symbol) {
  try {
    const data = await fetch(`/api/depth?symbol=${encodeURIComponent(symbol)}`).then((r) => r.json());
    if (symbol !== selectedSymbol || !data) return;
    const bids = levelsFromDepth(data.bids).sort((a, b) => b.price - a.price);
    const asks = levelsFromDepth(data.asks).sort((a, b) => a.price - b.price);
    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;
    ingestBook({
      symbol,
      bids,
      asks,
      mid: bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk,
    });
  } catch {
    /* ignore */
  }
}

async function loadLiqEstimate(symbol) {
  try {
    const data = await fetch(`/api/liq-estimate?symbol=${encodeURIComponent(symbol)}`).then((r) => r.json());
    if (symbol !== selectedSymbol || !data?.oiUsd) return;
    liqEstBySymbol[symbol] = data;
    renderLiquidityMap();
  } catch {
    /* ignore */
  }
}

function startLiqEstimateLoop() {
  if (liqEstTimer) clearInterval(liqEstTimer);
  loadLiqEstimate(selectedSymbol);
  liqEstTimer = setInterval(() => loadLiqEstimate(selectedSymbol), 30_000);
}

function renderMovePotential() {
  renderLiquidityMap();
}

function clearMovePotential() {
  liqAnchor.symbol = '';
  liqAnchor.mid = 0;
  for (const k of Object.keys(liqHits)) delete liqHits[k];
  if ($('liq-now')) $('liq-now').textContent = '—';
  if ($('liq-alert')) {
    $('liq-alert').className = 'liq-alert';
    $('liq-alert').textContent = 'Watching liquidation bands…';
  }
  if ($('liq-abs')) {
    $('liq-abs').className = 'liq-abs hidden';
    $('liq-abs').textContent = '';
  }
  if ($('liq-asks')) $('liq-asks').innerHTML = '<div class="liq-empty">Waiting for open interest…</div>';
  if ($('liq-bids')) $('liq-bids').innerHTML = '<div class="liq-empty">Waiting for open interest…</div>';
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
  clearMovePotential();
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
  document.querySelectorAll('.liq-only').forEach((el) => el.classList.toggle('hidden', spot));
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
  seedBook(selectedSymbol);
  startLiqEstimateLoop();
  renderSpotCompare();
  startDailySignalLoop();
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
  if (isSpotView() && config?.coins?.find((c) => c.symbol === symbol)?.venue === 'equity') {
    applyDataMode('perp');
  }
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

function startDailySignalLoop() {
  if (dailySignalTimer) clearInterval(dailySignalTimer);
  void loadDailySignal();
  dailySignalTimer = setInterval(() => void loadDailySignal(), 20_000);
}

async function loadDailySignal() {
  const symbol = selectedSymbol;
  const req = ++dailySignalReq;
  try {
    const params = new URLSearchParams({
      symbol,
      exchange: selectedExchange,
      market: footprintMarket(),
    });
    const data = await fetch(`/api/daily-signal?${params}`).then((r) => {
      if (!r.ok) throw new Error(`daily-signal ${r.status}`);
      return r.json();
    });
    if (req !== dailySignalReq || symbol !== selectedSymbol) return;
    lastDailySignal = data;
    renderDailySetup();
    if (selectedTf === '1D') {
      if (isSpotView()) updateSpotUi();
      else if (lastSummary) updateUi();
    }
    drawFootprint();
  } catch {
    if (req !== dailySignalReq) return;
    lastDailySignal = {
      bias: 'WAIT',
      setup: 'INSUFFICIENT',
      reason: 'Daily signal API is not running — restart npm start and refresh.',
      plan: {},
    };
    renderDailySetup();
  }
}

function renderDailySetup() {
  const sig = lastDailySignal;
  const bias = sig?.bias ?? 'WAIT';
  const setup = sig?.setup ?? 'INSUFFICIENT';
  const plan = sig?.plan ?? {};
  const title = DAILY_SETUP_META[setup] ?? String(setup).replace(/_/g, ' ');

  const biasEl = $('daily-bias');
  const titleEl = $('daily-setup-title');
  const helpEl = $('daily-setup-help');
  const levelsEl = $('daily-levels');
  if (biasEl) {
    biasEl.textContent = bias;
    biasEl.className = `daily-bias ${bias.toLowerCase()}`;
  }
  if (titleEl) titleEl.textContent = sig ? title : 'Waiting for daily structure…';
  if (helpEl) {
    if (!sig) helpEl.textContent = 'Footprint + support/resistance + live liquidity. TP is 1% then 2%.';
    else {
      const conf = Math.round((sig.confidence ?? 0) * 100);
      helpEl.textContent = `${sig.reason ?? ''} · ${conf}% confidence`;
    }
  }
  if (levelsEl) {
    const bits = [];
    if (sig?.levels?.support != null) bits.push(`<span class="sup">S ${fmtPrice(sig.levels.support)}</span>`);
    if (sig?.levels?.poc != null) bits.push(`<span class="poc">POC ${fmtPrice(sig.levels.poc)}</span>`);
    if (sig?.levels?.resistance != null) bits.push(`<span class="res">R ${fmtPrice(sig.levels.resistance)}</span>`);
    if (plan.tp1 != null) bits.push(`<span class="tp">TP1 ${fmtPrice(plan.tp1)}</span>`);
    if (plan.tp2 != null) bits.push(`<span class="tp">TP2 ${fmtPrice(plan.tp2)}</span>`);
    if (plan.sl != null) bits.push(`<span class="sl">SL ${fmtPrice(plan.sl)}</span>`);
    levelsEl.innerHTML = bits.join('');
  }

  const dsBias = $('ds-bias');
  const dsSetup = $('ds-setup');
  const dsReason = $('ds-reason');
  if (dsBias) {
    dsBias.textContent = bias;
    dsBias.className = `ds-bias ${bias.toLowerCase()}`;
  }
  if (dsSetup) dsSetup.textContent = sig ? title : 'Waiting for daily structure…';
  const setPlan = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value != null && Number.isFinite(value) ? `$${fmtPrice(value)}` : '—';
  };
  setPlan('ds-entry', plan.entry);
  setPlan('ds-tp1', plan.tp1);
  setPlan('ds-tp2', plan.tp2);
  setPlan('ds-sl', plan.sl);
  if (dsReason) {
    if (!sig) {
      dsReason.textContent = 'If this stays empty, restart the dashboard so /api/daily-signal is live.';
    } else if (bias === 'WAIT') {
      dsReason.textContent = sig.reason || 'No 1–2% setup — footprint, S/R, and liquidity are not aligned.';
    } else {
      dsReason.textContent = `${sig.reason} Entry now · TP1 1% · TP2 2%.`;
    }
  }
}

function renderDailyAsSignal(price, summary) {
  const sig = lastDailySignal;
  renderDailySetup();
  if ($('price')) $('price').textContent = price > 0 ? `$${fmtPrice(price)}` : '—';
  const coin = config?.coins?.find((c) => c.symbol === selectedSymbol);
  const venue = isSpotView()
    ? (selectedExchange === 'all' ? 'multi-exchange spot' : `${selectedExchange} spot`)
    : coin?.venue === 'equity'
      ? 'Binance equity perp'
      : selectedExchange === 'all'
        ? 'multi-exchange'
        : selectedExchange;
  if ($('symbol-label')) {
    $('symbol-label').textContent = `${coin?.label ?? selectedSymbol} · ${venue} · daily`;
  }
  const bias = sig?.bias ?? 'WAIT';
  const setup = sig?.setup ?? 'INSUFFICIENT';
  $('state-badge').textContent = bias === 'WAIT' ? 'NO DAILY EDGE' : `${bias} · ${String(setup).replace(/_/g, ' ')}`;
  $('state-badge').className = `state-badge ${bias === 'LONG' ? 'buy-flow' : bias === 'SHORT' ? 'sell-flow' : ''}`;
  $('state-title').textContent = DAILY_SETUP_META[setup] ?? 'Daily setup';
  $('state-help').textContent = sig?.reason
    ?? 'Daily bias waits until footprint, support/resistance, and liquidity agree.';
  const ch = sig?.flow?.todayChangePercent ?? 0;
  const chEl = $('price-change');
  if (chEl) {
    chEl.textContent = `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}% on the daily bar`;
    chEl.className = `price-change ${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}`;
  }
  $('flow-window-label').textContent = TF_LABEL['1D'];
  const delta = sig?.flow?.todayDelta ?? 0;
  $('delta').textContent = fmtUsd(delta);
  $('delta').className = `value ${delta >= 0 ? 'pos' : 'neg'}`;
  const dp = ((sig?.flow?.todayDeltaPercent ?? 0) * 100).toFixed(0);
  $('delta-pct').textContent = delta >= 0 ? `${dp}% buy-side dominance` : `${Math.abs(Number(dp))}% sell-side dominance`;
  $('score').textContent = String(sig?.score ?? 0);
  $('score').style.color = (sig?.score ?? 0) > 0 ? 'var(--buy)' : (sig?.score ?? 0) < 0 ? 'var(--sell)' : 'inherit';
  $('impact').textContent = (sig?.location ?? 'UNKNOWN').replace(/_/g, ' ');
  $('impact-help').textContent = sig?.pathOfLeastResistance
    ? `Path of least resistance ${sig.pathOfLeastResistance.toLowerCase()}`
    : 'Daily location vs support / resistance';
  $('confidence').textContent = sig ? `${Math.round(sig.confidence * 100)}%` : '—';
  $('flow-multiple').textContent = sig?.footprintComplete ? 'Daily footprint complete' : 'Using OHLC until footprint fills in';
  const buy = sig?.flow?.todayBuy ?? 0;
  const sell = sig?.flow?.todaySell ?? 0;
  const total = buy + sell || 1;
  $('buy-bar').style.width = `${(buy / total) * 100}%`;
  $('sell-bar').style.width = `${(sell / total) * 100}%`;
  $('buy-vol').textContent = fmtUsd(buy);
  $('sell-vol').textContent = fmtUsd(sell);
  const absBox = $('absorption-box');
  if (sig?.flow?.absorbed) {
    absBox.classList.remove('hidden');
    $('absorption-title').textContent = sig.flow.absorbed === 'SELLERS' ? 'SELLER ABSORPTION' : 'BUYER ABSORPTION';
    $('absorption-text').textContent = sig.flow.absorbed === 'SELLERS'
      ? 'Aggressive selling into the daily low, price holding — passive buyers absorbing.'
      : 'Aggressive buying into the daily high, price stalling — passive sellers absorbing.';
  } else {
    absBox.classList.add('hidden');
  }
  const w = summary?.windows?.['15m'] ?? summary?.windows?.['1m'] ?? summary?.windows?.['10s'];
  if (w) {
    renderFlowBattle(w);
    renderMovePotential(w.movePotential);
  }
  if (summary) renderCompare(summary);
  renderLiquidityResponse();
}

function updateUi() {
  if (isSpotView()) return;
  if (selectedTf === '1D') {
    if (lastSummary && lastSummary.symbol === selectedSymbol) {
      renderDailyAsSignal(lastSummary.price, lastSummary);
    } else {
      renderDailyAsSignal(lastDailySignal?.price ?? 0, null);
    }
    return;
  }
  if (!lastSummary || lastSummary.symbol !== selectedSymbol) return;
  const w = windowData(lastSummary, selectedTf);
  if (!w) return;

  const meta = STATE_META[w.state] ?? { title: w.state, help: '' };

  $('price').textContent = lastSummary.price > 0 ? `$${fmtPrice(lastSummary.price)}` : '—';
  const coin = config?.coins?.find((c) => c.symbol === lastSummary.symbol);
  const venue =
    coin?.venue === 'equity'
      ? 'Binance equity perp'
      : selectedExchange === 'all'
        ? 'multi-exchange'
        : selectedExchange;
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

  renderFlowBattle(w);
  renderMovePotential(w.movePotential);
  renderCompare(lastSummary);
  renderLiquidityResponse();
  renderDailySetup();
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
    drawFootprint();
  });
}

function applyDataMode(mode) {
  if (mode !== 'perp' && mode !== 'spot' && mode !== 'compare') return;
  if (mode !== 'perp' && coinIsEquity()) {
    const first = config?.crypto?.[0] ?? config?.coins?.find((c) => c.venue !== 'equity');
    if (first) openTab(first.symbol, first.label);
  }
  dataMode = mode;
  document.querySelectorAll('#data-mode-tabs [data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  const spot = isSpotView();
  $('chart-title').textContent = mode === 'perp'
    ? 'Order flow footprint'
    : mode === 'compare'
      ? 'Spot vs futures footprint'
      : 'Spot order flow footprint';
  $('chart-hint').textContent = mode === 'perp'
    ? 'Red left = sells, green right = buys. Lines are liquidation levels — remaining % until hit, then LIQUIDATED. Gold = absorption. All combines CEX + Hyperliquid + dYdX + Bitstamp.'
    : 'Red left = aggressive spot sells, green right = aggressive spot buys. Executed volume only — resting book is hatched, not counted as volume. All = Binance + Bybit + OKX + Bitstamp.';
  $('imb-cfg')?.classList.toggle('hidden', !spot);
  $('spot-hud')?.classList.toggle('hidden', !spot);
  $('move-panel')?.classList.toggle('hidden', spot);
  $('spot-compare-panel')?.classList.toggle('hidden', mode !== 'compare');
  document.querySelector('.asset-nav .asset-row:nth-child(2)')?.classList.toggle('hidden', spot);
  const coin = config?.coins?.find((c) => c.symbol === selectedSymbol);
  const venue = selectedExchange === 'all' ? (spot ? 'multi-exchange spot' : 'multi-exchange') : selectedExchange;
  $('symbol-label').textContent = `${coin?.label ?? selectedSymbol.replace('USDT', '')} · ${venue}`;
  refreshStatus();
  applySymbolFilter();
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
  if (selectedTf === '1D') {
    renderDailyAsSignal(snap.price, null);
    renderSpotHud(snap);
    renderSpotCompare();
    renderLiquidityResponse();
    return;
  }
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
  renderDailySetup();
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
  $('tf-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tf-tab');
    if (!btn) return;
    selectedTf = btn.dataset.tf;
    document.querySelectorAll('.tf-tab').forEach((b) => b.classList.toggle('active', b === btn));
    updateUi();
  });
}

// ═══════ Footprint / Order Flow Chart (canvas-based) ═══════

const CHART_TFS = [1, 5, 15, 30, 45, 60, 120, 240, 1440];
let chartTfMinutes = 1;
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
let fpLastLiveMinute = 0;
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

let fpLiqDrawTimer = null;
function scheduleFpLiqDraw() {
  if (fpLiqDrawTimer) return;
  fpLiqDrawTimer = setTimeout(() => {
    fpLiqDrawTimer = null;
    drawFootprint();
  }, 250);
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
    renderLiquidityResponse();
    void loadDailySignal();
  });
  document.getElementById('chart-ex-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ex]');
    if (!btn || btn.disabled) return;
    selectedExchange = btn.dataset.ex;
    syncExchangeTabs();
    snapChartToLive();
    seedFootprintKlines();
    subscribeFootprint();
    renderTape();
    void loadDailySignal();
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
 * Loads stored footprint history for the active symbol/timeframe.
 * The server rolls bars up and stops at the current minute, which the live
 * WS bar then completes — so the two sources never double-count.
 */
async function loadFootprintHistory() {
  const tf = chartTfMinutes;
  const symbol = selectedSymbol;
  const exchange = selectedExchange;
  const req = ++fpHistoryReq;
  try {
    const params = new URLSearchParams({
      symbol,
      exchange,
      tf: String(tf),
      limit: '1500',
      days: String(fpRetentionDays),
      market: footprintMarket(),
    });
    const data = await fetch(`/api/footprint?${params}`).then((r) => r.json());
    if (req !== fpHistoryReq) return;
    if (!data?.enabled) {
      fpHistoryEnabled = false;
      seedFromKlines();
      return;
    }
    const map = new Map();
    for (const w of data.bars ?? []) map.set(w.t, wireBarToFp(w));
    fpHistoryStore[historyKey(symbol, tf, exchange)] = map;
  } catch {
    /* keep whatever history we already had */
  }
  if (req === fpHistoryReq) drawFootprint();
}

function seedFootprintKlines() {
  if (fpHistoryEnabled) {
    void loadFootprintHistory();
    return;
  }
  void seedFromKlines();
}

async function seedFromKlines() {
  const tf = chartTfMinutes;
  const symbol = selectedSymbol;
  const exchange = klineExchange();
  if (tf < 15) {
    drawFootprint();
    return;
  }
  const req = ++fpKlineReq;
  try {
    const rows = await fetch(
      `/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${fpKlineInterval(tf)}&exchange=${encodeURIComponent(exchange)}&market=${encodeURIComponent(footprintMarket())}`,
    ).then((r) => r.json());
    if (req !== fpKlineReq || symbol !== selectedSymbol || tf !== chartTfMinutes || klineExchange() !== exchange) return;
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
    const seed = getFpKlineSeed(symbol, tf, exchange);
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
  const seed = fpHistoryEnabled
    ? getFpHistory(symbol, tf, selectedExchange)
    : tf >= 15
      ? getFpKlineSeed(symbol, tf)
      : new Map();
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
  // With persistence on, the server owns the live bar and pushes the complete
  // footprint. The tape is filtered to large prints, so building from it here
  // would understate volume and fight the server's bar. Spot always uses the
  // server aggregator for the same reason.
  if (fpHistoryEnabled || isSpotView()) return;
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
  if (!bar.levels.has(lk)) bar.levels.set(lk, { price: level, buy: 0, sell: 0 });
  const lv = bar.levels.get(lk);
  if (trade.side === 'BUY') { lv.buy += trade.quoteValue; bar.totalBuy += trade.quoteValue; }
  else { lv.sell += trade.quoteValue; bar.totalSell += trade.quoteValue; }
  if (trade.symbol === selectedSymbol && tradeMatchesExchange(trade)) {
    drawFootprint();
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

function liveFlowBattle() {
  return lastSummary?.windows?.[selectedTf]?.flowBattle
    ?? lastSummary?.windows?.['10s']?.flowBattle
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

function drawBattleHud(ctx, leftPad, plotRight) {
  ctx.font = 'bold 11px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let text;
  let color = '#8b949e';
  if (isSpotView()) {
    const w = lastSpotFlow ? spotWindow(lastSpotFlow) : null;
    if (w) {
      color = w.flow?.includes('BUY') ? '#22c55e' : w.flow?.includes('SELL') ? '#ef4444' : '#8b949e';
      const flags = (w.flags ?? []).slice(0, 2).map((f) => f.replace(/_/g, ' ')).join(' · ');
      text = `${(w.flow ?? 'BALANCED').replace(/_/g, ' ')}  ·  Δ ${fmtUsd(w.delta)}  ·  ${w.efficiency?.rank ?? ''}${w.efficiency?.effortVsResult ? ' · ' + w.efficiency.effortVsResult.replace(/_/g, ' ') : ''}${flags ? '  ·  ' + flags : ''}`;
    } else {
      text = 'Spot flow waiting…';
    }
  } else {
    const b = liveFlowBattle();
    if (b?.winner?.winner) {
      const w = b.winner.winner;
      color = w.includes('PASSIVE_SELL') ? '#fbbf24'
        : w.includes('PASSIVE_BUY') ? '#60a5fa'
        : w.includes('AGGRESSIVE_BUY') ? '#22c55e'
        : w.includes('AGGRESSIVE_SELL') ? '#ef4444'
        : '#8b949e';
      const ab = Math.round(b.battle?.aggressiveBuyerStrength ?? 0);
      const ps = Math.round(b.battle?.passiveSellerStrength ?? 0);
      const as = Math.round(b.battle?.aggressiveSellerStrength ?? 0);
      const pb = Math.round(b.battle?.passiveBuyerStrength ?? 0);
      text = `${battleLabel(w)}  ·  agg buy ${ab} vs pas sell ${ps}   agg sell ${as} vs pas buy ${pb}`;
    } else {
      text = 'Flow battle waiting…';
    }
  }
  ctx.fillStyle = 'rgba(13, 17, 23, 0.88)';
  ctx.fillRect(leftPad, 18, Math.min(plotRight - leftPad, 720), 16);
  ctx.fillStyle = color;
  ctx.fillText(text, leftPad + 4, 26);
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
  const topPad = 38;
  const bottomPad = isSpotView() ? 72 : 44;
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
  const liqOverlay = isSpotView() ? { asks: [], bids: [], now: 0 } : taggedLiqBands();
  const lastPx = visible[visible.length - 1]?.close || liqOverlay.now;
  if (lastPx > 0) {
    for (const r of [...liqOverlay.asks, ...liqOverlay.bids]) {
      if (Math.abs(r.price - lastPx) / lastPx > 0.03) continue;
      if (r.price > globalHigh) globalHigh = r.price;
      if (r.price < globalLow) globalLow = r.price;
    }
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
  drawBattleHud(ctx, leftPad, plotRight);

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
    const barWin = fpBarWinner(bar);
    if (barWin.short) {
      ctx.fillStyle = barWin.color;
      ctx.fillRect(x, topPad, 2, chartH);
    }
    const engineAbs = lastSummary?.windows?.[selectedTf]?.absorption?.type
      ?? lastSummary?.windows?.['10s']?.absorption?.type;
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

      const pasSell = (barWin.id === 'PASSIVE_SELLERS' || engineAbs === 'BUYER_ABSORPTION')
        && lv.buy >= lv.sell * 1.4 && lv.buy > maxVol * 0.12;
      const pasBuy = (barWin.id === 'PASSIVE_BUYERS' || engineAbs === 'SELLER_ABSORPTION')
        && lv.sell >= lv.buy * 1.4 && lv.sell > maxVol * 0.12;
      if (pasSell) {
        ctx.fillStyle = 'rgba(251, 191, 36, 0.28)';
        ctx.fillRect(cellX + half, y - rh / 2, half - 1, rh);
        ctx.strokeStyle = '#fbbf24';
        ctx.strokeRect(cellX + half, y - rh / 2 + 0.5, half - 1, rh - 1);
      } else if (pasBuy) {
        ctx.fillStyle = 'rgba(96, 165, 250, 0.28)';
        ctx.fillRect(cellX + 1, y - rh / 2, half - 1, rh);
        ctx.strokeStyle = '#60a5fa';
        ctx.strokeRect(cellX + 1, y - rh / 2 + 0.5, half - 1, rh - 1);
      }

      const imbBuy = lv.buy >= lv.sell * imbalanceRatio && lv.buy > maxVol * 0.15;
      const imbSell = lv.sell >= lv.buy * imbalanceRatio && lv.sell > maxVol * 0.15;
      if (imbBuy && !pasSell) {
        ctx.strokeStyle = '#22c55e';
        ctx.strokeRect(cellX + half, y - rh / 2 + 0.5, half - 1, rh - 1);
      } else if (imbSell && !pasBuy) {
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

    if (i === visible.length - 1 && pan < 0.15) {
      drawLiveLiquidityMarks(ctx, { cellX, half, cellW, yForPrice, rh, topPad, chartH });
    }

    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8b949e';
    const d = new Date(bar.time * 1000);
    const cx = x + barWidth / 2;
    let timeLabel;
    if (chartTfMinutes >= 1440) {
      timeLabel = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    } else {
      timeLabel = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    }
    ctx.fillText(timeLabel, cx, topPad + chartH + 13);

    const delta = bar.totalBuy - bar.totalSell;
    const barUsd = bar.totalBuy + bar.totalSell;
    if (barUsd > 0) {
      const cx = x + barWidth / 2;
      if (isSpotView()) {
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.fillStyle = '#86efac';
        ctx.fillText(`+${fmtVolLabel(bar.totalBuy)} A.BUY`, cx, topPad + chartH + 24);
        ctx.fillStyle = '#fca5a5';
        ctx.fillText(`-${fmtVolLabel(bar.totalSell)} A.SELL`, cx, topPad + chartH + 36);
        ctx.fillStyle = delta >= 0 ? '#22c55e' : '#ef4444';
        ctx.fillText(`Δ ${delta >= 0 ? '+' : '-'}${fmtVolLabel(Math.abs(delta))}  VOL ${fmtVolLabel(barUsd)}`, cx, topPad + chartH + 48);
      } else {
        const barLev = leverageForUsd(selectedSymbol, barUsd);
        const win = fpBarWinner(bar);
        ctx.fillStyle = win.short ? win.color : (delta >= 0 ? '#22c55e' : '#ef4444');
        ctx.font = 'bold 10px JetBrains Mono, monospace';
        const deltaLabel = `${delta >= 0 ? '+' : '-'}${fmtVolLabel(Math.abs(delta))}${win.short ? ` ${win.short}` : ''}${barLev ? ` ${levLabel(barLev)}` : ''}`;
        ctx.fillText(deltaLabel, cx, topPad + chartH + 27);
      }
    }
  }

  const liveBar = visible[visible.length - 1];
  updateFpLevNow((liveBar?.totalBuy ?? 0) + (liveBar?.totalSell ?? 0), liveBar);
  if (!isSpotView()) {
    drawLiqOverlay(ctx, {
      leftPad,
      plotRight,
      yForPrice,
      topPad,
      chartH,
      globalHigh,
      globalLow,
      overlay: liqOverlay,
    });
  }
  drawDailySrOverlay(ctx, {
    leftPad,
    plotRight,
    yForPrice,
    topPad,
    chartH,
    globalHigh,
    globalLow,
  });

  ctx.lineWidth = 1;
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

function drawLiqOverlay(ctx, { leftPad, plotRight, yForPrice, topPad, chartH, globalHigh, globalLow, overlay }) {
  const rows = [...(overlay?.asks ?? []), ...(overlay?.bids ?? [])];
  if (!rows.length) return;
  ctx.save();
  ctx.font = 'bold 10px JetBrains Mono, monospace';
  ctx.textBaseline = 'middle';
  let lastY = -99;
  const sorted = rows
    .filter((r) => r.price >= globalLow && r.price <= globalHigh)
    .sort((a, b) => b.price - a.price);
  for (const r of sorted) {
    const y = yForPrice(r.price);
    if (y < topPad + 2 || y > topPad + chartH - 2) continue;
    const isAsk = r.side === 'ask';
    const color = r.state === 'hit' ? '#fb7185' : r.state === 'close' ? '#fbbf24' : isAsk ? '#f87171' : '#4ade80';
    ctx.strokeStyle = color;
    ctx.lineWidth = r.state === 'hit' ? 2 : r.state === 'close' ? 1.6 : 1;
    ctx.setLineDash(r.state ? [] : [5, 4]);
    ctx.globalAlpha = r.state === 'hit' ? 0.95 : 0.7;
    ctx.beginPath();
    ctx.moveTo(leftPad, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    if (Math.abs(y - lastY) < 11) continue;
    lastY = y;
    const tag = r.state === 'hit' ? `≤${r.lev}x LIQUIDATED` : `≤${r.lev}x ${fmtGapPct(r.gap)} left`;
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    const tw = ctx.measureText(tag).width;
    ctx.fillStyle = 'rgba(13, 17, 23, 0.82)';
    ctx.fillRect(leftPad + 2, y - 7, tw + 8, 14);
    ctx.fillStyle = color;
    ctx.fillText(tag, leftPad + 6, y);
  }
  const now = overlay?.now;
  if (now > 0 && now >= globalLow && now <= globalHigh) {
    const y = yForPrice(now);
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(leftPad, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
  }
  const abs = liveAbsorption();
  if (abs && now > 0 && now >= globalLow && now <= globalHigh) {
    const y = yForPrice(now);
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = abs.buyer ? '#22c55e' : '#fbbf24';
    ctx.fillRect(leftPad, y - 10, plotRight - leftPad, 20);
    ctx.globalAlpha = 1;
    ctx.font = 'bold 10px JetBrains Mono, monospace';
    ctx.fillStyle = abs.buyer ? '#86efac' : '#fbbf24';
    ctx.textAlign = 'center';
    ctx.fillText(abs.title.toUpperCase(), (leftPad + plotRight) / 2, y);
  }
  ctx.restore();
}

function drawDailySrOverlay(ctx, { leftPad, plotRight, yForPrice, topPad, chartH, globalHigh, globalLow }) {
  const levels = lastDailySignal?.levels ?? {};
  const plan = lastDailySignal?.plan ?? {};
  const rows = [
    levels.support != null ? { price: levels.support, label: 'S', color: '#4ade80', dash: [6, 4] } : null,
    levels.resistance != null ? { price: levels.resistance, label: 'R', color: '#f87171', dash: [6, 4] } : null,
    levels.poc != null ? { price: levels.poc, label: 'POC', color: '#fbbf24', dash: [2, 3] } : null,
    plan.tp1 != null ? { price: plan.tp1, label: 'TP1 1%', color: '#22c55e', dash: [4, 3] } : null,
    plan.tp2 != null ? { price: plan.tp2, label: 'TP2 2%', color: '#86efac', dash: [2, 3] } : null,
    plan.sl != null ? { price: plan.sl, label: 'SL', color: '#fb7185', dash: [3, 3] } : null,
  ].filter(Boolean);
  if (!rows.length) return;
  ctx.save();
  ctx.font = 'bold 10px JetBrains Mono, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const r of rows) {
    if (r.price < globalLow || r.price > globalHigh) continue;
    const y = yForPrice(r.price);
    if (y < topPad + 2 || y > topPad + chartH - 2) continue;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.78;
    ctx.setLineDash(r.dash);
    ctx.beginPath();
    ctx.moveTo(leftPad, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const tag = `${r.label} ${fmtPrice(r.price)}`;
    const tw = ctx.measureText(tag).width;
    ctx.fillStyle = 'rgba(13, 17, 23, 0.82)';
    ctx.fillRect(plotRight - tw - 10, y - 7, tw + 8, 14);
    ctx.fillStyle = r.color;
    ctx.fillText(tag, plotRight - 6, y);
  }
  ctx.restore();
}

function updateFpLevNow(flowUsd, liveBar) {
  const el = document.getElementById('fp-lev-now');
  if (!el) return;
  const tf = tfShort(chartTfMinutes);
  if (isSpotView()) {
    const buy = liveBar?.totalBuy ?? 0;
    const sell = liveBar?.totalSell ?? 0;
    const delta = buy - sell;
    el.textContent = `${tf} spot · buy ${fmtUsd(buy)} · sell ${fmtUsd(sell)} · Δ ${fmtUsd(delta)}`;
    el.className = `fp-lev-now ${delta >= 0 ? 'lev-10' : 'lev-high'}`;
    el.title = 'Executed aggressive spot volume in the visible live candle';
    return;
  }
  const spec = levBrackets[selectedSymbol];
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

function subscribeFootprint() {
  if (fpLiveSocket?.readyState !== WebSocket.OPEN) return;
  if (!fpHistoryEnabled && !isSpotView()) return;
  fpLiveSocket.send(JSON.stringify({
    type: 'sub_footprint',
    symbol: selectedSymbol,
    exchange: selectedExchange,
    market: footprintMarket(),
  }));
}

/**
 * Applies the server's in-progress 1m bar. Only the current minute is kept:
 * once it closes it belongs to persisted history, so we refetch instead of
 * holding it locally and counting it twice.
 */
function applyLiveFootprint(ev) {
  const liveOk = fpHistoryEnabled || ev.market === 'spot' || isSpotView();
  if (!liveOk || ev.symbol !== selectedSymbol) return;
  if (ev.market && ev.market !== footprintMarket()) return;
  const bars = ev.bars ?? [];
  if (!bars.length) return;

  const minute = bars[0].bar.t;
  if (minute !== fpLastLiveMinute) {
    fpLastLiveMinute = minute;
    for (const key of Object.keys(footprintStore)) delete footprintStore[key];
    void loadFootprintHistory();
  }

  for (const { exchange, bar } of bars) {
    const store = getFootprintStore(ev.symbol, 1, exchange);
    store.clear();
    store.set(bar.t, wireBarToFp(bar));
  }
  drawFootprint();
}

// ═══════ End Footprint Chart ═══════

async function init() {
  setupTabs();
  setupDataMode();
  initChart();
  try {
    config = await fetch('/api/config').then((r) => r.json());
    fpHistoryEnabled = Boolean(config.history?.enabled);
    fpRetentionDays = Number(config.history?.retentionDays) || 30;
    imbalanceRatio = Number(config.imbalanceRatio) || 3;
    if ($('imb-ratio')) $('imb-ratio').value = String(imbalanceRatio);
    if (config.coins?.length) {
      selectedSymbol = config.coins[0].symbol;
      renderCoinBar(config.coins);
      openTab(config.coins[0].symbol, config.coins[0].label);
    }
    renderTierLegend();
    applyDataMode(config.market === 'spot' ? 'spot' : 'perp');
    $('symbol-label').textContent = `${selectedSymbol.replace('USDT', '')} · ${config.market}`;
  } catch { /* ignore */ }
  await loadLeverageBrackets();
  startLiqEstimateLoop();
  seedFootprintKlines();
  drawFootprint();
  renderTape();
  startDailySignalLoop();

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
        addTapeRow(ev.trade);
        ingestTradeToChart(ev.trade);
        break;
      case 'footprint_live':
        applyLiveFootprint(ev);
        break;
      case 'spot_flow':
        ingestSpotFlow(ev.snapshot);
        break;
      case 'summary':
        if (ev.summary && ev.market) ev.summary.market = ev.market;
        updateSummary(ev.summary);
        break;
      case 'overview':
        updateOverview(ev.coins, ev.market === 'spot' ? 'spot' : 'perp');
        break;
      case 'book':
        ingestBook(ev);
        break;
      case 'move_potential': {
        if (ev.market && ev.market !== footprintMarket()) break;
        const events = ev.events ?? [];
        if (!events.length) break;
        addEvent({
          kind: 'move',
          symbol: ev.symbol,
          title: `${ev.symbol.replace('USDT', '')} ${events[0].replace(/_/g, ' ').toLowerCase()}`,
          detail: events.map((e) => e.replace(/_/g, ' ').toLowerCase()).join(' · '),
          cls: events.some((e) => e.includes('ASK') || e.includes('UPSIDE')) ? 'buy' : 'sell',
        });
        break;
      }
      case 'large_trade': {
        if (ev.market && ev.market !== footprintMarket()) break;
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
        if (ev.market && ev.market !== footprintMarket()) break;
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
        if (ev.market && ev.market !== footprintMarket()) break;
        addEvent({
          kind: 'burst',
          symbol: ev.symbol,
          title: `${ev.symbol.replace('USDT', '')} ${ev.side} burst`,
          detail: `${fmtUsd(ev.totalQuoteValue)} across ${ev.tradeCount} prints in ${(ev.durationMs / 1000).toFixed(1)}s — possible split order`,
          cls: ev.side === 'BUY' ? 'buy' : 'sell',
        });
        break;
      case 'alert':
        if (ev.market && ev.market !== footprintMarket()) break;
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
