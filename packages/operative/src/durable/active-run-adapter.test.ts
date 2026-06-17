import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { stopWhen } from '../conditions/index';
import { createRun } from '../create-run';
import { BudgetExceededError, ElicitationDeniedError } from '../errors';
import type { RunOptions, RunResult } from '../types';
import { reattachDurableActiveRun } from './active-run-adapter';
import { createCheckpointStore } from './checkpoint-store';
import type { AnyRunEngine } from './create-run-engine';
import { createRunEngine } from './create-run-engine';
import { createRunWorkflow } from './run-workflow';

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
});
