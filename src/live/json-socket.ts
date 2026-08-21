import WebSocket from 'ws';

export interface JsonSocketOptions {
  url: string;
  label: string;
  pingMs?: number;
  ping?: (ws: WebSocket) => void;
  onOpen?: (ws: WebSocket) => void;
  onMessage: (msg: unknown, raw: string) => void;
  onConnection?: (connected: boolean, label: string) => void;
  isStopped: () => boolean;
}

export function openReconnectingJsonSocket(opts: JsonSocketOptions): () => void {
  let socket: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const connect = (): void => {
    if (stopped || opts.isStopped()) return;
    const ws = new WebSocket(opts.url);
    socket = ws;

    ws.on('open', () => {
      if (stopped || opts.isStopped()) {
        ws.close();
        return;
      }
      opts.onConnection?.(true, opts.label);
      opts.onOpen?.(ws);
      if (opts.ping && opts.pingMs) {
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) opts.ping?.(ws);
        }, opts.pingMs);
      }
    });

    ws.on('message', (raw) => {
      const text = String(raw);
      if (text === 'pong') return;
      if (text === 'ping') {
        ws.send('pong');
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      opts.onMessage(msg, text);
    });

    const retry = (): void => {
      clearInterval(pingTimer);
      pingTimer = undefined;
      if (socket === ws) socket = null;
      if (stopped || opts.isStopped()) return;
      opts.onConnection?.(false, opts.label);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2_000);
    };

    ws.on('close', retry);
    ws.on('error', () => ws.close());
  };

  connect();

  return () => {
    stopped = true;
    clearInterval(pingTimer);
    clearTimeout(reconnectTimer);
    socket?.removeAllListeners();
    socket?.close();
    socket = null;
  };
}
