import type { ClientFrame, ServerFrame } from '../../types';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface CreateWebSocketOptions {
  url: string;
  eventStreamUrl: string;
  authToken?: string;
  onMessage?: (frame: ServerFrame) => void;
  reconnectInterval?: number;
}

export interface WebSocketStore {
  /** The current connection status. Reactive — read directly, never destructure. */
  readonly status: ConnectionStatus;
  /** Opens the live transport. The root component calls this inside an `$effect`. */
  start: () => void;
  /** Tears the live transport down. Returned/called as the `$effect` cleanup. */
  stop: () => void;
  /** Sends a client frame over the active transport, tracking subscriptions. */
  send: (frame: ClientFrame) => void;
  /** Subscribes to live frames for a run id. */
  subscribe: (runId: string) => void;
  /** Unsubscribes from live frames for a run id. */
  unsubscribe: (runId: string) => void;
}

/**
 * Builds the SSE fallback URL, threading the auth token and the currently
 * desired run ids into the query string.
 */
function buildEventStreamUrl(
  baseUrl: string,
  authToken: string | undefined,
  runIds: Iterable<string>,
): string {
  const url = new URL(baseUrl, window.location.origin);

  if (authToken) {
    url.searchParams.set('token', authToken);
  }

  for (const runId of runIds) {
    url.searchParams.append('runId', runId);
  }

  return url.toString();
}

/**
 * Reactive live-transport store: a WebSocket to `/ws` with an EventSource (SSE)
 * fallback, mirroring the original React hook's connect/reconnect state machine.
 *
 * Lifecycle is exposed as `start()`/`stop()` rather than running inside a
 * module-level effect (runes forbid that). The root component drives them from
 * its own `$effect`, returning `stop` as the cleanup. Only `status` is reactive
 * (`$state`); every other handle is a plain closure local because none of them
 * drive UI. An explicit `active` flag replaces React's `mountedRef` — it must
 * survive into `start()/stop()` since async transport callbacks can fire after
 * teardown and would otherwise reconnect a stopped store.
 */
export function createWebSocket({
  url,
  eventStreamUrl,
  authToken,
  onMessage,
  reconnectInterval = 3000,
}: CreateWebSocketOptions): WebSocketStore {
  let status = $state<ConnectionStatus>('disconnected');

  // Plain locals: none of these drive UI, so they must NOT be `$state`.
  let ws: WebSocket | null = null;
  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  const desiredRunIds = new Set<string>();
  let shouldUseEventStream = false;
  let websocketConnected = false;

  function closeEventStream(): void {
    eventSource?.close();
    eventSource = null;
  }

  function closeWebSocket(): void {
    ws?.close();
    ws = null;
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function openEventStream(): void {
    clearReconnectTimer();
    closeEventStream();

    if (!active || desiredRunIds.size === 0) {
      status = 'disconnected';
      return;
    }

    status = 'connecting';
    const source = new EventSource(
      buildEventStreamUrl(eventStreamUrl, authToken, desiredRunIds.values()),
    );
    eventSource = source;

    source.addEventListener('open', () => {
      if (active) {
        status = 'connected';
      }
    });

    source.addEventListener('message', (event) => {
      try {
        const frame = JSON.parse((event as MessageEvent<string>).data) as ServerFrame;
        onMessage?.(frame);
      } catch {
        // Ignore malformed frames.
      }
    });

    source.addEventListener('error', () => {
      if (!active) {
        return;
      }

      status = 'disconnected';
    });
  }

  function connect(): void {
    clearReconnectTimer();

    if (!active) {
      return;
    }

    if (shouldUseEventStream) {
      openEventStream();
      return;
    }

    status = 'connecting';
    const connectionUrl = authToken
      ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(authToken)}`
      : url;
    const socket = new WebSocket(connectionUrl);
    ws = socket;
    let opened = false;

    socket.addEventListener('open', () => {
      opened = true;
      websocketConnected = true;
      closeEventStream();

      for (const runId of desiredRunIds) {
        socket.send(JSON.stringify({ type: 'subscribe', runId } satisfies ClientFrame));
      }

      if (active) {
        status = 'connected';
      }
    });

    socket.addEventListener('message', (event) => {
      try {
        const frame = JSON.parse(event.data as string) as ServerFrame;
        onMessage?.(frame);
      } catch {
        // Ignore malformed frames.
      }
    });

    socket.addEventListener('close', () => {
      if (!active) {
        return;
      }

      ws = null;

      if (!opened && !websocketConnected) {
        shouldUseEventStream = true;
        openEventStream();
        return;
      }

      status = 'disconnected';
      reconnectTimer = setTimeout(connect, reconnectInterval);
    });
  }

  function start(): void {
    active = true;
    connect();
  }

  function stop(): void {
    active = false;
    clearReconnectTimer();
    closeEventStream();
    closeWebSocket();
  }

  function send(frame: ClientFrame): void {
    if (frame.type === 'subscribe') {
      desiredRunIds.add(frame.runId);
    } else if (frame.type === 'unsubscribe') {
      desiredRunIds.delete(frame.runId);
    }

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
      return;
    }

    if (shouldUseEventStream) {
      openEventStream();
    }
  }

  function subscribe(runId: string): void {
    send({ type: 'subscribe', runId });
  }

  function unsubscribe(runId: string): void {
    send({ type: 'unsubscribe', runId });
  }

  return {
    get status() {
      return status;
    },
    start,
    stop,
    send,
    subscribe,
    unsubscribe,
  };
}
