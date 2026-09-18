const MAX_ALERTS = 80;

async function loadState() {
  const { alerts = [], unread = 0, dashboardOrigin = 'http://localhost:3456' } =
    await chrome.storage.session.get(['alerts', 'unread', 'dashboardOrigin']);
  return { alerts, unread, dashboardOrigin };
}

async function saveState(patch) {
  await chrome.storage.session.set(patch);
}

function bitunixTradeUrl(symbol) {
  const pair = String(symbol || '').toUpperCase();
  if (!pair) return '';
  return `https://www.bitunix.com/contract-trade/${pair}`;
}

async function setBadge(unread) {
  const text = unread > 0 ? String(Math.min(unread, 99)) : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#e879f9' });
}

async function rememberOrigin(origin) {
  if (!origin || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return;
  await saveState({ dashboardOrigin: origin });
}

function mergeById(incoming, existing) {
  const seen = new Set();
  const out = [];
  for (const alert of [...incoming, ...existing]) {
    if (!alert?.id || seen.has(alert.id)) continue;
    seen.add(alert.id);
    out.push(alert);
    if (out.length >= MAX_ALERTS) break;
  }
  return out;
}

async function notify(alert) {
  const iconUrl = chrome.runtime.getURL('icons/icon128.png');
  try {
    await chrome.notifications.create(String(alert.id), {
      type: 'basic',
      iconUrl,
      title: alert.title || 'Order Flow',
      message: alert.detail || '',
      priority: 2,
      silent: false,
    });
  } catch {
    /* macOS / permission */
  }
}

function senderOrigin(sender) {
  try {
    return sender?.tab?.url ? new URL(sender.tab.url).origin : '';
  } catch {
    return '';
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const origin = msg?.origin || senderOrigin(sender);
  if (origin) rememberOrigin(origin);

  if (msg?.type === 'fp-hello') {
    sendResponse({ ok: true });
    return;
  }

  if (msg?.type === 'fp-snapshot' && Array.isArray(msg.alerts)) {
    loadState().then(async ({ alerts, unread }) => {
      const next = mergeById(msg.alerts, alerts);
      await saveState({ alerts: next, unread });
      await setBadge(unread);
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === 'fp-alert' && msg.alert?.id) {
    loadState().then(async ({ alerts, unread }) => {
      if (alerts.some((a) => a.id === msg.alert.id)) return;
      const next = mergeById([msg.alert], alerts);
      const nextUnread = unread + 1;
      await saveState({ alerts: next, unread: nextUnread });
      await setBadge(nextUnread);
      await notify(msg.alert);
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === 'popup-opened') {
    loadState().then(async (state) => {
      await saveState({ unread: 0 });
      await setBadge(0);
      sendResponse(state);
    });
    return true;
  }

  if (msg?.type === 'popup-clear') {
    saveState({ alerts: [], unread: 0 }).then(async () => {
      await setBadge(0);
      sendResponse({ ok: true });
    });
    return true;
  }
});

chrome.notifications.onClicked.addListener(async (id) => {
  const { alerts } = await loadState();
  const alert = alerts.find((a) => String(a.id) === String(id));
  const url = bitunixTradeUrl(alert?.symbol);
  if (url) await chrome.tabs.create({ url });
});
