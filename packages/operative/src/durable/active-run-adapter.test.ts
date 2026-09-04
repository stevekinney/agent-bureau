import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import type { AnyToolbox } from 'armorer';
import {
  createTool,
  createToolbox,
  ToolboxBudgetExceededEvent,
  ToolboxCallEvent,
  ToolboxExecuteStartEvent,
  ToolboxPolicyDeniedEvent,
  ToolboxProgressEvent,
  ToolboxSettledEvent,
} from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { CompletableEventTarget, createManualRuntimeServices, HookRegistry } from 'lifecycle';
import { z } from 'zod';

import { createChildRunRegistry, dispatchChildRun } from '../child-run';
import { stopWhen } from '../conditions/index';
import { createAgent } from '../create-agent';
import { createActiveRun } from '../create-run';
import {
  AbortAgentRunError,
  AgentRunError,
  BudgetExceededError,
  ElicitationDeniedError,
  GuardrailTripwireError,
} from '../errors';
import {
  type CombinedOperativeEventMap,
  GenerateCompletedEvent,
  GenerateErrorEvent,
  GenerateRetryEvent,
  GenerateStartedEvent,
  RunCompletedEvent,
  StepStartedEvent,
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolStartedBubbleEvent,
} from '../events';
import type { OperativeHookMap } from '../hooks';
import { type StallWatchdogClock, TOOL_CALL_POLICY } from '../liveness';
import { UnsupportedRunResultVersionError } from '../run-envelope';
import type { RunnableAgent } from '../runnable-agent';
import { createManualDurableEngine, spyEngine } from '../test/durable-engine';
import { createManualCheckpointStore, createMockGenerate } from '../test/index';
import type { RunOptions, RunResult } from '../types';
import {
  createDurableActiveRun,
  createRecoveredRunEventSurface,
  reattachDurableActiveRun,
  startDurableRunResult,
} from './active-run-adapter';
import { createCheckpointStore } from './checkpoint-store';
import type { RegistryAgnosticEngine } from './create-run-engine';
import { createRunEngine } from './create-run-engine';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION, createRunWorkflow } from './run-workflow';
import type { DurableRunDeps } from './types';

const run = (...args: Parameters<typeof createActiveRun>) => createActiveRun(...args).result;
const createRun = createActiveRun;

/** A fully manual liveness clock — no real timers, no real sleeps. */
function createManualLivenessClock(): StallWatchdogClock & { advance(ms: number): void } {
  let time = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    setTimeout(callback, ms) {
      const handle = nextHandle++;
      timers.set(handle, { at: time + ms, callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      time += ms;
      let fired = true;
      while (fired) {
        fired = false;
        for (const [handle, timer] of [...timers]) {
          if (timer.at <= time) {
            timers.delete(handle);
            fired = true;
            timer.callback();
          }
        }
      }
    },
  };
}

// Drain Weft's deferred inline-launch queue between tests — a pending setTimeout(0)
// inline-launch left by one durable run can starve a later one under full
// `bun test` concurrency (CI). 0.3.0's dispose-drain does not replace this
// between-test flush.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

async function buildContext() {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const runWorkflow = createRunWorkflow(checkpointStore);
  const { engine } = await createRunEngine({ storage, runWorkflow, recover: false });
  return { engine, checkpointStore };
}

/** Build a durable context whose engine trips the history circuit breaker early. */
async function buildContextWithHistoryLimit(maxEvents: number) {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const runWorkflow = createRunWorkflow(checkpointStore);
  const { engine } = await createRunEngine({
    storage,
    runWorkflow,
    recover: false,
    history: { maxEvents },
  });
  return { engine, checkpointStore };
}

function runOptions(generate: RunOptions['generate']): RunOptions {
  return {
    generate,
    toolbox: createToolbox([]),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
  };
}

describe('createRun with durable routing', () => {
  it('forwards a supplied durable emitter through createActiveRun', async () => {
    const context = await buildContext();
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const completed: Event[] = [];
    emitter.addEventListener(RunCompletedEvent.type, (event) => completed.push(event));

    try {
      const result = await run(
        runOptions(async () => ({ content: 'durable emitter', toolCalls: [] })),
        {
          ...context,
          runId: 'run-wrapper-emitter',
          prompt: 'Hello',
          emitter,
        },
      );

      expect(result.content).toBe('durable emitter');
      expect(completed).toHaveLength(1);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('runs through the durable routing overload of run()', async () => {
    const context = await buildContext();
    try {
      const result = await run(
        runOptions(async () => ({ content: 'durable run', toolCalls: [] })),
        {
          ...context,
          runId: 'run-wrapper',
          prompt: 'Hello',
        },
      );

      expect(result.finishReason).toBe('stop-condition');
      expect(result.content).toBe('durable run');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('fires the full run-level lifecycle (run.started → run.completed) on the durable path', async () => {
    const context = await buildContext();
    try {
      const events: string[] = [];
      let completedFinishReason: RunResult['finishReason'] | undefined;
      let completedContent: string | undefined;

      const activeRun = createRun(
        runOptions(async () => ({ content: 'durable done', toolCalls: [] })),
        { ...context, runId: 'lifecycle-run', prompt: 'Hello' },
      );

      // Listeners attach synchronously, before the deferred-microtask start —
      // so run.started (the first event) must still be observed.
      activeRun.addEventListener('run.started', () => events.push('run.started'));
      activeRun.addEventListener('step.completed', () => events.push('step.completed'));
      activeRun.addEventListener('run.completed', (event) => {
        events.push('run.completed');
        // RunCompletedEvent flattens the RunResult into fields (no `.result`).
        completedFinishReason = event.finishReason;
        completedContent = event.content;
      });

      const result = await activeRun.result;

      // The run-level lifecycle fired, in order — this is the seam #7 closure
      // that makes the durable path visible to gateway's once('run.completed').
      expect(events).toEqual(['run.started', 'step.completed', 'run.completed']);
      expect(completedFinishReason).toBe('stop-condition');
      expect(completedContent).toBe('durable done');

      // The reconstructed RunResult is the FULL shape, not the thin summary.
      expect(result.finishReason).toBe('stop-condition');
      expect(result.content).toBe('durable done');
      expect(result.steps).toHaveLength(1);
      expect(result.conversation.getMessages().length).toBeGreaterThan(0);
      expect(result.usage).toEqual({ prompt: 0, completion: 0, total: 0 });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('exposes the full durable active-run event facade', async () => {
    const context = await buildContext();
    try {
      const activeRun = createRun(
        runOptions(async () => ({ content: 'facade done', toolCalls: [] })),
        { ...context, runId: 'event-facade-run', prompt: 'Hello' },
      );
      const collected: string[] = [];
      const removedListener = () => collected.push('removed');
      const iterator = activeRun.events('run.completed');
      const observableSubscription = activeRun.toObservable().subscribe({
        next(event) {
          if (event.type === 'run.completed') collected.push('observable');
        },
      });

      activeRun.addEventListener('run.started', removedListener);
      activeRun.removeEventListener('run.started', removedListener);
      activeRun.on('step.completed').subscribe({
        next() {
          collected.push('on');
        },
      });
      activeRun.once('run.completed', () => collected.push('once'));
      activeRun.subscribe('run.completed', () => collected.push('subscribe'));

      const result = await activeRun.result;
      const iteratorResult = await iterator.next();
      observableSubscription.unsubscribe();

      expect(result.finishReason).toBe('stop-condition');
      expect(iteratorResult.value.finishReason).toBe('stop-condition');
      expect(collected).toContain('on');
      expect(collected).toContain('once');
      expect(collected).toContain('subscribe');
      expect(collected).toContain('observable');
      expect(collected).not.toContain('removed');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('runs the onRunStart and onRunComplete hooks on the durable path', async () => {
    const context = await buildContext();
    try {
      const hookCalls: string[] = [];
      const options = runOptions(async () => ({ content: 'hooked', toolCalls: [] }));
      options.onStep = undefined;

      const activeRun = createRun(
        {
          ...options,
          afterToolExecution: undefined,
        },
        { ...context, runId: 'hooks-run', prompt: 'Go' },
      );
      activeRun.addEventListener('run.started', () => hookCalls.push('started'));
      activeRun.addEventListener('run.completed', () => hookCalls.push('completed'));

      await activeRun.result;
      expect(hookCalls).toEqual(['started', 'completed']);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('reconstructs a multi-step RunResult with all step records', async () => {
    const context = await buildContext();
    try {
      const toolbox = createToolbox([]) as unknown as RunOptions['toolbox'];
      const activeRun = createRun(
        {
          generate: async ({ step }) =>
            step < 2
              ? { content: `step ${step}`, toolCalls: [] }
              : { content: 'final', toolCalls: [] },
          toolbox,
          conversation: createConversationHistory(),
          // Stop only at step 2 so we record three steps.
          stopWhen: (ctx) => ctx.step >= 2,
        },
        { ...context, runId: 'multi-run', prompt: 'Start' },
      );

      const result = await activeRun.result;
      expect(result.steps).toHaveLength(3);
      expect(result.steps.map((s) => s.content)).toEqual(['step 0', 'step 1', 'final']);
      // Every step's conversation is the single final instance (executeLoop parity).
      const finalConversation = result.conversation;
      for (const step of result.steps) {
        expect(step.conversation).toBe(finalConversation);
      }
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('propagates the real generate error through the run lifecycle (not a placeholder)', async () => {
    const context = await buildContext();
    try {
      const thrownError = new Error('generate exploded: model unavailable');
      let runError: AgentRunError | undefined;
      let errorMessage: string | undefined;
      let completedFinishReason: RunResult['finishReason'] | undefined;
      let completedError: unknown;

      const activeRun = createRun(
        runOptions(async () => {
          throw thrownError;
        }),
        { ...context, runId: 'error-run', prompt: 'Hello' },
      );
      activeRun.addEventListener('run.error', (event) => {
        runError = event.error;
      });
      // A generate error ends the run via run.completed with finishReason 'error'
      // (executeLoop parity — it does not throw out of the run).
      activeRun.addEventListener('run.completed', (event) => {
        completedFinishReason = event.finishReason;
        completedError = event.error;
        errorMessage = event.error instanceof Error ? event.error.message : String(event.error);
      });

      const result = await activeRun.result;

      expect(result.finishReason).toBe('error');
      expect(completedFinishReason).toBe('error');
      // The REAL cause survives the workflow→adapter boundary, not a synthetic
      // "Durable run error" placeholder.
      expect(errorMessage).toBe('generate exploded: model unavailable');
      expect(result.error).toBeInstanceOf(AgentRunError);
      expect(result.error).toBe(runError);
      expect(completedError).toBe(runError);
      expect(runError?.kind).toBe('generate');
      expect(runError?.code).toBe('UNKNOWN');
      expect(runError?.cause).toBe(thrownError);
      expect((result.error as Error).message).toBe('generate exploded: model unavailable');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('reconstructs typed terminal errors on result-only durable runs', async () => {
    const context = await buildContext();
    try {
      const result = await startDurableRunResult(context, {
        runId: 'result-only-error-run',
        sessionId: 'result-only-error-run',
        options: runOptions(async () => {
          throw new Error('result-only generate exploded');
        }),
      });

      expect(result.finishReason).toBe('error');
      expect(result.error).toBeInstanceOf(AgentRunError);
      expect((result.error as AgentRunError).kind).toBe('generate');
      expect((result.error as AgentRunError).code).toBe('UNKNOWN');
      expect((result.error as Error).message).toBe('result-only generate exploded');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('an errored durable run carries accumulated usage and costEstimate (AB-92 parity with the in-memory loop)', async () => {
    const context = await buildContext();
    try {
      let calls = 0;
      const activeRun = createRun(
        {
          generate: async () => {
            calls++;
            if (calls === 1) {
              return {
                content: 'partial',
                toolCalls: [],
                usage: { prompt: 100, completion: 50, total: 150 },
              };
            }
            throw new Error('boom');
          },
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          costEstimation: { model: 'gpt-4o' },
        },
        { ...context, runId: 'error-cost-run', prompt: 'Hello' },
      );

      const result = await activeRun.result;

      expect(result.finishReason).toBe('error');
      expect(result.usage).toEqual({ prompt: 100, completion: 50, total: 150 });
      expect(result.costEstimate).toBeDefined();
      expect(result.costEstimate!.totalCost).toBeCloseTo(
        (100 / 1_000_000) * 2.5 + (50 / 1_000_000) * 10,
        10,
      );
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('aborts a running durable run and propagates the abort reason', async () => {
    const context = await buildContext();
    try {
      let abortedReason: string | undefined;
      let aborted = false;
      let abortedError: unknown;

      // generate blocks until the run-level signal aborts, then rejects — so the
      // run is in-flight when we call abort().
      const activeRun = createRun(
        {
          generate: ({ signal }) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(new Error('aborted during generate')),
                { once: true },
              );
            }),
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
        { ...context, runId: 'abort-run', prompt: 'Hello' },
      );

      activeRun.addEventListener('run.aborted', (event) => {
        aborted = true;
        abortedReason = event.reason;
        abortedError = event.error;
      });

      // Abort after the deferred-microtask start has begun the run.
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRun.abort('user requested stop');

      const result = await activeRun.result;

      expect(result.finishReason).toBe('aborted');
      expect(aborted).toBe(true);
      // The real abort reason survives the workflow→adapter boundary.
      expect(abortedReason).toBe('user requested stop');
      expect(result.error).toBeInstanceOf(AbortAgentRunError);
      expect(result.error).toBe(abortedError);
      expect((result.error as AbortAgentRunError).kind).toBe('abort');
      expect((result.error as AbortAgentRunError).code).toBe('ABORTED');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('an aborted durable run carries accumulated usage and costEstimate (AB-92 parity with the in-memory loop)', async () => {
    const context = await buildContext();
    try {
      // First step completes with usage; second step blocks until abort, then rejects.
      const activeRun = createRun(
        {
          generate: ({ signal, step }) => {
            if (step === 0) {
              return Promise.resolve({
                content: 'first',
                toolCalls: [],
                usage: { prompt: 200, completion: 20, total: 220 },
              });
            }
            return new Promise((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(new Error('aborted during generate')),
                { once: true },
              );
            });
          },
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          costEstimation: { model: 'gpt-4o' },
        },
        { ...context, runId: 'abort-cost-run', prompt: 'Hello' },
      );

      // Let the first step complete before aborting.
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeRun.abort('user requested stop');

      const result = await activeRun.result;

      expect(result.finishReason).toBe('aborted');
      expect(result.usage).toEqual({ prompt: 200, completion: 20, total: 220 });
      expect(result.costEstimate).toBeDefined();
      expect(result.costEstimate!.totalCost).toBeCloseTo(
        (200 / 1_000_000) * 2.5 + (20 / 1_000_000) * 10,
        10,
      );
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('still settles when engine.cancel rejects during durable abort cleanup', async () => {
    const context = await buildContext();
    const originalCancel = context.engine.cancel.bind(context.engine);
    try {
      context.engine.cancel = async () => {
        throw new Error('cancel failed after abort signal fired');
      };

      const activeRun = createRun(
        {
          generate: ({ signal }) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(new Error('aborted despite cancel failure')),
                { once: true },
              );
            }),
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
        { ...context, runId: 'cancel-rejects-run', prompt: 'Hello' },
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRun.abort('cancel can fail independently');

      const result = await activeRun.result;

      expect(result.finishReason).toBe('aborted');
    } finally {
      context.engine.cancel = originalCancel;
      context.engine[Symbol.dispose]();
    }
  });

  it('disposes a durable active run by aborting and completing the event surface', async () => {
    const context = await buildContext();
    try {
      const activeRun = createRun(
        {
          generate: ({ signal }) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('disposed')), {
                once: true,
              });
            }),
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
        { ...context, runId: 'dispose-run', prompt: 'Hello' },
      );

      await Promise.resolve();
      activeRun[Symbol.dispose]();

      const result = await activeRun.result;
      expect(result.finishReason).toBe('aborted');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('returns an error result when durable onRunStart fails before engine start', async () => {
    const context = await buildContext();
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('onRunStart', async () => {
      throw new Error('start hook failed');
    });

    try {
      const activeRun = createDurableActiveRun(context, {
        runId: 'durable-start-hook-fails',
        sessionId: 'durable-start-hook-fails',
        options: {
          ...runOptions(async () => ({ content: 'unused', toolCalls: [] })),
          hooks,
        },
      });

      const result = await activeRun.result;

      expect(result.finishReason).toBe('error');
      expect((result.error as Error).message).toBe('start hook failed');
      // AB-214 review (PRRT_kwDORvupsc6es7pl): the redacted projection
      // reports hasError without leaking the error value itself.
      expect(activeRun.snapshot().result).toEqual({ finishReason: 'error', hasError: true });
      expect(JSON.stringify(activeRun.snapshot().result)).not.toContain('start hook failed');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('AB-88/AB-214: records a provider-io pulse for generate.started/completed/error/retry on the fresh durable path', async () => {
    const context = await buildContext();
    try {
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const activeRun = createDurableActiveRun(context, {
        runId: 'durable-liveness-provider-pulses',
        sessionId: 'durable-liveness-provider-pulses',
        options: runOptions(async () => ({ content: 'done', toolCalls: [] })),
        emitter,
      });

      emitter.dispatchEvent(new GenerateStartedEvent(0));
      emitter.dispatchEvent(new GenerateCompletedEvent(0, { content: 'done' } as never, 1));
      emitter.dispatchEvent(new GenerateErrorEvent(0, new Error('boom'), 1));
      emitter.dispatchEvent(new GenerateRetryEvent(0, 1, new Error('boom')));

      const evidence = activeRun.snapshot().evidence;
      expect(evidence.filter((entry) => entry.source === 'provider-io')).toHaveLength(4);

      const received: number[] = [];
      const subscription = activeRun.subscribeSnapshot((snapshot) =>
        received.push(snapshot.revision),
      );
      expect(received.length).toBeGreaterThan(0);
      subscription.unsubscribe();

      await activeRun.result;
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('returns an interrupted result when the durable engine is disposed during a run', async () => {
    const disposedError = Object.assign(new Error('engine disposed'), {
      code: 'EngineDisposedError',
    });
    const engine = {
      start: async () => ({
        result: () => Promise.reject(disposedError),
      }),
    } as unknown as RegistryAgnosticEngine;
    const context = {
      engine,
      checkpointStore: {
        loadCheckpoint: async () => {
          throw new Error('unused');
        },
      },
    } as never;

    const activeRun = createDurableActiveRun(context, {
      runId: 'durable-engine-disposed',
      sessionId: 'durable-engine-disposed',
      options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
    });

    const result = await activeRun.result;

    expect(result.finishReason).toBe('aborted');
  });

  // Regression: a code-review finding on the AB-204 pull request —
  // driveDurableRun swallows an EngineDisposedError rejection of a FRESH
  // (non-reattached) run into a quiet, write-free, resolved RunResult (see
  // its own doc comment) — closed() cannot see this from the settled
  // `result` alone and must classify it unresolved/unreachable, matching
  // reattachDurableActiveRun's identical AC8 handling, never
  // completed/not-required.
  it('closed() classifies a fresh run whose engine was disposed as unresolved/unreachable, never completed or not-required', async () => {
    const disposedError = Object.assign(new Error('engine disposed'), {
      code: 'EngineDisposedError',
    });
    const engine = {
      start: async () => ({
        result: () => Promise.reject(disposedError),
      }),
    } as unknown as RegistryAgnosticEngine;
    const context = {
      engine,
      checkpointStore: {
        loadCheckpoint: async () => {
          throw new Error('unused');
        },
      },
    } as never;

    const activeRun = createDurableActiveRun(context, {
      runId: 'durable-engine-disposed-closed',
      sessionId: 'durable-engine-disposed-closed',
      options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
    });

    await activeRun.result;
    await Promise.resolve();

    expect(await activeRun.closed()).toEqual({ status: 'unresolved', reason: 'unreachable' });
  });

  it('classifies a durable workflow timeout as an execution deadline error', async () => {
    const timeoutError = Object.assign(new Error('timed out'), {
      code: 'WorkflowTimeoutError',
    });
    const engine = {
      start: async () => ({
        result: () => Promise.reject(timeoutError),
      }),
      get: async () => ({ status: 'timed-out' }),
    } as unknown as RegistryAgnosticEngine;
    const context = {
      engine,
      checkpointStore: {
        loadCheckpoint: async () => {
          throw new Error('unused');
        },
      },
    } as never;

    const activeRun = createDurableActiveRun(context, {
      runId: 'durable-deadline-timeout',
      sessionId: 'durable-deadline-timeout',
      options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
    });

    const result = await activeRun.result;

    expect(result.finishReason).toBe('error');
    expect((result.error as Error).message).toContain('execution deadline');
  });

  it('propagates unexpected durable handle result rejections', async () => {
    const unexpectedError = new Error('unexpected durable rejection');
    const engine = {
      start: async () => ({
        result: () => Promise.reject(unexpectedError),
      }),
    } as unknown as RegistryAgnosticEngine;
    const context = {
      engine,
      checkpointStore: {
        loadCheckpoint: async () => {
          throw new Error('unused');
        },
      },
    } as never;

    const activeRun = createDurableActiveRun(context, {
      runId: 'durable-unexpected-rejection',
      sessionId: 'durable-unexpected-rejection',
      options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
    });

    await activeRun.result.then(
      () => {
        throw new Error('Expected durable run to reject');
      },
      (error) => {
        expect(error).toBe(unexpectedError);
      },
    );
  });

  it('classifies a BudgetExceededError as finishReason budget-exceeded (durable parity)', async () => {
    // The durable path must classify terminal errors the SAME as the in-memory
    // loop. The error's class identity is lost once serialized across a
    // checkpoint, so classification happens inside the memo while it is live —
    // a regression here would collapse this back to a plain 'error'.
    const context = await buildContext();
    try {
      const activeRun = createRun(
        {
          generate: async () => ({ content: 'Hello', toolCalls: [] }),
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          prepareStep: async () => {
            throw new BudgetExceededError('Token budget exceeded');
          },
        },
        { ...context, runId: 'budget-run', prompt: 'Hello' },
      );
      let runError: AgentRunError | undefined;
      activeRun.addEventListener('run.error', (event) => {
        runError = event.error;
      });

      const result = await activeRun.result;

      expect(result.finishReason).toBe('budget-exceeded');
      expect(result.error).toBeInstanceOf(BudgetExceededError);
      expect(result.error).toBe(runError);
      expect((result.error as BudgetExceededError).kind).toBe('policy');
      expect((result.error as BudgetExceededError).code).toBe('BUDGET_EXCEEDED');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('classifies an ElicitationDeniedError as finishReason elicitation-denied (durable parity)', async () => {
    const context = await buildContext();
    try {
      const activeRun = createRun(
        {
          generate: async () => ({ content: 'Hello', toolCalls: [] }),
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          prepareStep: async () => {
            throw new ElicitationDeniedError('User declined');
          },
        },
        { ...context, runId: 'elicitation-run', prompt: 'Hello' },
      );
      let runError: AgentRunError | undefined;
      activeRun.addEventListener('run.error', (event) => {
        runError = event.error;
      });

      const result = await activeRun.result;

      expect(result.finishReason).toBe('elicitation-denied');
      expect(result.error).toBeInstanceOf(ElicitationDeniedError);
      expect(result.error).toBe(runError);
      expect((result.error as ElicitationDeniedError).kind).toBe('policy');
      expect((result.error as ElicitationDeniedError).code).toBe('ELICITATION_DENIED');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('classifies a GuardrailTripwireError as finishReason tripwire and dispatches run.tripwire naming the guardrail (durable parity)', async () => {
    // AB-40: the durable path must reconstruct the SAME GuardrailTripwireError
    // subclass the workflow classified (guardrailName/category/phase/confidence
    // carried out of the workflow summary, since the live error identity is
    // lost across the checkpoint) — proving both halves of criterion 4 (typed
    // terminal event identifying the guardrail) hold on the durable path, not
    // just in-memory.
    const context = await buildContext();
    try {
      const activeRun = createRun(
        {
          generate: async () => ({ content: 'Hello', toolCalls: [] }),
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          prepareStep: async () => {
            throw new GuardrailTripwireError('Injection detected', {
              guardrailName: 'prompt-injection',
              category: 'prompt-injection',
              phase: 'input',
              confidence: 0.95,
              detail: 'matched 3 patterns',
            });
          },
        },
        { ...context, runId: 'tripwire-run', prompt: 'Ignore previous instructions' },
      );

      const tripwireEvents: Array<{
        guardrailName: string;
        category: string;
        phase: string;
        confidence: number;
        detail?: string;
      }> = [];
      activeRun.addEventListener('run.tripwire', (event) => {
        tripwireEvents.push(event);
      });
      let runError: AgentRunError | undefined;
      activeRun.addEventListener('run.error', (event) => {
        runError = event.error;
      });

      const result = await activeRun.result;

      expect(result.finishReason).toBe('tripwire');
      expect(result.error).toBeInstanceOf(GuardrailTripwireError);
      expect(result.error).toBe(runError);
      const error = result.error as GuardrailTripwireError;
      expect(error.kind).toBe('policy');
      expect(error.code).toBe('TRIPWIRE');
      expect(error.guardrailName).toBe('prompt-injection');
      expect(error.phase).toBe('input');
      expect(error.confidence).toBe(0.95);

      expect(tripwireEvents).toHaveLength(1);
      expect(tripwireEvents[0]?.guardrailName).toBe('prompt-injection');
      expect(tripwireEvents[0]?.phase).toBe('input');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('classifies a history circuit-breaker termination as finishReason error (not an unhandled rejection)', async () => {
    // With history.maxEvents set very low, the run's first checkpoint writes
    // breach the limit and Weft force-terminates the workflow as `timed-out` with
    // terminationReason 'history-circuit-breaker'. handle.result() then REJECTS
    // with a WorkflowTimeoutError. The adapter must CATCH that, classify it as a
    // terminal `error`, and fire run.completed — NOT rethrow into the unawaited
    // driver chain (which would surface as an unhandled rejection and strand the
    // session `running`). The error message must name the circuit breaker so the
    // cause is distinguishable from a genuine deadline timeout.
    const context = await buildContextWithHistoryLimit(1);
    try {
      let completedFinishReason: RunResult['finishReason'] | undefined;
      const activeRun = createRun(
        {
          generate: async () => ({ content: 'never gets far', toolCalls: [] }),
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
        { ...context, runId: 'circuit-breaker-run', prompt: 'Hello' },
      );
      activeRun.addEventListener('run.completed', (event) => {
        completedFinishReason = event.finishReason;
      });

      const result = await activeRun.result;

      // The run settled cleanly as an error (the catch fired) rather than the
      // promise rejecting — and the terminal lifecycle fired.
      expect(result.finishReason).toBe('error');
      expect(completedFinishReason).toBe('error');
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain('history circuit breaker');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('carries schemaValidation through to the durable RunResult (durable parity)', async () => {
    // A run with a `output` produces `RunResult.schemaValidation` on the
    // in-memory path; the durable path must surface the SAME shape. The live
    // validation error is reduced to a message across the checkpoint.
    const context = await buildContext();
    try {
      const activeRun = createRun(
        {
          generate: async () => ({ content: '{"answer":"42"}', toolCalls: [] }),
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          output: z.object({ answer: z.string() }),
        },
        { ...context, runId: 'schema-run', prompt: 'Hello' },
      );

      const result = await activeRun.result;

      expect(result.finishReason).toBe('stop-condition');
      expect(result.schemaValidation).toBeDefined();
      expect(result.schemaValidation?.success).toBe(true);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('carries output through to the durable RunResult (durable parity)', async () => {
    // A run with a `output` produces `RunResult.output` on the
    // in-memory path (AB-95's "distinct field" requirement); the durable path
    // must surface the SAME validated value, unchanged (it's already plain JSON,
    // so unlike `schemaValidation.error` it needs no reconstruction).
    const context = await buildContext();
    try {
      const activeRun = createRun(
        {
          generate: async () => ({ content: '{"answer":"42"}', toolCalls: [] }),
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          output: z.object({ answer: z.string() }),
        },
        { ...context, runId: 'structured-output-run', prompt: 'Hello' },
      );

      const result = await activeRun.result;

      expect(result.finishReason).toBe('stop-condition');
      expect(result.output).toEqual({ answer: '42' });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('NEUTER CHECK: output is absent on the durable path when validation fails', async () => {
    // Confirms the parity test above is exercising the real success path (a
    // output field that's ALWAYS present regardless of validation
    // outcome would trivially pass the previous test too).
    const context = await buildContext();
    try {
      const activeRun = createRun(
        {
          generate: async () => ({ content: '{"answer":42}', toolCalls: [] }),
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          output: z.object({ answer: z.string() }),
          schemaRetries: 0,
        },
        { ...context, runId: 'structured-output-fail-run', prompt: 'Hello' },
      );

      const result = await activeRun.result;

      expect(result.finishReason).toBe('stop-condition');
      expect(result.schemaValidation?.success).toBe(false);
      expect(result.output).toBeUndefined();
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  // Regression: PRRT_kwDORvupsc6MV8Xa — durable path was missing the C3 curated
  // tool.* bubble events; only raw toolbox:* events were forwarded. The audit trail
  // sinks tool.started / tool.settled / tool.error, so durable tool calls were
  // absent from the curated run stream and /api/v1/audit for persistent bureaus.
  it('emits curated tool.started and tool.settled events on the durable path', async () => {
    const context = await buildContext();
    try {
      const echoTool = createTool({
        name: 'echo',
        description: 'Echo the input',
        input: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => message,
      });

      const toolbox = createToolbox([echoTool]) as unknown as RunOptions['toolbox'];

      const generate = createMockGenerate([
        { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'hi' } }] },
        { content: 'done', toolCalls: [] },
      ]);

      const activeRun = createRun(
        {
          generate,
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          agentName: 'durable-agent',
          runId: 'durable-tool-run',
        },
        { ...context, runId: 'durable-tool-run', prompt: 'Start' },
      );

      const started: ToolStartedBubbleEvent[] = [];
      const settled: ToolSettledBubbleEvent[] = [];
      activeRun.addEventListener('tool.started', (e) => started.push(e));
      activeRun.addEventListener('tool.settled', (e) => settled.push(e));

      await activeRun.result;

      expect(started).toHaveLength(1);
      expect(started[0]).toBeInstanceOf(ToolStartedBubbleEvent);
      expect(started[0]?.toolName).toBe('echo');
      expect(started[0]?.agentName).toBe('durable-agent');
      expect(started[0]?.runId).toBe('durable-tool-run');
      // step stamp must be a non-negative integer — confirms StepStartedEvent fired
      // on the durable emitter before execute-start (not stuck at default 0 from a
      // missing listener, which would also be 0 for step 0, so assert type).
      expect(typeof started[0]?.step).toBe('number');
      expect(started[0]?.step).toBe(0); // tool runs on step 0

      expect(settled).toHaveLength(1);
      expect(settled[0]).toBeInstanceOf(ToolSettledBubbleEvent);
      expect(settled[0]?.toolName).toBe('echo');
      expect(settled[0]?.status).toBe('success');
      expect(settled[0]?.step).toBe(0);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  // AB-253's own completion criterion: two durable `createActiveRun` calls in
  // one process, each given its own `ManualRuntimeServices` pinned to a
  // different origin and identifier seed, driven to completion, carry
  // disjoint run identifiers and origin-derived (not process-clock-derived)
  // tool-event timestamps. Before this slice, `driveDurableRun`'s own
  // `runStartTime`/tool-started timestamp read the real `performance.now()`/
  // `Date.now()` globals directly (and the durable branch in `create-run.ts`
  // resolved `options.runtime` too late to reach it at all), so this
  // assertion could not have been made: both runs would have observed the
  // SAME real clock regardless of what `runtime` either caller supplied.
  it('two durable runs with two manual runtimes (different origins/seeds) carry disjoint ids and origin-derived timestamps', async () => {
    const contextA = await buildContext();
    const contextB = await buildContext();
    try {
      const runtimeA = createManualRuntimeServices({
        origin: '2021-01-01T00:00:00.000Z',
        identifierSeed: 'run-a',
      });
      const runtimeB = createManualRuntimeServices({
        origin: '2032-07-04T00:00:00.000Z',
        identifierSeed: 'run-b',
      });
      // Advance each runtime a DIFFERENT amount before its run starts, so a
      // shared-origin coincidence could not produce equal timestamps by
      // accident.
      await runtimeA.advance(1_000);
      await runtimeB.advance(9_000);

      const echoTool = createTool({
        name: 'echo',
        description: 'Echo the input',
        input: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => message,
      });
      const toolbox = () => createToolbox([echoTool]) as unknown as RunOptions['toolbox'];
      const generateFor = (label: string) =>
        createMockGenerate([
          { content: '', toolCalls: [{ name: 'echo', arguments: { message: label } }] },
          { content: 'done', toolCalls: [] },
        ]);

      const runA = createRun(
        {
          generate: generateFor('a'),
          toolbox: toolbox(),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          agentName: 'durable-agent-a',
          runId: 'durable-run-a',
          runtime: runtimeA,
        },
        { ...contextA, runId: 'durable-run-a', prompt: 'Start A' },
      );
      const runB = createRun(
        {
          generate: generateFor('b'),
          toolbox: toolbox(),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          agentName: 'durable-agent-b',
          runId: 'durable-run-b',
          runtime: runtimeB,
        },
        { ...contextB, runId: 'durable-run-b', prompt: 'Start B' },
      );

      const startedA: ToolStartedBubbleEvent[] = [];
      const startedB: ToolStartedBubbleEvent[] = [];
      runA.addEventListener('tool.started', (e) => startedA.push(e));
      runB.addEventListener('tool.started', (e) => startedB.push(e));

      const [resultA, resultB] = await Promise.all([runA.result, runB.result]);

      expect(resultA.finishReason).toBe('stop-condition');
      expect(resultB.finishReason).toBe('stop-condition');

      // Disjoint identifiers: each run's own explicit runId, carried through
      // the durable routing untouched.
      expect(runA.snapshot().id).toBe('durable-run-a');
      expect(runB.snapshot().id).toBe('durable-run-b');
      expect(runA.snapshot().id).not.toBe(runB.snapshot().id);

      // Origin-derived (not real-clock-derived) timestamps: each event's
      // `startedAt` matches ITS OWN runtime's pinned origin plus its own
      // advance, and the two values are provably disjoint because the
      // origins/advances differ.
      expect(startedA).toHaveLength(1);
      expect(startedB).toHaveLength(1);
      expect(startedA[0]?.startedAt).toBe(Date.parse('2021-01-01T00:00:01.000Z'));
      expect(startedB[0]?.startedAt).toBe(Date.parse('2032-07-04T00:00:09.000Z'));
      expect(startedA[0]?.startedAt).not.toBe(startedB[0]?.startedAt);
    } finally {
      contextA.engine[Symbol.dispose]();
      contextB.engine[Symbol.dispose]();
    }
  });

  it('emits tool.error on the durable path when a tool throws', async () => {
    const context = await buildContext();
    try {
      const failingTool = createTool({
        name: 'fail',
        description: 'Always fails',
        input: z.object({}),
        execute: async () => {
          throw new Error('deliberate durable failure');
        },
      });

      const toolbox = createToolbox([failingTool]) as unknown as RunOptions['toolbox'];

      const generate = createMockGenerate([
        { content: '', toolCalls: [{ name: 'fail', arguments: {} }] },
        { content: 'done', toolCalls: [] },
      ]);

      const activeRun = createRun(
        {
          generate,
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          agentName: 'durable-agent',
          runId: 'durable-error-run',
        },
        { ...context, runId: 'durable-error-run', prompt: 'Start' },
      );

      const errors: ToolErrorBubbleEvent[] = [];
      const settled: ToolSettledBubbleEvent[] = [];
      activeRun.addEventListener('tool.error', (e) => errors.push(e));
      activeRun.addEventListener('tool.settled', (e) => settled.push(e));

      await activeRun.result;

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(ToolErrorBubbleEvent);
      expect(errors[0]?.toolName).toBe('fail');
      expect(errors[0]?.agentName).toBe('durable-agent');
      expect(errors[0]?.error).toBeDefined();
      expect(errors[0]?.step).toBe(0); // tool runs on step 0

      expect(settled[0]?.status).toBe('error');
      expect(settled[0]?.step).toBe(0);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('forwards toolbox progress and policy-denied events on the durable path', async () => {
    const context = await buildContext();
    let resolveGenerate: ((response: { content: string; toolCalls: [] }) => void) | undefined;
    let markGenerateStarted: (() => void) | undefined;
    const generateStarted = new Promise<void>((resolve) => {
      markGenerateStarted = resolve;
    });
    const durableTool = createTool({
      name: 'durable_tool',
      description: 'Stands in as the subject of the forwarded toolbox events.',
      input: z.object({}),
      execute: async () => 'ok',
    });
    const toolbox = createToolbox([durableTool]);

    try {
      const activeRun = createRun(
        {
          generate: () =>
            new Promise((resolve) => {
              resolveGenerate = resolve;
              markGenerateStarted?.();
            }),
          toolbox: toolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
        { ...context, runId: 'durable-forwarded-tool-events', prompt: 'Hello' },
      );
      const events: string[] = [];
      activeRun.toObservable().subscribe({
        next(event) {
          events.push(event.type);
        },
      });

      await generateStarted;
      toolbox.emit('progress', {
        tool: durableTool,
        call: { id: 'call-1', name: 'durable_tool', arguments: {} },
        percent: 25,
        message: 'started',
        // AB-290: matches the `runId` supplied to `createRun` above — the
        // curated `tool.progress` bubble now requires it before forwarding.
        ownerId: 'durable-forwarded-tool-events',
      });
      toolbox.emit('policy-denied', {
        tool: durableTool,
        call: { id: 'call-1', name: 'durable_tool', arguments: {} },
        params: {},
        reason: 'blocked',
      });
      resolveGenerate?.({ content: 'done', toolCalls: [] });

      await activeRun.result;

      expect(events).toContain('tool.progress');
      expect(events).toContain('tool.policy-denied');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('stamps tool events with the correct step index across multiple steps on the durable path', async () => {
    const context = await buildContext();
    try {
      const echoTool = createTool({
        name: 'echo',
        description: 'Echo the input',
        input: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => message,
      });

      const toolbox = createToolbox([echoTool]) as unknown as RunOptions['toolbox'];

      // Step 0: tool call, Step 1: tool call again, Step 2: stop
      const generate = createMockGenerate([
        { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'step-zero' } }] },
        { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'step-one' } }] },
        { content: 'done', toolCalls: [] },
      ]);

      const activeRun = createRun(
        {
          generate,
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          agentName: 'durable-agent',
          runId: 'durable-step-stamp-run',
        },
        { ...context, runId: 'durable-step-stamp-run', prompt: 'Start' },
      );

      const started: ToolStartedBubbleEvent[] = [];
      activeRun.addEventListener('tool.started', (e) => started.push(e));

      await activeRun.result;

      expect(started).toHaveLength(2);
      // First tool call happens on step 0
      expect(started[0]?.step).toBe(0);
      // Second tool call happens on step 1 — proves the step listener updated currentStep
      expect(started[1]?.step).toBe(1);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('forwards a budget-exceeded event from a selectTools-swapped step toolbox on the durable path (AB-239)', async () => {
    const context = await buildContext();
    try {
      const echoTool = createTool({
        name: 'echo',
        description: 'Echo the input',
        input: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => message,
      });

      const baseToolbox = createToolbox([echoTool]) as unknown as RunOptions['toolbox'];
      const swappedToolbox = createToolbox([echoTool], {
        budget: { maxCalls: 1 },
      }) as unknown as RunOptions['toolbox'];

      const generate = createMockGenerate([
        { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'step-zero' } }] },
        { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'step-one' } }] },
        { content: 'done', toolCalls: [] },
      ]);

      const activeRun = createRun(
        {
          generate,
          toolbox: baseToolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          runId: 'durable-swap-budget-run',
          // Every step resolves to the swapped toolbox; the base toolbox is
          // never used for tool execution.
          selectTools: () => swappedToolbox,
        },
        { ...context, runId: 'durable-swap-budget-run', prompt: 'Start' },
      );

      const forwardedEvents: string[] = [];
      activeRun.toObservable().subscribe({
        next(event) {
          if (event.type.startsWith('toolbox.')) forwardedEvents.push(event.type);
        },
      });

      await activeRun.result;

      expect(forwardedEvents).toContain('toolbox.budget-exceeded');
      expect(forwardedEvents).toContain('toolbox.error');
      expect(forwardedEvents.filter((type) => type === 'toolbox.call')).toHaveLength(2);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('forwards a loop-blocked companion error from a selectTools-swapped step toolbox on the durable path (AB-239)', async () => {
    const context = await buildContext();
    try {
      const echoTool = createTool({
        name: 'echo',
        description: 'Echo the input',
        input: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => message,
      });

      const baseToolbox = createToolbox([echoTool]) as unknown as RunOptions['toolbox'];
      const swappedToolbox = createToolbox([echoTool], {
        loopDetection: { warningThreshold: 2, blockThreshold: 4, maxWindowSize: 30 },
      }) as unknown as RunOptions['toolbox'];

      const responses = Array.from({ length: 5 }, () => ({
        content: '',
        toolCalls: [{ name: 'echo', arguments: { message: 'repeat' } }],
      }));
      responses.push({ content: 'done', toolCalls: [] });
      const generate = createMockGenerate(responses);

      const activeRun = createRun(
        {
          generate,
          toolbox: baseToolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          runId: 'durable-swap-loop-run',
          selectTools: () => swappedToolbox,
        },
        { ...context, runId: 'durable-swap-loop-run', prompt: 'Start' },
      );

      const forwardedErrorEvents: Array<{ originalEvent: unknown }> = [];
      activeRun.addEventListener('toolbox.error', (event) => {
        forwardedErrorEvents.push(event);
      });

      await activeRun.result;

      const loopBlockedError = forwardedErrorEvents.find((e) => {
        const original = e.originalEvent as {
          result?: { error?: { code?: string; category?: string } };
        };
        return (
          original.result?.error?.code === 'LOOP_BLOCKED' &&
          original.result?.error?.category === 'conflict'
        );
      });
      expect(loopBlockedError).toBeDefined();
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('does not duplicate toolbox events on the durable path when selectTools returns the original toolbox instance', async () => {
    const context = await buildContext();
    try {
      const echoTool = createTool({
        name: 'echo',
        description: 'Echo the input',
        input: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => message,
      });

      const toolbox = createToolbox([echoTool]) as unknown as RunOptions['toolbox'];

      const generate = createMockGenerate([
        { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'hi' } }] },
        { content: 'done', toolCalls: [] },
      ]);

      const activeRun = createRun(
        {
          generate,
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          runId: 'durable-no-swap-run',
          selectTools: () => toolbox,
        },
        { ...context, runId: 'durable-no-swap-run', prompt: 'Start' },
      );

      const callEvents: unknown[] = [];
      activeRun.addEventListener('toolbox.call', (e) => callEvents.push(e));

      await activeRun.result;

      expect(callEvents).toHaveLength(1);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('forwards tool.started, tool.settled, tool.progress, and tool.policy-denied from a selectTools-swapped step toolbox on the durable path (AB-294)', async () => {
    const context = await buildContext();
    try {
      const echoTool = createTool({
        name: 'echo',
        description: 'Echo the input',
        input: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => message,
      });

      const baseToolbox = createToolbox([echoTool]) as unknown as RunOptions['toolbox'];
      const swappedToolbox = createToolbox([echoTool]) as unknown as RunOptions['toolbox'];

      let resolveGenerate: ((response: { content: string; toolCalls: [] }) => void) | undefined;
      let markGenerateStarted: (() => void) | undefined;
      const generateStarted = new Promise<void>((resolve) => {
        markGenerateStarted = resolve;
      });

      const activeRun = createRun(
        {
          generate: () =>
            new Promise((resolve) => {
              resolveGenerate = resolve;
              markGenerateStarted?.();
            }),
          toolbox: baseToolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          runId: 'durable-swap-curated-run',
          // Every step resolves to the swapped toolbox; the base toolbox
          // never sees these injected events.
          selectTools: () => swappedToolbox,
        },
        { ...context, runId: 'durable-swap-curated-run', prompt: 'Start' },
      );

      const started: ToolStartedBubbleEvent[] = [];
      const settled: ToolSettledBubbleEvent[] = [];
      const progress: ToolProgressBubbleEvent[] = [];
      const denied: ToolPolicyDeniedBubbleEvent[] = [];
      activeRun.addEventListener('tool.started', (e) => started.push(e));
      activeRun.addEventListener('tool.settled', (e) => settled.push(e));
      activeRun.addEventListener('tool.progress', (e) => progress.push(e));
      activeRun.addEventListener('tool.policy-denied', (e) => denied.push(e));

      // `onStepToolbox` opens the swap subscription before `generate` is
      // called (see `run-step.ts`) — once the mock generate has started,
      // events emitted directly on `swappedToolbox` are forwarded exactly
      // as a real tool call's would be.
      await generateStarted;
      const call = { id: 'call-1', name: 'echo', arguments: { message: 'hi' } };
      // AB-290: `ownerId` matches the `runId` supplied above — the curated
      // `tool.*` bubbles now require it before forwarding.
      const ownerId = 'durable-swap-curated-run';
      swappedToolbox.emit('execute-start', {
        tool: echoTool,
        call,
        params: { message: 'hi' },
        ownerId,
      });
      swappedToolbox.emit('progress', {
        tool: echoTool,
        call,
        percent: 50,
        message: 'halfway',
        ownerId,
      });
      swappedToolbox.emit('policy-denied', {
        tool: echoTool,
        call,
        params: { message: 'hi' },
        reason: 'blocked',
      });
      swappedToolbox.emit('settled', {
        tool: echoTool,
        call,
        result: 'hi',
        error: undefined,
        ownerId,
      });
      resolveGenerate?.({ content: 'done', toolCalls: [] });

      await activeRun.result;

      expect(started).toHaveLength(1);
      expect(started[0]?.toolName).toBe('echo');
      expect(settled).toHaveLength(1);
      expect(settled[0]?.toolName).toBe('echo');
      expect(progress).toHaveLength(1);
      expect(progress[0]?.percent).toBe(50);
      expect(denied).toHaveLength(1);
      expect(denied[0]?.reason).toBe('blocked');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('does not duplicate curated tool.* bubble events on the durable path when selectTools returns the original toolbox instance', async () => {
    const context = await buildContext();
    try {
      const echoTool = createTool({
        name: 'echo',
        description: 'Echo the input',
        input: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => message,
      });

      const toolbox = createToolbox([echoTool]) as unknown as RunOptions['toolbox'];

      const generate = createMockGenerate([
        { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'hi' } }] },
        { content: 'done', toolCalls: [] },
      ]);

      const activeRun = createRun(
        {
          generate,
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          runId: 'durable-no-swap-curated-run',
          selectTools: () => toolbox,
        },
        { ...context, runId: 'durable-no-swap-curated-run', prompt: 'Start' },
      );

      const started: ToolStartedBubbleEvent[] = [];
      const settled: ToolSettledBubbleEvent[] = [];
      activeRun.addEventListener('tool.started', (e) => started.push(e));
      activeRun.addEventListener('tool.settled', (e) => settled.push(e));

      await activeRun.result;

      expect(started).toHaveLength(1);
      expect(settled).toHaveLength(1);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('does not throw when the base toolbox omits addEventListener (AB-294)', async () => {
    const context = await buildContext();
    try {
      // A minimal stub toolbox without `addEventListener` — mirrors the
      // guard `attachToolboxCuratedListeners` documents against mock/custom
      // toolboxes that omit it (e.g. minimal stubs used in tests).
      const stubToolbox = {
        tools: () => [],
        execute: async () => {
          throw new Error('never called — no tool calls in this run');
        },
        toObservable: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
      };

      const activeRun = createRun(
        {
          generate: createMockGenerate([{ content: 'done', toolCalls: [] }]),
          toolbox: stubToolbox as unknown as RunOptions['toolbox'],
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          runId: 'durable-no-addeventlistener-run',
        },
        { ...context, runId: 'durable-no-addeventlistener-run', prompt: 'Start' },
      );

      const result = await activeRun.result;
      expect(result.content).toBe('done');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('calls onStepToolbox at each step start with the resolved toolbox and at step end with the base toolbox on the durable path (AB-239)', async () => {
    const context = await buildContext();
    try {
      const echoTool = createTool({
        name: 'echo',
        description: 'Echo the input',
        input: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => message,
      });

      const baseToolbox = createToolbox([echoTool]) as unknown as RunOptions['toolbox'];
      const swappedToolbox = createToolbox([echoTool]) as unknown as RunOptions['toolbox'];

      const generate = createMockGenerate([
        { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'step-zero' } }] },
        { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'step-one' } }] },
        { content: 'done', toolCalls: [] },
      ]);

      const calls: Array<'base' | 'swapped'> = [];

      const activeRun = createRun(
        {
          generate,
          toolbox: baseToolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          runId: 'durable-onstep-ordering-run',
          selectTools: () => swappedToolbox,
        },
        {
          ...context,
          runId: 'durable-onstep-ordering-run',
          prompt: 'Start',
          onServices: (services) => {
            const inner = services.onStepToolbox;
            services.onStepToolbox = (toolbox) => {
              calls.push(toolbox === swappedToolbox ? 'swapped' : 'base');
              inner?.(toolbox);
            };
          },
        },
      );

      await activeRun.result;

      // Three steps (two tool-calling, one final stop): `selectTools` resolves
      // on every step, so each brackets the swapped toolbox between a start
      // call and an end call reverting to the base toolbox.
      expect(calls).toEqual(['swapped', 'base', 'swapped', 'base', 'swapped', 'base']);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  // Regression: PRRT_kwDORvupsc6MZ-vs — when engine.cancel() wins the B6 abort
  // race (handle.result() rejects with "Workflow cancelled"), the abort result was
  // built from an empty run state and the original seed conversation, losing any
  // steps the durable workflow had already checkpointed. The fix loads the
  // checkpoint before finalizing the abort, matching the normal durable summary path.
  it('preserves checkpointed steps and usage when cancel wins the B6 abort race', async () => {
    const storage = new MemoryStorage();
    const checkpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    const { engine } = createManualDurableEngine();

    const runId = 'b6-cancel-wins-with-checkpoint';

    // Pre-populate the checkpoint store with a completed step and usage —
    // simulating a multi-step run that checkpointed before cancel() won.
    await checkpointStore.saveCursor(runId, {
      step: 1,
      totalUsage: { prompt: 42, completion: 17, total: 59 },
      lastContent: 'step 0 content',
      schemaAttempts: 0,
      lastAppliedConfigVersion: 0,
    });
    await checkpointStore.saveStep(runId, {
      step: 0,
      content: 'step 0 content',
      toolCalls: [],
      results: [],
      usage: { prompt: 42, completion: 17, total: 59 },
      final: true,
    });

    const activeRun = createDurableActiveRun(
      { engine, checkpointStore },
      {
        runId,
        sessionId: runId,
        options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
        prompt: 'Hello',
      },
    );

    let abortFired = false;
    activeRun.addEventListener('run.aborted', () => {
      abortFired = true;
    });

    // Trigger cancel() which rejects the handle with 'Workflow cancelled'
    await Promise.resolve();
    activeRun.abort();

    const result = await activeRun.result;

    // The abort lifecycle fired
    expect(result.finishReason).toBe('aborted');
    expect(abortFired).toBe(true);

    // Checkpointed steps and usage are preserved — not an empty runState
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.content).toBe('step 0 content');
    expect(result.usage).toEqual({ prompt: 42, completion: 17, total: 59 });
  });

  it('falls back to empty state when checkpoint is unavailable after cancel wins the abort race', async () => {
    // If loadCheckpoint throws (storage unavailable), the abort result still
    // settles cleanly — falling back to the seed conversation + empty run state.
    const { engine } = createManualDurableEngine();

    const brokenCheckpointStore = {
      ...createCheckpointStore(
        textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false }),
      ),
      loadCheckpoint: async () => {
        throw new Error('checkpoint storage unavailable');
      },
    } as ReturnType<typeof createCheckpointStore>;

    const runId = 'b6-cancel-wins-no-checkpoint';
    const activeRun = createDurableActiveRun(
      { engine, checkpointStore: brokenCheckpointStore },
      {
        runId,
        sessionId: runId,
        options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
        prompt: 'Hello',
      },
    );

    await Promise.resolve();
    activeRun.abort();

    const result = await activeRun.result;

    // Falls back gracefully — no throw, result still reflects the abort
    expect(result.finishReason).toBe('aborted');
    expect(result.steps).toHaveLength(0);
  });
});

describe('createDurableActiveRun.closed()', () => {
  it('resolves not-required immediately when first called after a normal completion, with no cancellation and nothing in flight', async () => {
    const context = await buildContext();
    try {
      const activeRun = createDurableActiveRun(context, {
        runId: 'ac2-durable-not-required',
        sessionId: 'ac2-durable-not-required',
        options: runOptions(async () => ({ content: 'done', toolCalls: [] })),
        prompt: 'Hello',
      });

      await activeRun.result;
      await Promise.resolve();

      expect(await activeRun.closed()).toEqual({ status: 'not-required' });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  // Regression: a code-review finding on the AB-204 pull request —
  // `cancelRequested` alone tracks only a direct `abort()` call, missing a
  // cancellation delivered through `RunOptions.signal` (which
  // `AgentRunContext.signal`/`createAgent` forward), so a run cancelled
  // that way could wrongly resolve not-required despite genuinely being
  // cancelled.
  it('disqualifies not-required when the run was cancelled through RunOptions.signal rather than abort()', async () => {
    const context = await buildContext();
    try {
      const controller = new AbortController();
      const activeRun = createDurableActiveRun(context, {
        runId: 'ac-durable-external-signal',
        sessionId: 'ac-durable-external-signal',
        options: {
          ...runOptions(async () => ({ content: 'unused', toolCalls: [] })),
          signal: controller.signal,
        },
        prompt: 'Hello',
      });

      controller.abort();
      await activeRun.result;
      await Promise.resolve();

      const acknowledgement = await activeRun.closed();
      expect(acknowledgement).not.toEqual({ status: 'not-required' });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  // Regression: a code-review finding on the AB-204 pull request — a
  // signal-only cancellation (abort() never called) never fires
  // engine.cancel from abort() itself, so `resolveDurableOutcome` must
  // still run the full post-cancel re-read dance rather than returning
  // `completed` the moment it sees `!cancelRequested`. Uses the manual
  // engine (not the real one) so the workflow genuinely does not settle on
  // its own before the signal fires — proving cancellation, not a race.
  // Regression: a code-review finding on the AB-204 pull request — a
  // workflow parked in `ctx.sleep`/`ctx.waitForSignal` cannot advance on
  // the in-process signal alone; only `engine.cancel()` can unblock it.
  // Deferring that call to `resolveDurableOutcome`'s fallback (which only
  // runs after `result` has settled) would deadlock closed() AND `result`
  // forever for a signal-only cancellation. `engine.cancel` must fire the
  // moment the signal fires — proven here by asserting it fires
  // SYNCHRONOUSLY-ISH with controller.abort(), well before `closed()` is
  // ever called, and before the manual engine's own `result` has any other
  // way to settle.
  it('fires engine.cancel the moment RunOptions.signal aborts, never calling abort() directly, unblocking a workflow that cannot otherwise advance', async () => {
    const { engine } = createManualDurableEngine();
    const cancelledIds: string[] = [];
    const realCancel = engine.cancel.bind(engine);
    engine.cancel = async (id: string) => {
      cancelledIds.push(id);
      return realCancel(id);
    };
    engine.get = (async () => ({
      status: 'cancelled',
    })) as unknown as RegistryAgnosticEngine['get'];

    const controller = new AbortController();
    const runId = 'ac-durable-signal-only-cancel';
    const activeRun = createDurableActiveRun(
      { engine, checkpointStore: createManualCheckpointStore() },
      {
        runId,
        sessionId: runId,
        options: {
          ...runOptions(async () => ({ content: 'unused', toolCalls: [] })),
          signal: controller.signal,
        },
        prompt: 'Hello',
      },
    );

    await Promise.resolve();
    controller.abort();
    // engine.cancel is async (its own body awaits nothing before the
    // push), so a single microtask tick is enough to observe it fired —
    // no closed() call, and no other trigger, was involved.
    await Promise.resolve();
    expect(cancelledIds).toEqual([runId]);

    // The manual engine's `cancel` rejects the workflow result as its own
    // side effect (the B6 race simulation) — that is what actually lets
    // `result` (and therefore closed()) settle here, not anything closed()
    // itself drove.
    const closedAcknowledgement = activeRun.closed();
    await activeRun.result;

    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
    expect(cancelledIds).toEqual([runId]);
  });

  it('routes an already-aborted RunOptions.signal into abort() too, even when the signal was aborted before this ActiveRun was even created', async () => {
    const context = await buildContext();
    try {
      const controller = new AbortController();
      controller.abort('already gone before creation');

      const activeRun = createDurableActiveRun(context, {
        runId: 'ac-durable-pre-aborted-signal',
        sessionId: 'ac-durable-pre-aborted-signal',
        options: {
          ...runOptions(async () => ({ content: 'unused', toolCalls: [] })),
          signal: controller.signal,
        },
        prompt: 'Hello',
      });

      await activeRun.result;
      await Promise.resolve();

      const acknowledgement = await activeRun.closed();
      expect(acknowledgement).not.toEqual({ status: 'not-required' });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  // Regression: a code-review finding on the AB-204 pull request — see the
  // identical fixture in create-run.test.ts for the full rationale.
  it('does not corrupt in-flight tool tracking when the toolbox emits settled with no preceding execute-start', async () => {
    const context = await buildContext();
    try {
      const tool = createTool({
        name: 'spurious_settled_tool',
        description: 'Stands in as the subject of a settled-with-no-start event.',
        input: z.object({}),
        execute: async () => 'ok',
      });
      const toolbox = createToolbox([tool]);
      const spuriousCall = { id: 'spurious-call-id', name: tool.name, arguments: {} };

      const activeRun = createDurableActiveRun(context, {
        runId: 'ac-durable-spurious-settled',
        sessionId: 'ac-durable-spurious-settled',
        options: {
          ...runOptions(async () => ({ content: 'done', toolCalls: [] })),
          toolbox,
        },
        prompt: 'Hello',
      });

      expect(() => {
        // AB-290: `ownerId` matches this run's own id above — the curated
        // `settled` handling now requires it before treating the event as
        // this run's own (the accounting it is meant to exercise here).
        toolbox.dispatchEvent(
          new ToolboxSettledEvent({
            tool,
            call: spuriousCall,
            ownerId: 'ac-durable-spurious-settled',
          }),
        );
        toolbox.dispatchEvent(
          new ToolboxSettledEvent({
            tool,
            call: spuriousCall,
            ownerId: 'ac-durable-spurious-settled',
          }),
        );
      }).not.toThrow();

      const closedAcknowledgement = activeRun.closed();
      const result = await activeRun.result;
      expect(result.finishReason).toBe('stop-condition');
      expect(await closedAcknowledgement).toEqual({ status: 'completed' });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('resolves completed once the result promise settles normally, without any cancellation', async () => {
    const context = await buildContext();
    try {
      const activeRun = createDurableActiveRun(context, {
        runId: 'ac1-durable-completed',
        sessionId: 'ac1-durable-completed',
        options: runOptions(async () => ({ content: 'done', toolCalls: [] })),
        prompt: 'Hello',
      });

      const closedAcknowledgement = activeRun.closed();
      await activeRun.result;

      expect(await closedAcknowledgement).toEqual({ status: 'completed' });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('withholds completed until the post-cancel re-read of getDurableRun observes status "cancelled" — never merely because engine.cancel resolved (AC7)', async () => {
    const { engine } = createManualDurableEngine();
    let resolveGet!: (state: { status: string } | null) => void;
    const getPromise = new Promise<{ status: string } | null>((resolve) => {
      resolveGet = resolve;
    });
    // createManualDurableEngine's `cancel` rejects the workflow result with
    // "Workflow cancelled" (the B6 race) but resolves its own promise — so a
    // non-throwing `engine.cancel` reaching closed() proves nothing on its
    // own; only this controllable `get` re-read can unblock it.
    engine.get = (async () => getPromise) as RegistryAgnosticEngine['get'];

    const runId = 'ac7-cancel-confirmed';
    const activeRun = createDurableActiveRun(
      { engine, checkpointStore: createManualCheckpointStore() },
      {
        runId,
        sessionId: runId,
        options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
        prompt: 'Hello',
      },
    );

    await Promise.resolve();
    activeRun.abort();

    const closedAcknowledgement = activeRun.closed();
    await activeRun.result;

    let settled = false;
    void closedAcknowledgement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveGet({ status: 'cancelled' });

    const first = await closedAcknowledgement;
    expect(first).toEqual({ status: 'completed' });
    // Idempotent: a repeated call returns the identical cached object.
    expect(await activeRun.closed()).toBe(first);
  });

  it('fires its own post-cancel re-read cancellation when abort() ran before the workflow existed, so cancelSettled was never set (AC7)', async () => {
    const { engine, resolveResult } = createManualDurableEngine();
    const cancelledIds: string[] = [];
    // Rejects (run already terminal, matching the comment on
    // `resolveDurableOutcome`'s fallback call) rather than resolving — this
    // exercises the `.catch(() => undefined)` swallow, not just the call
    // itself. Doesn't touch the workflow result (the real `cancel` does that
    // via `createManualDurableEngine`'s B6 race simulation); this scenario
    // tests the OTHER way a run ends up cancel-requested-but-settled: the
    // workflow completed on its own (`resolveResult` below) despite an
    // abort that arrived before it even existed.
    engine.cancel = async (id: string) => {
      cancelledIds.push(id);
      throw new Error('already terminal');
    };
    engine.get = (async () => ({
      status: 'cancelled',
    })) as unknown as RegistryAgnosticEngine['get'];

    const runId = 'ac7-abort-before-drive-started';
    const activeRun = createDurableActiveRun(
      { engine, checkpointStore: createManualCheckpointStore() },
      {
        runId,
        sessionId: runId,
        options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
        prompt: 'Hello',
      },
    );

    // Abort SYNCHRONOUSLY, before the deferred-microtask `drive()` call has
    // fired — `driveStarted` is still false, so abort()'s own engine.cancel
    // call is skipped (the workflow doesn't exist yet) and `cancelSettled`
    // is never set. `resolveDurableOutcome` must fire its own cancel call
    // instead of awaiting `undefined`.
    activeRun.abort();
    expect(cancelledIds).toEqual([]);

    // The manual engine never settles its own result on its own; simulate
    // the workflow completing normally so `result` (and therefore
    // `resolveDurableOutcome`) can proceed.
    resolveResult();

    const closedAcknowledgement = activeRun.closed();
    await activeRun.result;

    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
    expect(cancelledIds).toContain(runId);
  });

  it('resolves unresolved/persistence-failed when the post-cancel re-read throws (coordinator persistence-failed fixture)', async () => {
    const { engine } = createManualDurableEngine();
    const readFailure = new Error('storage unavailable');
    engine.get = async () => {
      throw readFailure;
    };

    const runId = 'ac7-persistence-failed-throws';
    const activeRun = createDurableActiveRun(
      { engine, checkpointStore: createManualCheckpointStore() },
      {
        runId,
        sessionId: runId,
        options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
        prompt: 'Hello',
      },
    );

    await Promise.resolve();
    activeRun.abort();
    const closedAcknowledgement = activeRun.closed();
    await activeRun.result;

    expect(await closedAcknowledgement).toEqual({
      status: 'unresolved',
      reason: 'persistence-failed',
      error: readFailure,
    });
  });

  it('resolves unresolved/persistence-failed when the post-cancel re-read returns no record (coordinator persistence-failed fixture)', async () => {
    const { engine } = createManualDurableEngine();
    engine.get = async () => null;

    const runId = 'ac7-persistence-failed-null';
    const activeRun = createDurableActiveRun(
      { engine, checkpointStore: createManualCheckpointStore() },
      {
        runId,
        sessionId: runId,
        options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
        prompt: 'Hello',
      },
    );

    await Promise.resolve();
    activeRun.abort();
    const closedAcknowledgement = activeRun.closed();
    await activeRun.result;

    expect(await closedAcknowledgement).toEqual({
      status: 'unresolved',
      reason: 'persistence-failed',
    });
  });

  // Regression: a code-review finding on the AB-204 pull request —
  // `engine.cancel` resolving is not proof the cancellation record
  // committed; a post-cancel re-read that still reports a NONTERMINAL
  // status (not just a missing record) must not be reported completed.
  it('resolves unresolved/persistence-failed when the post-cancel re-read reports a nonterminal status', async () => {
    const { engine } = createManualDurableEngine();
    engine.get = (async () => ({ status: 'running' })) as unknown as RegistryAgnosticEngine['get'];

    const runId = 'ac7-persistence-failed-nonterminal';
    const activeRun = createDurableActiveRun(
      { engine, checkpointStore: createManualCheckpointStore() },
      {
        runId,
        sessionId: runId,
        options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
        prompt: 'Hello',
      },
    );

    await Promise.resolve();
    activeRun.abort();
    const closedAcknowledgement = activeRun.closed();
    await activeRun.result;

    expect(await closedAcknowledgement).toEqual({
      status: 'unresolved',
      reason: 'persistence-failed',
    });
  });

  // Regression: a code-review finding on the AB-204 pull request — a second
  // abort() (e.g. explicit abort() followed by dispose()) must not
  // overwrite `cancelSettled` with a fresh, possibly slower or
  // non-resolving, redundant `engine.cancel` call; closed() must keep
  // waiting on the FIRST one.
  it('does not fire a second engine.cancel call — and does not wait on one — when abort() is called twice after the workflow started', async () => {
    const { engine, rejectResult } = createManualDurableEngine();
    const cancelCalls: string[] = [];
    let resolveFirstCancel!: () => void;
    const firstCancelGate = new Promise<void>((resolve) => {
      resolveFirstCancel = resolve;
    });
    engine.cancel = async (id: string) => {
      cancelCalls.push(id);
      if (cancelCalls.length === 1) {
        await firstCancelGate;
        // The real `cancel` rejects the workflow result as a side effect
        // (the B6 race) — replicate that so the run still settles.
        rejectResult(new Error('Workflow cancelled'));
        return;
      }
      throw new Error('a second engine.cancel call should never have been made');
    };
    engine.get = (async () => ({
      status: 'cancelled',
    })) as unknown as RegistryAgnosticEngine['get'];

    const runId = 'ac7-cancel-settled-idempotent';
    const activeRun = createDurableActiveRun(
      { engine, checkpointStore: createManualCheckpointStore() },
      {
        runId,
        sessionId: runId,
        options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
        prompt: 'Hello',
      },
    );

    await Promise.resolve();
    activeRun.abort();
    activeRun.abort();
    expect(cancelCalls).toEqual([runId]);

    const closedAcknowledgement = activeRun.closed();
    resolveFirstCancel();
    await activeRun.result;

    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
    expect(cancelCalls).toEqual([runId]);
  });

  // AB-291 (AC1) — durable parity with AB-204's in-memory fix
  // (create-run.test.ts's identical "does not resolve completed while an
  // onRunComplete hook is still running" test): `onRunComplete` fires
  // fire-and-forget via `runHookSilently`, so `result` can settle while it
  // is still running. `closed()` is called BEFORE `result` settles (not
  // after) — matching the reference test's own structure — because
  // `createClosedAcknowledgement`'s `not-required` fast path only ever
  // engages when `result` has ALREADY fulfilled at the moment `closed()` is
  // first called; calling `closed()` first forces the real
  // `resolveDurableOutcome` path so this test actually exercises the fix.
  it('does not resolve durable closed() completed while an onRunComplete hook is still running, and resolves once it settles (AC1)', async () => {
    const context = await buildContext();
    try {
      let releaseHook: (() => void) | undefined;
      const hookGate = new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('onRunComplete', async () => {
        await hookGate;
      });

      const activeRun = createRun(
        {
          ...runOptions(async () => ({ content: 'done', toolCalls: [] })),
          hooks,
        },
        { ...context, runId: 'ac1-durable-slow-hook', prompt: 'Hello' },
      );

      const closedAcknowledgement = activeRun.closed();
      const result = await activeRun.result;
      expect(result.finishReason).toBe('stop-condition');

      let settledFlag = false;
      void closedAcknowledgement.then(() => {
        settledFlag = true;
      });
      // `hookGate` is only ever resolved by `releaseHook()`, so
      // `resolveDurableOutcome` genuinely cannot reach `completed` while
      // it's pending, at any tick count.
      for (let tick = 0; tick < 25; tick++) {
        await Promise.resolve();
      }
      expect(settledFlag).toBe(false);

      releaseHook?.();

      expect(await closedAcknowledgement).toEqual({ status: 'completed' });
      expect(settledFlag).toBe(true);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  // AB-291 (AC2) — durable parity with create-run.ts's identical fix
  // (AB-204 review PRRT_kwDORvupsc6erGS9): `options.signal` can be a
  // long-lived signal a caller reuses across many runs. An un-removed
  // listener on an already-terminal run would fire `abort()` — and issue a
  // redundant `engine.cancel()` — for that historical run too, the instant
  // the shared signal later aborts for an unrelated (still-live) run.
  it('removes the caller-signal abort listener on terminal state, so a reused signal fires engine.cancel only for the still-live durable run (AC2)', async () => {
    const context = await buildContext();
    try {
      const controller = new AbortController();

      // Run A settles to terminal on its own, never aborted while alive,
      // with the shared signal attached for its whole life.
      const finished = createRun(
        {
          ...runOptions(async () => ({ content: 'done', toolCalls: [] })),
          signal: controller.signal,
        },
        { ...context, runId: 'ac2-terminal-run', prompt: 'Hello' },
      );
      await finished.result;

      // Spy AFTER run A settles: a stale, un-removed listener on A would
      // fire `abort()` (and `engine.cancel`) for A's OWN (already-terminal)
      // runId too, once the shared signal aborts below, alongside the
      // genuinely live run B.
      const cancelCalls: string[] = [];
      const realCancel = context.engine.cancel.bind(context.engine);
      context.engine.cancel = async (id: string) => {
        cancelCalls.push(id);
        return realCancel(id);
      };

      // Run B is genuinely in flight — its generate() blocks on the shared
      // signal — when the signal aborts.
      const live = createRun(
        {
          ...runOptions(
            ({ signal }) =>
              new Promise((_resolve, reject) => {
                signal?.addEventListener(
                  'abort',
                  () => reject(new Error('aborted during generate')),
                  { once: true },
                );
              }),
          ),
          signal: controller.signal,
        },
        { ...context, runId: 'ac2-live-run', prompt: 'Hello' },
      );

      // Let the deferred-microtask `drive()` call begin for run B before
      // aborting — matching this file's established pattern for exercising
      // the real Weft engine (see e.g. "aborts a running durable run and
      // propagates the abort reason" above); a real engine's inline launch
      // is scheduled via a macrotask, so a bare microtask flush is not
      // enough.
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort('shared signal aborted');

      await live.result;

      // Only B's `engine.cancel` call — A's already-detached listener never
      // fired a second, redundant one for its own runId.
      expect(cancelCalls).toEqual(['ac2-live-run']);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  // AB-291 (AC3): a workflow parked in `ctx.sleep`/`ctx.waitForSignal` can
  // only be unblocked by a resolving `engine.cancel()` — if it rejects
  // instead, the workflow never advances, `result` never settles, and
  // `closed()` (gated on `result`) would hang forever without this fix.
  // Uses the manual engine so the workflow's own `result` genuinely never
  // settles on its own (unlike the real engine, or `createManualDurableEngine`'s
  // DEFAULT `cancel`, which rejects `result` as its own side effect — the
  // B6 race simulation other tests in this file rely on).
  it('resolves closed() with failed (never hangs) when engine.cancel rejects against a genuinely parked workflow (AC3)', async () => {
    const { engine } = createManualDurableEngine();
    const cancelRejection = new Error('cancel rejected while parked');
    engine.cancel = async () => {
      // Reject WITHOUT settling the workflow's own result — the workflow
      // stays parked, unable to advance, exactly as it would in production
      // if the durable engine's own cancel command failed.
      throw cancelRejection;
    };

    const runId = 'ac3-durable-cancel-rejects-while-parked';
    const activeRun = createDurableActiveRun(
      { engine, checkpointStore: createManualCheckpointStore() },
      {
        runId,
        sessionId: runId,
        options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
        prompt: 'Hello',
      },
    );

    // Let the deferred-microtask drive() call fire (driveStarted = true) so
    // abort() below actually reaches engine.cancel().
    await Promise.resolve();
    activeRun.abort('stop the parked workflow');

    const closedAcknowledgement = await activeRun.closed();
    expect(closedAcknowledgement).toEqual({ status: 'failed', error: cancelRejection });

    // The public `result` promise is UNCHANGED by this fix — the run's real
    // completion signal stays genuinely pending (the workflow really is
    // stuck); only `closed()`'s own gate resolved.
    let resultSettled = false;
    void activeRun.result.then(
      () => {
        resultSettled = true;
      },
      () => {
        resultSettled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(resultSettled).toBe(false);
  });

  // Review finding on this pull request: `cancelRejectionGate` must trip
  // ONLY for the genuinely-parked (suspended) case above — not for every
  // `engine.cancel()` rejection. A cancel can also legitimately reject
  // against a workflow that's already terminal, or mid-step and about to
  // settle cleanly on its own (the B6 abort-into-generate race the "still
  // settles when engine.cancel rejects during durable abort cleanup" test
  // above exercises for `result`). Misclassifying THOSE as `failed` would
  // be a regression on a clean cleanup. Overrides `engine.get` to report
  // `'running'` (not `'suspended'`) at the moment of the rejection, proving
  // the gate stays untripped and `closed()` instead falls through to the
  // ordinary post-cancel re-read once the workflow settles on its own.
  it('does not classify closed() failed for a benign engine.cancel rejection against a workflow that is not parked', async () => {
    const { engine, resolveResult } = createManualDurableEngine();
    engine.cancel = async () => {
      throw new Error('cancel rejected but the workflow was never actually parked');
    };
    engine.get = (async () => ({ status: 'running' })) as unknown as RegistryAgnosticEngine['get'];

    const runId = 'ac3-durable-cancel-rejects-not-parked';
    const activeRun = createDurableActiveRun(
      { engine, checkpointStore: createManualCheckpointStore() },
      {
        runId,
        sessionId: runId,
        options: runOptions(async () => ({ content: 'unused', toolCalls: [] })),
        prompt: 'Hello',
      },
    );

    await Promise.resolve();
    activeRun.abort('abort races a workflow about to settle on its own');
    const closedAcknowledgement = activeRun.closed();

    // Let the rejected engine.cancel()'s own `engine.get` check resolve —
    // it observes 'running', so `cancelRejectionGate` is never tripped —
    // before the workflow settles on its own.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The workflow settles normally, as if the cancel simply lost the race.
    resolveResult();

    // `resolveDurableOutcome`'s OWN post-cancel re-read also observes the
    // still-'running' (nonterminal) status, so this resolves
    // unresolved/persistence-failed — never `failed` — proving the benign
    // rejection above was correctly ignored, not misclassified.
    expect(await closedAcknowledgement).toEqual({
      status: 'unresolved',
      reason: 'persistence-failed',
    });
  });
});

/**
 * AB-304: `createDurableActiveRun`/`reattachDurableActiveRun` thread
 * `RunOptions.childRegistry`/the `childRegistry` reattach option through,
 * folding `ChildRunRegistry.awaitChildrenClosed()` into their own
 * `closed()` — the durable-path counterpart to `create-run.test.ts`'s
 * identical AB-211 suite. The child is a REAL in-memory `RunnableAgent`
 * (`createAgent`) dispatched via `dispatchChildRun`, with a tool gated on a
 * manually-resolved promise (no real sleeps) so its own `closed()` stays
 * pending on a slow tool drain — exactly the AB-289 pattern `create-run.ts`
 * already exercises — until the test releases it.
 */
describe('AB-304: durable ActiveRun closed() awaits registered children', () => {
  function buildSlowChildAgent(): { agent: RunnableAgent; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowTool = createTool({
      name: 'slow_child_tool',
      description: 'Stays in flight until the test releases it.',
      input: z.object({}),
      execute: async () => {
        await gate;
        return { done: true };
      },
    });
    const toolbox = createTestToolbox([slowTool]);
    const generate = createMockGenerate([
      { content: '', toolCalls: [{ name: 'slow_child_tool', arguments: {} }] },
      { content: 'child done', toolCalls: [] },
    ]);
    const agent = createAgent({
      name: 'ab-304-child',
      generate,
      toolbox,
      stopWhen: stopWhen.noToolCalls(),
    });
    return { agent, release };
  }

  it('does not report completed until a dispatched child, kept pending by a slow tool drain, itself settles', async () => {
    const context = await buildContext();
    try {
      const registry = createChildRunRegistry();
      const { agent: childAgent, release: releaseChildTool } = buildSlowChildAgent();
      const runId = 'ab-304-durable-parent';

      const activeRun = createDurableActiveRun(context, {
        runId,
        sessionId: runId,
        options: {
          ...runOptions(async () => ({ content: 'done', toolCalls: [] })),
          childRegistry: registry,
        },
        prompt: 'Hello',
      });

      dispatchChildRun(childAgent, 'go', {
        agentName: 'ab-304-child',
        parentRunId: runId,
        registry,
      });

      const closedAcknowledgement = activeRun.closed();
      const result = await activeRun.result;
      expect(result.finishReason).toBe('stop-condition');

      let settledFlag = false;
      void closedAcknowledgement.then(() => {
        settledFlag = true;
      });
      // The child's own `closed()` only settles once `slow_child_tool`'s
      // callback genuinely returns (AB-289) — flush generously so a
      // regression that skips the fold-in shows up unambiguously rather
      // than surviving a lucky race against a handful of microtask hops.
      for (let tick = 0; tick < 25; tick++) {
        await Promise.resolve();
      }
      expect(settledFlag).toBe(false);

      releaseChildTool();

      expect(await closedAcknowledgement).toEqual({ status: 'completed' });
      expect(settledFlag).toBe(true);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('resolves not-required immediately for a zero-children run, identically to before this issue, even when a childRegistry is supplied but empty', async () => {
    const context = await buildContext();
    try {
      const registry = createChildRunRegistry();
      const runId = 'ab-304-durable-empty-registry';

      const activeRun = createDurableActiveRun(context, {
        runId,
        sessionId: runId,
        options: {
          ...runOptions(async () => ({ content: 'done', toolCalls: [] })),
          childRegistry: registry,
        },
        prompt: 'Hello',
      });

      await activeRun.result;
      await Promise.resolve();

      expect(await activeRun.closed()).toEqual({ status: 'not-required' });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('a reattached parent after recovery waits the same way for a child dispatched onto the SAME registry after reattachment', async () => {
    const context = await buildContext();
    try {
      const registry = createChildRunRegistry();
      const { agent: childAgent, release: releaseChildTool } = buildSlowChildAgent();
      const runId = 'ab-304-reattach-parent';

      const handle = {
        id: runId,
        result: () =>
          Promise.resolve({
            schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
            runId,
            steps: 1,
            content: 'recovered done',
            finishReason: 'stop-condition' as const,
          }),
      };

      const recoveredRun = reattachDurableActiveRun(
        { engine: context.engine, checkpointStore: context.checkpointStore },
        { runId, handle, childRegistry: registry },
      );

      // Dispatched AFTER reattachment — proving discovery isn't limited to
      // children registered before the parent was rebuilt.
      dispatchChildRun(childAgent, 'go', {
        agentName: 'ab-304-child',
        parentRunId: runId,
        registry,
      });

      const closedAcknowledgement = recoveredRun.closed();
      const result = await recoveredRun.result;
      expect(result.finishReason).toBe('stop-condition');

      let settledFlag = false;
      void closedAcknowledgement.then(() => {
        settledFlag = true;
      });
      for (let tick = 0; tick < 25; tick++) {
        await Promise.resolve();
      }
      expect(settledFlag).toBe(false);

      releaseChildTool();

      expect(await closedAcknowledgement).toEqual({ status: 'completed' });
      expect(settledFlag).toBe(true);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('reattach resolves not-required immediately when a childRegistry is supplied but nothing was ever dispatched onto it', async () => {
    const context = await buildContext();
    try {
      const registry = createChildRunRegistry();
      const runId = 'ab-304-reattach-empty-registry';
      const handle = {
        id: runId,
        result: () =>
          Promise.resolve({
            schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
            runId,
            steps: 0,
            content: 'done',
            finishReason: 'stop-condition' as const,
          }),
      };

      const recoveredRun = reattachDurableActiveRun(
        { engine: context.engine, checkpointStore: context.checkpointStore },
        { runId, handle, childRegistry: registry },
      );

      await recoveredRun.result;
      await Promise.resolve();

      expect(await recoveredRun.closed()).toEqual({ status: 'not-required' });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });
});

describe('createRecoveredRunEventSurface', () => {
  it('rebuilds curated and forwarded toolbox events with recovery stamps and cleanup', () => {
    const callerAbortController = new AbortController();
    const tool = createTool({
      name: 'recovered-tool',
      description: 'A recovered-run event source',
      input: z.object({ value: z.string() }),
      async execute({ value }) {
        return { value };
      },
    });
    const toolbox = createToolbox([tool]);
    const options = {
      ...runOptions(async () => ({ content: 'unused', toolCalls: [] })),
      signal: callerAbortController.signal,
      toolbox: toolbox as unknown as RunOptions['toolbox'],
    };
    const services = { options, toolbox };
    const surface = createRecoveredRunEventSurface(services, 'recovered-run-id', 'recovered-agent');

    const started: ToolStartedBubbleEvent[] = [];
    const settled: ToolSettledBubbleEvent[] = [];
    const errors: ToolErrorBubbleEvent[] = [];
    const progress: ToolProgressBubbleEvent[] = [];
    const denials: ToolPolicyDeniedBubbleEvent[] = [];
    const forwardedTypes: string[] = [];
    surface.emitter.addEventListener('tool.started', (event) => started.push(event));
    surface.emitter.addEventListener('tool.settled', (event) => settled.push(event));
    surface.emitter.addEventListener('tool.error', (event) => errors.push(event));
    surface.emitter.addEventListener('tool.progress', (event) => progress.push(event));
    surface.emitter.addEventListener('tool.policy-denied', (event) => denials.push(event));
    surface.emitter.toObservable().subscribe((event) => forwardedTypes.push(event.type));

    const conversation = new Conversation();
    surface.emitter.dispatchEvent(new StepStartedEvent(conversation, 3));
    const call = {
      id: 'recovered-call-id',
      name: tool.name,
      arguments: { value: 'hello' },
    };
    // AB-290: each hand-constructed event's `ownerId` matches the
    // `'recovered-run-id'` `runId` passed to `createRecoveredRunEventSurface`
    // above — the curated `tool.*` bubbles now require it before forwarding.
    toolbox.dispatchEvent(
      new ToolboxExecuteStartEvent({
        tool,
        call,
        params: { value: 'hello' },
        ownerId: 'recovered-run-id',
      }),
    );
    toolbox.dispatchEvent(
      new ToolboxProgressEvent({
        tool,
        call,
        percent: 50,
        message: 'halfway',
        ownerId: 'recovered-run-id',
      }),
    );
    toolbox.dispatchEvent(
      new ToolboxPolicyDeniedEvent({
        tool,
        call,
        params: { value: 'hello' },
        reason: 'approval required',
      }),
    );
    toolbox.dispatchEvent(
      new ToolboxSettledEvent({
        tool,
        call,
        result: { value: 'hello' },
        ownerId: 'recovered-run-id',
      }),
    );
    const failure = new Error('recovered tool failed');
    toolbox.dispatchEvent(
      new ToolboxSettledEvent({ tool, call, error: failure, ownerId: 'recovered-run-id' }),
    );

    expect(services.options.toolbox).toBe(toolbox);
    expect(services.options.signal).not.toBe(callerAbortController.signal);
    expect(services.options.signal?.aborted).toBe(false);
    surface.abort('recovered run stopped');
    expect(services.options.signal?.aborted).toBe(true);
    expect(services.options.signal?.reason).toBe('recovered run stopped');
    expect(services).toMatchObject({ emitter: surface.emitter });
    expect(forwardedTypes).toEqual(
      expect.arrayContaining([
        'toolbox.execute-start',
        'toolbox.progress',
        'toolbox.policy-denied',
        'toolbox.settled',
      ]),
    );
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      agentName: 'recovered-agent',
      runId: 'recovered-run-id',
      step: 3,
      toolName: tool.name,
      toolCallId: call.id,
      params: { value: 'hello' },
    });
    expect(progress[0]).toMatchObject({
      step: 3,
      percent: 50,
      message: 'halfway',
    });
    expect(denials[0]).toMatchObject({ step: 3, reason: 'approval required' });
    expect(settled).toHaveLength(2);
    expect(settled[0]).toMatchObject({ step: 3, status: 'success', result: { value: 'hello' } });
    expect(settled[1]).toMatchObject({ step: 3, status: 'error', error: failure });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ step: 3, error: failure });

    surface.stopToolboxForward();
    const eventCountAfterCleanup = forwardedTypes.length;
    surface.emitter.dispatchEvent(new StepStartedEvent(conversation, 9));
    toolbox.dispatchEvent(
      new ToolboxProgressEvent({ tool, call, percent: 100, message: 'after cleanup' }),
    );
    expect(forwardedTypes).toHaveLength(eventCountAfterCleanup + 1);
    expect(progress).toHaveLength(1);
  });

  it('forwards events from a selectTools-swapped step toolbox and stops without duplicating base events (AB-239)', () => {
    const tool = createTool({
      name: 'recovered-swap-tool',
      description: 'A recovered-run swapped-toolbox event source',
      input: z.object({ value: z.string() }),
      async execute({ value }) {
        return { value };
      },
    });
    const baseToolbox = createToolbox([tool]);
    const swappedToolbox = createToolbox([tool]);
    const options = {
      ...runOptions(async () => ({ content: 'unused', toolCalls: [] })),
      toolbox: baseToolbox as unknown as RunOptions['toolbox'],
    };
    // A resolver-installed `onStepToolbox` already on `services` before this
    // surface is built must be chained, not clobbered.
    const priorCalls: AnyToolbox[] = [];
    const services: DurableRunDeps = {
      options,
      toolbox: baseToolbox,
      onStepToolbox: (toolbox) => priorCalls.push(toolbox),
    };
    const surface = createRecoveredRunEventSurface(
      services,
      'recovered-swap-run',
      'recovered-agent',
    );

    const forwardedTypes: string[] = [];
    surface.emitter.toObservable().subscribe((event) => forwardedTypes.push(event.type));

    // `run-workflow.ts` calls `deps.onStepToolbox` (== `services.onStepToolbox`)
    // once per step with that step's resolved toolbox.
    expect(services.onStepToolbox).toBeDefined();
    services.onStepToolbox?.(swappedToolbox);
    expect(priorCalls).toEqual([swappedToolbox]);

    const call = { id: 'swap-call-id', name: tool.name, arguments: { value: 'hi' } };
    swappedToolbox.dispatchEvent(
      new ToolboxBudgetExceededEvent({ tool, call, reason: 'Budget exceeded: max calls 1' }),
    );
    expect(forwardedTypes).toContain('toolbox.budget-exceeded');

    // The base toolbox's own subscription is untouched by the swap — it
    // still forwards, and does not duplicate the swapped toolbox's events.
    const beforeBaseCount = forwardedTypes.length;
    baseToolbox.dispatchEvent(new ToolboxCallEvent({ tool, call }));
    expect(forwardedTypes).toHaveLength(beforeBaseCount + 1);
    expect(forwardedTypes.filter((type) => type === 'toolbox.call')).toHaveLength(1);

    // Reverting to the base toolbox for the next step stops the swap
    // subscription — the swapped toolbox's later events are no longer forwarded.
    services.onStepToolbox?.(baseToolbox);
    const beforeRevertCount = forwardedTypes.length;
    swappedToolbox.dispatchEvent(
      new ToolboxBudgetExceededEvent({ tool, call, reason: 'ignored after revert' }),
    );
    expect(forwardedTypes).toHaveLength(beforeRevertCount);

    // `stopToolboxForward` (used by both the fresh-start and recovered
    // drivers' cleanup) also silences the base subscription.
    surface.stopToolboxForward();
    const beforeStopCount = forwardedTypes.length;
    baseToolbox.dispatchEvent(new ToolboxCallEvent({ tool, call }));
    expect(forwardedTypes).toHaveLength(beforeStopCount);

    // `stop()` is final: a late `onStepToolbox` call (e.g. a driver bug, or a
    // step resolving after cleanup) must not re-open a swap subscription —
    // the chained resolver callback still fires either way.
    services.onStepToolbox?.(swappedToolbox);
    expect(priorCalls).toEqual([swappedToolbox, baseToolbox, swappedToolbox]);
    swappedToolbox.dispatchEvent(
      new ToolboxBudgetExceededEvent({ tool, call, reason: 'ignored after stop' }),
    );
    expect(forwardedTypes).toHaveLength(beforeStopCount);
  });

  it('forwards curated tool.* bubble events from a selectTools-swapped step toolbox and stops without duplicating base events (AB-294)', () => {
    const tool = createTool({
      name: 'recovered-swap-curated-tool',
      description: 'A recovered-run swapped-toolbox curated-event source',
      input: z.object({ value: z.string() }),
      async execute({ value }) {
        return { value };
      },
    });
    const baseToolbox = createToolbox([tool]);
    const swappedToolbox = createToolbox([tool]);
    const options = {
      ...runOptions(async () => ({ content: 'unused', toolCalls: [] })),
      toolbox: baseToolbox as unknown as RunOptions['toolbox'],
    };
    const services: DurableRunDeps = { options, toolbox: baseToolbox };
    const surface = createRecoveredRunEventSurface(
      services,
      'recovered-swap-curated-run',
      'recovered-agent',
    );

    const started: ToolStartedBubbleEvent[] = [];
    const settled: ToolSettledBubbleEvent[] = [];
    const progress: ToolProgressBubbleEvent[] = [];
    const denied: ToolPolicyDeniedBubbleEvent[] = [];
    surface.emitter.addEventListener('tool.started', (event) => started.push(event));
    surface.emitter.addEventListener('tool.settled', (event) => settled.push(event));
    surface.emitter.addEventListener('tool.progress', (event) => progress.push(event));
    surface.emitter.addEventListener('tool.policy-denied', (event) => denied.push(event));

    // `run-workflow.ts` calls `deps.onStepToolbox` once per step with that
    // step's resolved toolbox.
    services.onStepToolbox?.(swappedToolbox);

    const call = { id: 'swap-curated-call-id', name: tool.name, arguments: { value: 'hi' } };
    // AB-290: `ownerId` matches the `'recovered-swap-curated-run'` runId
    // above — the curated `tool.*` bubbles now require it before forwarding.
    const ownerId = 'recovered-swap-curated-run';
    swappedToolbox.dispatchEvent(
      new ToolboxExecuteStartEvent({ tool, call, params: { value: 'hi' }, ownerId }),
    );
    swappedToolbox.dispatchEvent(
      new ToolboxProgressEvent({ tool, call, percent: 50, message: 'halfway', ownerId }),
    );
    swappedToolbox.dispatchEvent(
      new ToolboxPolicyDeniedEvent({ tool, call, params: { value: 'hi' }, reason: 'blocked' }),
    );
    swappedToolbox.dispatchEvent(
      new ToolboxSettledEvent({ tool, call, result: { value: 'hi' }, ownerId }),
    );

    expect(started).toHaveLength(1);
    expect(started[0]?.toolName).toBe(tool.name);
    expect(progress).toHaveLength(1);
    expect(progress[0]?.percent).toBe(50);
    expect(denied).toHaveLength(1);
    expect(denied[0]?.reason).toBe('blocked');
    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe('success');

    // The base toolbox's own curated subscription is untouched by the
    // swap — it still forwards, and does not duplicate the swapped
    // toolbox's events.
    const beforeBaseStartedCount = started.length;
    baseToolbox.dispatchEvent(
      new ToolboxExecuteStartEvent({ tool, call, params: { value: 'hi' }, ownerId }),
    );
    expect(started).toHaveLength(beforeBaseStartedCount + 1);

    // Reverting to the base toolbox for the next step stops the swap
    // subscription — the swapped toolbox's later events are no longer forwarded.
    services.onStepToolbox?.(baseToolbox);
    const beforeRevertProgressCount = progress.length;
    swappedToolbox.dispatchEvent(
      new ToolboxProgressEvent({
        tool,
        call,
        percent: 100,
        message: 'ignored after revert',
        ownerId,
      }),
    );
    expect(progress).toHaveLength(beforeRevertProgressCount);

    surface.stopToolboxForward();
    const beforeStopStartedCount = started.length;
    baseToolbox.dispatchEvent(
      new ToolboxExecuteStartEvent({ tool, call, params: { value: 'hi' }, ownerId }),
    );
    expect(started).toHaveLength(beforeStopStartedCount);
  });

  it('does not throw when the base toolbox omits addEventListener (AB-294)', () => {
    // A minimal stub toolbox without `addEventListener` — mirrors the guard
    // `attachToolboxCuratedListeners` documents against mock/custom
    // toolboxes that omit it (e.g. minimal stubs used in tests).
    const stubToolbox = {
      tools: () => [],
      execute: async () => {
        throw new Error('never called in this test');
      },
      toObservable: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
    };
    const options = {
      ...runOptions(async () => ({ content: 'unused', toolCalls: [] })),
      toolbox: stubToolbox as unknown as RunOptions['toolbox'],
    };
    const services: DurableRunDeps = { options, toolbox: stubToolbox as unknown as AnyToolbox };

    const surface = createRecoveredRunEventSurface(
      services,
      'recovered-no-listener-run',
      'recovered-agent',
    );
    expect(() => surface.stopToolboxForward()).not.toThrow();
  });
});

describe('reattachDurableActiveRun', () => {
  it('rethrows unsupported recovered result versions', async () => {
    const context = await buildContext();
    try {
      const handle = {
        id: 'reattach-unsupported-version',
        result: () =>
          Promise.resolve({
            schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION + 1,
            runId: 'reattach-unsupported-version',
            steps: 0,
            content: 'legacy',
            finishReason: 'stop-condition',
          }),
      };
      const recoveredRun = reattachDurableActiveRun(
        { engine: context.engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-unsupported-version', handle },
      );

      expect(recoveredRun.result).rejects.toThrow(UnsupportedRunResultVersionError);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('fires run.aborted when the run is aborted via the adapter (committee round-2 finding 2)', async () => {
    const context = await buildContext();
    try {
      // A handle whose result() stays pending until the adapter cancels it, then
      // rejects — modelling engine.cancel terminalizing a recovered run.
      let rejectResult: ((error: unknown) => void) | undefined;
      const handle = {
        id: 'reattach-abort',
        result: () => new Promise<unknown>((_resolve, reject) => (rejectResult = reject)),
      };
      const cancelled: string[] = [];
      // The reattach adapter only calls `engine.cancel` (in abort()); a minimal
      // stub whose cancel rejects the mock handle's result is all it needs.
      const engine = {
        cancel: async (id: string) => {
          cancelled.push(id);
          rejectResult?.(new Error('cancelled'));
        },
      } as unknown as RegistryAgnosticEngine;

      const events: string[] = [];
      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-abort', handle },
      );
      recoveredRun.addEventListener('run.aborted', () => events.push('run.aborted'));
      recoveredRun.addEventListener('run.completed', () => events.push('run.completed'));

      // The adapter starts driving (and calls handle.result(), wiring rejectResult)
      // on a deferred microtask, so yield once before aborting — otherwise abort
      // would cancel before result() is even awaited and the mock could not reject.
      await Promise.resolve();
      recoveredRun.abort();
      const result = await recoveredRun.result;

      // The adapter-initiated abort terminalized via engine.cancel AND fired a real
      // run.aborted lifecycle (so gateway persists `aborted`), rather than the
      // write-free interrupted path used for resolver/teardown failures.
      expect(cancelled).toEqual(['reattach-abort']);
      expect(events).toEqual(['run.aborted']);
      expect(result.finishReason).toBe('aborted');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('exposes the full reattached active-run event facade', async () => {
    const context = await buildContext();
    try {
      const handle = {
        id: 'reattach-event-facade',
        result: () =>
          Promise.resolve({
            schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
            runId: 'reattach-event-facade',
            steps: 0,
            content: 'reattached',
            finishReason: 'stop-condition',
          }),
      };
      const engine = {
        cancel: async () => {},
      } as unknown as RegistryAgnosticEngine;

      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-event-facade', handle },
      );
      const collected: string[] = [];
      const removedListener = () => collected.push('removed');
      const iterator = recoveredRun.events('run.completed');
      const observableSubscription = recoveredRun.toObservable().subscribe({
        next(event) {
          if (event.type === 'run.completed') collected.push('observable');
        },
      });

      recoveredRun.addEventListener('run.completed', removedListener);
      recoveredRun.removeEventListener('run.completed', removedListener);
      recoveredRun.on('run.completed').subscribe({
        next() {
          collected.push('on');
        },
      });
      recoveredRun.once('run.completed', () => collected.push('once'));
      recoveredRun.subscribe('run.completed', () => collected.push('subscribe'));

      const result = await recoveredRun.result;
      const iteratorResult = await iterator.next();
      observableSubscription.unsubscribe();

      expect(result.finishReason).toBe('stop-condition');
      expect(iteratorResult.value.finishReason).toBe('stop-condition');
      expect(collected).toContain('on');
      expect(collected).toContain('once');
      expect(collected).toContain('subscribe');
      expect(collected).toContain('observable');
      expect(collected).not.toContain('removed');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  // Regression (AB-96 codex review, PRRT_kwDORvupsc6PxWje): the reattach
  // adapter's abort-cancel-wins branch built its RunAbortedEvent from an empty
  // `createRunState()` after loading only the checkpoint CONVERSATION, so
  // `event.usage` was zeroed even when the recovered run had already
  // checkpointed steps before the abort raced it. Mirrors the sibling B6 fix
  // for `createDurableActiveRun` above ("preserves checkpointed steps and
  // usage when cancel wins the B6 abort race"), for the RECOVERED-run path.
  it('preserves checkpointed usage when an adapter-initiated abort wins the race on a RECOVERED run', async () => {
    const context = await buildContext();
    try {
      const runId = 'reattach-abort-preserves-usage';

      // Pre-populate the checkpoint store with a completed step and usage —
      // simulating a multi-step run that checkpointed step 0 in a prior
      // process before this process recovered it.
      await context.checkpointStore.saveCursor(runId, {
        step: 1,
        totalUsage: { prompt: 42, completion: 17, total: 59 },
        lastContent: 'step 0 content',
        schemaAttempts: 0,
        lastAppliedConfigVersion: 0,
      });
      await context.checkpointStore.saveStep(runId, {
        step: 0,
        content: 'step 0 content',
        toolCalls: [],
        results: [],
        usage: { prompt: 42, completion: 17, total: 59 },
        final: true,
      });

      let rejectResult: ((error: unknown) => void) | undefined;
      const handle = {
        id: runId,
        result: () => new Promise<unknown>((_resolve, reject) => (rejectResult = reject)),
      };
      const cancelled: string[] = [];
      const engine = {
        cancel: async (id: string) => {
          cancelled.push(id);
          rejectResult?.(new Error('cancelled'));
        },
      } as unknown as RegistryAgnosticEngine;

      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: context.checkpointStore },
        { runId, handle },
      );

      let abortEvent: { usage: { prompt: number; completion: number; total: number } } | undefined;
      recoveredRun.addEventListener('run.aborted', (event) => {
        abortEvent = event as unknown as typeof abortEvent;
      });

      await Promise.resolve();
      recoveredRun.abort();
      const result = await recoveredRun.result;

      expect(cancelled).toEqual([runId]);
      expect(result.finishReason).toBe('aborted');
      // The checkpointed step + usage survive the abort — not a zeroed run state.
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.content).toBe('step 0 content');
      expect(result.usage).toEqual({ prompt: 42, completion: 17, total: 59 });
      expect(abortEvent?.usage).toEqual({ prompt: 42, completion: 17, total: 59 });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('falls back to an empty conversation when abort reconstruction cannot read the checkpoint', async () => {
    let rejectResult: ((error: unknown) => void) | undefined;
    const handle = {
      id: 'reattach-abort-load-fails',
      result: () => new Promise<unknown>((_resolve, reject) => (rejectResult = reject)),
    };
    const engine = {
      cancel: async () => {
        rejectResult?.(new Error('cancelled'));
      },
    } as unknown as RegistryAgnosticEngine;
    const checkpointStore = {
      loadConversation: async () => {
        throw new Error('checkpoint unavailable');
      },
    };

    const recoveredRun = reattachDurableActiveRun(
      { engine, checkpointStore: checkpointStore as never },
      { runId: 'reattach-abort-load-fails', handle },
    );

    await Promise.resolve();
    recoveredRun.abort();
    const result = await recoveredRun.result;

    expect(result.finishReason).toBe('aborted');
  });

  it('does not fire an abort lifecycle when recovered cancel fails', async () => {
    const originalConsoleError = console.error;
    const logs: unknown[] = [];
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      let rejectResult: ((error: unknown) => void) | undefined;
      const handle = {
        id: 'reattach-abort-cancel-fails',
        result: () => new Promise<unknown>((_resolve, reject) => (rejectResult = reject)),
      };
      const engine = {
        cancel: async () => {
          rejectResult?.(new Error('resolver-owned failure'));
          throw new Error('cancel failed');
        },
      } as unknown as RegistryAgnosticEngine;
      const events: string[] = [];

      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: {} as never },
        { runId: 'reattach-abort-cancel-fails', handle },
      );
      recoveredRun.addEventListener('run.aborted', () => events.push('run.aborted'));

      await Promise.resolve();
      recoveredRun.abort();
      const result = await recoveredRun.result;

      expect(result.finishReason).toBe('aborted');
      expect(events).toEqual([]);
      expect(logs.length).toBe(1);
      expect(String((logs[0] as unknown[])[0])).toContain('resolver-owned failure');
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('fires run.completed with finishReason error when a recovered run is terminated by the history circuit breaker (Bugbot #38)', async () => {
    // A recovered run whose handle.result() rejects with a WorkflowTimeoutError
    // (history circuit breaker / execution deadline) is GENUINELY terminal — and
    // unlike a pre-replay resolver failure, nothing else reconciles it. The
    // reattach path must fire run.completed (finishReason 'error') so the gateway
    // persists a terminal session status, rather than leaving it stuck `running`.
    const context = await buildContext();
    try {
      // A WeftError-shaped rejection: a real Error carrying the `code` that
      // isWeftErrorLike narrows on (mirrors weft's WorkflowTimeoutError).
      const timeoutError = Object.assign(new Error('workflow timed out'), {
        code: 'WorkflowTimeoutError',
      });
      const handle = {
        id: 'reattach-timeout',
        result: () => Promise.reject(timeoutError),
      };
      // engine.get returns a state whose terminationReason names the circuit
      // breaker, so classifyTimeoutMessage distinguishes it from a deadline.
      const engine = {
        get: async () => ({ status: 'timed-out', terminationReason: 'history-circuit-breaker' }),
        cancel: async () => {},
      } as unknown as RegistryAgnosticEngine;

      let completedFinishReason: RunResult['finishReason'] | undefined;
      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-timeout', handle },
      );
      recoveredRun.addEventListener('run.completed', (event) => {
        completedFinishReason = event.finishReason;
      });

      const result = await recoveredRun.result;

      // Settled as a terminal error (not the write-free interrupted path) and the
      // terminal lifecycle fired, so the session won't be left `running`.
      expect(result.finishReason).toBe('error');
      expect(completedFinishReason).toBe('error');
      expect((result.error as Error).message).toContain('history circuit breaker');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('falls back to the timeout error message when the recovered state cannot be read', async () => {
    const context = await buildContext();
    try {
      const timeoutError = Object.assign(new Error('deadline unknown'), {
        code: 'WorkflowTimeoutError',
      });
      const handle = {
        id: 'reattach-timeout-get-fails',
        result: () => Promise.reject(timeoutError),
      };
      const engine = {
        get: async () => {
          throw new Error('state unavailable');
        },
        cancel: async () => {},
      } as unknown as RegistryAgnosticEngine;

      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-timeout-get-fails', handle },
      );

      const result = await recoveredRun.result;

      expect(result.finishReason).toBe('error');
      expect((result.error as Error).message).toBe('deadline unknown');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('falls back to an empty conversation when recovered timeout checkpoint read fails', async () => {
    const timeoutError = Object.assign(new Error('workflow timed out'), {
      code: 'WorkflowTimeoutError',
    });
    const handle = {
      id: 'reattach-timeout-load-fails',
      result: () => Promise.reject(timeoutError),
    };
    const engine = {
      get: async () => ({ status: 'timed-out', terminationReason: 'history-circuit-breaker' }),
      cancel: async () => {},
    } as unknown as RegistryAgnosticEngine;
    const checkpointStore = {
      loadConversation: async () => {
        throw new Error('checkpoint unavailable');
      },
    };

    const recoveredRun = reattachDurableActiveRun(
      { engine, checkpointStore: checkpointStore as never },
      { runId: 'reattach-timeout-load-fails', handle },
    );

    const result = await recoveredRun.result;

    expect(result.finishReason).toBe('error');
    expect((result.error as Error).message).toContain('history circuit breaker');
  });

  it('returns an interrupted result and logs when a recovered run rejects without engine disposal', async () => {
    const context = await buildContext();
    const originalConsoleError = console.error;
    const logs: unknown[] = [];
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      const handle = {
        id: 'reattach-unexpected',
        result: () => Promise.reject(new Error('resolver failed')),
      };
      const engine = {
        cancel: async () => {},
      } as unknown as RegistryAgnosticEngine;

      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-unexpected', handle },
      );

      const result = await recoveredRun.result;

      expect(result.finishReason).toBe('aborted');
      expect(logs.length).toBe(1);
      expect(String((logs[0] as unknown[])[0])).toContain('did not settle cleanly');
    } finally {
      console.error = originalConsoleError;
      context.engine[Symbol.dispose]();
    }
  });

  it('disposes a reattached active run event surface', async () => {
    const context = await buildContext();
    try {
      const handle = {
        id: 'reattach-dispose',
        result: () =>
          Promise.resolve({
            schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
            runId: 'reattach-dispose',
            steps: 0,
            content: '',
            finishReason: 'stop-condition',
          }),
      };
      const engine = {
        cancel: async () => {},
      } as unknown as RegistryAgnosticEngine;

      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-dispose', handle },
      );
      recoveredRun[Symbol.dispose]();

      const result = await recoveredRun.result;
      expect(result.finishReason).toBe('stop-condition');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('reconstructs schema validation errors from recovered summaries', async () => {
    const context = await buildContext();
    try {
      const handle = {
        id: 'reattach-schema-error',
        result: () =>
          Promise.resolve({
            schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
            runId: 'reattach-schema-error',
            steps: 0,
            content: '',
            finishReason: 'stop-condition',
            schemaValidation: { success: false, error: 'schema failed' },
          }),
      };
      const engine = {
        cancel: async () => {},
      } as unknown as RegistryAgnosticEngine;

      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-schema-error', handle },
      );

      const result = await recoveredRun.result;
      expect(result.schemaValidation?.success).toBe(false);
      expect(result.schemaValidation?.error).toBeInstanceOf(AgentRunError);
      expect((result.schemaValidation?.error as AgentRunError).kind).toBe('output');
      expect((result.schemaValidation?.error as AgentRunError).code).toBe('INVALID_OUTPUT');
      expect((result.schemaValidation?.error as Error).message).toBe('schema failed');
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  // Regression (Codex re-review of 7b910a15): disposing a reattached/recovered
  // run must cancel it at the engine — not just complete the local emitter.
  // Otherwise `using`/[Symbol.dispose]() makes the caller stop observing while
  // the workflow keeps executing and BILLING under Weft.
  it('cancels the durable run at the engine when disposed (PRRT_kwDORvupsc6Mddw...)', async () => {
    let rejectResult: ((error: unknown) => void) | undefined;
    const handle = {
      id: 'reattach-dispose',
      result: () => new Promise<unknown>((_resolve, reject) => (rejectResult = reject)),
    };
    const cancelled: string[] = [];
    const engine = {
      cancel: async (id: string) => {
        cancelled.push(id);
        rejectResult?.(new Error('cancelled'));
      },
    } as unknown as RegistryAgnosticEngine;

    const recoveredRun = reattachDurableActiveRun(
      { engine, checkpointStore: {} as never },
      { runId: 'reattach-dispose', handle },
    );

    // Let the adapter start driving (wires rejectResult) before disposing, same
    // ordering as the abort() tests above.
    await Promise.resolve();
    recoveredRun[Symbol.dispose]();
    const result = await recoveredRun.result;

    // Dispose terminalized the run via engine.cancel (the workflow is stopped,
    // not left billing), and the result settles as aborted.
    expect(cancelled).toEqual(['reattach-dispose']);
    expect(result.finishReason).toBe('aborted');
  });

  it('does not double-cancel when abort() is followed by dispose() (idempotent)', async () => {
    let rejectResult: ((error: unknown) => void) | undefined;
    const handle = {
      id: 'reattach-abort-then-dispose',
      result: () => new Promise<unknown>((_resolve, reject) => (rejectResult = reject)),
    };
    const cancelled: string[] = [];
    const engine = {
      cancel: async (id: string) => {
        cancelled.push(id);
        rejectResult?.(new Error('cancelled'));
      },
    } as unknown as RegistryAgnosticEngine;

    const recoveredRun = reattachDurableActiveRun(
      { engine, checkpointStore: {} as never },
      { runId: 'reattach-abort-then-dispose', handle },
    );

    await Promise.resolve();
    recoveredRun.abort();
    recoveredRun[Symbol.dispose]();
    await recoveredRun.result;

    // engine.cancel ran exactly once despite both abort() and dispose().
    expect(cancelled).toEqual(['reattach-abort-then-dispose']);
  });

  it('AB-88/AB-214: reports a liveness snapshot fed by generate.*/tool.progress pulses on the supplied emitter', async () => {
    const context = await buildContext();
    try {
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      let resolveResult!: (value: unknown) => void;
      const handle = {
        id: 'reattach-liveness',
        result: () => new Promise<unknown>((resolve) => (resolveResult = resolve)),
      };
      const recoveredRun = reattachDurableActiveRun(
        { engine: context.engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-liveness', handle, emitter },
      );

      expect(recoveredRun.snapshot().id).toBe('reattach-liveness');
      expect(recoveredRun.snapshot().durability).toBe('durable');
      expect(recoveredRun.snapshot().evidence).toHaveLength(0);

      emitter.dispatchEvent(new GenerateStartedEvent(0));
      emitter.dispatchEvent(new GenerateCompletedEvent(0, { content: '' } as never, 1));
      emitter.dispatchEvent(new GenerateErrorEvent(0, new Error('boom'), 1));
      emitter.dispatchEvent(new GenerateRetryEvent(0, 1, new Error('boom')));
      emitter.dispatchEvent(
        new ToolProgressBubbleEvent(
          { agentName: 'a', runId: 'reattach-liveness', step: 0 },
          { toolName: 'search', toolCallId: 'call-1', percent: 50 },
        ),
      );

      const evidence = recoveredRun.snapshot().evidence;
      expect(evidence.filter((entry) => entry.source === 'provider-io')).toHaveLength(4);
      expect(evidence.filter((entry) => entry.source === 'tool-progress')).toHaveLength(1);

      const received: string[] = [];
      const subscription = recoveredRun.subscribeSnapshot((snapshot) =>
        received.push(snapshot.status),
      );
      expect(received).toEqual(['running']);
      subscription.unsubscribe();

      // The adapter starts driving (and calls handle.result(), wiring
      // resolveResult) on a deferred microtask — yield once first.
      await Promise.resolve();

      // Await the normal `drive()` (schema-version-checked) completion path
      // instead of aborting, so this doesn't exercise `engine.cancel` on a
      // workflow id the real engine never started.
      resolveResult({
        schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
        runId: 'reattach-liveness',
        steps: 0,
        content: 'done',
        finishReason: 'stop-condition',
      });
      await recoveredRun.result;

      expect(recoveredRun.snapshot().status).toBe('terminal');
      // AB-214 review (PRRT_kwDORvupsc6es7pl): the redacted projection
      // never carries the raw RunResult (conversation, tool content).
      expect(recoveredRun.snapshot().result).toEqual({
        finishReason: 'stop-condition',
        hasError: false,
      });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('AB-214 review (PRRT_kwDORvupsc6etXKX): starts and stops the tool-call watchdog from tool.started/tool.settled, not tool.progress alone', async () => {
    const context = await buildContext();
    try {
      const clock = createManualLivenessClock();
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      let resolveResult!: (value: unknown) => void;
      const handle = {
        id: 'reattach-tool-lifecycle',
        result: () => new Promise<unknown>((resolve) => (resolveResult = resolve)),
      };
      const recoveredRun = reattachDurableActiveRun(
        { engine: context.engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-tool-lifecycle', handle, emitter, livenessClock: clock },
      );

      // A tool that never reports progress still starts a watchdog — a
      // hanging tool with no progress calls must be observable as late.
      emitter.dispatchEvent(
        new ToolStartedBubbleEvent(
          { agentName: 'a', runId: 'reattach-tool-lifecycle', step: 0 },
          { toolName: 'search', toolCallId: 'call-1', params: {}, startedAt: clock.now() },
        ),
      );
      const toolCheckIntervalMs =
        (TOOL_CALL_POLICY.cadenceMs ?? 0) + TOOL_CALL_POLICY.graceMs + TOOL_CALL_POLICY.jitterMs;
      clock.advance(toolCheckIntervalMs);
      expect(recoveredRun.snapshot().missedPulseCount).toBeGreaterThan(0);

      // Settling the call tears the watchdog down — its accrued
      // missed-pulse state does not survive to falsely mark a later
      // provider step unreachable.
      emitter.dispatchEvent(
        new ToolSettledBubbleEvent(
          { agentName: 'a', runId: 'reattach-tool-lifecycle', step: 0 },
          { toolName: 'search', toolCallId: 'call-1', status: 'success' },
        ),
      );
      expect(recoveredRun.snapshot().missedPulseCount).toBe(0);
      clock.advance(toolCheckIntervalMs * 5);
      expect(recoveredRun.snapshot().missedPulseCount).toBe(0);

      // The adapter starts driving (and calls handle.result(), wiring
      // resolveResult) on a deferred microtask — yield once first.
      await Promise.resolve();
      resolveResult({
        schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
        runId: 'reattach-tool-lifecycle',
        steps: 0,
        content: 'done',
        finishReason: 'stop-condition',
      });
      await recoveredRun.result;
    } finally {
      context.engine[Symbol.dispose]();
    }
  });
});

describe('reattachDurableActiveRun.closed()', () => {
  it('classifies an EngineDisposedError rejection of a pending result() waiter as unresolved/unreachable, never failed (AC8)', async () => {
    const context = await buildContext();
    try {
      const disposedError = Object.assign(new Error('engine disposed'), {
        code: 'EngineDisposedError',
      });
      const handle = {
        id: 'reattach-closed-unreachable',
        result: () => Promise.reject(disposedError),
      };
      const recoveredRun = reattachDurableActiveRun(
        { engine: context.engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-closed-unreachable', handle },
      );

      // The public `result` promise settles quietly (write-free path) rather
      // than rejecting — see driveReattachedRun's own doc comment — so
      // closed() cannot classify this from a rejection; it needs the
      // `reachability` side channel this issue adds.
      const result = await recoveredRun.result;
      expect(result.finishReason).toBe('aborted');

      expect(await recoveredRun.closed()).toEqual({ status: 'unresolved', reason: 'unreachable' });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('resolves not-required immediately for a clean recovered completion with no cancellation and nothing in flight', async () => {
    const context = await buildContext();
    try {
      const handle = {
        id: 'reattach-closed-not-required',
        result: () =>
          Promise.resolve({
            schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
            runId: 'reattach-closed-not-required',
            steps: 0,
            content: 'done',
            finishReason: 'stop-condition',
          }),
      };
      const recoveredRun = reattachDurableActiveRun(
        { engine: context.engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-closed-not-required', handle },
      );

      await recoveredRun.result;
      await Promise.resolve();

      expect(await recoveredRun.closed()).toEqual({ status: 'not-required' });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('withholds completed until the post-cancel re-read of getDurableRun observes status "cancelled"', async () => {
    const context = await buildContext();
    try {
      let rejectResult!: (error: unknown) => void;
      const handle = {
        id: 'reattach-closed-cancel-confirmed',
        result: () =>
          new Promise<unknown>((_resolve, reject) => {
            rejectResult = reject;
          }),
      };
      let resolveGet!: (state: { status: string } | null) => void;
      const getPromise = new Promise<{ status: string } | null>((resolve) => {
        resolveGet = resolve;
      });
      const engine = {
        cancel: async () => {
          rejectResult(new Error('cancelled'));
        },
        get: async () => getPromise,
      } as unknown as RegistryAgnosticEngine;

      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-closed-cancel-confirmed', handle },
      );

      await Promise.resolve();
      recoveredRun.abort();
      const closedAcknowledgement = recoveredRun.closed();
      await recoveredRun.result;

      let settled = false;
      void closedAcknowledgement.then(() => {
        settled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);

      resolveGet({ status: 'cancelled' });

      expect(await closedAcknowledgement).toEqual({ status: 'completed' });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('resolves unresolved/persistence-failed when the post-cancel re-read throws', async () => {
    const context = await buildContext();
    try {
      let rejectResult!: (error: unknown) => void;
      const handle = {
        id: 'reattach-closed-persistence-failed',
        result: () =>
          new Promise<unknown>((_resolve, reject) => {
            rejectResult = reject;
          }),
      };
      const readFailure = new Error('storage unavailable');
      const engine = {
        cancel: async () => {
          rejectResult(new Error('cancelled'));
        },
        get: async () => {
          throw readFailure;
        },
      } as unknown as RegistryAgnosticEngine;

      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-closed-persistence-failed', handle },
      );

      await Promise.resolve();
      recoveredRun.abort();
      const closedAcknowledgement = recoveredRun.closed();
      await recoveredRun.result;

      expect(await closedAcknowledgement).toEqual({
        status: 'unresolved',
        reason: 'persistence-failed',
        error: readFailure,
      });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  // Regression: a code-review finding on the AB-204 pull request — see
  // `createDurableActiveRun.closed()`'s identical fixture for the full
  // rationale.
  it('resolves unresolved/persistence-failed when the post-cancel re-read reports a nonterminal status', async () => {
    const context = await buildContext();
    try {
      let rejectResult!: (error: unknown) => void;
      const handle = {
        id: 'reattach-closed-nonterminal',
        result: () =>
          new Promise<unknown>((_resolve, reject) => {
            rejectResult = reject;
          }),
      };
      const engine = {
        cancel: async () => {
          rejectResult(new Error('cancelled'));
        },
        get: async () => ({ status: 'running' }),
      } as unknown as RegistryAgnosticEngine;

      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-closed-nonterminal', handle },
      );

      await Promise.resolve();
      recoveredRun.abort();
      const closedAcknowledgement = recoveredRun.closed();
      await recoveredRun.result;

      expect(await closedAcknowledgement).toEqual({
        status: 'unresolved',
        reason: 'persistence-failed',
      });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });
});

// -----------------------------------------------------------------------
// B6 — Abort-into-generate (load-bearing) acceptance tests
//
// SPEC: "Seam threads AbortSignal to SDK; cancel()/abort() fire it
// immediately in parallel with Weft termination."
//
// ACCEPTANCE: cancel during streaming → spy.cancels has run id AND the
// generate abort signal fires AND the run settles within ~1s.
//
// The test uses a blocking generate function that only resolves when the
// AbortSignal fires, proving the signal is the load-bearing link. The
// spy confirms engine.cancel is called in parallel (the second prong of
// the two-action abort: signal stops the billing call; engine.cancel
// stops the next step from starting).
// -----------------------------------------------------------------------
describe('B6 — abort-into-generate load-bearing abort', () => {
  /**
   * A blocking generate that parks until the AbortSignal fires, then rejects.
   * This models a real provider SDK streaming call: the network connection
   * stays open until the signal aborts it. Records whether the signal fired
   * and what signal was received.
   */
  function makeBlockingGenerate(): {
    generate: RunOptions['generate'];
    abortFired: { value: boolean };
    receivedSignal: { value: AbortSignal | undefined };
  } {
    const abortFired = { value: false };
    const receivedSignal: { value: AbortSignal | undefined } = { value: undefined };

    const generate: RunOptions['generate'] = ({ signal }) =>
      new Promise((_resolve, reject) => {
        receivedSignal.value = signal;
        if (signal?.aborted) {
          abortFired.value = true;
          reject(new Error('generate already aborted'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => {
            abortFired.value = true;
            reject(new Error('generate aborted by signal'));
          },
          { once: true },
        );
      });

    return { generate, abortFired, receivedSignal };
  }

  it('abort() fires the generate AbortSignal immediately and calls engine.cancel in parallel (durable path)', async () => {
    const context = await buildContext();
    const spy = spyEngine(context.engine);
    const { generate, abortFired, receivedSignal } = makeBlockingGenerate();

    const runId = 'b6-abort-durable';
    const activeRun = createDurableActiveRun(
      { engine: spy.engine, checkpointStore: context.checkpointStore },
      {
        runId,
        sessionId: runId,
        options: {
          generate,
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
        prompt: 'Hello',
      },
    );

    // Wait for the deferred-microtask drive() to start and the workflow to
    // register with the engine, then enter the blocking generate call.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const abortStart = performance.now();
    activeRun.abort('cancel during streaming');

    const result = await activeRun.result;
    const elapsed = performance.now() - abortStart;

    // ACCEPTANCE criterion 1: the generate AbortSignal fired — proving the
    // signal reaches the in-flight provider call and drops the connection.
    expect(abortFired.value).toBe(true);

    // ACCEPTANCE criterion 2: spy.cancels has the run id — proving engine.cancel
    // was called in parallel with the AbortController abort (not sequentially).
    expect(spy.cancels).toContain(runId);

    // ACCEPTANCE criterion 3: the run settled within ~1 second — proving the
    // abort is load-bearing (not waiting for Weft's yield* boundary).
    expect(elapsed).toBeLessThan(1000);

    // The generate AbortSignal was correctly threaded end-to-end.
    expect(receivedSignal.value).toBeInstanceOf(AbortSignal);

    // Sanity: the run finished as aborted.
    expect(result.finishReason).toBe('aborted');

    context.engine[Symbol.dispose]();
  });

  it('abort() before the first microtask fires the AbortSignal without hanging (pre-start abort)', async () => {
    const context = await buildContext();
    const spy = spyEngine(context.engine);
    const { generate, abortFired } = makeBlockingGenerate();

    const runId = 'b6-pre-start-abort';
    const activeRun = createDurableActiveRun(
      { engine: spy.engine, checkpointStore: context.checkpointStore },
      {
        runId,
        sessionId: runId,
        options: {
          generate,
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
        prompt: 'Hello',
      },
    );

    // Abort synchronously — BEFORE the first microtask that starts the workflow.
    // The AbortController signal fires immediately on the controller.
    activeRun.abort('immediate pre-start cancel');

    const result = await activeRun.result;

    // The run must settle cleanly (not hang) even when aborted before the workflow
    // was registered with the engine. The AbortSignal path is sufficient here.
    expect(['aborted', 'error']).toContain(result.finishReason);

    // runStep detects the pre-aborted signal at its entry check (line: if
    // (signal?.aborted) return { kind: 'abort' }) and short-circuits WITHOUT
    // invoking generate() — so abortFired remains false. This is correct:
    // the signal was already fired on the controller before generate was called.
    expect(abortFired.value).toBe(false);

    context.engine[Symbol.dispose]();
  });

  it('abort() on the in-memory path fires the generate AbortSignal and settles within ~1s', async () => {
    // Proves the signal seam works on the in-memory (non-durable) path too.
    // Both paths share the same AbortController → combined signal → generate()
    // channel, so this test documents the seam is wired on both paths.
    const { generate, abortFired, receivedSignal } = makeBlockingGenerate();

    const activeRun = createRun({
      generate,
      toolbox: createToolbox([]),
      conversation: createConversationHistory(),
      stopWhen: stopWhen.noToolCalls(),
    });

    // Let the deferred-microtask start fire and the generate call begin.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const abortStart = performance.now();
    activeRun.abort('cancel during streaming in-memory');

    const result = await activeRun.result;
    const elapsed = performance.now() - abortStart;

    expect(abortFired.value).toBe(true);
    expect(receivedSignal.value).toBeInstanceOf(AbortSignal);
    expect(elapsed).toBeLessThan(1000);
    expect(result.finishReason).toBe('aborted');
  });
});

// AB-317: `active-run-adapter.ts`'s toolbox listeners (`execute-start`/
// `settled`/`progress`/`policy-denied`) must be removed on the same
// settle-aware boundary the in-memory path uses (create-run.ts's `complete()`,
// which runs once `result` settles) — never on the abort signal alone. Binding
// them to `abortController.signal` would remove them synchronously, on the
// SAME tick as `abort()`, before armorer's own asynchronous cancellation-race
// `settled` event for an in-flight call can arrive on a later microtask — so
// the adapter would never observe that settlement: `onSettled` (whose very
// first statement is `liveness.endToolCall()`, immediately followed by
// scheduling the deferred `inFlightTools` decrement against
// `e.callbackCompletion`) would simply never run for that call. These tests
// pin the fix for both drivers by proving the late `settled` event is still
// delivered — the observable evidence that `onSettled` (and therefore
// `endToolCall()` and the in-flight decrement) actually ran.
describe('AB-317: durable toolbox listeners survive abort() until the settle-aware boundary', () => {
  it("the fresh-start driver still delivers a stubborn in-flight tool call's settled event after abort()", async () => {
    const context = await buildContext();
    try {
      let notifyToolStarted: (() => void) | undefined;
      const toolStarted = new Promise<void>((resolve) => {
        notifyToolStarted = resolve;
      });
      let releaseStubbornTool: ((value: string) => void) | undefined;
      const stubbornToolGate = new Promise<string>((resolve) => {
        releaseStubbornTool = resolve;
      });
      const stubbornTool = createTool({
        name: 'stubborn_tool',
        description: 'Ignores cancellation; keeps running until the test releases it',
        input: z.object({}),
        execute: async () => {
          notifyToolStarted?.();
          return stubbornToolGate;
        },
      });
      const toolbox = createToolbox([stubbornTool]) as unknown as RunOptions['toolbox'];
      const generate = createMockGenerate([
        { content: '', toolCalls: [{ name: 'stubborn_tool', arguments: {} }] },
      ]);

      const activeRun = createDurableActiveRun(context, {
        runId: 'ab-317-fresh-post-abort-settled',
        sessionId: 'ab-317-fresh-post-abort-settled',
        options: {
          generate,
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
        prompt: 'Hello',
      });

      const settled: ToolSettledBubbleEvent[] = [];
      activeRun.addEventListener('tool.settled', (event) => settled.push(event));

      // Wait until the tool's own execute() has actually started (not just a
      // fixed tick count) before aborting, so the run is genuinely aborted
      // while a real call is in flight rather than before it was dispatched.
      await toolStarted;

      activeRun.abort('stop');

      // The run's own `result` settles (aborted) while the stubborn callback
      // is still running — armorer resolves the cancellation race promptly,
      // without waiting for the callback's own promise. If the toolbox
      // listeners had been torn down synchronously on `abort()` alone, this
      // `settled` event — which arrives on a LATER microtask than the
      // synchronous `abort()` call — would have been missed entirely.
      const result = await activeRun.result;
      expect(result.finishReason).toBe('aborted');
      expect(settled).toHaveLength(1);
      expect(settled[0]).toBeInstanceOf(ToolSettledBubbleEvent);
      expect(settled[0]?.toolName).toBe('stubborn_tool');

      // The callback keeps running after `result` has settled; releasing it
      // must not throw or corrupt the adapter's bookkeeping — the deferred
      // `inFlightTools` decrement (scheduled against `e.callbackCompletion`
      // inside `onSettled`) resolves quietly in the background.
      releaseStubbornTool?.('done');
      await yieldToPortableEventLoop();
      expect(await activeRun.closed()).toEqual({ status: 'completed' });
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it("the reattached driver still delivers a settled event on the ActiveRun's own emitter after abort()", async () => {
    const context = await buildContext();
    try {
      const runId = 'ab-317-reattach-post-abort-settled';
      const tool = createTool({
        name: 'stubborn_tool',
        description: 'Stands in as a settled-after-abort event source',
        input: z.object({}),
        execute: async () => 'ok',
      });
      const toolbox = createToolbox([tool]);
      const options = {
        ...runOptions(async () => ({ content: 'unused', toolCalls: [] })),
        toolbox: toolbox as unknown as RunOptions['toolbox'],
      };
      const services = { options, toolbox };
      // `createRecoveredRunEventSurface` is the toolbox → emitter forwarder
      // `reattachDurableActiveRun` relies on for a recovered run — see its
      // `attachToolboxCuratedListeners` (mirroring the fresh-start driver's,
      // per its own AB-290 comment).
      const surface = createRecoveredRunEventSurface(services, runId, 'reattach-agent');

      const cancelled: string[] = [];
      const engine = {
        cancel: async (id: string) => {
          cancelled.push(id);
        },
      } as unknown as RegistryAgnosticEngine;
      // `result()` never settles during this test — isolates the assertion
      // to "does `abort()` alone tear down the toolbox listeners", not
      // whatever `complete()` does once the run's own result settles.
      const handle = {
        id: runId,
        result: () => new Promise<unknown>(() => {}),
      };

      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: context.checkpointStore },
        {
          runId,
          handle,
          emitter: surface.emitter,
          stopToolboxForward: surface.stopToolboxForward,
          abort: surface.abort,
        },
      );

      const settled: ToolSettledBubbleEvent[] = [];
      recoveredRun.addEventListener('tool.settled', (event) => settled.push(event));

      const call = { id: 'stubborn-call-id', name: tool.name, arguments: {} };
      toolbox.dispatchEvent(
        new ToolboxExecuteStartEvent({ tool, call, params: {}, ownerId: runId }),
      );

      // Let the deferred-microtask `drive()` start (wiring `abortCancelled`)
      // before aborting.
      await Promise.resolve();
      recoveredRun.abort();

      // Dispatched AFTER `abort()` — mirrors armorer's real cancellation-race
      // `settled` event arriving on a later microtask than the synchronous
      // `abort()` call.
      toolbox.dispatchEvent(new ToolboxSettledEvent({ tool, call, result: 'ok', ownerId: runId }));

      expect(cancelled).toEqual([runId]);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toBeInstanceOf(ToolSettledBubbleEvent);
      expect(settled[0]?.toolName).toBe(tool.name);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });
});
