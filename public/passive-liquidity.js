/**
 * Passive Liquidity panel.
 *
 * Book updates arrive far faster than a screen can usefully redraw, so incoming
 * snapshots only mutate state. Painting happens on a requestAnimationFrame loop
 * throttled to RENDER_MS, which keeps the data path and the render path
 * independent. Per-level history is pulled over HTTP for the visible symbol only.
 */

const RENDER_MS = 80;
const HEATMAP_POLL_MS = 1000;
const DEFAULT_SYMBOL = 'BTCUSDT';
const NET_WINDOWS = [
  { ms: 10_000, label: '10s' },
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '1m' },
  { ms: 300_000, label: '5m' },
  { ms: 900_000, label: '15m' },
];

const state = {
  snapshots: new Map(),
  coins: [],
  symbol: DEFAULT_SYMBOL,
  market: 'perp',
  selected: null,
  detail: null,
  dirty: false,
  lastRender: 0,
  rafId: 0,
  profileHitboxes: [],
  priceRange: null,
  netWindowMs: 10_000,
  netLiquidity: null,
  netRequest: 0,
};

const el = {};
let css = null;

function $(id) {
  return document.getElementById(id);
}

function palette() {
  if (css) return css;
  const s = getComputedStyle(document.body);
  const read = (name, fallback) => (s.getPropertyValue(name) || fallback).trim();
  css = {
    bid: read('--buy', '#22c55e'),
    ask: read('--sell', '#ef4444'),
    text: read('--text', '#eef0f3'),
    muted: read('--muted', '#7a8494'),
    accent: read('--accent', '#60a5fa'),
    warn: read('--warn', '#fbbf24'),
    border: read('--border', '#1c2230'),
    panel: read('--panel2', '#0d1015'),
    mono: read('--mono', 'monospace'),
  };
  return css;
}

function fmtUsd(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtQty(value) {
  const n = Number(value) || 0;
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function fmtPrice(value) {
  const n = Number(value) || 0;
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(6);
}

function fmtAge(ms) {
  const s = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}

function label(value) {
  return String(value ?? '—').replace(/_/g, ' ');
}

/** Levels are coloured by what is happening to them, not by an arbitrary ramp. */
function stateColor(levelState) {
  const c = palette();
  switch (levelState) {
    case 'WITHDRAWING':
    case 'UNRELIABLE':
      return c.warn;
    case 'BROKEN':
    case 'VACUUM':
      return c.muted;
    case 'DEFENDING':
    case 'ABSORBING':
    case 'REPLENISHING':
      return c.accent;
    default:
      return null;
  }
}

function stateTone(marketState) {
  const s = String(marketState ?? '');
  if (s.includes('ABSORPTION') || s.includes('DEFENDING')) return 'abs';
  if (s.includes('VACUUM')) return 'vac';
  if (s.includes('FLOOR') || s.includes('BUYERS')) return 'buy';
  if (s.includes('CEILING') || s.includes('SELLERS')) return 'sell';
  return '';
}

export function setPassiveMarket(market) {
  const next = market === 'spot' ? 'spot' : 'perp';
  if (next === state.market) return;
  state.market = next;
  state.netLiquidity = null;
  state.dirty = true;
}

/**
 * Replace the coin tabs from the live watchlist. Keeps BTC when still listed,
 * otherwise falls back to the first coin.
 */
export function setPassiveCoins(coins) {
  const list = Array.isArray(coins) ? coins.filter((c) => c?.symbol) : [];
  state.coins = list;
  const stillThere = list.some((c) => c.symbol === state.symbol);
  if (!stillThere) {
    const btc = list.find((c) => c.symbol === DEFAULT_SYMBOL);
    setPassiveSymbol(btc?.symbol ?? list[0]?.symbol ?? DEFAULT_SYMBOL);
  }
  renderCoinTabs();
}

export function setPassiveSymbol(symbol) {
  if (!symbol || symbol === state.symbol) {
    renderCoinTabs();
    return;
  }
  state.symbol = symbol;
  state.selected = null;
  state.detail = null;
  state.netLiquidity = null;
  state.dirty = true;
  renderCoinTabs();
  updateSymbolLabel();
}

export function ingestPassiveLiquidity(symbol, snapshot) {
  if (!symbol || !snapshot) return;
  state.snapshots.set(symbol, snapshot);
  if (symbol === state.symbol) state.dirty = true;
}

function current() {
  return state.symbol ? state.snapshots.get(state.symbol) ?? null : null;
}

/**
 * @param {{ getMarket?: () => string }} hooks
 *   Market follows the dashboard (perp/spot). Symbol is chosen from the
 *   watchlist tabs on this panel and defaults to BTCUSDT.
 */
export function initPassiveLiquidity(hooks = {}) {
  el.panel = $('pl-panel');
  if (!el.panel) return;
  state.getMarket = typeof hooks.getMarket === 'function' ? hooks.getMarket : null;
  el.state = $('pl-state');
  el.quality = $('pl-quality');
  el.symbol = $('pl-symbol');
  el.coinTabs = $('pl-coin-tabs');
  el.profile = $('pl-profile');
  el.bands = $('pl-bands');
  el.net = $('pl-net');
  el.sides = $('pl-sides');
  el.aggression = $('pl-aggression');
  el.walls = $('pl-walls');
  el.why = $('pl-why');
  el.level = $('pl-level');

  if (el.net) {
    el.net.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-net-window]');
      if (!btn) return;
      const windowMs = Number(btn.dataset.netWindow);
      if (!NET_WINDOWS.some((window) => window.ms === windowMs)) return;
      state.netWindowMs = windowMs;
      state.netLiquidity = null;
      state.dirty = true;
      void pollNetLiquidity();
    });
  }

  if (el.coinTabs) {
    el.coinTabs.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-pl-symbol]');
      if (!btn) return;
      setPassiveSymbol(btn.dataset.plSymbol);
    });
  }

  if (el.profile) {
    el.profile.addEventListener('click', onProfileClick);
    el.profile.addEventListener('mousemove', (ev) => {
      el.profile.style.cursor = hitTest(ev) ? 'pointer' : 'default';
    });
  }

  window.addEventListener('resize', () => {
    state.dirty = true;
  });

  renderCoinTabs();
  updateSymbolLabel();
  setInterval(pollNetLiquidity, HEATMAP_POLL_MS);
  loop();
}

function coinLabel(symbol) {
  const coin = state.coins.find((c) => c.symbol === symbol);
  return coin?.label ?? String(symbol).replace(/USDT$/i, '') ?? symbol;
}

function updateSymbolLabel() {
  if (el.symbol) el.symbol.textContent = coinLabel(state.symbol);
}

function renderCoinTabs() {
  if (!el.coinTabs) return;
  const coins = state.coins.length
    ? state.coins
    : [{ symbol: DEFAULT_SYMBOL, label: 'BTC' }];
  el.coinTabs.innerHTML = coins
    .map(
      (c) =>
        `<button class="chart-tf-tab${c.symbol === state.symbol ? ' active' : ''}" data-pl-symbol="${c.symbol}" type="button">${c.label ?? coinLabel(c.symbol)}</button>`,
    )
    .join('');
  updateSymbolLabel();
}

function loop() {
  state.rafId = requestAnimationFrame(loop);
  if (state.getMarket) setPassiveMarket(state.getMarket());
  const now = performance.now();
  if (!state.dirty || now - state.lastRender < RENDER_MS) return;
  state.lastRender = now;
  state.dirty = false;
  try {
    render();
  } catch (err) {
    console.error('[passive-liquidity] render failed:', err);
  }
}

async function pollNetLiquidity() {
  if (!state.symbol || !el.panel || el.panel.classList.contains('hidden')) return;
  const request = ++state.netRequest;
  const symbol = state.symbol;
  const market = state.market;
  const windowMs = state.netWindowMs;
  try {
    const params = new URLSearchParams({ symbol, market, windowMs: String(windowMs) });
    const res = await fetch(`/api/passive-liquidity/net?${params}`);
    const body = await res.json();
    if (request !== state.netRequest || symbol !== state.symbol || market !== state.market || windowMs !== state.netWindowMs) return;
    state.netLiquidity = body.netLiquidity ?? null;
    state.dirty = true;
  } catch {
    // Keep the last valid window on a transient request failure.
  }
}

function hitTest(ev) {
  const rect = el.profile.getBoundingClientRect();
  const y = ev.clientY - rect.top;
  return state.profileHitboxes.find((box) => y >= box.top && y <= box.bottom) ?? null;
}

async function onProfileClick(ev) {
  const box = hitTest(ev);
  if (!box) return;
  state.selected = { side: box.side, price: box.price };
  state.dirty = true;
  try {
    const res = await fetch(
      `/api/passive-liquidity/level?symbol=${encodeURIComponent(state.symbol)}&market=${state.market}` +
        `&side=${box.side}&price=${box.price}`,
    );
    const body = await res.json();
    state.detail = body.detail ?? null;
  } catch {
    state.detail = null;
  }
  state.dirty = true;
}

function render() {
  const snap = current();
  renderHeader(snap);
  const range = priceRange(snap);
  state.priceRange = range;
  drawProfile(snap, range);
  renderBands(snap);
  renderNetLiquidity(snap);
  renderSides(snap);
  renderAggression(snap);
  renderWalls(snap);
  renderWhy(snap);
  renderLevel(snap);
}

function renderHeader(snap) {
  if (el.state) {
    el.state.textContent = snap ? label(snap.state) : '—';
    el.state.className = `pl-state ${snap ? stateTone(snap.state) : ''}`;
  }
  if (el.quality) {
    const q = snap?.dataQuality;
    const score = Math.round(q?.score ?? 0);
    const trusted = Boolean(q?.trustworthy);
    el.quality.textContent = trusted
      ? `data ${score}/100 · conf ${Math.round(snap?.stateConfidence ?? 0)}`
      : `LOW DATA QUALITY ${score}/100`;
    el.quality.className = `pl-quality ${trusted ? '' : 'bad'}`;
    el.quality.title = (q?.reasons ?? []).join(' · ') || 'stream healthy';
  }
}

function priceRange(snap) {
  const prices = [];
  for (const level of snap?.profile ?? []) prices.push(level.price);
  if (!prices.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const p of prices) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  const pad = (max - min) * 0.02;
  return { min: min - pad, max: max + pad };
}

function prepCanvas(canvas) {
  if (!canvas) return null;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width <= 0 || height <= 0) return null;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function yFor(price, range, height) {
  const t = (price - range.min) / (range.max - range.min);
  return height - t * height;
}

/**
 * Collapse price levels that would occupy the same text row. The profile can
 * contain dozens of ticks only a few pixels apart; drawing every label makes
 * both the price and notional columns unreadable. Each row keeps the strongest
 * real level for click-through while its bar represents the row's total depth.
 */
function readableProfileRows(levels, range, plotTop, plotHeight, minRowHeight) {
  const rows = new Map();
  for (const level of levels) {
    const exactY = plotTop + yFor(level.price, range, plotHeight);
    const slot = Math.max(0, Math.min(
      Math.floor(plotHeight / minRowHeight) - 1,
      Math.floor((exactY - plotTop) / minRowHeight),
    ));
    const key = `${level.side}:${slot}`;
    const current = rows.get(key);
    if (!current) {
      rows.set(key, {
        ...level,
        slot,
        notionalValue: level.notionalValue,
        strongestNotional: level.notionalValue,
      });
      continue;
    }
    const total = current.notionalValue + level.notionalValue;
    const strongest = level.notionalValue > current.strongestNotional ? level : current;
    rows.set(key, {
      ...strongest,
      slot,
      notionalValue: total,
      strongestNotional: Math.max(current.strongestNotional ?? current.notionalValue, level.notionalValue),
      isWall: current.isWall || level.isWall,
      approachWithdrawal: current.approachWithdrawal || level.approachWithdrawal,
    });
  }
  return [...rows.values()].sort((a, b) => a.slot - b.slot);
}

function drawProfile(snap, range) {
  const surface = prepCanvas(el.profile);
  state.profileHitboxes = [];
  if (!surface) return;
  const { ctx, width, height } = surface;
  const c = palette();

  ctx.fillStyle = c.panel;
  ctx.fillRect(0, 0, width, height);

  const levels = snap?.profile ?? [];
  if (!range || !levels.length) {
    ctx.fillStyle = c.muted;
    ctx.font = `11px ${c.mono}`;
    ctx.fillText('no resting liquidity', 10, 18);
    return;
  }

  const plotTop = 28;
  const plotBottom = 10;
  const plotHeight = Math.max(1, height - plotTop - plotBottom);
  const rowHeight = 16;
  const rows = readableProfileRows(levels, range, plotTop, plotHeight, rowHeight);

  let peak = 0;
  for (const level of rows) peak = Math.max(peak, level.notionalValue);
  if (peak <= 0) return;

  const labelWidth = 88;
  const valueWidth = 66;
  const barSpace = Math.max(20, width - labelWidth - valueWidth - 8);

  ctx.font = `600 10px ${c.mono}`;
  ctx.textBaseline = 'middle';

  for (const level of rows) {
    const y = plotTop + level.slot * rowHeight + rowHeight / 2;
    const isBid = level.side === 'BID';
    const barWidth = (level.notionalValue / peak) * barSpace;
    const color = stateColor(level.state) ?? (isBid ? c.bid : c.ask);
    const selected =
      state.selected && state.selected.side === level.side && state.selected.price === level.price;

    ctx.globalAlpha = level.isWall ? 0.95 : 0.6;
    ctx.fillStyle = color;
    ctx.fillRect(labelWidth, y - rowHeight / 2, barWidth, Math.max(2, rowHeight - 1));
    ctx.globalAlpha = 1;

    if (level.approachWithdrawal) {
      ctx.strokeStyle = c.warn;
      ctx.lineWidth = 1;
      ctx.strokeRect(labelWidth, y - rowHeight / 2, Math.max(barWidth, 2), Math.max(2, rowHeight - 1));
    }
    if (selected) {
      ctx.strokeStyle = c.text;
      ctx.lineWidth = 1;
      ctx.strokeRect(1, y - rowHeight / 2, width - 2, Math.max(2, rowHeight - 1));
    }

    ctx.fillStyle = isBid ? c.bid : c.ask;
    ctx.textAlign = 'left';
    ctx.fillText(`${isBid ? 'B' : 'A'} ${fmtPrice(level.price)}`, 4, y);
    ctx.fillStyle = c.text;
    ctx.textAlign = 'right';
    ctx.fillText(fmtUsd(level.notionalValue), width - 4, y);

    state.profileHitboxes.push({
      side: level.side,
      price: level.price,
      top: y - rowHeight / 2,
      bottom: y + rowHeight / 2,
    });
  }

  if (snap.mid > 0) {
    const y = plotTop + yFor(snap.mid, range, plotHeight);
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const midLabel = `MID ${fmtPrice(snap.mid)}`;
    ctx.font = `700 10px ${c.mono}`;
    const midLabelWidth = ctx.measureText(midLabel).width + 8;
    ctx.fillStyle = c.panel;
    ctx.fillRect(3, y - 17, midLabelWidth, 14);
    ctx.fillStyle = c.accent;
    ctx.textAlign = 'left';
    ctx.fillText(midLabel, 7, y - 10);
  }
  ctx.textAlign = 'left';
}

function metric(key, value, cls = '', title = '') {
  const t = title ? ` title="${String(title).replace(/"/g, '&quot;')}"` : '';
  return `<div class="pl-metric"${t}><span class="k">${key}</span><span class="v ${cls}">${value}</span></div>`;
}

function card(title, body) {
  return `<h3>${title}</h3>${body}`;
}

function pctCls(percentile) {
  const p = Number(percentile);
  if (!Number.isFinite(p)) return '';
  if (p >= 92) return 'extreme';
  if (p >= 80) return 'high';
  if (p <= 20) return 'low';
  return '';
}

function pct(percentile) {
  const p = Number(percentile);
  return Number.isFinite(p) ? `${Math.round(p)}th` : '—';
}

function signedUsd(value) {
  const n = Number(value) || 0;
  return `${n > 0 ? '+' : ''}${fmtUsd(n)}`;
}

function signedPercent(value, reliable) {
  if (!reliable || value == null || !Number.isFinite(value)) return 'unreliable base';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function netTone(side) {
  const stateName = String(side?.state ?? 'LOW_CONFIDENCE');
  if (stateName.includes('GROWING')) return 'buy';
  if (stateName.includes('SHRINKING')) return 'sell';
  return stateName === 'LOW_CONFIDENCE' ? 'low' : '';
}

function renderNetLiquidity(snap) {
  if (!el.net) return;
  const net = state.netLiquidity ?? (state.netWindowMs === 10_000 ? snap?.netLiquidity : null);
  if (!net) {
    el.net.innerHTML = card('Net liquidity', '<p class="pl-empty">collecting depth history…</p>');
    return;
  }
  const side = (value, name) => `<div class="pl-net-side">
    <h4 class="${name === 'BID' ? 'buy' : 'sell'}">${name}</h4>
    <div class="pl-metrics">
      ${metric('Starting', fmtUsd(value.startingDepth))}
      ${metric('Current', fmtUsd(value.currentDepth))}
      ${metric('Net change', signedUsd(value.bookNetChange), netTone(value))}
      ${metric('Change', signedPercent(value.netChangePercent, value.percentageReliable), netTone(value))}
      ${metric('New liquidity', signedUsd(value.newAdded), 'buy')}
      ${metric('Replenished', signedUsd(value.replenished), 'buy')}
      ${metric('Cancelled', signedUsd(-value.cancelled), 'sell')}
      ${metric('Consumed', signedUsd(-value.consumed), 'sell')}
      ${metric('Velocity', `${signedUsd(value.velocityPerSec)}/s`, netTone(value))}
      ${metric('State', label(value.state), netTone(value))}
      ${metric('Primary cause', label(value.primaryCause))}
    </div>
  </div>`;
  const near = net.near10Bps;
  const imbalance = net.liquidityChangeImbalance;
  const flags = net.flags?.length
    ? `<div class="pl-net-flags">${net.flags.map((flag) => `<span>${label(flag)}</span>`).join('')}</div>`
    : '';
  const tabs = `<div class="pl-net-windows" aria-label="Net liquidity timeframe">${NET_WINDOWS.map((window) =>
    `<button class="chart-tf-tab${window.ms === state.netWindowMs ? ' active' : ''}" data-net-window="${window.ms}" type="button">${window.label}</button>`,
  ).join('')}</div>`;
  el.net.innerHTML = card(
    `Net liquidity <span class="muted">${NET_WINDOWS.find((window) => window.ms === net.windowMs)?.label ?? `${Math.round(net.windowMs / 1_000)}s`} change</span>`,
    `${tabs}<div class="pl-sides">${side(net.bid, 'BID')}${side(net.ask, 'ASK')}</div>
     <div class="pl-net-summary">
       ${metric('Near 10bps bid', signedUsd(near.bid.behavioralNetChange), netTone(near.bid))}
       ${metric('Near 10bps ask', signedUsd(near.ask.behavioralNetChange), netTone(near.ask))}
       ${metric('Change imbalance', signedUsd(imbalance), imbalance >= 0 ? 'buy' : 'sell')}
       <p>${net.interpretation}</p>
     </div>${flags}`,
  );
}

function renderBands(snap) {
  if (!el.bands) return;
  const bands = snap?.bands ?? [];
  if (!bands.length) {
    el.bands.innerHTML = card('Liquidity bands', '<p class="pl-empty">—</p>');
    return;
  }
  const rows = bands
    .map((band) => {
      const total = band.bidNotional + band.askNotional;
      const bidShare = total > 0 ? (band.bidNotional / total) * 100 : 50;
      return `<div class="pl-band">
        <span class="pl-band-label">${band.label}</span>
        <span class="pl-band-bar"><i style="width:${bidShare.toFixed(1)}%"></i></span>
        <span class="pl-band-val buy">${fmtUsd(band.bidNotional)}</span>
        <span class="pl-band-val sell">${fmtUsd(band.askNotional)}</span>
      </div>`;
    })
    .join('');
  const cuts = (snap.imbalanceCuts ?? [])
    .map((cut) =>
      metric(
        `${cut.withinBps}bps imbalance`,
        cut.imbalance.toFixed(2),
        cut.imbalance >= 0 ? 'pos' : 'neg',
        `bid ${fmtUsd(cut.bidNotional)} vs ask ${fmtUsd(cut.askNotional)}`,
      ),
    )
    .join('');
  el.bands.innerHTML = card(
    'Liquidity bands <span class="muted">bid / ask</span>',
    `<div class="pl-bands">${rows}</div><div class="pl-metrics">${cuts}</div>`,
  );
}

function renderSides(snap) {
  if (!el.sides) return;
  if (!snap) {
    el.sides.innerHTML = card('Passive sides', '<p class="pl-empty">—</p>');
    return;
  }
  const side = (m, name) =>
    `<div class="pl-side">
      <h4 class="${name === 'BIDS' ? 'buy' : 'sell'}">${name}</h4>
      <div class="pl-metrics">
        ${metric('Depth', fmtUsd(m.depthNotional))}
        ${metric('Near touch', fmtUsd(m.nearDepthNotional), pctCls(m.nearDepthPercentile), `${pct(m.nearDepthPercentile)} percentile`)}
        ${metric('Distance weighted', fmtUsd(m.weightedDepthNotional))}
        ${metric('Consumed', fmtUsd(m.consumedNotional), pctCls(m.consumedPercentile), `${pct(m.consumedPercentile)} percentile`)}
        ${metric('Cancelled', fmtUsd(m.cancelledNotional), pctCls(m.cancelledPercentile), `${pct(m.cancelledPercentile)} percentile`)}
        ${metric('Replenished', fmtUsd(m.replenishedNotional), pctCls(m.replenishedPercentile), `${pct(m.replenishedPercentile)} percentile`)}
        ${metric('Replenish ratio', m.replenishmentRatio.toFixed(2))}
        ${metric('Persistence', `${Math.round(m.persistenceScore)}/100`)}
        ${metric('Withdrawal', `${Math.round(m.withdrawalScore)}/100`)}
        ${metric('Consumed /s', fmtUsd(m.velocity.consumedNotionalPerSec))}
        ${metric('Cancelled /s', fmtUsd(m.velocity.cancelledNotionalPerSec))}
        ${metric('Added /s', fmtUsd(m.velocity.addedNotionalPerSec))}
        ${metric('Levels', String(m.levelCount))}
      </div>
    </div>`;

  el.sides.innerHTML = card(
    `Passive strength <span class="muted">buyers ${Math.round(snap.passiveBuyerStrength)} · sellers ${Math.round(snap.passiveSellerStrength)}</span>`,
    `<div class="pl-sides">${side(snap.bid, 'BIDS')}${side(snap.ask, 'ASKS')}</div>`,
  );
}

function renderAggression(snap) {
  if (!el.aggression) return;
  if (!snap) {
    el.aggression.innerHTML = card('Aggression vs liquidity', '<p class="pl-empty">—</p>');
    return;
  }
  const p = snap.aggressionVsLiquidity;
  const step = (name, measure) =>
    `<div class="pl-step">
      <span class="pl-step-name">${name}</span>
      <span class="pl-step-val">${fmtUsd(measure.raw)}</span>
      <span class="pl-step-pct ${pctCls(measure.percentile)}">${pct(measure.percentile)}</span>
    </div>`;

  const evr = snap.effortVsResult;
  const vacuum = `${Math.round(snap.upsideVacuum.score)} up · ${Math.round(snap.downsideVacuum.score)} down`;

  el.aggression.innerHTML = card(
    `Aggression vs liquidity <span class="muted">${p.aggressiveSide}</span>`,
    `<div class="pl-steps">
      ${step('Aggression', p.aggression)}
      ${step('Consumption', p.consumption)}
      ${step('Replenishment', p.replenishment)}
      ${step('Withdrawal', p.withdrawal)}
      <div class="pl-step">
        <span class="pl-step-name">Displacement</span>
        <span class="pl-step-val">${p.displacementBps.raw.toFixed(1)} bps</span>
        <span class="pl-step-pct ${pctCls(p.displacementBps.percentile)}">${pct(p.displacementBps.percentile)}</span>
      </div>
    </div>
    <div class="pl-metrics">
      ${metric('Seller absorption', `${Math.round(snap.sellerAbsorption.score)}/100`, snap.sellerAbsorption.detected ? 'extreme' : '')}
      ${metric('Buyer absorption', `${Math.round(snap.buyerAbsorption.score)}/100`, snap.buyerAbsorption.detected ? 'extreme' : '')}
      ${metric('Vacuum score', vacuum)}
      ${metric('Effort', `${Math.round(evr.effortScore)}/100`)}
      ${metric('Result', `${Math.round(evr.resultScore)}/100`)}
      ${metric('Passive defense', `${Math.round(evr.passiveDefenseScore)}/100`)}
      ${evr.labels.length ? metric('Read', evr.labels.map(label).join(' · ')) : ''}
    </div>`,
  );
}

function renderWalls(snap) {
  if (!el.walls) return;
  const walls = (snap?.walls ?? []).slice(0, 10);
  const zones = (snap?.zones ?? []).slice(0, 4);
  if (!walls.length && !zones.length) {
    el.walls.innerHTML = card('Walls & structure', '<p class="pl-empty">no statistically unusual levels</p>');
    return;
  }
  const wallRows = walls
    .map(
      (wall) => `<div class="pl-wall">
        <span class="pl-wall-side ${wall.side === 'BID' ? 'buy' : 'sell'}">${wall.side}</span>
        <span class="pl-wall-price">${fmtPrice(wall.price)}</span>
        <span class="pl-wall-size">${fmtUsd(wall.notional)}</span>
        <span class="pl-wall-dist">${wall.distanceBps.toFixed(1)}bps</span>
        <span class="pl-wall-score" title="strength ${Math.round(wall.strength)} · reliability ${Math.round(wall.reliability)} · size ${pct(wall.sizePercentile)} · age ${fmtAge(wall.ageMs)}">${Math.round(wall.strength)}/${Math.round(wall.reliability)}</span>
        <span class="pl-wall-life ${wall.lifecycle === 'WITHDRAWN' || wall.lifecycle === 'BROKEN' ? 'bad' : ''}">${label(wall.lifecycle)}</span>
        ${wall.labels.length ? `<span class="pl-wall-flag" title="${wall.labels.map(label).join(' · ')}">!</span>` : ''}
      </div>`,
    )
    .join('');
  const zoneRows = zones
    .map(
      (zone) => `<div class="pl-zone">
        <span class="pl-zone-state ${zone.side === 'BID' ? 'buy' : 'sell'}">${label(zone.state)}</span>
        <span>${fmtPrice(zone.priceMin)}–${fmtPrice(zone.priceMax)}</span>
        <span class="muted">${zone.defendedTests}/${zone.testCount} defended · ratio ${zone.replenishmentRatio.toFixed(2)} · ${Math.round(zone.strength)}/100</span>
      </div>`,
    )
    .join('');

  el.walls.innerHTML = card(
    'Walls & structure <span class="muted">strength / reliability</span>',
    `<div class="pl-walls">${wallRows}</div>${zoneRows ? `<div class="pl-zones">${zoneRows}</div>` : ''}`,
  );
}

function renderWhy(snap) {
  if (!el.why) return;
  const facts = snap?.why ?? [];
  if (!facts.length) {
    el.why.innerHTML = card('Why', '<p class="pl-empty">—</p>');
    return;
  }
  const rows = facts
    .map((f) => {
      if (f.label === 'Interpretation') {
        return `<p class="pl-interpretation">${f.value}</p>`;
      }
      const band = f.band ? `<span class="pl-band-tag ${String(f.band).toLowerCase()}">${label(f.band)}</span>` : '';
      const percentile = f.percentile == null ? '' : `<span class="pl-why-pct">${pct(f.percentile)}</span>`;
      const title = [f.tooltip, f.detail].filter(Boolean).join(' — ');
      return `<div class="pl-why-row"${title ? ` title="${title.replace(/"/g, '&quot;')}"` : ''}>
        <span class="pl-why-k">${f.label}</span>
        <span class="pl-why-v">${f.value}</span>
        ${percentile}${band}
      </div>`;
    })
    .join('');
  el.why.innerHTML = card(`Why <span class="muted">${label(snap.state)}</span>`, rows);
}

function renderLevel(snap) {
  if (!el.level) return;
  const detail = state.detail;
  if (!detail?.level) {
    el.level.innerHTML = card(
      'Price level',
      '<p class="pl-empty">click a level in the profile to inspect its history</p>',
    );
    return;
  }
  const l = detail.level;
  const m = detail.memory;
  const rows = [
    metric('Price', fmtPrice(l.price)),
    metric('Side', l.side, l.side === 'BID' ? 'buy' : 'sell'),
    metric('Current', `${fmtUsd(l.notionalValue)} · ${fmtQty(l.quantity)}`),
    metric('Max', fmtUsd(l.maxNotional)),
    metric('Distance', `${l.distanceBps.toFixed(1)}bps`),
    metric('Age', fmtAge(l.ageMs)),
    metric('Present', fmtAge(l.presentMs)),
    metric('Added', fmtUsd(l.addedNotional)),
    metric('Consumed', fmtUsd(l.consumedNotional)),
    metric('Cancelled', fmtUsd(l.cancelledNotional)),
    metric('Replenished', fmtUsd(l.replenishedNotional)),
    metric('Unresolved', fmtQty(l.unresolvedQuantity), '', 'drops still inside the trade matching window'),
    metric('Attacks', `${l.attackCount} · ${l.defendedCount} defended`),
    metric('Replenish ratio', l.replenishmentRatio.toFixed(2)),
    metric('Persistence', `${Math.round(l.persistenceScore)}/100`),
    metric('Withdrawal', `${Math.round(l.withdrawalScore)}/100`),
    metric('Absorption', `${Math.round(l.absorptionScore)}/100`),
    metric('Size percentile', pct(l.sizePercentile)),
    metric('Closest approach', `${l.closestApproachBps.toFixed(1)}bps`),
    metric('State', label(l.state), stateTone(l.state)),
  ];
  if (l.approachWithdrawal) {
    rows.push(metric('Flag', 'APPROACH WITHDRAWAL', 'extreme', 'size was pulled as price closed in'));
  }
  if (m) {
    rows.push(
      metric('Level memory', `${m.attacks} attacks · ${m.defendedTests} defended`),
      metric('Absorbed here', fmtUsd(m.totalAggressionAbsorbed)),
      metric('Defense score', `${Math.round(m.defenseScore)}/100`),
    );
  }

  el.level.innerHTML = card(
    `Price level <span class="muted">${fmtPrice(l.price)} ${l.side}</span>`,
    `<div class="pl-metrics">${rows.join('')}</div>${timelineHtml(detail.timeline)}`,
  );
  void snap;
}

function timelineHtml(timeline) {
  const points = Array.isArray(timeline) ? timeline : [];
  if (points.length < 2) return '';
  let peak = 0;
  for (const p of points) peak = Math.max(peak, p.notional);
  if (peak <= 0) return '';
  const bars = points
    .map((p) => {
      const h = Math.max(2, (p.notional / peak) * 100);
      const cls =
        p.event === 'LIQUIDITY_CONSUMED'
          ? 'consumed'
          : p.event === 'LIQUIDITY_REPLENISHED'
            ? 'replenished'
            : p.event === 'LIQUIDITY_CANCELLED'
              ? 'cancelled'
              : '';
      const time = new Date(p.at).toLocaleTimeString('en-GB');
      return `<i class="${cls}" style="height:${h.toFixed(1)}%" title="${time} · ${fmtUsd(p.notional)} · ${label(p.event)}"></i>`;
    })
    .join('');
  return `<div class="pl-timeline-wrap"><span class="pl-timeline-label">Level timeline</span><div class="pl-timeline">${bars}</div></div>`;
}
