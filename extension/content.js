const SOURCE = 'oderflow-alerts';

function send(payload) {
  try {
    chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
  } catch {
    /* extension reloading */
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.source !== SOURCE) return;
  if (data.type === 'alert' && data.alert) {
    send({ type: 'fp-alert', alert: data.alert, origin: location.origin });
  } else if (data.type === 'snapshot' && Array.isArray(data.alerts)) {
    send({ type: 'fp-snapshot', alerts: data.alerts, origin: location.origin });
  }
});

window.postMessage({ source: SOURCE, type: 'bridge-ready' }, location.origin);
window.postMessage({ source: SOURCE, type: 'request-snapshot' }, location.origin);
send({ type: 'fp-hello', origin: location.origin });
