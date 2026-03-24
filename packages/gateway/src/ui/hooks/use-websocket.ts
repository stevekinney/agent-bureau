import { useCallback, useEffect, useRef, useState } from 'react';

import type { ClientFrame, ServerFrame } from '../../types';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface UseWebSocketOptions {
  url: string;
  onMessage?: (frame: ServerFrame) => void;
  reconnectInterval?: number;
}

export interface UseWebSocketResult {
  status: ConnectionStatus;
  send: (frame: ClientFrame) => void;
  subscribe: (runId: string) => void;
  unsubscribe: (runId: string) => void;
}

export function useWebSocket({
  url,
  onMessage,
  reconnectInterval = 3000,
}: UseWebSocketOptions): UseWebSocketResult {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    function connect() {
      setStatus('connecting');
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.addEventListener('open', () => setStatus('connected'));

      ws.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data as string) as ServerFrame;
        onMessageRef.current?.(frame);
      });

      ws.addEventListener('close', () => {
        setStatus('disconnected');
        wsRef.current = null;
        setTimeout(connect, reconnectInterval);
      });
    }

    connect();

    return () => {
      const ws = wsRef.current;
      if (ws) {
        ws.close();
        wsRef.current = null;
      }
    };
  }, [url, reconnectInterval]);

  const send = useCallback((frame: ClientFrame) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }, []);

  const subscribe = useCallback((runId: string) => send({ type: 'subscribe', runId }), [send]);

  const unsubscribe = useCallback((runId: string) => send({ type: 'unsubscribe', runId }), [send]);

  return { status, send, subscribe, unsubscribe };
}
