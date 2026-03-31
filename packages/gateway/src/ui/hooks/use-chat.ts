import { useCallback, useRef, useState } from 'react';

import type { RunSummary, ServerFrame } from '../../types';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export interface UseChatOptions {
  onRunCreated?: (run: RunSummary) => void;
  subscribe: (runId: string) => void;
  unsubscribe: (runId: string) => void;
}

export interface UseChatResult {
  messages: ChatMessage[];
  runId: string | undefined;
  sending: boolean;
  error: string | undefined;
  sessionId: string | undefined;
  streamingAssistantContent: string;
  toolActivity: string[];
  send: (message: string) => Promise<void>;
  handleMessage: (frame: ServerFrame) => void;
}

function summarizeToolArguments(argumentsValue: unknown): string {
  if (argumentsValue === undefined) {
    return '';
  }

  if (
    typeof argumentsValue === 'string' ||
    typeof argumentsValue === 'number' ||
    typeof argumentsValue === 'boolean' ||
    typeof argumentsValue === 'bigint'
  ) {
    return String(argumentsValue);
  }

  if (argumentsValue instanceof Error) {
    return argumentsValue.message;
  }

  if (typeof argumentsValue === 'symbol') {
    return argumentsValue.description ? `Symbol(${argumentsValue.description})` : 'Symbol()';
  }

  try {
    return JSON.stringify(argumentsValue);
  } catch {
    return Object.prototype.toString.call(argumentsValue);
  }
}

export function useChat({ onRunCreated, subscribe, unsubscribe }: UseChatOptions): UseChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const runIdRef = useRef<string | undefined>(undefined);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [streamingAssistantContent, setStreamingAssistantContent] = useState('');
  const streamingContentRef = useRef('');
  const [toolActivity, setToolActivity] = useState<string[]>([]);

  const send = useCallback(
    async (message: string) => {
      setSending(true);
      setError(undefined);
      setStreamingAssistantContent('');
      streamingContentRef.current = '';
      setToolActivity([]);
      setMessages((previous) => [...previous, { role: 'user', content: message }]);

      try {
        const response = await fetch('/api/v1/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message,
            sessionId: sessionIdRef.current,
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          setError(errorBody || `Request failed with status ${response.status}`);
          return;
        }

        const data = (await response.json()) as RunSummary;

        if (runIdRef.current) {
          unsubscribe(runIdRef.current);
        }

        subscribe(data.id);
        runIdRef.current = data.id;
        sessionIdRef.current = data.sessionId;
        setRunId(data.id);
        setSessionId(data.sessionId);
        onRunCreated?.(data);
      } catch (fetchError) {
        setError(fetchError instanceof Error ? fetchError.message : 'Network error');
      } finally {
        setSending(false);
      }
    },
    [onRunCreated, subscribe, unsubscribe],
  );

  const handleMessage = useCallback((frame: ServerFrame) => {
    if (!('runId' in frame) || frame.runId !== runIdRef.current) return;

    switch (frame.type) {
      case 'event': {
        if (frame.event === 'run.completed') {
          const detail = frame.detail as { content?: string };
          const assistantContent = streamingContentRef.current || detail.content;
          if (assistantContent) {
            setMessages((previous) => [
              ...previous,
              { role: 'assistant', content: assistantContent },
            ]);
          }
          streamingContentRef.current = '';
          setStreamingAssistantContent('');
        }

        if (frame.event === 'run.error') {
          const detail = frame.detail as { error?: string };
          setError(detail.error ?? 'Run failed');
          streamingContentRef.current = '';
          setStreamingAssistantContent('');
        }

        if (frame.event === 'run.aborted') {
          streamingContentRef.current = '';
          setStreamingAssistantContent('');
        }

        break;
      }
      case 'stream:text-delta':
        streamingContentRef.current = frame.accumulated;
        setStreamingAssistantContent(frame.accumulated);
        break;
      case 'stream:tool-call-start':
        setToolActivity((previous) => [...previous, `Calling ${frame.toolName}`]);
        break;
      case 'stream:tool-call-delta':
        setToolActivity((previous) => {
          const next = [...previous];
          next[next.length - 1] =
            next[next.length - 1] ?? `Calling ${frame.toolName}: ${frame.partialArgs}`;
          if (next.length > 0) {
            next[next.length - 1] = `${frame.toolName}: ${frame.partialArgs}`;
          }
          return next;
        });
        break;
      case 'stream:tool-call-complete':
        setToolActivity((previous) => [
          ...previous,
          `${frame.toolName} completed ${summarizeToolArguments(frame.arguments)}`.trim(),
        ]);
        break;
      case 'subscribed':
      case 'unsubscribed':
      case 'stream:complete':
      case 'stream:error':
        break;
    }
  }, []);

  return {
    messages,
    runId,
    sending,
    error,
    sessionId,
    streamingAssistantContent,
    toolActivity,
    send,
    handleMessage,
  };
}
