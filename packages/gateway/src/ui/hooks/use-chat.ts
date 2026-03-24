import { useCallback, useRef, useState } from 'react';

import type { RunSummary, ServerFrame } from '../../types';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface UseChatResult {
  messages: ChatMessage[];
  runId: string | undefined;
  sending: boolean;
  send: (message: string) => Promise<void>;
  handleMessage: (frame: ServerFrame) => void;
}

export function useChat(): UseChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const runIdRef = useRef<string | undefined>(undefined);
  const [sending, setSending] = useState(false);

  const send = useCallback(async (message: string) => {
    setSending(true);
    setMessages((previous) => [...previous, { role: 'user', content: message }]);

    const response = await fetch('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    const data = (await response.json()) as RunSummary;
    runIdRef.current = data.id;
    setRunId(data.id);
    setSending(false);
  }, []);

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

  return { messages, runId, sending, send, handleMessage };
}
