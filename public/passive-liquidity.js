/**
 * Passive Liquidity panel.
 *
 * Book updates arrive far faster than a screen can usefully redraw, so incoming
 * snapshots only mutate state. Painting happens on a requestAnimationFrame loop
 * throttled to RENDER_MS, which keeps the data path and the render path
 * independent. Per-level history is pulled over HTTP for the visible symbol only.
 */

const RENDER_MS = 80;
const DEFAULT_SYMBOL = 'BTCUSDT';
const FIGHT_TF = '1m';
const FIGHT_WINDOW_SEC = 60;

const state = {
  snapshots: new Map(),
  coins: [],
  symbol: DEFAULT_SYMBOL,
  market: 'perp',
  dirty: false,
  lastRender: 0,
  rafId: 0,
  getMarket: null,
  getSymbol: null,
  onSelectSymbol: null,
  /** Aggressive volumes from the matching summary window (USD). */
  fightFlow: {
    symbol: null,
    tf: FIGHT_TF,
    aggressiveBuy: 0,
    aggressiveSell: 0,
  },
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
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(abs >= 10_000 ? 0 : 2)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function label(value) {
  return String(value ?? '—').replace(/_/g, ' ');
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
  state.dirty = true;
}

/**
 * Replace the coin tabs from the live watchlist. Keeps the dashboard's
 * selected coin when possible — never jumps back to BTC on its own.
 */
export function setPassiveCoins(coins) {
  const list = Array.isArray(coins) ? coins.filter((c) => c?.symbol) : [];
  state.coins = list;
  const preferred =
    (typeof state.getSymbol === 'function' && state.getSymbol()) || state.symbol;
  const stillThere = list.some((c) => c.symbol === preferred);
  if (stillThere) {
    setPassiveSymbol(preferred);
  } else {
    setPassiveSymbol(list[0]?.symbol ?? preferred ?? DEFAULT_SYMBOL);
  }
  renderCoinTabs();
}

export function setPassiveSymbol(symbol) {
  if (!symbol) return;
  if (symbol === state.symbol) {
    renderCoinTabs();
    updateSymbolLabel();
    return;
  }
  state.symbol = symbol;
  state.dirty = true;
  renderCoinTabs();
  updateSymbolLabel();
}

export function ingestPassiveLiquidity(symbol, snapshot) {
  if (!symbol || !snapshot) return;
  state.snapshots.set(symbol, snapshot);
  if (symbol === state.symbol) state.dirty = true;
}

/**
 * Feed aggressive buy/sell notional from the summary window so classic-fight
 * cards can show aggression alongside book cancel/refill/exec.
 */
export function setPassiveFightFlow(payload) {
  if (!payload?.symbol) return;
  const locked = typeof state.getSymbol === 'function' ? state.getSymbol() : state.symbol;
  if (locked && payload.symbol !== locked) return;
  state.fightFlow = {
    symbol: payload.symbol,
    tf: payload.tf || FIGHT_TF,
    aggressiveBuy: Number(payload.aggressiveBuy) || 0,
    aggressiveSell: Number(payload.aggressiveSell) || 0,
  };
  if (payload.symbol === state.symbol) state.dirty = true;
}

function current() {
  return state.symbol ? state.snapshots.get(state.symbol) ?? null : null;
}

/**
 * @param {{
 *   getMarket?: () => string,
 *   getSymbol?: () => string,
 *   onSelectSymbol?: (symbol: string) => void,
 * }} hooks
 *   Market + symbol follow the dashboard coin. Coin tabs open another coin
 *   (usually a new browser tab) instead of drifting this panel alone.
 */
export function initPassiveLiquidity(hooks = {}) {
  el.panel = $('pl-panel');
  if (!el.panel) return;
  state.getMarket = typeof hooks.getMarket === 'function' ? hooks.getMarket : null;
  state.getSymbol = typeof hooks.getSymbol === 'function' ? hooks.getSymbol : null;
  state.onSelectSymbol = typeof hooks.onSelectSymbol === 'function' ? hooks.onSelectSymbol : null;
  el.state = $('pl-state');
  el.quality = $('pl-quality');
  el.symbol = $('pl-symbol');
  el.coinTabs = $('pl-coin-tabs');
  el.sides = $('pl-sides');
  el.classicFight = $('classic-fight-root');

  if (el.coinTabs) {
    el.coinTabs.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-pl-symbol]');
      if (!btn) return;
      const symbol = btn.dataset.plSymbol;
      if (typeof state.onSelectSymbol === 'function') {
        state.onSelectSymbol(symbol);
        return;
      }
      setPassiveSymbol(symbol);
    });
  }

  window.addEventListener('resize', () => {
    state.dirty = true;
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
        `<button class="chart-tf-tab${c.symbol === state.symbol ? ' active' : ''}" data-pl-symbol="${c.symbol}" type="button">${c.label ?? coinLabel(c.symbol)}</button>`,
    )
    .join('');
  updateSymbolLabel();
}

function loop() {
  state.rafId = requestAnimationFrame(loop);
  if (state.getMarket) setPassiveMarket(state.getMarket());
  // Stay locked to the dashboard / URL coin every frame.
  if (typeof state.getSymbol === 'function') {
    const sym = state.getSymbol();
    if (sym && sym !== state.symbol) setPassiveSymbol(sym);
  }
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

function render() {
  const snap = current();
  renderHeader(snap);
  renderClassicFight(snap);
  renderSides(snap);
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

function fightStat(labelText, value, cls = '', tag = '', covNote = '') {
  const tagHtml = tag ? `<em class="absorb-tag">${tag}</em>` : '';
  const cov = covNote ? `<em class="cov-note">${covNote}</em>` : '';
  return `<span class="${cls}${tag ? ' absorbing' : ''}">${labelText} <b>${fmtUsd(value)}</b>${tagHtml}${cov}</span>`;
}

function bookConsumptionPerMinute(volume, windowSec, depth) {
  const d = Number(depth);
  const w = Number(windowSec);
  if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(w) || w <= 0) return 0;
  return (((Number(volume) || 0) / w) * 60) / d;
}

function battleShare(battle) {
  const attack = Math.max(0, Math.min(1, Number(battle?.attackScore) || 0));
  const exec = Math.max(0, Math.min(1, Number(battle?.executionRatio) || 0));
  const refill = Math.max(0, Math.min(1, Number(battle?.refillRatio) || 0));
  const force = Math.max(0.05, Math.min(0.95, 0.5 * attack + 0.35 * exec + 0.15 * (1 - refill)));
  return { force, resist: 1 - force };
}

function fightResultClass(result = '') {
  const s = String(result).toUpperCase();
  if (s.includes('ABSORB') || s.includes('DEFENDING')) return 'state-absorb';
  if (s.includes('ASK CANCELLATION') || s.includes('BUYERS') || s.includes('UPSIDE')) return 'state-buy';
  if (s.includes('BID CANCELLATION') || s.includes('SELLERS') || s.includes('DOWNSIDE')) return 'state-sell';
  if (s.includes('VACUUM') || s.includes('WALL')) return 'state-wall';
  return 'state-neutral';
}

function classifyBuyFight(snap, ask) {
  if (snap?.sellerAbsorption?.detected) return 'ASK ABSORPTION · BUYERS ABSORBED';
  const cancelShare = snap?.context?.askCancellationShare ?? ask?.cancelledPercentile / 100;
  if ((ask?.cancelledPercentile ?? 0) >= 90 || cancelShare >= 0.72) return 'ASK CANCELLATION SURGE';
  if (String(snap?.state || '').includes('VACUUM') && String(snap.state).includes('UPSIDE')) {
    return 'ASK LIQUIDITY WITHDRAWING';
  }
  if (snap?.state === 'PASSIVE_SELLERS_DEFENDING') return 'SELLERS DEFENDING';
  if (snap?.state === 'SELLERS_EXPANDING' || snap?.state === 'BUYERS_EXPANDING') {
    return label(snap.state);
  }
  return label(snap?.state || 'NEUTRAL');
}

function classifySellFight(snap, bid) {
  if (snap?.buyerAbsorption?.detected) return 'BID ABSORPTION · SELLERS ABSORBED';
  const cancelShare = snap?.context?.bidCancellationShare ?? bid?.cancelledPercentile / 100;
  if ((bid?.cancelledPercentile ?? 0) >= 90 || cancelShare >= 0.72) return 'BID CANCELLATION SURGE';
  if (String(snap?.state || '').includes('VACUUM') && String(snap.state).includes('DOWNSIDE')) {
    return 'BID LIQUIDITY WITHDRAWING';
  }
  if (snap?.state === 'PASSIVE_BUYERS_DEFENDING') return 'BUYERS DEFENDING';
  if (snap?.state === 'SELLERS_EXPANDING' || snap?.state === 'BUYERS_EXPANDING') {
    return label(snap.state);
  }
  return label(snap?.state || 'NEUTRAL');
}

function coverageNote(snap) {
  const net = snap?.netLiquidity;
  if (!net) return '';
  const avail = Number(net.availableMs);
  const win = Number(net.windowMs) || FIGHT_WINDOW_SEC * 1000;
  if (!Number.isFinite(avail) || net.coverageComplete || avail >= win - 2000) return '';
  const sec = Math.max(0, Math.round(avail / 1000));
  return `${sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`} of ${FIGHT_TF}`;
}

function renderClassicFight(snap) {
  if (!el.classicFight) return;
  if (!snap) {
    el.classicFight.innerHTML =
      '<div class="classic-fight"><div class="fight-card buy"><div class="flow"><span class="agg">Aggressive buyers</span><span class="arrow">→</span><span class="pas">Passive asks</span></div><p class="pl-empty">Waiting for book…</p></div><div class="fight-card sell"><div class="flow"><span class="agg">Aggressive sellers</span><span class="arrow">→</span><span class="pas">Passive bids</span></div><p class="pl-empty">Waiting for book…</p></div></div>';
    return;
  }

  const ask = snap.ask;
  const bid = snap.bid;
  const flowOk = state.fightFlow.symbol === state.symbol;
  const aggBuy = flowOk ? state.fightFlow.aggressiveBuy : ask?.consumedNotional ?? 0;
  const aggSell = flowOk ? state.fightFlow.aggressiveSell : bid?.consumedNotional ?? 0;

  const buyExecuted = ask?.consumedNotional ?? 0;
  const buyCancelled = ask?.cancelledNotional ?? 0;
  const buyRefill = ask?.replenishedNotional ?? 0;
  const buyLiq = ask?.depthNotional ?? ask?.nearDepthNotional ?? 0;
  const buyAbsorbed = Math.min(aggBuy, buyExecuted, buyRefill);

  const sellExecuted = bid?.consumedNotional ?? 0;
  const sellCancelled = bid?.cancelledNotional ?? 0;
  const sellRefill = bid?.replenishedNotional ?? 0;
  const sellLiq = bid?.depthNotional ?? bid?.nearDepthNotional ?? 0;
  const sellAbsorbed = Math.min(aggSell, sellExecuted, sellRefill);

  const buyMeter = battleShare({
    attackScore: bookConsumptionPerMinute(aggBuy, FIGHT_WINDOW_SEC, buyLiq),
    executionRatio:
      buyExecuted + buyCancelled > 0 ? buyExecuted / Math.max(buyExecuted + buyCancelled, 1e-9) : 0,
    refillRatio: buyExecuted > 0 ? buyRefill / Math.max(buyExecuted, 1e-9) : 0,
  });
  const sellMeter = battleShare({
    attackScore: bookConsumptionPerMinute(aggSell, FIGHT_WINDOW_SEC, sellLiq),
    executionRatio:
      sellExecuted + sellCancelled > 0
        ? sellExecuted / Math.max(sellExecuted + sellCancelled, 1e-9)
        : 0,
    refillRatio: sellExecuted > 0 ? sellRefill / Math.max(sellExecuted, 1e-9) : 0,
  });

  const buyResult = classifyBuyFight(snap, ask);
  const sellResult = classifySellFight(snap, bid);
  const askAbsorbing = Boolean(snap.sellerAbsorption?.detected);
  const bidAbsorbing = Boolean(snap.buyerAbsorption?.detected);
  const cov = coverageNote(snap);
  const tf = (flowOk ? state.fightFlow.tf : FIGHT_TF).toUpperCase();

  el.classicFight.innerHTML = `
    <div class="classic-fight" aria-label="Classic aggressive vs passive summary">
      <div class="fight-card buy${askAbsorbing ? ' is-absorbing' : ''}">
        <div class="flow">
          <span class="agg">Aggressive buyers</span>
          <span class="arrow">→</span>
          <span class="pas">Passive asks</span>
          <span class="tf">${tf} · USD</span>
        </div>
        <div class="fight-meter" title="Force (aggression) vs Resistance (resting asks)">
          <div class="force" style="width:${(buyMeter.force * 100).toFixed(0)}%"></div>
          <div class="resist" style="width:${(buyMeter.resist * 100).toFixed(0)}%"></div>
        </div>
        <div class="fight-stats">
          ${fightStat('Aggressive', aggBuy, '', askAbsorbing ? 'ABSORBED' : '')}
          ${fightStat('Ask liq', buyLiq, 'pas', askAbsorbing ? 'ABSORBING' : '')}
          ${fightStat('Executed', buyExecuted, 'exec', '', cov)}
          ${fightStat('Cancelled', buyCancelled, 'cancel', '', cov)}
          ${fightStat('Refilled', buyRefill, 'refill', '', cov)}
          ${fightStat('Absorbed', buyAbsorbed, 'absorb', askAbsorbing ? 'ACTIVE' : '', cov)}
        </div>
        <div class="fight-result ${fightResultClass(buyResult)}">${buyResult}</div>
        <div class="fight-hint">Absorbed = min(aggression, executed, refilled) — size soaked by asks (est.).</div>
      </div>
      <div class="fight-card sell${bidAbsorbing ? ' is-absorbing' : ''}">
        <div class="flow">
          <span class="agg">Aggressive sellers</span>
          <span class="arrow">→</span>
          <span class="pas">Passive bids</span>
          <span class="tf">${tf} · USD</span>
        </div>
        <div class="fight-meter" title="Force (aggression) vs Resistance (resting bids)">
          <div class="force" style="width:${(sellMeter.force * 100).toFixed(0)}%"></div>
          <div class="resist" style="width:${(sellMeter.resist * 100).toFixed(0)}%"></div>
        </div>
        <div class="fight-stats">
          ${fightStat('Aggressive', aggSell, '', bidAbsorbing ? 'ABSORBED' : '')}
          ${fightStat('Bid liq', sellLiq, 'pas', bidAbsorbing ? 'ABSORBING' : '')}
          ${fightStat('Executed', sellExecuted, 'exec', '', cov)}
          ${fightStat('Cancelled', sellCancelled, 'cancel', '', cov)}
          ${fightStat('Refilled', sellRefill, 'refill', '', cov)}
          ${fightStat('Absorbed', sellAbsorbed, 'absorb', bidAbsorbing ? 'ACTIVE' : '', cov)}
        </div>
        <div class="fight-result ${fightResultClass(sellResult)}">${sellResult}</div>
        <div class="fight-hint">Absorbed = min(aggression, executed, refilled) — size soaked by bids (est.).</div>
      </div>
    </div>`;
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
