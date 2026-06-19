<script lang="ts">
  import { untrack } from 'svelte';

  import type { ConfigurationResponse, RunDetail, RunSummary } from '../types';
  import { createChatStore } from './hooks/use-chat.svelte';
  import { createRunDetailStore } from './hooks/use-run-detail.svelte';
  import { createRunsStore } from './hooks/use-runs.svelte';
  import { createWebSocket } from './hooks/use-websocket.svelte';
  import Layout from './layout.svelte';
  import ChatPage from './pages/chat.svelte';
  import ConfigurationPage from './pages/configuration.svelte';
  import DashboardPage from './pages/dashboard.svelte';
  import RunDetailPage from './pages/run-detail.svelte';
  import { matchRoute } from './router';

  type InitialData = {
    runs?: RunSummary[];
    run?: RunDetail;
    config?: ConfigurationResponse;
  };

  /**
   * Root application component. Single source of truth for the gateway UI:
   * the same component tree renders on the server (svelte/server `render`) and
   * on the client (`hydrate`), so SSR markup and the hydrated app agree for any
   * given `initialData`.
   *
   * It owns the four reactive stores, fans every incoming websocket/SSE frame
   * out to their handlers, drives route-scoped subscriptions, and routes
   * between the four pages inside the shared {@link Layout}.
   */
  let { initialData, pathname }: { initialData: InitialData; pathname: string } = $props();

  const EMPTY_RUN_DETAIL: RunDetail = {
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
  };

  const EMPTY_CONFIGURATION: ConfigurationResponse = {
    provider: undefined,
    providers: [],
    maximumSteps: 10,
    systemPrompt: undefined,
    tools: [],
  };

  let route = $derived(matchRoute(pathname));

  // Stores are constructed in dependency order: runs and run-detail first, then
  // chat (which upserts created runs into the runs list), then the websocket
  // whose onMessage fans frames out to all three. The fan-out closure only runs
  // once frames arrive (post-mount), so the earlier stores are already in scope.
  // `initialData` is one-time hydration seed: the root is hydrated once with
  // fixed props, and each store owns its own reactive state thereafter (fed by
  // live frames). `untrack` expresses that deliberate one-time read so it isn't
  // mistaken for a reactive dependency. It is isomorphic, so the SSR and client
  // seeds stay identical.
  const runsStore = createRunsStore(untrack(() => initialData.runs ?? []));
  const runDetailStore = createRunDetailStore(untrack(() => initialData.run ?? EMPTY_RUN_DETAIL));

  const websocketProtocol =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const websocketHost = typeof window !== 'undefined' ? window.location.host : '';
  const websocketUrl = `${websocketProtocol}//${websocketHost}/ws`;

  const chatStore = createChatStore({
    subscribe: (runId: string) => websocket.subscribe(runId),
    unsubscribe: (runId: string) => websocket.unsubscribe(runId),
    onRunCreated: (run: RunSummary) => runsStore.upsertRun(run),
  });

  const websocket = createWebSocket({
    url: websocketUrl,
    eventStreamUrl: '/api/v1/events',
    onMessage(frame) {
      runsStore.handleMessage(frame);
      runDetailStore.handleMessage(frame);
      chatStore.handleMessage(frame);
    },
  });

  let isDashboardRoute = $derived(route?.name === 'dashboard');
  let detailRunId = $derived(route?.name === 'run-detail' ? route.params['id'] : undefined);

  // The live transport exposes start()/stop() rather than self-connecting, so
  // the root component owns its lifecycle. This effect runs only on the client
  // (effects never run during SSR), opening the transport on mount and tearing
  // it down on unmount.
  $effect(() => {
    websocket.start();
    return () => websocket.stop();
  });

  // Route-scoped subscriptions: a genuine side effect with cleanup keyed to a
  // reactive route, mirroring the two React useEffects exactly.
  $effect(() => {
    if (!isDashboardRoute) return;
    websocket.subscribe('*');
    return () => websocket.unsubscribe('*');
  });

  $effect(() => {
    const id = detailRunId;
    if (!id) return;
    websocket.subscribe(id);
    return () => websocket.unsubscribe(id);
  });
</script>

<Layout connectionStatus={websocket.status} {pathname}>
  {#if route?.name === 'dashboard'}
    <DashboardPage runs={runsStore.runs} />
  {:else if route?.name === 'run-detail'}
    <RunDetailPage
      run={runDetailStore.run}
      events={runDetailStore.events}
      streamingAssistantContent={runDetailStore.streamingAssistantContent}
      toolActivity={runDetailStore.toolActivity}
      connectionStatus={websocket.status}
    />
  {:else if route?.name === 'configuration'}
    <ConfigurationPage config={initialData.config ?? EMPTY_CONFIGURATION} />
  {:else if route?.name === 'chat'}
    <ChatPage chat={chatStore} />
  {:else}
    <p>Page not found.</p>
  {/if}
</Layout>
