import { useCallback, useEffect, useRef, useState } from 'react';

import type { ClientFrame, ServerFrame } from '../../types';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface UseWebSocketOptions {
  url: string;
  eventStreamUrl: string;
  authToken?: string;
  onMessage?: (frame: ServerFrame) => void;
  reconnectInterval?: number;
}

export interface UseWebSocketResult {
  status: ConnectionStatus;
  send: (frame: ClientFrame) => void;
  subscribe: (runId: string) => void;
  unsubscribe: (runId: string) => void;
}

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

export function useWebSocket({
  url,
  eventStreamUrl,
  authToken,
  onMessage,
  reconnectInterval = 3000,
}: UseWebSocketOptions): UseWebSocketResult {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onMessageRef = useRef(onMessage);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const desiredRunIdsRef = useRef(new Set<string>());
  const shouldUseEventStreamRef = useRef(false);
  const websocketConnectedRef = useRef(false);

  onMessageRef.current = onMessage;

  const closeEventStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const closeWebSocket = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const openEventStream = useCallback(() => {
    clearReconnectTimer();
    closeEventStream();

    if (!mountedRef.current || desiredRunIdsRef.current.size === 0) {
      setStatus('disconnected');
      return;
    }

    setStatus('connecting');
    const source = new EventSource(
      buildEventStreamUrl(eventStreamUrl, authToken, desiredRunIdsRef.current.values()),
    );
    eventSourceRef.current = source;

    source.addEventListener('open', () => {
      if (mountedRef.current) {
        setStatus('connected');
      }
    });

    source.addEventListener('message', (event) => {
      try {
        const frame = JSON.parse((event as MessageEvent<string>).data) as ServerFrame;
        onMessageRef.current?.(frame);
      } catch {
        // Ignore malformed frames.
      }
    });

    source.addEventListener('error', () => {
      if (!mountedRef.current) {
        return;
      }

      setStatus('disconnected');
    });
  }, [authToken, clearReconnectTimer, closeEventStream, eventStreamUrl]);

  const connect = useCallback(() => {
    clearReconnectTimer();

    if (!mountedRef.current) {
      return;
    }

    if (shouldUseEventStreamRef.current) {
      openEventStream();
      return;
    }

    setStatus('connecting');
    const connectionUrl = authToken
      ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(authToken)}`
      : url;
    const ws = new WebSocket(connectionUrl);
    wsRef.current = ws;
    let opened = false;

    ws.addEventListener('open', () => {
      opened = true;
      websocketConnectedRef.current = true;
      closeEventStream();

      for (const runId of desiredRunIdsRef.current) {
        ws.send(JSON.stringify({ type: 'subscribe', runId } satisfies ClientFrame));
      }

      if (mountedRef.current) {
        setStatus('connected');
      }
    });

    ws.addEventListener('message', (event) => {
      try {
        const frame = JSON.parse(event.data as string) as ServerFrame;
        onMessageRef.current?.(frame);
      } catch {
        // Ignore malformed frames.
      }
    });

    ws.addEventListener('close', () => {
      if (!mountedRef.current) {
        return;
      }

      wsRef.current = null;

      if (!opened && !websocketConnectedRef.current) {
        shouldUseEventStreamRef.current = true;
        openEventStream();
        return;
      }

      setStatus('disconnected');
      reconnectTimerRef.current = setTimeout(connect, reconnectInterval);
    });
  }, [authToken, clearReconnectTimer, closeEventStream, openEventStream, reconnectInterval, url]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      clearReconnectTimer();
      closeEventStream();
      closeWebSocket();
    };
  }, [clearReconnectTimer, closeEventStream, closeWebSocket, connect]);

  const send = useCallback(
    (frame: ClientFrame) => {
      if (frame.type === 'subscribe') {
        desiredRunIdsRef.current.add(frame.runId);
      } else if (frame.type === 'unsubscribe') {
        desiredRunIdsRef.current.delete(frame.runId);
      }

      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(frame));
        return;
      }

      if (shouldUseEventStreamRef.current) {
        openEventStream();
      }
    },
    [openEventStream],
  );

  const subscribe = useCallback((runId: string) => send({ type: 'subscribe', runId }), [send]);

  const unsubscribe = useCallback((runId: string) => send({ type: 'unsubscribe', runId }), [send]);

  return { status, send, subscribe, unsubscribe };
}
