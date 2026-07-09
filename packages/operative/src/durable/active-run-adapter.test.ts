import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { HookRegistry } from 'lifecycle';
import { z } from 'zod';

import { stopWhen } from '../conditions/index';
import { createActiveRun } from '../create-run';
import { BudgetExceededError, ElicitationDeniedError } from '../errors';
import { ToolErrorBubbleEvent, ToolSettledBubbleEvent, ToolStartedBubbleEvent } from '../events';
import type { OperativeHookMap } from '../hooks';
import { createManualDurableEngine, spyEngine } from '../test/durable-engine';
import { createMockGenerate } from '../test/index';
import type { RunOptions, RunResult } from '../types';
import { createDurableActiveRun, reattachDurableActiveRun } from './active-run-adapter';
import { createCheckpointStore } from './checkpoint-store';
import type { AnyRunEngine } from './create-run-engine';
import { createRunEngine } from './create-run-engine';
import { createRunWorkflow } from './run-workflow';

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
    toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
  };
}

describe('createRun with durable routing', () => {
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
      let errorMessage: string | undefined;
      let completedFinishReason: RunResult['finishReason'] | undefined;

      const activeRun = createRun(
        runOptions(async () => {
          throw new Error('generate exploded: model unavailable');
        }),
        { ...context, runId: 'error-run', prompt: 'Hello' },
      );
      // A generate error ends the run via run.completed with finishReason 'error'
      // (executeLoop parity — it does not throw out of the run).
      activeRun.addEventListener('run.completed', (event) => {
        completedFinishReason = event.finishReason;
        errorMessage = event.error instanceof Error ? event.error.message : String(event.error);
      });

      const result = await activeRun.result;

      expect(result.finishReason).toBe('error');
      expect(completedFinishReason).toBe('error');
      // The REAL cause survives the workflow→adapter boundary, not a synthetic
      // "Durable run error" placeholder.
      expect(errorMessage).toBe('generate exploded: model unavailable');
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('generate exploded: model unavailable');
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
          toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
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
          toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
        { ...context, runId: 'abort-run', prompt: 'Hello' },
      );

      activeRun.addEventListener('run.aborted', (event) => {
        aborted = true;
        abortedReason = event.reason;
      });

      // Abort after the deferred-microtask start has begun the run.
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRun.abort('user requested stop');

      const result = await activeRun.result;

      expect(result.finishReason).toBe('aborted');
      expect(aborted).toBe(true);
      // The real abort reason survives the workflow→adapter boundary.
      expect(abortedReason).toBe('user requested stop');
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
          toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
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
          toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
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
          toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
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
    } as unknown as AnyRunEngine;
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

  it('classifies a durable workflow timeout as an execution deadline error', async () => {
    const timeoutError = Object.assign(new Error('timed out'), {
      code: 'WorkflowTimeoutError',
    });
    const engine = {
      start: async () => ({
        result: () => Promise.reject(timeoutError),
      }),
      get: async () => ({ status: 'timed-out' }),
    } as unknown as AnyRunEngine;
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
    } as unknown as AnyRunEngine;
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
          toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          prepareStep: async () => {
            throw new BudgetExceededError('Token budget exceeded');
          },
        },
        { ...context, runId: 'budget-run', prompt: 'Hello' },
      );

      const result = await activeRun.result;

      expect(result.finishReason).toBe('budget-exceeded');
      expect(result.error).toBeInstanceOf(BudgetExceededError);
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
          toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          prepareStep: async () => {
            throw new ElicitationDeniedError('User declined');
          },
        },
        { ...context, runId: 'elicitation-run', prompt: 'Hello' },
      );

      const result = await activeRun.result;

      expect(result.finishReason).toBe('elicitation-denied');
      expect(result.error).toBeInstanceOf(ElicitationDeniedError);
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
          toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
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
    // A run with a `responseSchema` produces `RunResult.schemaValidation` on the
    // in-memory path; the durable path must surface the SAME shape. The live
    // validation error is reduced to a message across the checkpoint.
    const context = await buildContext();
    try {
      const activeRun = createRun(
        {
          generate: async () => ({ content: '{"answer":"42"}', toolCalls: [] }),
          toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
          responseSchema: z.object({ answer: z.string() }),
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
    const toolbox = createToolbox([]);

    try {
      const activeRun = createRun(
        {
          generate: () =>
            new Promise((resolve) => {
              resolveGenerate = resolve;
              markGenerateStarted?.();
            }),
          toolbox: toolbox as unknown as RunOptions['toolbox'],
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
      toolbox.emit(
        'progress' as never,
        {
          call: { id: 'call-1', name: 'durable_tool' },
          percent: 25,
          message: 'started',
        } as never,
      );
      toolbox.emit(
        'policy-denied' as never,
        {
          call: { id: 'call-1', name: 'durable_tool' },
          reason: 'blocked',
        } as never,
      );
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

describe('reattachDurableActiveRun', () => {
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
      } as unknown as AnyRunEngine;

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
            runId: 'reattach-event-facade',
            steps: 0,
            content: 'reattached',
            finishReason: 'stop-condition',
          }),
      };
      const engine = {
        cancel: async () => {},
      } as unknown as AnyRunEngine;

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
    } as unknown as AnyRunEngine;
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
      } as unknown as AnyRunEngine;
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
      } as unknown as AnyRunEngine;

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
      } as unknown as AnyRunEngine;

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
    } as unknown as AnyRunEngine;
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
      } as unknown as AnyRunEngine;

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
            runId: 'reattach-dispose',
            steps: 0,
            content: '',
            finishReason: 'stop-condition',
          }),
      };
      const engine = {
        cancel: async () => {},
      } as unknown as AnyRunEngine;

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
            runId: 'reattach-schema-error',
            steps: 0,
            content: '',
            finishReason: 'stop-condition',
            schemaValidation: { success: false, error: 'schema failed' },
          }),
      };
      const engine = {
        cancel: async () => {},
      } as unknown as AnyRunEngine;

      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: context.checkpointStore },
        { runId: 'reattach-schema-error', handle },
      );

      const result = await recoveredRun.result;
      expect(result.schemaValidation?.success).toBe(false);
      expect(result.schemaValidation?.error).toBeInstanceOf(Error);
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
    } as unknown as AnyRunEngine;

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
    } as unknown as AnyRunEngine;

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
          toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
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
          toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
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
      toolbox: createToolbox([]) as unknown as RunOptions['toolbox'],
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
