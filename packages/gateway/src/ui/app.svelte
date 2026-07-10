<script lang="ts">
  import { untrack } from 'svelte';

  import type { RunDetailResponse } from '../routes/runs';
  import type { UsageResponse } from '../routes/usage';
  import type {
    ConfigurationResponse,
    EvaluationReportsResponse,
    PendingReview,
    RunSummary,
  } from '../types';
  import { createChatStore } from './hooks/use-chat.svelte';
  import { createReviewsStore } from './hooks/use-reviews.svelte';
  import { createRunDetailStore } from './hooks/use-run-detail.svelte';
  import { createRunsStore } from './hooks/use-runs.svelte';
  import { createWebSocket } from './hooks/use-websocket.svelte';
  import Layout from './layout.svelte';
  import ChatPage from './pages/chat.svelte';
  import ConfigurationPage from './pages/configuration.svelte';
  import DashboardPage from './pages/dashboard.svelte';
  import EvaluationsPage from './pages/evaluations.svelte';
  import ReviewsPage from './pages/reviews.svelte';
  import RunDetailPage from './pages/run-detail.svelte';
  import UsagePage from './pages/usage.svelte';
  import { matchRoute } from './router';

  type InitialData = {
    runs?: RunSummary[];
    run?: RunDetailResponse;
    config?: ConfigurationResponse;
    reviews?: PendingReview[];
    usage?: UsageResponse;
    evaluations?: EvaluationReportsResponse;
  };

  /**
   * Root application component. Single source of truth for the gateway UI:
   * the same component tree renders on the server (svelte/server `render`) and
   * on the client (`hydrate`), so SSR markup and the hydrated app agree for any
   * given `initialData`.
   *
   * It owns the four reactive stores, fans every incoming websocket/SSE frame
   * out to their handlers, drives route-scoped subscriptions, and routes
   * between the six pages inside the shared {@link Layout}.
   */
  let { initialData, pathname }: { initialData: InitialData; pathname: string } = $props();

  const EMPTY_RUN_DETAIL: RunDetailResponse = {
    id: '',
    sessionId: '',
    status: 'running',
    steps: 0,
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: undefined,
    error: undefined,
    actionCount: 0,
    agentName: undefined,
    principal: undefined,
    startedAt: undefined,
    events: [],
    stepDetails: [],
    latestSnapshot: undefined,
    timeline: [],
  };

  const EMPTY_CONFIGURATION: ConfigurationResponse = {
    provider: undefined,
    providers: [],
    maximumSteps: 10,
    systemPrompt: undefined,
    tools: [],
  };

  const EMPTY_USAGE: UsageResponse = {
    aggregate: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      runCount: 0,
      totalCost: 0,
      costComplete: true,
    },
    analytics: { byAgent: [], byPrincipal: [], byWindow: [] },
    runs: [],
  };
  const EMPTY_EVALUATIONS: EvaluationReportsResponse = { reports: [] };

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
  const reviewsStore = createReviewsStore(untrack(() => initialData.reviews ?? []));

  const websocketProtocol =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const websocketHost = typeof window !== 'undefined' ? window.location.host : '';
  const websocketUrl = `${websocketProtocol}//${websocketHost}/ws`;

  const chatStore = createChatStore({
    subscribe: (runId: string) => websocket.subscribe(runId),
    unsubscribe: (runId: string) => websocket.unsubscribe(runId),
    onRunCreated: (run: RunSummary) => runsStore.upsertRun(run),
    // AB-23: a tool call parked on `needs_approval` or a durable run parked
    // on `requestHumanInput` both surface as a `PendingReview` — refresh the
    // queue immediately instead of waiting for the next poll tick so the
    // chat surface's inline form appears promptly.
    onHumanInputRequested: () => void reviewsStore.refresh(),
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
  let isReviewsRoute = $derived(route?.name === 'reviews');
  let isChatRoute = $derived(route?.name === 'chat');
  let isRunDetailRoute = $derived(route?.name === 'run-detail');
  let detailRunId = $derived(route?.name === 'run-detail' ? route.params['id'] : undefined);

  /**
   * Poll interval for the review queue, in milliseconds. The review queue has
   * no live websocket/SSE feed (unlike runs) — a review is created/resolved
   * by a direct human action elsewhere, not a run's step loop — so staying
   * current means polling while the page is open. The chat page (AB-23) is
   * included whenever a run is active so its inline elicitation/human-wait
   * form (a review whose `runId` matches the active chat run) stays current
   * even if the `onHumanInputRequested` fast-path trigger is missed. The
   * run-detail page (AB-12) is included unconditionally — its resume
   * affordance needs to notice a run parking on `ctx.waitForSignal` while
   * the operator is already looking at it, not just on the next visit.
   */
  const REVIEWS_POLL_INTERVAL_MS = 5000;
  let shouldPollReviews = $derived(
    isReviewsRoute || isRunDetailRoute || (isChatRoute && chatStore.runId !== undefined),
  );

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

  // Keep the review queue current while it is relevant (see
  // REVIEWS_POLL_INTERVAL_MS above for why this is polling, not a live feed).
  $effect(() => {
    if (!shouldPollReviews) return;
    const interval = setInterval(() => void reviewsStore.refresh(), REVIEWS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  });

  // Entering the chat route with an already-active run (e.g. the chat store
  // was seeded before this effect first ran) should surface an
  // already-parked review immediately, not after the first poll tick.
  $effect(() => {
    if (!isChatRoute || chatStore.runId === undefined) return;
    void reviewsStore.refresh();
  });

  // Same immediacy for the run-detail route: a run parked on human-wait
  // before this page loaded should show its resume affordance right away.
  $effect(() => {
    if (!isRunDetailRoute) return;
    void reviewsStore.refresh();
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
      reviews={reviewsStore}
    />
  {:else if route?.name === 'reviews'}
    <ReviewsPage reviews={reviewsStore} />
  {:else if route?.name === 'usage'}
    <UsagePage usage={initialData.usage ?? EMPTY_USAGE} />
  {:else if route?.name === 'configuration'}
    <ConfigurationPage config={initialData.config ?? EMPTY_CONFIGURATION} />
  {:else if route?.name === 'chat'}
    <ChatPage chat={chatStore} reviews={reviewsStore} />
  {:else if route?.name === 'evaluations'}
    <EvaluationsPage evaluations={initialData.evaluations ?? EMPTY_EVALUATIONS} />
  {:else}
    <p>Page not found.</p>
  {/if}
</Layout>
