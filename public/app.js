const $ = (id) => document.getElementById(id);

const MAX_TAPE = 200;
const MAX_EVENTS = 50;

let tapeCount = 0;
const seenTradeIds = new Set();

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

function stateClass(state) {
  if (!state || state === 'NO_SIGNAL') return '';
  if (state.includes('BUY')) return 'buy-flow';
  if (state.includes('SELL')) return 'sell-flow';
  if (state.includes('ABSORPTION')) return 'absorption';
  if (state.includes('BURST')) return 'burst';
  return '';
}

function addTapeRow(trade) {
  if (seenTradeIds.has(trade.id)) return;
  seenTradeIds.add(trade.id);
  if (seenTradeIds.size > MAX_TAPE * 2) seenTradeIds.clear();

  tapeCount += 1;
  $('tape-count').textContent = `${tapeCount} prints`;

  const row = document.createElement('div');
  row.className = `tape-row ${trade.side.toLowerCase()}`;
  row.innerHTML = `
    <span>${fmtTime(trade.timestamp)}</span>
    <span class="side-${trade.side.toLowerCase()}">${trade.side}</span>
    <span>${fmtPrice(trade.price)}</span>
    <span>${fmtUsd(trade.quoteValue)}</span>
    <span class="tag">${trade.tag || '—'}</span>
  `;

  const tape = $('tape');
  tape.prepend(row);
  while (tape.children.length > MAX_TAPE) tape.lastChild?.remove();
}

function addEvent(text, cls = '') {
  const el = document.createElement('div');
  el.className = `event ${cls}`;
  el.innerHTML = `<div class="time">${fmtTime(Date.now())}</div><div>${text}</div>`;
  const box = $('events');
  box.prepend(el);
  while (box.children.length > MAX_EVENTS) box.lastChild?.remove();
}

function updateSummary(s) {
  const w10 = s.windows['10s'];
  const w1m = s.windows['1m'];
  const w5m = s.windows['5m'];

  $('price').textContent = `$${fmtPrice(s.price)}`;
  $('symbol-label').textContent = `${s.symbol} · ${s.market}`;

  const badge = $('state-badge');
  badge.textContent = w10.state;
  badge.className = `state-badge ${stateClass(w10.state)}`;

  $('score').textContent = w10.largeFlowDirectionalScore;
  $('score').style.color = w10.largeFlowDirectionalScore > 0 ? 'var(--buy)' : w10.largeFlowDirectionalScore < 0 ? 'var(--sell)' : 'inherit';
  $('confidence').textContent = `${Math.round(w10.confidence * 100)}%`;
  $('impact').textContent = w10.priceImpactEfficiency;

  const total = w10.aggressiveBuyVolume + w10.aggressiveSellVolume || 1;
  $('buy-bar').style.width = `${(w10.aggressiveBuyVolume / total) * 100}%`;
  $('sell-bar').style.width = `${(w10.aggressiveSellVolume / total) * 100}%`;

  $('buy-vol').textContent = fmtUsd(w10.aggressiveBuyVolume);
  $('sell-vol').textContent = fmtUsd(w10.aggressiveSellVolume);

  const deltaEl = $('delta');
  deltaEl.textContent = fmtUsd(w10.delta);
  deltaEl.className = `value ${w10.delta >= 0 ? 'pos' : 'neg'}`;

  $('window-cards').innerHTML = [
    { label: '10s', w: w10 },
    { label: '1m', w: w1m },
    { label: '5m', w: w5m },
  ]
    .map(
      ({ label, w }) => `
    <div class="window-card">
      <div class="win-label">${label}</div>
      <div class="win-state">${w.state}</div>
      <div class="win-delta" style="color:${w.delta >= 0 ? 'var(--buy)' : 'var(--sell)'}">${fmtUsd(w.delta)}</div>
    </div>`,
    )
    .join('');

  if (w10.absorption.detected) {
    badge.textContent = w10.absorption.type ?? w10.state;
    badge.className = 'state-badge absorption';
  }
}

function setStatus(connected, message) {
  const el = $('status');
  el.textContent = message;
  el.className = `status ${connected ? 'live' : message.includes('Connect') ? 'connecting' : 'offline'}`;
}

async function init() {
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    $('symbol-label').textContent = `${cfg.symbol} · ${cfg.market}`;
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
        if (ev.connected) addEvent(`Connected — ${ev.message}`);
        break;
      case 'trade':
        addTapeRow(ev.trade);
        break;
      case 'summary':
        updateSummary(ev.summary);
        break;
      case 'burst':
        addEvent(
          `${ev.side} BURST ${fmtUsd(ev.totalQuoteValue)} · ${ev.tradeCount} trades · ${(ev.durationMs / 1000).toFixed(1)}s`,
          'burst',
        );
        break;
      case 'alert':
        addEvent(`${ev.alertType}: ${ev.message}`, 'alert');
        break;
    }
  };
}

init();
