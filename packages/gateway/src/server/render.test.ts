import { describe, expect, it } from 'bun:test';

import { assembleRunTimeline, type RunDetailResponse } from '../routes/runs';
import type { PendingReview } from '../types';
import { createReviewsStore } from '../ui/hooks/use-reviews.svelte';
import RunDetailPage from '../ui/pages/run-detail.svelte';
import { renderPage } from './render';
import Fixture from './test-fixtures/render-fixture.svelte';
import { extractRootMarkup } from './test-utilities';

const baseProps = { initialData: { label: 'hello' }, pathname: '/dashboard' };

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
  // RunStepTimeline, EventStreamViewer, and StatGroup. Empty-state rendering of
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
    // The page passes latestSnapshot straight to JsonViewer (opaque object) or
    // renders an EmptyState when undefined. Its internal shape is irrelevant to
    // what this test proves, so leave it undefined and let the tool
    // calls/results/timeline detail exercise JsonViewer instead.
    latestSnapshot: undefined,
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
    connectionStatus: 'connected',
  };

  it('server-renders the heavy cinder components without throwing', async () => {
    const html = await renderPage({ title: 'Run run-populated', component: RunDetailPage, props });

    expect(html).toStartWith('<!doctype html>');
    expect(html).toContain('<title>Run run-populated</title>');
  });

  it('renders populated run details through the event, step, payload, code, and usage surfaces', async () => {
    const html = await renderPage({ title: 'Run run-populated', component: RunDetailPage, props });
    const rootMarkup = extractRootMarkup(html);

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
    expect(rootMarkup).toContain('aria-label="Run event stream"');
    expect(rootMarkup).toContain('run.completed');
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
    };
    const reviews = createReviewsStore([parkedReview]);

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
    };
    const reviews = createReviewsStore([otherRunReview]);

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
