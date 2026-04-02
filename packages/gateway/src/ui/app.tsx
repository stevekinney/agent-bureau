import { useEffect, useRef } from 'react';

import type { ConfigurationResponse, RunDetail, RunSummary, ServerFrame } from '../types';
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
  run?: RunDetail;
  config?: ConfigurationResponse;
}

export function App({ initialData, pathname }: { initialData: InitialData; pathname: string }) {
  const route = matchRoute(pathname);
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
  const eventStreamUrl = '/api/v1/events';

  const runsHook = useRuns(initialData.runs ?? []);
  const runDetailHook = useRunDetail(
    initialData.run ?? {
      id: '',
      sessionId: '',
      status: 'running',
      steps: 0,
      usage: { prompt: 0, completion: 0, total: 0 },
      finishReason: undefined,
      error: undefined,
      actionCount: 0,
      events: [],
      stepDetails: [],
      latestSnapshot: undefined,
    },
  );

  // Use a ref for the chat message handler so useWebSocket's onMessage can
  // reference it without a circular hook dependency.
  const chatHandleMessageRef = useRef<(frame: ServerFrame) => void>(() => {});

  const {
    status: connectionStatus,
    subscribe,
    unsubscribe,
  } = useWebSocket({
    url: wsUrl,
    eventStreamUrl,
    onMessage(frame) {
      runsHook.handleMessage(frame);
      runDetailHook.handleMessage(frame);
      chatHandleMessageRef.current(frame);
    },
  });

  // useChat now subscribes to the WebSocket synchronously on run creation,
  // eliminating the race where the run completes before the useEffect-based
  // subscription could fire.
  const chat = useChat({ subscribe, unsubscribe, onRunCreated: runsHook.upsertRun });
  chatHandleMessageRef.current = chat.handleMessage;

  const isDashboardRoute = route?.name === 'dashboard';
  const detailRunId = route?.name === 'run-detail' ? route.params?.['id'] : undefined;
  useEffect(() => {
    if (isDashboardRoute) {
      subscribe('*');
      return () => unsubscribe('*');
    }

    return undefined;
  }, [isDashboardRoute, subscribe, unsubscribe]);

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
        return (
          <RunDetailPage
            run={runDetailHook.run}
            events={runDetailHook.events}
            streamingAssistantContent={runDetailHook.streamingAssistantContent}
            toolActivity={runDetailHook.toolActivity}
          />
        );
      case 'configuration':
        return (
          <ConfigurationPage
            config={
              initialData.config ?? {
                provider: undefined,
                providers: [],
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
