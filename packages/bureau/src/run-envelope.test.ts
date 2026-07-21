/**
 * Tests for AB-96's bureau-side run envelope wiring:
 * `createRunFrameForwarder`, `buildTerminalReportFromCompletedEvent`,
 * `buildTerminalReportFromAbortedEvent`, `buildPartialRunReport`, and the
 * `Bureau.getRunReport` / `run-envelope` `ServerFrame` surface they feed.
 */
import { createTool, createToolbox } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { TypedEventTarget } from 'lifecycle';
import {
  type ActiveRun,
  BudgetExceededEvent,
  BudgetThresholdEvent,
  ContextBudgetWarningEvent,
  createActiveRun,
  ElicitationRequestedEvent,
  type GenerateFunction,
  type RunFrame,
  runFrameSchema,
  StreamCustomEvent,
  type StreamEventMap,
  type Toolbox,
} from 'operative';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import {
  buildPartialRunReport,
  buildTerminalReportFromAbortedEvent,
  buildTerminalReportFromCompletedEvent,
  createRunFrameForwarder,
} from './run-envelope';
import type { ServerFrame } from './types';

function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

function roundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

/**
 * A minimal `ActiveRun` stub for exercising `createRunFrameForwarder`'s
 * notification-frame listeners directly, without driving a full agent loop
 * through a real cost budget or context-window configuration. Only
 * `addEventListener`/`removeEventListener` are real (backed by a plain
 * `EventTarget`) — `createRunFrameForwarder` never calls anything else on
 * its `activeRun` parameter, so the rest of the interface is stubbed out.
 */
function createEventDrivenActiveRun(): {
  activeRun: ActiveRun;
  dispatch: (event: Event) => void;
} {
  const target = new EventTarget();
  const notImplemented = () => {
    throw new Error('not implemented in this test stub');
  };
  const activeRun = {
    result: new Promise<never>(() => {}),
    abort: () => {},
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    on: notImplemented,
    once: notImplemented,
    subscribe: notImplemented,
    events: notImplemented,
    toObservable: notImplemented,
    complete: () => {},
    [Symbol.dispose]: () => {},
  } as unknown as ActiveRun;

  return { activeRun, dispatch: (event) => target.dispatchEvent(event) };
}

describe('createRunFrameForwarder', () => {
  it('forwards run-started through tool-pre/tool-post to run-finished frames, all JSON round-trip-safe', async () => {
    const addTool = createTool({
      name: 'add',
      description: 'add two numbers',
      input: z.object({ a: z.number(), b: z.number(), apiKey: z.string().optional() }),
      execute: async ({ a, b }) => ({ total: a + b }),
    });

    const generate: GenerateFunction = async ({ step }) =>
      step === 0
        ? {
            content: '',
            toolCalls: [{ name: 'add', arguments: { a: 2, b: 2, apiKey: 'sk-secret' } }],
          }
        : { content: 'The answer is 4.', toolCalls: [] };

    const activeRun: ActiveRun = createActiveRun({
      generate,
      toolbox: createTestToolbox([addTool]),
      conversation: new Conversation(),
      maximumSteps: 5,
      agentName: 'test-agent',
      runId: 'run-forwarder-1',
    });

    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-forwarder-1', activeRun, (frame) => {
      frames.push(frame);
    });

    await activeRun.result;
    dispose();

    // Every frame is JSON-safe and validates against the exported schema.
    for (const frame of frames) {
      const roundTripped = roundTrip(frame);
      expect(roundTripped).toEqual(JSON.parse(JSON.stringify(frame)));
      expect(() => runFrameSchema.parse(roundTripped)).not.toThrow();
    }

    const types = frames.map((frame) => frame.type);
    expect(types).toContain('step');
    expect(types).toContain('tool-pre');
    expect(types).toContain('tool-post');
    expect(types).toContain('assistant-final');

    const toolPre = frames.find((frame) => frame.type === 'tool-pre');
    expect(toolPre?.type).toBe('tool-pre');
    if (toolPre?.type === 'tool-pre') {
      expect(toolPre.toolName).toBe('add');
      // The apiKey argument is redacted, never leaked into the frame.
      expect(toolPre.inputSummary).toMatchObject({ apiKey: '[redacted]', a: 2, b: 2 });
    }

    const toolPost = frames.find((frame) => frame.type === 'tool-post');
    expect(toolPost?.type).toBe('tool-post');
    if (toolPost?.type === 'tool-post') {
      expect(toolPost.status).toBe('success');
      expect(toolPost.resultSummary).toMatchObject({ total: 4 });
    }

    // Disposing removes every listener — no more frames after dispose.
    const countAfterDispose = frames.length;
    await activeRun.result;
    expect(frames.length).toBe(countAfterDispose);
  });

  it('stops emitting frames once disposed', async () => {
    const generate: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });
    const activeRun = createActiveRun({
      generate,
      toolbox: createEmptyToolbox(),
      conversation: new Conversation(),
      maximumSteps: 1,
      runId: 'run-forwarder-2',
    });

    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-forwarder-2', activeRun, (frame) =>
      frames.push(frame),
    );
    dispose();

    await activeRun.result;
    expect(frames.length).toBe(0);
  });

  it('emits exactly one tool-post frame for a failing tool call (regression: create-run.ts fires both tool.settled AND tool.error for the same failure)', async () => {
    const failingTool = createTool({
      name: 'explode',
      description: 'always fails',
      input: z.object({}),
      execute: async () => {
        throw new Error('kaboom');
      },
    });

    const generate: GenerateFunction = async ({ step }) =>
      step === 0
        ? { content: '', toolCalls: [{ name: 'explode', arguments: {} }] }
        : { content: 'recovered', toolCalls: [] };

    const activeRun = createActiveRun({
      generate,
      toolbox: createTestToolbox([failingTool]),
      conversation: new Conversation(),
      maximumSteps: 5,
      runId: 'run-forwarder-3',
    });

    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-forwarder-3', activeRun, (frame) =>
      frames.push(frame),
    );

    await activeRun.result;
    dispose();

    const toolPostFrames = frames.filter((frame) => frame.type === 'tool-post');
    expect(toolPostFrames.length).toBe(1);
    expect(toolPostFrames[0]?.status).toBe('error');
    expect(toolPostFrames[0]?.error).toBe('kaboom');
  });

  it('emits exactly one tool-post frame for a policy-denied tool call (regression: create-tool.ts fires policy-denied AND settled for the same denial)', async () => {
    const deniedTool = createTool({
      name: 'restricted',
      description: 'never allowed',
      input: z.object({}),
      policy: {
        beforeExecute: () => ({ allow: false, reason: 'not permitted' }),
      },
      execute: async () => 'unreachable',
    });

    const generate: GenerateFunction = async ({ step }) =>
      step === 0
        ? { content: '', toolCalls: [{ name: 'restricted', arguments: {} }] }
        : { content: 'moving on', toolCalls: [] };

    const activeRun = createActiveRun({
      generate,
      toolbox: createTestToolbox([deniedTool]),
      conversation: new Conversation(),
      maximumSteps: 5,
      runId: 'run-forwarder-4',
    });

    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-forwarder-4', activeRun, (frame) =>
      frames.push(frame),
    );

    await activeRun.result;
    dispose();

    const toolPostFrames = frames.filter((frame) => frame.type === 'tool-post');
    expect(toolPostFrames.length).toBe(1);
    expect(toolPostFrames[0]?.status).toBe('denied');
    expect(toolPostFrames[0]?.error).toBe('not permitted');
  });

  it('emits a warning notification frame when the cost budget threshold is crossed', () => {
    const { activeRun, dispatch } = createEventDrivenActiveRun();
    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-budget-threshold', activeRun, (frame) =>
      frames.push(frame),
    );

    dispatch(
      new BudgetThresholdEvent({
        threshold: 0.8,
        currentCost: 4,
        budget: 5,
        model: 'claude-sonnet-5',
      }),
    );
    dispose();

    const notification = frames.find((frame) => frame.type === 'notification');
    expect(notification?.type).toBe('notification');
    if (notification?.type === 'notification') {
      expect(notification.level).toBe('warning');
      expect(notification.code).toBe('budget.threshold');
      expect(notification.message).toBe('Cost budget at 80% (4 of 5)');
    }
  });

  it('emits an error notification frame when the cost budget is exceeded', () => {
    const { activeRun, dispatch } = createEventDrivenActiveRun();
    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-budget-exceeded', activeRun, (frame) =>
      frames.push(frame),
    );

    dispatch(new BudgetExceededEvent({ currentCost: 6, budget: 5, model: 'claude-sonnet-5' }));
    dispose();

    const notification = frames.find((frame) => frame.type === 'notification');
    expect(notification?.type).toBe('notification');
    if (notification?.type === 'notification') {
      expect(notification.level).toBe('error');
      expect(notification.code).toBe('budget.exceeded');
      expect(notification.message).toBe('Cost budget exceeded (6 of 5)');
    }
  });

  it('emits a warning notification frame when the context window budget is running low', () => {
    const { activeRun, dispatch } = createEventDrivenActiveRun();
    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-context-budget', activeRun, (frame) =>
      frames.push(frame),
    );

    dispatch(new ContextBudgetWarningEvent(2, 7_500, 500, 8_000));
    dispose();

    const notification = frames.find((frame) => frame.type === 'notification');
    expect(notification?.type).toBe('notification');
    if (notification?.type === 'notification') {
      expect(notification.step).toBe(2);
      expect(notification.level).toBe('warning');
      expect(notification.code).toBe('context.budget-warning');
      expect(notification.message).toBe('Context budget: 500 of 8000 tokens remaining');
    }
  });

  it('emits an info notification frame for an elicitation request', () => {
    const { activeRun, dispatch } = createEventDrivenActiveRun();
    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder('run-elicitation', activeRun, (frame) =>
      frames.push(frame),
    );

    dispatch(new ElicitationRequestedEvent(1, 'Do you want to proceed?'));
    dispose();

    const notification = frames.find((frame) => frame.type === 'notification');
    expect(notification?.type).toBe('notification');
    if (notification?.type === 'notification') {
      expect(notification.step).toBe(1);
      expect(notification.level).toBe('info');
      expect(notification.code).toBe('elicitation.requested');
      expect(notification.message).toBe('Do you want to proceed?');
    }
  });

  it('forwards stream:text-delta events from an optional streamEventTarget into assistant-chunk frames', () => {
    const { activeRun } = createEventDrivenActiveRun();
    const streamEventTarget = new TypedEventTarget<StreamEventMap>();
    const frames: RunFrame[] = [];
    const dispose = createRunFrameForwarder(
      'run-stream-chunk',
      activeRun,
      (frame) => frames.push(frame),
      { streamEventTarget },
    );

    streamEventTarget.dispatchEvent(
      new StreamCustomEvent('stream:text-delta', {
        type: 'stream:text-delta',
        content: 'Hel',
        accumulated: 'Hel',
      }),
    );

    const chunk = frames.find((frame) => frame.type === 'assistant-chunk');
    expect(chunk?.type).toBe('assistant-chunk');
    if (chunk?.type === 'assistant-chunk') {
      expect(chunk.delta).toBe('Hel');
      expect(chunk.accumulated).toBe('Hel');
    }

    // Disposing removes the streamEventTarget listener too — no more chunks after.
    dispose();
    streamEventTarget.dispatchEvent(
      new StreamCustomEvent('stream:text-delta', {
        type: 'stream:text-delta',
        content: 'lo',
        accumulated: 'Hello',
      }),
    );
    expect(frames.filter((frame) => frame.type === 'assistant-chunk')).toHaveLength(1);
  });
});

describe('buildTerminalReportFromCompletedEvent / buildTerminalReportFromAbortedEvent', () => {
  it('builds a succeeded report with usage, costEstimate, and effectiveModel from a completed run', async () => {
    const generate: GenerateFunction = async () => ({
      content: 'Done.',
      toolCalls: [],
      usage: { prompt: 10, completion: 5, total: 15 },
      metadata: { effectiveModel: 'claude-sonnet-5', effectiveEffort: 'medium' },
    });

    const activeRun = createActiveRun({
      generate,
      toolbox: createEmptyToolbox(),
      conversation: new Conversation(),
      maximumSteps: 1,
      runId: 'run-completed-1',
      costEstimation: { model: 'claude-sonnet-5' },
    });

    let captured: Parameters<typeof buildTerminalReportFromCompletedEvent>[1] | undefined;
    activeRun.once('run.completed', (event) => {
      captured = event;
    });

    const result = await activeRun.result;
    expect(result.finishReason).toBe('maximum-steps');
    expect(captured).toBeDefined();

    const report = buildTerminalReportFromCompletedEvent('run-completed-1', captured!);
    expect(report.status).toBe('succeeded');
    expect(report.usage).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(report.effectiveModel).toBe('claude-sonnet-5');
    expect(report.effectiveEffort).toBe('medium');
    expect(report.transcript?.ids.length).toBeGreaterThan(0);

    const roundTripped = roundTrip(report);
    expect(roundTripped).toEqual(JSON.parse(JSON.stringify(report)));
  });

  it('builds a budget_stopped report when the run finishes on budget-exceeded', () => {
    // Exercises the mapping/build helper directly against a hand-built event
    // shape (the same fields RunCompletedEvent carries) rather than wiring a
    // full budget monitor through a real run.
    const conversation = new Conversation();
    conversation.appendUserMessage('hi');

    const report = buildTerminalReportFromCompletedEvent('run-budget-1', {
      finishReason: 'budget-exceeded',
      usage: { prompt: 3, completion: 1, total: 4 },
      steps: [],
      conversation,
      error: new Error('budget exceeded'),
    });

    expect(report.status).toBe('budget_stopped');
    expect(report.error).toBe('budget exceeded');
  });

  it('builds an aborted report from a run.aborted event, pulling steps from the store', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('hi');
    conversation.appendAssistantMessage('partial');

    const report = buildTerminalReportFromAbortedEvent('run-aborted-1', {
      usage: { prompt: 4, completion: 2, total: 6 },
      reason: 'user cancelled',
      steps: [],
      conversation,
    });

    expect(report.status).toBe('aborted');
    expect(report.finishReason).toBe('aborted');
    expect(report.error).toBe('user cancelled');
    expect(report.usage).toEqual({ prompt: 4, completion: 2, total: 6 });
    expect(report.transcript?.ids.length).toBeGreaterThan(0);
  });
});

describe('buildPartialRunReport', () => {
  it('synchronously builds a partial aborted report from a live RunState', () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('hi');
    conversation.appendAssistantMessage('working on it', {
      effectiveModel: 'claude-sonnet-5',
      effectiveEffort: 'low',
    });

    const runState = {
      id: 'run-partial-1',
      status: 'running' as const,
      steps: [
        {
          step: 0,
          conversation,
          content: 'working on it',
          toolCalls: [],
          results: [],
          usage: { prompt: 6, completion: 3, total: 9 },
          metadata: { effectiveModel: 'claude-sonnet-5', effectiveEffort: 'low' },
          final: false,
        },
      ],
      usage: { prompt: 6, completion: 3, total: 9 },
      finishReason: undefined,
      error: undefined,
      // The real store (`store.ts`) always pushes a `conversation.snapshot()`
      // alongside every `step.completed` action, in the same reducer update as
      // the step itself — so a genuine RunState never has more steps than
      // snapshots. Mirror that invariant here.
      snapshots: [conversation.snapshot()],
      actions: [],
      activeRun: {} as ActiveRun,
    };

    const report = buildPartialRunReport('run-partial-1', runState, 'process shutdown');
    expect(report.status).toBe('aborted');
    expect(report.usage).toEqual({ prompt: 6, completion: 3, total: 9 });
    expect(report.effectiveModel).toBe('claude-sonnet-5');
    expect(report.error).toBe('process shutdown');
    expect(report.transcript?.ids.length).toBeGreaterThan(0);
  });

  it('reads the transcript from the last COMPLETED step snapshot, not a later in-flight mutation of the shared Conversation (regression PRRT_kwDORvupsc6PxWjh)', () => {
    // AB-96 codex review: every StepResult.conversation is the SAME mutable
    // Conversation instance the loop threads through every step (see
    // `run-step.ts`). Reading `steps[last].conversation` while a LATER step is
    // still in flight (e.g. it already pushed a tool call but has not yet
    // committed the tool result) would read that dangling, uncommitted state.
    // `buildPartialRunReport` must read the STORE'S OWN immutable snapshot
    // (`runState.snapshots`, captured via `conversation.snapshot()` at each
    // `step.completed`) instead, which freezes the transcript at the moment
    // the step actually finished.
    const conversation = new Conversation();
    conversation.appendUserMessage('hi');
    conversation.appendAssistantMessage('step 0 done', {
      effectiveModel: 'claude-sonnet-5',
      effectiveEffort: 'low',
    });
    // Snapshot taken the instant step 0 completed — this is what a partial
    // report requested right now should reflect.
    const completedSnapshot = conversation.snapshot();

    // Step 1 is now IN FLIGHT on the SAME shared conversation instance: it has
    // pushed a tool call but the tool result has not landed yet (a dangling,
    // uncommitted mutation a partial report must NOT observe).
    conversation.appendToolCall({ id: 'call-1', name: 'search', arguments: {} });

    const runState = {
      id: 'run-partial-dangling',
      status: 'running' as const,
      steps: [
        {
          step: 0,
          // Both entries point at the SAME live, now-further-mutated instance —
          // exactly the shape a real in-memory RunState has.
          conversation,
          content: 'step 0 done',
          toolCalls: [],
          results: [],
          usage: { prompt: 6, completion: 3, total: 9 },
          metadata: { effectiveModel: 'claude-sonnet-5', effectiveEffort: 'low' },
          final: false,
        },
      ],
      usage: { prompt: 6, completion: 3, total: 9 },
      finishReason: undefined,
      error: undefined,
      // Only step 0 ever completed, so only its snapshot was ever captured —
      // the in-flight step 1 mutation has no corresponding snapshot yet.
      snapshots: [completedSnapshot],
      actions: [],
      activeRun: {} as ActiveRun,
    };

    const report = buildPartialRunReport('run-partial-dangling', runState, 'process shutdown');

    const transcriptMessages = (report.transcript?.ids ?? []).map(
      (id) => report.transcript?.messages[id],
    );

    // The dangling tool call from the in-flight step must NOT appear.
    expect(transcriptMessages.some((message) => message?.toolCall?.id === 'call-1')).toBe(false);
    // The last COMPLETED content must be present.
    expect(transcriptMessages.some((message) => message?.content === 'step 0 done')).toBe(true);
  });
});

describe('Bureau.getRunReport', () => {
  it('returns a cached succeeded report once the run completes, and emits a run-finished frame', async () => {
    const bureau = await createBureau({
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
      toolbox: createEmptyToolbox(),
    });

    const runEnvelopeFrames: Extract<ServerFrame, { type: 'run-envelope' }>[] = [];
    const unsubscribe = bureau.subscribeLiveFrames((frame) => {
      if (frame.type === 'run-envelope') runEnvelopeFrames.push(frame);
    });

    const run = await bureau.createRun({ message: 'Hello' });

    await new Promise<void>((resolve) => {
      const check = () => {
        const report = bureau.getRunReport(run.id);
        if (report && report.status !== undefined && bureau.getRun(run.id)?.status !== 'running') {
          resolve();
        } else {
          setTimeout(check, 0);
        }
      };
      check();
    });

    const report = bureau.getRunReport(run.id);
    expect(report?.status).toBe('succeeded');
    expect(report?.runId).toBe(run.id);

    const runStartedFrame = runEnvelopeFrames.find((f) => f.frame.type === 'run-started');
    expect(runStartedFrame).toBeDefined();
    const runFinishedFrame = runEnvelopeFrames.find((f) => f.frame.type === 'run-finished');
    expect(runFinishedFrame).toBeDefined();
    if (runFinishedFrame?.frame.type === 'run-finished') {
      expect(runFinishedFrame.frame.report.status).toBe('succeeded');
    }

    // Every emitted run-envelope frame round-trips JSON.parse(JSON.stringify(x)).
    for (const { frame } of runEnvelopeFrames) {
      const roundTripped = roundTrip(frame);
      expect(roundTripped).toEqual(JSON.parse(JSON.stringify(frame)));
    }

    unsubscribe();
    bureau.dispose();
  });

  it('returns undefined for an unknown run id', async () => {
    const bureau = await createBureau({
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
      toolbox: createEmptyToolbox(),
    });

    expect(bureau.getRunReport('does-not-exist')).toBeUndefined();

    bureau.dispose();
  });

  it('graceful shutdown: synchronously returns a partial report with accumulated usage and transcript when a run is killed mid-step (regression)', async () => {
    // REGRESSION (AB-96): the embedder must be able to call abortRun() then
    // IMMEDIATELY (no await) call getRunReport() and get back the usage +
    // transcript accumulated through the last completed step — not an
    // undefined/empty report, and not something that requires waiting for
    // the abort to fully settle.
    const addTool = createTool({
      name: 'add',
      description: 'add two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => a + b,
    });

    let resolveSecondStep: ((response: { content: string; toolCalls: [] }) => void) | undefined;
    const secondStepPending = new Promise<{ content: string; toolCalls: [] }>((resolve) => {
      resolveSecondStep = resolve;
    });

    const generate: GenerateFunction = async ({ step, signal }) => {
      if (step === 0) {
        return {
          content: '',
          toolCalls: [{ name: 'add', arguments: { a: 2, b: 3 } }],
          usage: { prompt: 5, completion: 2, total: 7 },
        };
      }
      // Step 1 hangs until the test resolves it (never, in the abort case) or
      // the run is aborted, in which case the loop's own abort handling wins.
      return Promise.race([
        secondStepPending,
        new Promise<{ content: string; toolCalls: [] }>((resolve) => {
          signal?.addEventListener('abort', () => resolve({ content: '', toolCalls: [] }), {
            once: true,
          });
        }),
      ]);
    };

    const bureau = await createBureau({
      generate,
      toolbox: createTestToolbox([addTool]) as unknown as Toolbox,
    });

    const run = await bureau.createRun({ message: 'Add 2 and 3, then keep going' });

    // Wait until step 0 (the tool call) has been recorded in the store before
    // killing the run — this is what makes the report "partial but non-empty".
    await new Promise<void>((resolve) => {
      const check = () => {
        const runState = bureau.store.getRun(run.id);
        if (runState && runState.steps.length > 0) resolve();
        else setTimeout(check, 0);
      };
      check();
    });

    bureau.abortRun(run.id);
    // NO await here — this is the synchronous graceful-shutdown call.
    const partialReport = bureau.getRunReport(run.id);

    expect(partialReport).toBeDefined();
    expect(partialReport?.status).toBe('aborted');
    expect(partialReport?.usage.total).toBeGreaterThan(0);
    expect(partialReport?.transcript).toBeDefined();
    const toolCallMessage = Object.values(partialReport!.transcript!.messages).find(
      (m) => m.toolCall,
    );
    expect(toolCallMessage?.toolCall?.name).toBe('add');

    resolveSecondStep?.({ content: 'unused', toolCalls: [] });
    bureau.dispose();
  });
});
