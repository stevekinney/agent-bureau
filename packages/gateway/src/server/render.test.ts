import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import {
  assembleRunTimeline,
  EMPTY_LIVENESS_SNAPSHOT,
  type RunDetailResponse,
} from '../routes/runs';
import type { UsageGroupTotals, UsageResponse } from '../routes/usage';
import type { ConfigurationResponse, PendingReview, RunSummary } from '../types';
import App from '../ui/app.svelte';
import { createBrowserClientEnvironment } from '../ui/client-environment';
import type { ChatStore } from '../ui/hooks/use-chat.svelte';
import type { ReviewsStore } from '../ui/hooks/use-reviews.svelte';
import { createReviewsStore } from '../ui/hooks/use-reviews.svelte';
import ChatPage from '../ui/pages/chat.svelte';
import ConfigurationPage from '../ui/pages/configuration.svelte';
import DashboardPage from '../ui/pages/dashboard.svelte';
import ReviewsPage from '../ui/pages/reviews.svelte';
import RunDetailPage from '../ui/pages/run-detail.svelte';
import UsagePage from '../ui/pages/usage.svelte';
import { renderPage, resetAssetManifestCache } from './render';
import Fixture from './test-fixtures/render-fixture.svelte';
import { extractRootMarkup, stripHydrationMarkers } from './test-utilities';

const baseProps = { initialData: { label: 'hello' }, pathname: '/dashboard' };

// AB-92/AB-272: every renderPage() call in this file that does not pass its
// own `manifestDirectory` relies on the from-source degrade path
// (`cachedManifest` resolving to `{}`, since no `manifest.json` sits next to
// this test's own compiled/source location). The manifest-cache describe
// block below is the only one that ever populates `cachedManifest` with a
// real build; resetting after every test in this file (not just that block)
// keeps that population from leaking into an unrelated test run later in
// the same process.
afterEach(() => {
  resetAssetManifestCache();
});

describe('renderPage', () => {
  it('returns a complete HTML document string', async () => {
    const html = await renderPage({ title: 'Test Page', component: Fixture, props: baseProps });

    expect(typeof html).toBe('string');
    expect(html).toStartWith('<!doctype html>');
    expect(html).toContain('<html lang="en"');
  });

  it('activates cinder dark mode by setting data-theme="dark" on <html>', async () => {
    // Cinder's tokens use CSS `light-dark()` gated on `color-scheme`; the
    // `[data-theme="dark"]` selector flips `color-scheme` to dark so every
    // component resolves its dark arm. Without this attribute the page renders
    // cinder's light palette against the app shell — the bug this fixes.
    const html = await renderPage({ title: 'Test', component: Fixture, props: baseProps });

    expect(html).toContain('<html lang="en" data-theme="dark">');
  });

  it('includes the title in the HTML output', async () => {
    const html = await renderPage({ title: 'My Dashboard', component: Fixture, props: baseProps });

    expect(html).toContain('<title>My Dashboard</title>');
  });

  it('HTML-escapes the title so an untrusted run id cannot inject markup', async () => {
    // pages.ts builds titles like `Run ${run.id}`; a malicious id must not be
    // able to break out of the <title> element or inject a script.
    const html = await renderPage({
      title: 'Run </title><script>alert(1)</script>',
      component: Fixture,
      props: baseProps,
    });

    expect(html).not.toContain('</title><script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders the Svelte component markup inside the root div', async () => {
    const html = await renderPage({ title: 'Test', component: Fixture, props: baseProps });

    expect(html).toContain('id="root"');
    expect(html).toContain('<h1>Fixture</h1>');
    expect(html).toContain('hello');
  });

  it('passes props through to the rendered component', async () => {
    const html = await renderPage({
      title: 'Test',
      component: Fixture,
      props: { initialData: { label: 'projected' }, pathname: '/runs/abc' },
    });

    expect(html).toContain('projected');
    expect(html).toContain('data-pathname="/runs/abc"');
  });

  it('serializes the props into window.__INITIAL_DATA__ by default', async () => {
    const html = await renderPage({ title: 'Test', component: Fixture, props: baseProps });

    expect(html).toContain('window.__INITIAL_DATA__ =');
    expect(html).toContain(JSON.stringify(baseProps));
  });

  it('serializes an explicit data payload over the props when provided', async () => {
    const data = { runs: [{ id: 'run-1', status: 'completed' }] };
    const html = await renderPage({
      title: 'Test',
      component: Fixture,
      props: baseProps,
      data,
    });

    expect(html).toContain('window.__INITIAL_DATA__ =');
    expect(html).toContain(JSON.stringify(data));
  });

  it('escapes < to prevent breaking out of the script tag (XSS)', async () => {
    const data = { value: '</script><script>alert(1)</script>' };
    const html = await renderPage({
      title: 'Test',
      component: Fixture,
      props: baseProps,
      data,
    });

    // The raw closing tag must not survive into the inline data script.
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script');
  });

  it('escapes U+2028 and U+2029 line terminators', async () => {
    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);
    const data = { value: `line${lineSeparator}sep${paragraphSeparator}para` };
    const html = await renderPage({
      title: 'Test',
      component: Fixture,
      props: baseProps,
      data,
    });

    expect(html).not.toContain(lineSeparator);
    expect(html).not.toContain(paragraphSeparator);
    expect(html).toContain('\\u2028');
    expect(html).toContain('\\u2029');
  });

  it('includes the stylesheet link for a styled first paint', async () => {
    const html = await renderPage({ title: 'Test', component: Fixture, props: baseProps });

    expect(html).toContain('rel="stylesheet"');
    expect(html).toContain('/public/styles.css');
  });

  it('includes the hydration client module script', async () => {
    const html = await renderPage({ title: 'Test', component: Fixture, props: baseProps });

    expect(html).toContain('type="module"');
    expect(html).toContain('/public/entry.js');
  });
});

describe('renderPage with a populated run-detail page', () => {
  // The run-detail route is the heaviest cinder surface in the migration:
  // CodeBlock (streaming output), PayloadInspector (tool calls / results),
  // RunStepTimeline, EventStreamViewer, and StatisticGroup. Empty-state rendering of
  // the other routes proves none of this, so this test renders the REAL page
  // with fully populated data — including a tool call carrying a code string to
  // hit the payload/code path — to prove SSR does not throw and emits the
  // expected visible content and public semantics.
  const populatedRunEvents = [
    {
      sequence: 0,
      runId: 'run-populated',
      event: 'run.started',
      detail: { at: 0 },
      timestamp: 1,
    },
    {
      sequence: 1,
      runId: 'run-populated',
      event: 'tool.completed',
      detail: { tool: 'read_file', ok: true },
      timestamp: 2,
    },
    // AB-12 milestone kinds — one of each so the timeline section proves it
    // classifies and renders every kind, not just the generic event stream.
    {
      sequence: 2,
      runId: 'run-populated',
      event: 'step.started',
      detail: { step: 1 },
      timestamp: 3,
    },
    {
      sequence: 3,
      runId: 'run-populated',
      event: 'generate.retry',
      detail: { attempt: 1, error: 'rate limited' },
      timestamp: 4,
    },
    {
      sequence: 4,
      runId: 'run-populated',
      event: 'multiagent.child-workflow.started',
      detail: { parentAgentName: 'lead', childAgentName: 'researcher' },
      timestamp: 5,
    },
    {
      sequence: 5,
      runId: 'run-populated',
      event: 'multiagent.handoff.occurred',
      detail: { sourceAgentName: 'lead', targetAgentName: 'closer' },
      timestamp: 6,
    },
    {
      sequence: 6,
      runId: 'run-populated',
      event: 'multiagent.human-wait.parked',
      detail: { signalName: 'human-response', prompt: 'Approve the refund?' },
      timestamp: 7,
    },
    {
      sequence: 7,
      runId: 'run-populated',
      event: 'workflow.reattached',
      detail: {
        sessionId: 'session-1',
        versionMismatch: true,
        storedVersion: 'v1',
        registeredVersion: 'v2',
      },
      timestamp: 8,
    },
    {
      sequence: 8,
      runId: 'run-populated',
      event: 'run.completed',
      detail: { finishReason: 'stop' },
      timestamp: 9,
    },
  ];

  const populatedRun: RunDetailResponse = {
    id: 'run-populated',
    sessionId: 'session-1',
    status: 'completed',
    steps: 2,
    usage: { prompt: 120, completion: 80, total: 200 },
    finishReason: 'stop',
    error: undefined,
    actionCount: 1,
    agentName: 'bureau',
    principal: undefined,
    startedAt: 0,
    stepDetails: [
      {
        step: 0,
        content: 'Calling a tool to read the file.',
        final: false,
        usage: { prompt: 60, completion: 40, total: 100 },
        toolCalls: [
          {
            id: 'call-1',
            name: 'read_file',
            arguments: { path: 'src/index.ts', snippet: 'export const answer = 42;\n' },
          },
        ],
        results: [{ toolName: 'read_file', result: { contents: 'export const answer = 42;\n' } }],
      },
      {
        step: 1,
        content: 'The file exports `answer = 42`.',
        final: true,
        usage: { prompt: 60, completion: 40, total: 100 },
        toolCalls: [],
        results: [],
      },
    ],
    latestSnapshot: new Conversation(createConversationHistory({ id: 'conversation-1' }), {
      now: () => '2026-01-01T00:00:00.000Z',
    }).snapshot(),
    liveness: EMPTY_LIVENESS_SNAPSHOT,
    events: populatedRunEvents,
    timeline: assembleRunTimeline(populatedRunEvents),
  };

  const props = {
    run: populatedRun,
    events: populatedRun.events.map((record) => ({
      event: record.event,
      detail: record.detail,
      timestamp: record.timestamp,
      sequence: record.sequence,
    })),
    streamingAssistantContent: 'const greeting = "hello";\nconsole.log(greeting);\n',
    toolActivity: ['read_file → completed'],
    connectionStatus: 'connected' as const,
  };

  it('server-renders the heavy cinder components without throwing', async () => {
    const html = await renderPage({ title: 'Run run-populated', component: RunDetailPage, props });

    expect(html).toStartWith('<!doctype html>');
    expect(html).toContain('<title>Run run-populated</title>');
  });

  it('renders populated run details through the event, step, payload, code, and usage surfaces', async () => {
    const html = await renderPage({ title: 'Run run-populated', component: RunDetailPage, props });
    const rootMarkup = extractRootMarkup(html);

    const pageHeadings = [...rootMarkup.matchAll(/<h1\b[^>]*>(.*?)<\/h1>/gs)];
    expect(pageHeadings).toHaveLength(1);
    expect(stripHydrationMarkers(pageHeadings[0]?.[1] ?? '')).toBe('Run run-populated');
    expect(rootMarkup.match(/<h[1-4]\b/)?.[0]).toBe('<h1');

    // Section headings the page composes around the heavy components.
    expect(rootMarkup).toContain('Summary');
    expect(rootMarkup).toContain('Streaming Output');
    expect(rootMarkup).toContain('Tool Activity');
    expect(rootMarkup).toContain('Event Stream');

    // Public labels and fixture data prove each surface rendered under SSR.
    expect(rootMarkup).toContain('aria-label="Token usage"');
    expect(rootMarkup).toContain('Prompt');
    expect(rootMarkup).toContain('120');
    expect(rootMarkup).toContain('Completion');
    expect(rootMarkup).toContain('80');
    expect(rootMarkup).toContain('Total');
    expect(rootMarkup).toContain('200');
    expect(rootMarkup).toContain('const greeting = "hello"');
    expect(rootMarkup).toContain('read_file → completed');
    expect(rootMarkup).toContain('aria-label="Run steps"');
    expect(rootMarkup).toContain('Step 1');
    expect(rootMarkup).toContain('Step 2 (final)');
    expect(rootMarkup).toContain('Step 1 tool calls');
    expect(rootMarkup).toContain('Step 1 results');
    expect(rootMarkup).toContain('"name": "read_file"');
    expect(rootMarkup).toContain('"path": "src/index.ts"');
    expect(rootMarkup).toContain('"toolName": "read_file"');
    expect(rootMarkup).toContain('"contents": "export const answer = 42;\\n"');
    expect(rootMarkup).toContain('Latest conversation snapshot');
    expect(rootMarkup).toContain('aria-label="JSON tree"');
    expect(rootMarkup).not.toContain('activeview');
    expect(rootMarkup).not.toContain('meta="[object Object]"');
    expect(rootMarkup).toContain('aria-label="Run event stream"');
    expect(rootMarkup).toContain('run.completed');
  });

  it('bounds large tool-result CodeBlock output during SSR', async () => {
    const resultTail = 'RESULT-END';
    const firstStep = populatedRun.stepDetails[0]!;
    const finalStep = populatedRun.stepDetails[1]!;
    const largeResultRun: RunDetailResponse = {
      ...populatedRun,
      stepDetails: [
        {
          ...firstStep,
          results: [{ toolName: 'read_file', result: `${'x'.repeat(1_100_000)}${resultTail}` }],
        },
        finalStep,
      ],
    };
    const html = await renderPage({
      title: 'Run run-populated',
      component: RunDetailPage,
      props: { ...props, run: largeResultRun },
    });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).toContain('[Payload truncated at 1 MiB]');
    expect(rootMarkup).not.toContain(resultTail);
    expect(new TextEncoder().encode(rootMarkup).byteLength).toBeLessThan(1_200_000);
  });

  // AB-12 — the run-inspector Timeline section renders every milestone kind
  // classified from the run's event log: checkpoint boundaries,
  // HumanWaitParkedEvent, ChildWorkflowStartedEvent, HandoffOccurredEvent,
  // the recovery/reattach marker (including AB-10's version-mismatch
  // detail), and a generate retry attempt.
  it('renders a Timeline section covering every AB-12 milestone kind', async () => {
    const html = await renderPage({ title: 'Run run-populated', component: RunDetailPage, props });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).toContain('Timeline');

    // Milestone kind badges.
    expect(rootMarkup).toContain('Checkpoint');
    expect(rootMarkup).toContain('Retry');
    expect(rootMarkup).toContain('Child workflow');
    expect(rootMarkup).toContain('Handoff');
    expect(rootMarkup).toContain('Parked');
    expect(rootMarkup).toContain('Reattached');

    // Underlying event types and detail — proves real timeline data flowed
    // through the classification, not just static badge labels.
    expect(rootMarkup).toContain('step.started');
    expect(rootMarkup).toContain('generate.retry');
    expect(rootMarkup).toContain('multiagent.child-workflow.started');
    expect(rootMarkup).toContain('multiagent.handoff.occurred');
    expect(rootMarkup).toContain('multiagent.human-wait.parked');
    expect(rootMarkup).toContain('workflow.reattached');
    expect(rootMarkup).toContain('human-response');
    expect(rootMarkup).toContain('v1');
    expect(rootMarkup).toContain('v2');
  });

  // Regression (Codex review, PR #203) — the Timeline section must classify
  // milestones from the LIVE `events` list, not the server-fetched
  // `run.timeline` snapshot. Simulates exactly the staleness scenario the
  // review flagged: a milestone (`multiagent.human-wait.parked`) has arrived
  // over the live stream and is in `events`, but `run.timeline` is still the
  // stale (here, empty) snapshot from before that event landed — the page
  // must render the milestone from `events` regardless.
  it('classifies timeline milestones from live events, not the stale run.timeline snapshot', async () => {
    const staleRun: RunDetailResponse = { ...populatedRun, timeline: [] };
    const html = await renderPage({
      title: 'Run run-populated',
      component: RunDetailPage,
      props: { ...props, run: staleRun },
    });

    expect(html).toContain('Parked');
    expect(html).toContain('multiagent.human-wait.parked');
    expect(html).toContain('Reattached');
    expect(html).toContain('workflow.reattached');
  });

  // AB-12 — a run parked on a human-wait signal offers a resume affordance,
  // reusing the AB-20 review-queue store and its `ReviewRow` component
  // rather than a second approve/deny code path. This exercises the actual
  // client-side render branch (`{#if parkedReview}` in run-detail.svelte),
  // not just the server-side `findParkedReview` helper in isolation.
  it('shows the "Awaiting Human Input" resume affordance for a parked run', async () => {
    const parkedReview: PendingReview = {
      kind: 'human-wait',
      id: 'human-wait:run-populated:human-response',
      runId: 'run-populated',
      sessionId: 'session-1',
      agentName: 'bureau',
      signalName: 'human-response',
      prompt: 'Approve the refund?',
      requestedAt: 0,
      ageMilliseconds: 5000,
      status: 'pending',
    };
    const reviews = createReviewsStore([parkedReview], createBrowserClientEnvironment());

    const html = await renderPage({
      title: 'Run run-populated',
      component: RunDetailPage,
      props: { ...props, reviews },
    });

    expect(html).toContain('Awaiting Human Input');
    expect(html).toContain('human-response');
    expect(html).toContain('Approve the refund?');
    expect(html).toContain('Approve');
    expect(html).toContain('Deny');
    expect(html).toContain('<div class="review-row-reason-field');
  });

  // A review parking a DIFFERENT run must not surface here — the affordance
  // is scoped to the run this page is showing, not the whole queue.
  it('does not show a resume affordance for a review parking a different run', async () => {
    const otherRunReview: PendingReview = {
      kind: 'human-wait',
      id: 'human-wait:other-run:human-response',
      runId: 'other-run',
      sessionId: 'session-2',
      agentName: 'bureau',
      signalName: 'human-response',
      prompt: 'Approve the refund?',
      requestedAt: 0,
      ageMilliseconds: 5000,
      status: 'pending',
    };
    const reviews = createReviewsStore([otherRunReview], createBrowserClientEnvironment());

    const html = await renderPage({
      title: 'Run run-populated',
      component: RunDetailPage,
      props: { ...props, reviews },
    });

    expect(html).not.toContain('Awaiting Human Input');
  });

  it('does not mark a completed step failed just because the run failed later', async () => {
    const erroredRunEvents = [
      {
        sequence: 0,
        runId: 'run-error-after-step',
        event: 'step.completed',
        detail: { step: 0 },
        timestamp: 1,
      },
      {
        sequence: 1,
        runId: 'run-error-after-step',
        event: 'run.error',
        detail: { error: 'The next step failed before it completed.' },
        timestamp: 2,
      },
    ];
    const erroredRun: RunDetailResponse = {
      ...populatedRun,
      id: 'run-error-after-step',
      status: 'error',
      finishReason: 'error',
      error: 'The next step failed before it completed.',
      steps: 1,
      stepDetails: [
        {
          step: 0,
          content: 'This step completed before the later failure.',
          final: false,
          usage: { prompt: 60, completion: 40, total: 100 },
          toolCalls: [],
          results: [],
        },
      ],
      events: erroredRunEvents,
      timeline: assembleRunTimeline(erroredRunEvents),
    };
    const html = await renderPage({
      title: 'Run run-error-after-step',
      component: RunDetailPage,
      props: {
        ...props,
        run: erroredRun,
        events: erroredRun.events.map((record) => ({
          event: record.event,
          detail: record.detail,
          timestamp: record.timestamp,
          sequence: record.sequence,
        })),
        streamingAssistantContent: '',
        toolActivity: [],
      },
    });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).toContain('aria-label="Status: Succeeded"');
    expect(rootMarkup).not.toContain('aria-label="Status: Failed"');
  });
});

describe('renderPage with a populated usage page', () => {
  // The `/usage` route's aggregate tiles are the other Cinder StatisticGroup
  // surface. The `/usage` SSR coverage elsewhere only exercises the zero-run
  // empty state, which renders no statistics at all — so this test pins the
  // public contract of the populated view: the group's accessible name, every
  // tile label, and every formatted value.
  const usage: UsageResponse = {
    aggregate: {
      promptTokens: 1200,
      completionTokens: 850,
      totalTokens: 2050,
      cacheCreationTokens: 300,
      cacheReadTokens: 150,
      runCount: 7,
      totalCost: 1.2345,
      costComplete: true,
    },
    analytics: { byAgent: [], byPrincipal: [], byWindow: [] },
    runs: [],
  };

  it('renders every aggregate statistic under the "Usage totals" group', async () => {
    const html = await renderPage({
      title: 'Usage & Cost',
      component: UsagePage,
      props: { initialData: { usage }, pathname: '/usage', usage },
    });
    const rootMarkup = extractRootMarkup(html);

    const pageHeadings = [...rootMarkup.matchAll(/<h1\b[^>]*>(.*?)<\/h1>/gs)];
    expect(pageHeadings).toHaveLength(1);
    expect(stripHydrationMarkers(pageHeadings[0]?.[1] ?? '')).toBe('Usage &amp; Cost');

    // The accessible name of the statistic group, not just its visual variant.
    expect(rootMarkup).toContain('aria-label="Usage totals"');

    expect(rootMarkup).toContain('Runs');
    expect(rootMarkup).toContain('7');
    expect(rootMarkup).toContain('Prompt Tokens');
    expect(rootMarkup).toContain('1,200');
    expect(rootMarkup).toContain('Completion Tokens');
    expect(rootMarkup).toContain('850');
    expect(rootMarkup).toContain('Total Tokens');
    expect(rootMarkup).toContain('2,050');
    expect(rootMarkup).toContain('Cache Write Tokens');
    expect(rootMarkup).toContain('300');
    expect(rootMarkup).toContain('Cache Read Tokens');
    expect(rootMarkup).toContain('150');
    expect(rootMarkup).toContain('Estimated Cost');
    expect(rootMarkup).toContain('$1.2345');
  });

  it('omits the cache statistics when no run touched the prompt cache', async () => {
    const withoutCache: UsageResponse = {
      ...usage,
      aggregate: { ...usage.aggregate, cacheCreationTokens: 0, cacheReadTokens: 0 },
    };
    const html = await renderPage({
      title: 'Usage & Cost',
      component: UsagePage,
      props: { initialData: { usage: withoutCache }, pathname: '/usage', usage: withoutCache },
    });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).toContain('aria-label="Usage totals"');
    expect(rootMarkup).not.toContain('Cache Write Tokens');
    expect(rootMarkup).not.toContain('Cache Read Tokens');
  });

  it('renders a row per group in the By Agent, By Principal, and By Time Window tables, and appends "+" to an incomplete cost total', async () => {
    function group(key: string, costComplete: boolean): UsageGroupTotals {
      return {
        key,
        runCount: 3,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCost: 0.5,
        costComplete,
      };
    }
    const populated: UsageResponse = {
      ...usage,
      analytics: {
        byAgent: [group('bureau', true), group('reviewer', false)],
        byPrincipal: [group('api-key:abc123', true)],
        byWindow: [group('2026-09-01', true)],
      },
    };

    const html = await renderPage({
      title: 'Usage & Cost',
      component: UsagePage,
      props: { initialData: { usage: populated }, pathname: '/usage', usage: populated },
    });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).toContain('Usage by agent');
    expect(rootMarkup).toContain('bureau');
    expect(rootMarkup).toContain('reviewer');
    expect(rootMarkup).toContain('Usage by authenticated principal');
    expect(rootMarkup).toContain('api-key:abc123');
    expect(rootMarkup).toContain('Usage by time window');
    expect(rootMarkup).toContain('2026-09-01');

    // The complete group's cost has no floor suffix; the incomplete one does.
    const costCells = [...rootMarkup.matchAll(/\$0\.50\+?/g)].map((match) => match[0]);
    expect(costCells).toContain('$0.50');
    expect(costCells).toContain('$0.50+');
  });
});

// AB-92/AB-272: `cachedManifest` (render.ts:10) is module-level state — a
// single Bun process rendering pages for two independently built gateway
// deployments (for example two loopback gateways in one test file, each
// pointed at its own build output) would otherwise serve the FIRST build's
// manifest to both, silently mismatching the second one's actual hashed
// asset URLs. `resetAssetManifestCache()` is the public seam that clears it
// between reads that must see a different build.
describe('resetAssetManifestCache', () => {
  const createdDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });

  async function writeManifestFixture(entryLabel: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-render-manifest-'));
    createdDirectories.push(directory);
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        'entry.js': `/public/entry-${entryLabel}.js`,
        'styles.css': `/public/styles-${entryLabel}.css`,
      }),
    );
    return directory;
  }

  it('reads a manifest.json from manifestDirectory when present', async () => {
    const directory = await writeManifestFixture('first');

    const html = await renderPage({
      title: 'Test',
      component: Fixture,
      props: baseProps,
      manifestDirectory: directory,
    });

    expect(html).toContain('/public/entry-first.js');
    expect(html).toContain('/public/styles-first.css');
  });

  it('without a reset, a later render over a different manifestDirectory incorrectly reuses the first cached manifest', async () => {
    const firstDirectory = await writeManifestFixture('first');
    const secondDirectory = await writeManifestFixture('second');

    const firstHtml = await renderPage({
      title: 'Test',
      component: Fixture,
      props: baseProps,
      manifestDirectory: firstDirectory,
    });
    expect(firstHtml).toContain('/public/entry-first.js');

    // No resetAssetManifestCache() call here — this documents the bug the
    // reset exists to fix: the cache is process-wide, so the second read
    // still returns the first build's manifest.
    const secondHtmlWithoutReset = await renderPage({
      title: 'Test',
      component: Fixture,
      props: baseProps,
      manifestDirectory: secondDirectory,
    });
    expect(secondHtmlWithoutReset).toContain('/public/entry-first.js');
    expect(secondHtmlWithoutReset).not.toContain('/public/entry-second.js');
  });

  it('two builds rendered in one process each render their own manifest once reset between them', async () => {
    const firstDirectory = await writeManifestFixture('first');
    const secondDirectory = await writeManifestFixture('second');

    const firstHtml = await renderPage({
      title: 'Test',
      component: Fixture,
      props: baseProps,
      manifestDirectory: firstDirectory,
    });
    expect(firstHtml).toContain('/public/entry-first.js');
    expect(firstHtml).toContain('/public/styles-first.css');

    resetAssetManifestCache();

    const secondHtml = await renderPage({
      title: 'Test',
      component: Fixture,
      props: baseProps,
      manifestDirectory: secondDirectory,
    });
    expect(secondHtml).toContain('/public/entry-second.js');
    expect(secondHtml).toContain('/public/styles-second.css');
    expect(secondHtml).not.toContain('/public/entry-first.js');

    // Reset back to the first build and confirm it round-trips — proves the
    // cache genuinely re-reads from disk each time rather than merely
    // toggling between two remembered values.
    resetAssetManifestCache();
    const firstAgainHtml = await renderPage({
      title: 'Test',
      component: Fixture,
      props: baseProps,
      manifestDirectory: firstDirectory,
    });
    expect(firstAgainHtml).toContain('/public/entry-first.js');
    expect(firstAgainHtml).not.toContain('/public/entry-second.js');
  });
});

// AB-92/AB-272: `isBuiltOutput` reflects where render.ts itself was loaded
// from, which is always "source" under `bun test`. `assumeBuiltOutput`
// (test-only) drives the built-mode manifest failure branches directly.
describe('renderPage in built mode (assumeBuiltOutput override)', () => {
  const createdDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });

  it('throws when dist/manifest.json is missing in built mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-render-built-missing-'));
    createdDirectories.push(directory);

    let rejection: unknown;
    try {
      await renderPage({
        title: 'Test',
        component: Fixture,
        props: baseProps,
        manifestDirectory: directory,
        assumeBuiltOutput: true,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('dist/manifest.json is missing or invalid');
  });

  it('throws when dist/manifest.json is missing a required key in built mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-render-built-incomplete-'));
    createdDirectories.push(directory);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ 'entry.js': '/x.js' }));

    let rejection: unknown;
    try {
      await renderPage({
        title: 'Test',
        component: Fixture,
        props: baseProps,
        manifestDirectory: directory,
        assumeBuiltOutput: true,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('missing required styles.css entr(y/ies)');
  });

  it('succeeds in built mode when the manifest carries every required key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-render-built-complete-'));
    createdDirectories.push(directory);
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        'entry.js': '/public/entry-built.js',
        'styles.css': '/public/styles-built.css',
      }),
    );

    const html = await renderPage({
      title: 'Test',
      component: Fixture,
      props: baseProps,
      manifestDirectory: directory,
      assumeBuiltOutput: true,
    });

    expect(html).toContain('/public/entry-built.js');
    expect(html).toContain('/public/styles-built.css');
  });
});

function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    status: 'running',
    steps: 0,
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: undefined,
    error: undefined,
    actionCount: 0,
    agentName: 'bureau',
    principal: undefined,
    startedAt: 0,
    ...overrides,
  };
}

describe('dashboard page (Table of RunRow, and RunRow/StatusBadge by extension)', () => {
  it('renders the empty state when there are no runs', async () => {
    const html = await renderPage({
      title: 'Dashboard',
      component: DashboardPage,
      props: { initialData: { runs: [] }, pathname: '/', runs: [] },
    });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).toContain('No runs yet.');
    expect(rootMarkup).not.toContain('<table');
  });

  it('renders one RunRow per run, linked by id, with steps/tokens/finish reason, and every status badge variant', async () => {
    // Every branch of status-badge.svelte's statusToVariant switch,
    // including its default fallback for an unrecognized status string.
    const runs: RunSummary[] = [
      makeRunSummary({
        id: 'run-running',
        status: 'running',
        steps: 3,
        usage: { prompt: 10, completion: 5, total: 15 },
        finishReason: undefined,
      }),
      makeRunSummary({
        id: 'run-completed',
        status: 'completed',
        steps: 5,
        usage: { prompt: 20, completion: 10, total: 30 },
        finishReason: 'stop-condition',
      }),
      makeRunSummary({ id: 'run-error', status: 'error' }),
      makeRunSummary({ id: 'run-aborted', status: 'aborted' }),
      makeRunSummary({ id: 'run-pending', status: 'pending' }),
      makeRunSummary({ id: 'run-unknown-status', status: 'a-status-nobody-invented-yet' }),
    ];

    const html = await renderPage({
      title: 'Dashboard',
      component: DashboardPage,
      props: { initialData: { runs }, pathname: '/', runs },
    });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).not.toContain('No runs yet.');
    expect(rootMarkup).toContain('href="/runs/run-running"');
    expect(rootMarkup).toContain('>run-running<');
    expect(rootMarkup).toContain('>3<');
    expect(rootMarkup).toContain('>15<');
    // No finishReason renders the em dash fallback.
    expect(rootMarkup).toContain('>—<');
    expect(rootMarkup).toContain('>stop-condition<');

    for (const status of [
      'running',
      'completed',
      'error',
      'aborted',
      'pending',
      'a-status-nobody-invented-yet',
    ]) {
      expect(rootMarkup).toContain(`>${status}<`);
    }
  });
});

function makeChatStore(overrides: Partial<ChatStore> = {}): ChatStore {
  return {
    conversation: createConversationHistory({ id: 'conversation-1' }),
    runId: undefined,
    sending: false,
    error: undefined,
    sessionId: undefined,
    streamingAssistantContent: '',
    toolActivity: [],
    send: async () => {},
    handleMessage: () => {},
    ...overrides,
  };
}

function makeReviewsStore(overrides: Partial<ReviewsStore> = {}): ReviewsStore {
  return {
    reviews: [],
    loading: false,
    pendingId: undefined,
    error: undefined,
    refresh: async () => {},
    approve: async () => {},
    deny: async () => {},
    ...overrides,
  };
}

describe('chat page (every {#if} branch: errors, pending-review inline surface, tool activity)', () => {
  it('renders no error callouts, no pending-review section, and no tool-activity section when everything is idle', async () => {
    const chat = makeChatStore();
    const reviews = makeReviewsStore();

    const html = await renderPage({
      title: 'Chat',
      component: ChatPage,
      props: { initialData: { chat, reviews }, pathname: '/', chat, reviews },
    });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).not.toContain('Chat error');
    expect(rootMarkup).not.toContain('Review error');
    expect(rootMarkup).not.toContain('Needs your input');
    expect(rootMarkup).not.toContain('Tool Activity');
  });

  it('renders the chat error callout, the review error callout, an inline ReviewRow scoped to the active run, and the tool-activity log', async () => {
    const chat = makeChatStore({
      runId: 'run-1',
      error: 'The provider timed out.',
      toolActivity: ['read_file → completed', 'write_file → completed'],
    });
    const reviews = makeReviewsStore({
      error: 'Could not refresh reviews.',
      reviews: [
        // Belongs to the active run — must render inline in the chat.
        {
          kind: 'human-wait',
          id: 'review-1',
          runId: 'run-1',
          sessionId: 'session-1',
          agentName: 'bureau',
          signalName: 'human-response',
          prompt: 'What is your name?',
          requestedAt: 0,
          ageMilliseconds: 0,
          status: 'pending',
        },
        // Belongs to a DIFFERENT run — must be filtered out of the inline surface.
        {
          kind: 'human-wait',
          id: 'review-2',
          runId: 'run-2',
          sessionId: 'session-2',
          agentName: 'bureau',
          signalName: 'human-response',
          prompt: 'Unrelated question',
          requestedAt: 0,
          ageMilliseconds: 0,
          status: 'pending',
        },
      ] satisfies PendingReview[],
    });

    const html = await renderPage({
      title: 'Chat',
      component: ChatPage,
      props: { initialData: { chat, reviews }, pathname: '/', chat, reviews },
    });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).toContain('Chat error');
    expect(rootMarkup).toContain('The provider timed out.');
    expect(rootMarkup).toContain('Review error');
    expect(rootMarkup).toContain('Could not refresh reviews.');

    expect(rootMarkup).toContain('Needs your input');
    expect(rootMarkup).toContain('What is your name?');
    expect(rootMarkup).not.toContain('Unrelated question');

    expect(rootMarkup).toContain('Tool Activity');
    expect(rootMarkup).toContain('read_file → completed');
    expect(rootMarkup).toContain('write_file → completed');
  });
});

describe('reviews page (Card list of ReviewRow, and ReviewRow by extension)', () => {
  it('renders the empty state and no error callout when there are no reviews and no error', async () => {
    const reviews = makeReviewsStore();

    const html = await renderPage({
      title: 'Review Queue',
      component: ReviewsPage,
      props: { initialData: { reviews }, pathname: '/reviews', reviews },
    });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).toContain('Nothing pending review.');
    expect(rootMarkup).not.toContain('Review queue error');
  });

  it('renders the error callout, a tool-approval row with a reason and no agent, and a human-wait row with a prompt and an agent', async () => {
    const reviews = makeReviewsStore({
      error: 'Could not refresh reviews.',
      reviews: [
        {
          kind: 'tool-approval',
          id: 'approval-1',
          runId: 'run-1',
          sessionId: 'session-1',
          agentName: undefined,
          approval: {
            callId: 'call-1',
            toolName: 'delete_file',
            arguments: { path: '/tmp/scratch.txt' },
            action: { type: 'approval' },
            reason: 'Destructive operation requires sign-off',
          },
          requestedAt: 0,
          ageMilliseconds: 65_000,
          status: 'pending',
        },
        {
          kind: 'human-wait',
          id: 'wait-1',
          runId: 'run-2',
          sessionId: 'session-2',
          agentName: 'bureau',
          signalName: 'human-response',
          prompt: 'What is your name?',
          requestedAt: 0,
          ageMilliseconds: 500,
          status: 'pending',
        },
      ] satisfies PendingReview[],
    });

    const html = await renderPage({
      title: 'Review Queue',
      component: ReviewsPage,
      props: { initialData: { reviews }, pathname: '/reviews', reviews },
    });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).toContain('Review queue error');
    expect(rootMarkup).toContain('Could not refresh reviews.');
    expect(rootMarkup).not.toContain('Nothing pending review.');

    expect(rootMarkup).toContain('Tool approval');
    expect(rootMarkup).toContain('delete_file');
    expect(rootMarkup).toContain('Destructive operation requires sign-off');
    expect(rootMarkup).toContain('href="/runs/run-1"');

    expect(rootMarkup).toContain('Human input');
    expect(rootMarkup).toContain('human-response');
    expect(rootMarkup).toContain('What is your name?');
    expect(rootMarkup).toContain('href="/runs/run-2"');

    // Only the human-wait row (agentName: 'bureau') renders the "· <agent>"
    // suffix — the tool-approval row (agentName: undefined) renders none.
    expect(
      [...rootMarkup.matchAll(/review-row-agent">·\s*(\S+)<\/span>/g)].map((m) => m[1]),
    ).toEqual(['bureau']);

    expect(rootMarkup).toContain('1m ago');
    expect(rootMarkup).toContain('just now');
    expect(rootMarkup).not.toContain('just now ago');
  });
});

describe('configuration page (purely presentational — every {#if} branch)', () => {
  it('renders the no-provider empty state, "None" for an unset system prompt, and no Tools section when there are no tools', async () => {
    const config: ConfigurationResponse = {
      provider: undefined,
      providers: [],
      maximumSteps: 25,
      systemPrompt: undefined,
      tools: [],
    };

    const html = await renderPage({
      title: 'Configuration',
      component: ConfigurationPage,
      props: { initialData: { config }, pathname: '/configuration', config },
    });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).toContain('No provider configured.');
    expect(rootMarkup).toContain('25');
    expect(rootMarkup).toContain('None');
    expect(rootMarkup).not.toContain('Tools (');
  });

  it('renders the provider description list, the configured system prompt, and the tools list with names and descriptions', async () => {
    const config: ConfigurationResponse = {
      provider: { provider: 'anthropic', model: 'claude-opus-4-5' },
      providers: [],
      maximumSteps: 40,
      systemPrompt: 'You are a helpful assistant.',
      tools: [
        { name: 'read_file', description: 'Reads a file from disk.' },
        { name: 'write_file', description: 'Writes a file to disk.' },
      ],
    };

    const html = await renderPage({
      title: 'Configuration',
      component: ConfigurationPage,
      props: { initialData: { config }, pathname: '/configuration', config },
    });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).not.toContain('No provider configured.');
    expect(rootMarkup).toContain('anthropic');
    expect(rootMarkup).toContain('claude-opus-4-5');
    expect(rootMarkup).toContain('40');
    expect(rootMarkup).toContain('You are a helpful assistant.');
    expect(rootMarkup).toContain('Tools (2)');
    expect(rootMarkup).toContain('read_file');
    expect(rootMarkup).toContain('Reads a file from disk.');
    expect(rootMarkup).toContain('write_file');
    expect(rootMarkup).toContain('Writes a file to disk.');
  });
});

describe('App root shell', () => {
  it('renders "Page not found." for a pathname none of the six routes match', async () => {
    const html = await renderPage({
      title: 'Not Found',
      component: App,
      props: { initialData: {}, pathname: '/nonexistent-route' },
    });
    const rootMarkup = extractRootMarkup(html);

    expect(rootMarkup).toContain('Page not found.');
  });
});
