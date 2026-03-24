import { useEffect, useRef } from 'react';

import type { ConfigurationResponse, RunSummary } from '../types';
import { useChat } from './hooks/use-chat';
import { useRunDetail } from './hooks/use-run-detail';
import { useRuns } from './hooks/use-runs';
import { useWebSocket } from './hooks/use-websocket';
import { Layout } from './layout';
import { ChatPage } from './pages/chat';
import { ConfigurationPage } from './pages/configuration';
import { DashboardPage } from './pages/dashboard';
import { RunDetailPage } from './pages/run-detail';
import { matchRoute } from './router';

interface InitialData {
  runs?: RunSummary[];
  run?: RunSummary;
  config?: ConfigurationResponse;
}

export function App({ initialData, pathname }: { initialData: InitialData; pathname: string }) {
  const route = matchRoute(pathname);
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

  const runsHook = useRuns(initialData.runs ?? []);
  const runDetailHook = useRunDetail(
    initialData.run ?? {
      id: '',
      status: 'running',
      steps: 0,
      usage: { prompt: 0, completion: 0, total: 0 },
      finishReason: undefined,
      error: undefined,
      actionCount: 0,
    },
  );
  const chat = useChat();

  const {
    status: connectionStatus,
    subscribe,
    unsubscribe,
  } = useWebSocket({
    url: wsUrl,
    onMessage(frame) {
      runsHook.handleMessage(frame);
      runDetailHook.handleMessage(frame);
      chat.handleMessage(frame);
    },
  });

  // Subscribe to the chat run when it's created
  const previousChatRunIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (chat.runId && chat.runId !== previousChatRunIdRef.current) {
      if (previousChatRunIdRef.current) {
        unsubscribe(previousChatRunIdRef.current);
      }
      subscribe(chat.runId);
      previousChatRunIdRef.current = chat.runId;
    }
  }, [chat.runId, subscribe, unsubscribe]);

  // Subscribe to the run detail page's run
  const detailRunId = route?.name === 'run-detail' ? route.params?.['id'] : undefined;
  useEffect(() => {
    if (!detailRunId) return;
    subscribe(detailRunId);
    return () => unsubscribe(detailRunId);
  }, [detailRunId, subscribe, unsubscribe]);

  function renderPage() {
    switch (route?.name) {
      case 'dashboard':
        return <DashboardPage runs={runsHook.runs} />;
      case 'run-detail':
        return <RunDetailPage run={runDetailHook.run} />;
      case 'configuration':
        return (
          <ConfigurationPage
            config={
              initialData.config ?? {
                provider: undefined,
                maximumSteps: 10,
                systemPrompt: undefined,
                tools: [],
              }
            }
          />
        );
      case 'chat':
        return <ChatPage chat={chat} />;
      default:
        return <p>Page not found.</p>;
    }
  }

  return <Layout connectionStatus={connectionStatus}>{renderPage()}</Layout>;
}
