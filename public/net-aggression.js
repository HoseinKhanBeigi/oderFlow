/**
 * Net Aggression panel — executed aggressive buys vs sells only.
 * No cancel / replenish (those live on Passive Liquidity).
 *
 * Data arrives on summary.windows[tf].netAggression over the existing WS.
 */

const RENDER_MS = 80;
const DEFAULT_SYMBOL = 'BTCUSDT';
const NA_WINDOWS = [
  { id: '10s', label: '10s', ms: 10_000 },
  { id: '30s', label: '30s', ms: 30_000 },
  { id: '1m', label: '1m', ms: 60_000 },
  { id: '5m', label: '5m', ms: 300_000 },
  { id: '15m', label: '15m', ms: 900_000 },
];

const state = {
  /** symbol → { windowId → NetAggressionSnapshot } */
  bySymbol: new Map(),
  coins: [],
  symbol: DEFAULT_SYMBOL,
  market: 'perp',
  windowId: '1m',
  dirty: false,
  lastRender: 0,
  rafId: 0,
};

const el = {};

function $(id) {
  return document.getElementById(id);
}

function fmtUsd(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtUsdAbs(value) {
  const n = Math.abs(Number(value) || 0);
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtCount(value) {
  const n = Math.round(Number(value) || 0);
  return n.toLocaleString('en-US');
}

function fmtImbalance(value) {
  const n = Number(value) || 0;
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

function label(value) {
  return String(value ?? '—').replace(/_/g, ' ');
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}th` : '—';
}

function pctCls(percentile) {
  const p = Number(percentile);
  if (!Number.isFinite(p)) return '';
  if (p >= 92) return 'extreme';
  if (p >= 80) return 'high';
  if (p <= 20) return 'low';
  return '';
}

function stateTone(s) {
  const v = String(s ?? '');
  if (v.includes('BUY')) return 'buy';
  if (v.includes('SELL')) return 'sell';
  return '';
}

export function setNetAggressionMarket(market) {
  const next = market === 'spot' ? 'spot' : 'perp';
  if (next === state.market) return;
  state.market = next;
  state.dirty = true;
}

export function setNetAggressionCoins(coins) {
  const list = Array.isArray(coins) ? coins.filter((c) => c?.symbol) : [];
  state.coins = list;
  const stillThere = list.some((c) => c.symbol === state.symbol);
  if (!stillThere) {
    const btc = list.find((c) => c.symbol === DEFAULT_SYMBOL);
    setNetAggressionSymbol(btc?.symbol ?? list[0]?.symbol ?? DEFAULT_SYMBOL);
  }
  renderCoinTabs();
}

export function setNetAggressionSymbol(symbol) {
  if (!symbol || symbol === state.symbol) {
    renderCoinTabs();
    return;
  }
  state.symbol = symbol;
  state.dirty = true;
  renderCoinTabs();
  updateSymbolLabel();
}

/**
 * Build a panel snapshot from raw window aggregates when the server has not
 * attached netAggression yet (or for older deploys).
 */
function fromWindowAggregates(windowId, w) {
  const meta = NA_WINDOWS.find((x) => x.id === windowId);
  const windowMs = meta?.ms ?? 60_000;
  const buyVol = Number(w.aggressiveBuyVolume) || 0;
  const sellVol = Number(w.aggressiveSellVolume) || 0;
  const buyCount = Number(w.buyTradeCount) || 0;
  const sellCount = Number(w.sellTradeCount) || 0;
  const seconds = Math.max(windowMs / 1000, 0.001);
  const net = buyVol - sellVol;
  const total = buyVol + sellVol;
  const imbalance = total > 0 ? net / total : 0;
  const buyPct = Number(w.netAggression?.buyPercentile)
    ?? Number(w.liquidityResponse?.norms?.aggressiveBuy?.percentile)
    ?? 50;
  const sellPct = Number(w.netAggression?.sellPercentile)
    ?? Number(w.liquidityResponse?.norms?.aggressiveSell?.percentile)
    ?? 50;
  const netPct = Number(w.netAggression?.netPercentile)
    ?? Number(w.liquidityResponse?.norms?.delta?.percentile)
    ?? 50;

  let stateName = 'BALANCED';
  if (imbalance >= 0.35 && buyPct >= 70) stateName = 'STRONG_BUY_AGGRESSION';
  else if (imbalance <= -0.35 && sellPct >= 70) stateName = 'STRONG_SELL_AGGRESSION';
  else if (imbalance >= 0.12 || (imbalance >= 0.06 && buyPct >= 65)) stateName = 'BUY_AGGRESSION';
  else if (imbalance <= -0.12 || (imbalance <= -0.06 && sellPct >= 65)) stateName = 'SELL_AGGRESSION';

  const side = (executed, tradeCount, largeVolume, percentile) => ({
    executed,
    tradeCount,
    velocityPerSec: executed / seconds,
    averageTradeSize: tradeCount > 0 ? executed / tradeCount : 0,
    largeVolume: Number(largeVolume) || 0,
    percentile,
  });

  return {
    window: windowId,
    windowMs,
    buy: side(buyVol, buyCount, w.largeBuyVolume, buyPct),
    sell: side(sellVol, sellCount, w.largeSellVolume, sellPct),
    net,
    imbalance,
    netVelocityPerSec: net / seconds,
    buyPercentile: buyPct,
    sellPercentile: sellPct,
    netPercentile: netPct,
    state: stateName,
    interpretation: `Executed flow over ${meta?.label ?? windowId}. Longer windows accumulate more volume — tabs should not match.`,
  };
}

/**
 * Ingest from a live summary: pack netAggression from each window.
 * Falls back to aggressiveBuy/Sell volumes so timeframe tabs always diverge.
 */
export function ingestNetAggression(symbol, windows) {
  if (!symbol || !windows) return;
  const pack = {};
  for (const { id } of NA_WINDOWS) {
    const w = windows[id];
    if (!w) continue;
    pack[id] = w.netAggression ?? fromWindowAggregates(id, w);
  }
  if (!Object.keys(pack).length) return;
  state.bySymbol.set(symbol, pack);
  if (symbol === state.symbol) state.dirty = true;
}

export function initNetAggression(hooks = {}) {
  el.panel = $('na-panel');
  if (!el.panel) return;
  state.getMarket = typeof hooks.getMarket === 'function' ? hooks.getMarket : null;
  el.symbol = $('na-symbol');
  el.coinTabs = $('na-coin-tabs');
  el.body = $('na-body');
  el.state = $('na-state');

  el.panel.addEventListener('click', (ev) => {
    const winBtn = ev.target.closest('[data-na-window]');
    if (winBtn) {
      const id = winBtn.dataset.naWindow;
      if (!NA_WINDOWS.some((w) => w.id === id)) return;
      state.windowId = id;
      state.dirty = true;
      return;
    }
    const coinBtn = ev.target.closest('[data-na-symbol]');
    if (coinBtn) {
      setNetAggressionSymbol(coinBtn.dataset.naSymbol);
    }
  });

  renderCoinTabs();
  updateSymbolLabel();
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
        `<button type="button" class="pl-coin-tab${c.symbol === state.symbol ? ' active' : ''}" data-na-symbol="${c.symbol}">${c.label ?? coinLabel(c.symbol)}</button>`,
    )
    .join('');
}

function current() {
  const pack = state.bySymbol.get(state.symbol);
  return pack?.[state.windowId] ?? null;
}

function loop() {
  state.rafId = requestAnimationFrame(loop);
  if (state.getMarket) setNetAggressionMarket(state.getMarket());
  const now = performance.now();
  if (!state.dirty || now - state.lastRender < RENDER_MS) return;
  state.lastRender = now;
  state.dirty = false;
  try {
    render();
  } catch (err) {
    console.error('[net-aggression] render failed:', err);
  }
}

function metric(key, value, cls = '', title = '') {
  const t = title ? ` title="${String(title).replace(/"/g, '&quot;')}"` : '';
  return `<div class="pl-metric"${t}><span class="k">${key}</span><span class="v ${cls}">${value}</span></div>`;
}

function sideBlock(title, side, tone) {
  return `<div class="na-side">
    <h4 class="${tone}">${title}</h4>
    <div class="pl-metrics">
      ${metric('Executed', fmtUsdAbs(side.executed), tone)}
      ${metric('Trades', fmtCount(side.tradeCount))}
      ${metric('Velocity', `${fmtUsdAbs(side.velocityPerSec)}/s`)}
      ${metric('Avg trade', fmtUsdAbs(side.averageTradeSize))}
      ${metric('Large trades', fmtUsdAbs(side.largeVolume))}
      ${metric('Percentile', pct(side.percentile), pctCls(side.percentile))}
    </div>
  </div>`;
}

function render() {
  const snap = current();
  if (el.state) {
    el.state.textContent = snap ? label(snap.state) : '—';
    el.state.className = `pl-state ${snap ? stateTone(snap.state) : ''}`;
  }
  if (!el.body) return;

  const tabs = `<div class="pl-net-windows" aria-label="Net aggression timeframe">${NA_WINDOWS.map(
    (w) =>
      `<button class="chart-tf-tab${w.id === state.windowId ? ' active' : ''}" data-na-window="${w.id}" type="button">${w.label}</button>`,
  ).join('')}</div>`;

  if (!snap) {
    el.body.innerHTML = `${tabs}<p class="pl-empty">waiting for executed aggressive flow…</p>`;
    return;
  }

  const winLabel = NA_WINDOWS.find((w) => w.id === snap.window)?.label ?? snap.window;
  const netTone = snap.net > 0 ? 'buy' : snap.net < 0 ? 'sell' : '';
  const imbTone = snap.imbalance > 0.05 ? 'buy' : snap.imbalance < -0.05 ? 'sell' : '';

  el.body.innerHTML = `${tabs}
    <div class="na-head">
      <h3>Net aggression <span class="muted">${winLabel}</span></h3>
      <p class="na-note">Executed trades only — cancels and replenishment belong to Passive liquidity.</p>
    </div>
    <div class="pl-sides">
      ${sideBlock('BUY', snap.buy, 'buy')}
      ${sideBlock('SELL', snap.sell, 'sell')}
    </div>
    <div class="na-summary">
      ${metric('Net aggression', fmtUsd(snap.net), netTone)}
      ${metric('Imbalance', fmtImbalance(snap.imbalance), imbTone, '−1 strong sell · 0 balanced · +1 strong buy')}
      ${metric('Net velocity', `${fmtUsd(snap.netVelocityPerSec)}/s`, netTone)}
      ${metric('Buy percentile', pct(snap.buyPercentile), pctCls(snap.buyPercentile))}
      ${metric('Sell percentile', pct(snap.sellPercentile), pctCls(snap.sellPercentile))}
      ${metric('Net |Δ| percentile', pct(snap.netPercentile), pctCls(snap.netPercentile), 'How unusual |buy−sell| is vs history')}
      ${metric('State', label(snap.state), stateTone(snap.state))}
      <p class="na-interpretation">${snap.interpretation}</p>
    </div>`;
}
