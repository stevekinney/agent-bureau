import { useCallback, useRef, useState } from 'react';

import type { RunSummary, ServerFrame } from '../../types';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface UseChatOptions {
  subscribe: (runId: string) => void;
  unsubscribe: (runId: string) => void;
}

export interface UseChatResult {
  messages: ChatMessage[];
  runId: string | undefined;
  sending: boolean;
  error: string | undefined;
  send: (message: string) => Promise<void>;
  handleMessage: (frame: ServerFrame) => void;
}

export function useChat({ subscribe, unsubscribe }: UseChatOptions): UseChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const runIdRef = useRef<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const send = useCallback(
    async (message: string) => {
      setSending(true);
      setError(undefined);
      setMessages((previous) => [...previous, { role: 'user', content: message }]);

      try {
        const response = await fetch('/api/v1/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          setError(errorBody || `Request failed with status ${response.status}`);
          return;
        }

        const data = (await response.json()) as RunSummary;

        // Unsubscribe from the previous run before subscribing to the new one.
        if (runIdRef.current) {
          unsubscribe(runIdRef.current);
        }

        // Subscribe immediately — before setting state — so the WebSocket
        // subscription is active before the next microtask, eliminating the
        // race where the run completes before the useEffect-based subscription
        // in App could fire.
        subscribe(data.id);

        runIdRef.current = data.id;
        setRunId(data.id);
      } catch (fetchError) {
        setError(fetchError instanceof Error ? fetchError.message : 'Network error');
      } finally {
        setSending(false);
      }
    },
    [subscribe, unsubscribe],
  );

  const handleMessage = useCallback((frame: ServerFrame) => {
    if (frame.type !== 'event') return;
    if (frame.runId !== runIdRef.current) return;

    if (frame.event === 'run.completed') {
      const detail = frame.detail as { content?: string };
      if (detail.content) {
        setMessages((previous) => [
          ...previous,
          { role: 'assistant', content: detail.content as string },
        ]);
      }
    }
  }, []);

  return { messages, runId, sending, error, send, handleMessage };
}
