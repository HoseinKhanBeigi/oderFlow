const list = document.getElementById('list');
const status = document.getElementById('status');
const clearBtn = document.getElementById('clear');

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

function bitunixTradeUrl(symbol) {
  const pair = String(symbol || '').toUpperCase();
  if (!pair) return '';
  return `https://www.bitunix.com/contract-trade/${pair}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render(alerts, origin) {
  if (!alerts?.length) {
    list.innerHTML = '<div class="empty">No alerts yet — keep the Order Flow tab open (it can stay in the background).</div>';
    status.textContent = origin ? `Listening · ${origin.replace(/^https?:\/\//, '')}` : 'Waiting for dashboard…';
    return;
  }
  status.textContent = `${alerts.length} this session · ${origin?.replace(/^https?:\/\//, '') || 'localhost'}`;
  list.innerHTML = alerts.map((a) => `
    <button type="button" class="row ${a.side || ''}" data-symbol="${escapeHtml(a.symbol || '')}">
      <span class="kind">${escapeHtml(a.kind || '')}</span>
      <span class="title">${escapeHtml(a.title || '')}</span>
      <span class="detail">${escapeHtml(a.detail || '')}</span>
      <span class="time">${fmtTime(a.at || Date.now())}</span>
    </button>
  `).join('');
}

async function openCoin(symbol) {
  const url = bitunixTradeUrl(symbol);
  if (url) await chrome.tabs.create({ url });
}

chrome.runtime.sendMessage({ type: 'popup-opened' }, (state) => {
  if (chrome.runtime.lastError) {
    status.textContent = 'Reload the extension, then refresh the dashboard.';
    return;
  }
  render(state?.alerts || [], state?.dashboardOrigin);
});

list.addEventListener('click', (e) => {
  const row = e.target.closest('[data-symbol]');
  if (!row) return;
  openCoin(row.dataset.symbol);
});

clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'popup-clear' }, () => {
    render([], null);
    status.textContent = 'Cleared';
  });
});
