import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import {
  createTool,
  createToolbox,
  ToolboxExecuteStartEvent,
  ToolboxPolicyDeniedEvent,
  ToolboxProgressEvent,
  ToolboxSettledEvent,
} from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { CompletableEventTarget, HookRegistry } from 'lifecycle';
import { z } from 'zod';

import { stopWhen } from '../conditions/index';
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
  RunCompletedEvent,
  StepStartedEvent,
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolStartedBubbleEvent,
} from '../events';
import type { OperativeHookMap } from '../hooks';
import { UnsupportedRunResultVersionError } from '../run-envelope';
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

const run = (...args: Parameters<typeof createActiveRun>) => createActiveRun(...args).result;
const createRun = createActiveRun;

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
        toolbox.dispatchEvent(new ToolboxSettledEvent({ tool, call: spuriousCall }));
        toolbox.dispatchEvent(new ToolboxSettledEvent({ tool, call: spuriousCall }));
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
    toolbox.dispatchEvent(new ToolboxExecuteStartEvent({ tool, call, params: { value: 'hello' } }));
    toolbox.dispatchEvent(
      new ToolboxProgressEvent({ tool, call, percent: 50, message: 'halfway' }),
    );
    toolbox.dispatchEvent(
      new ToolboxPolicyDeniedEvent({
        tool,
        call,
        params: { value: 'hello' },
        reason: 'approval required',
      }),
    );
    toolbox.dispatchEvent(new ToolboxSettledEvent({ tool, call, result: { value: 'hello' } }));
    const failure = new Error('recovered tool failed');
    toolbox.dispatchEvent(new ToolboxSettledEvent({ tool, call, error: failure }));

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
