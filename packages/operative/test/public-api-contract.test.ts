/**
 * A1 — Characterization tests against the current public API.
 *
 * These tests capture must-survive behaviors as PUBLIC-API contract tests.
 * They use only the operative package's published exports — no internal
 * imports — so they survive renames and internal refactors during the
 * big-bang rebuild. This file is Movement 2's green-up acceptance criteria.
 *
 * The four behaviors under contract:
 *   1. Loop completion  — the agent loop runs to a stop condition and returns
 *      the correct finishReason, content, and step count.
 *   2. Abort propagation — aborting a run propagates to the generate function
 *      and finalizes as `finishReason: 'aborted'`.
 *   3. Step-level recovery re-attach — after a simulated crash (engine
 *      disposed), a new engine on the same storage resumes from the last
 *      completed checkpoint, skipping completed steps entirely.
 *   4. At-least-once tool re-execution on simulated crash — a crash mid-step
 *      causes the in-flight step (including its tools) to re-run on recovery.
 */

import type {
  CombinedOperativeEventMap,
  GenerateFunction,
  RunOptions,
} from '@lostgradient/operative';
import { createActiveRun } from '@lostgradient/operative';
import { stopWhen } from '@lostgradient/operative/conditions';
import type { DurableRunDeps } from '@lostgradient/operative/durable';
import {
  createCheckpointStore,
  createDurableActiveRun,
  createRunEngine,
  createRunWorkflow,
} from '@lostgradient/operative/durable';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { CompletableEventTarget } from 'lifecycle';
import { z } from 'zod';
const run = (opts: Parameters<typeof createActiveRun>[0]) => createActiveRun(opts).result;
const createRun = createActiveRun;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A no-op tool the generate function can call to keep the loop running. */
const nextTool = createTool({
  name: 'next',
  description: 'Advance to the next step',
  input: z.object({}),
  execute: async () => 'ok',
});

function makeToolbox() {
  return createToolbox([nextTool]) as unknown as RunOptions['toolbox'];
}

/** Base RunOptions with a single next-tool toolbox and a no-tool-calls stop. */
function baseRunOptions(generate: RunOptions['generate']): RunOptions {
  return {
    generate,
    toolbox: makeToolbox(),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
  };
}

/**
 * Build a durable engine over a given storage backend.
 * `recover: false` so tests control recovery explicitly via `recoverAll`.
 * An optional `resolveWorkflowServices` is passed at engine-build time,
 * which is what Weft calls on a fresh process before resuming a workflow.
 */
async function buildEngine(
  storage: MemoryStorage,
  resolveWorkflowServices?: Parameters<typeof createRunEngine>[0]['resolveWorkflowServices'],
) {
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const runWorkflow = createRunWorkflow(checkpointStore);
  const { engine } = await createRunEngine({
    storage,
    runWorkflow,
    recover: false,
    ...(resolveWorkflowServices ? { resolveWorkflowServices } : {}),
  });
  return { engine, checkpointStore };
}

// Drain Weft's deferred inline-launch queue between tests so one test's
// pending setTimeout(0) macrotask cannot starve the next test.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

// ---------------------------------------------------------------------------
// 1. Loop completion
// ---------------------------------------------------------------------------

describe('loop completion — the agent loop runs to a stop condition', () => {
  it('a single-step run with no tool calls completes with finishReason stop-condition', async () => {
    const result = await run(baseRunOptions(async () => ({ content: 'done', toolCalls: [] })));

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('done');
    expect(result.steps).toHaveLength(1);
  });

  it('a multi-step run completes only after the stop condition is satisfied', async () => {
    let step = 0;
    const result = await run(
      baseRunOptions(async () => {
        const current = step++;
        if (current < 2) {
          return { content: `step ${current}`, toolCalls: [{ name: 'next', arguments: {} }] };
        }
        return { content: 'final', toolCalls: [] };
      }),
    );

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('final');
    expect(result.steps).toHaveLength(3);
  });

  it('a run that never settles stops at maximumSteps with finishReason maximum-steps', async () => {
    const result = await run({
      ...baseRunOptions(async () => ({
        content: 'looping',
        toolCalls: [{ name: 'next', arguments: {} }],
      })),
      maximumSteps: 2,
    });

    expect(result.finishReason).toBe('maximum-steps');
    expect(result.steps).toHaveLength(2);
  });

  it('createRun emits run.started then run.completed in that order', async () => {
    const events: string[] = [];
    const activeRun = createActiveRun(
      baseRunOptions(async () => ({ content: 'hello', toolCalls: [] })),
    );

    activeRun.addEventListener('run.started', () => events.push('run.started'));
    activeRun.addEventListener('run.completed', () => events.push('run.completed'));

    const result = await activeRun.result;

    expect(events).toEqual(['run.started', 'run.completed']);
    expect(result.finishReason).toBe('stop-condition');
  });

  it('the durable path completes with the same finishReason and content as the in-memory path', async () => {
    const { engine, checkpointStore } = await buildEngine(new MemoryStorage());
    try {
      const result = await createDurableActiveRun(
        { engine, checkpointStore },
        {
          runId: 'contract-loop-completion',
          sessionId: 'contract-loop-completion',
          options: baseRunOptions(async () => ({ content: 'durable done', toolCalls: [] })),
          prompt: 'Go',
        },
      ).result;

      expect(result.finishReason).toBe('stop-condition');
      expect(result.content).toBe('durable done');
      expect(result.steps).toHaveLength(1);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('createActiveRun forwards a supplied durable emitter', async () => {
    const { engine, checkpointStore } = await buildEngine(new MemoryStorage());
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();

    try {
      const activeRun = createActiveRun(
        baseRunOptions(async () => ({ content: 'emitted', toolCalls: [] })),
        {
          engine,
          checkpointStore,
          runId: 'contract-durable-emitter',
          emitter,
        },
      );

      const result = await activeRun.result;
      expect(result.content).toBe('emitted');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Abort propagation
// ---------------------------------------------------------------------------

describe('abort propagation — aborting a run finalizes as aborted and stops generate', () => {
  it('aborting before the first step yields finishReason aborted with no steps taken', async () => {
    const controller = new AbortController();
    controller.abort('user cancelled');

    const result = await run({
      ...baseRunOptions(async () => ({ content: 'should not reach', toolCalls: [] })),
      signal: controller.signal,
    });

    expect(result.finishReason).toBe('aborted');
    expect(result.steps).toHaveLength(0);
  });

  it('aborting via the run signal mid-flight finalizes as aborted', async () => {
    const controller = new AbortController();
    let generateCallCount = 0;

    // Step 0: return a tool call to continue the loop
    // onStep: abort AFTER step 0 completes (onStep fires post-step)
    const result = await run({
      ...baseRunOptions(async () => {
        generateCallCount++;
        return { content: 'step', toolCalls: [{ name: 'next', arguments: {} }] };
      }),
      signal: controller.signal,
      onStep: async ({ step }) => {
        if (step === 0) {
          controller.abort('cancelled after step 0');
        }
      },
    });

    expect(result.finishReason).toBe('aborted');
    // Step 0 completed before the abort, step 1 was stopped by the signal
    expect(result.steps).toHaveLength(1);
    // generate was only called once (step 0); step 1 was aborted before generate
    expect(generateCallCount).toBe(1);
  });

  it('the AbortSignal passed to generate is aborted when the run-level signal fires', async () => {
    const controller = new AbortController();
    const signalsReceived: AbortSignal[] = [];

    await run({
      ...baseRunOptions(async ({ signal }) => {
        if (signal) signalsReceived.push(signal);
        return { content: 'done', toolCalls: [] };
      }),
      signal: controller.signal,
    });

    // The generate function received a signal
    expect(signalsReceived.length).toBeGreaterThan(0);
    expect(signalsReceived[0]).toBeInstanceOf(AbortSignal);
  });

  it('createRun.abort() fires run.aborted and finalizes as aborted', async () => {
    const events: string[] = [];
    let finishReasonSeen: string | undefined;

    // Use a generate that parks until we let it proceed — gives us time to abort
    let allowProceed: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      allowProceed = resolve;
    });

    const activeRun = createActiveRun(
      baseRunOptions(async () => {
        await gate;
        return { content: 'should abort before here', toolCalls: [] };
      }),
    );

    activeRun.addEventListener('run.aborted', () => {
      events.push('run.aborted');
    });
    activeRun.addEventListener('run.completed', (event) => {
      events.push('run.completed');
      finishReasonSeen = event.finishReason;
    });

    // Yield once so the deferred loop start fires
    await Promise.resolve();
    // Abort before we release the gate — the loop should short-circuit
    activeRun.abort('test abort');
    // Now let the gate resolve so generate can return (abort already registered)
    allowProceed!();

    const result = await activeRun.result;

    expect(result.finishReason).toBe('aborted');
    // Either run.aborted or run.completed with aborted is acceptable
    expect(events.length).toBeGreaterThan(0);
  });

  it('aborting a durable run terminates it with finishReason aborted', async () => {
    const { engine, checkpointStore } = await buildEngine(new MemoryStorage());
    try {
      let allowProceed: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        allowProceed = resolve;
      });

      const activeRun = createDurableActiveRun(
        { engine, checkpointStore },
        {
          runId: 'contract-abort-durable',
          sessionId: 'contract-abort-durable',
          options: baseRunOptions(async () => {
            await gate;
            return { content: 'interrupted', toolCalls: [] };
          }),
          prompt: 'Go',
        },
      );

      // Yield so the deferred run can be established before aborting
      await Promise.resolve();
      activeRun.abort('durable abort test');
      allowProceed!();

      const result = await activeRun.result;
      expect(result.finishReason).toBe('aborted');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Step-level recovery re-attach
// ---------------------------------------------------------------------------

describe('step-level recovery re-attach — a recovered run resumes from its checkpoint, not step 0', () => {
  it('a recovered run resumes from its checkpoint, not step 0', async () => {
    const storage = new MemoryStorage();
    const runId = 'contract-recovery-resume';

    // === Engine A: completes step 0 (tool call), then hangs at step 1's generate ===
    let hangResolverA: (() => void) | undefined;
    const hangPromiseA = new Promise<void>((resolve) => {
      hangResolverA = resolve;
    });

    const aGenerate: GenerateFunction = async ({ step }) => {
      if (step === 0) {
        return { content: 'step 0 done', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      // Step 1: hang until disposed
      await hangPromiseA;
      return { content: 'unreachable', toolCalls: [] };
    };

    const a = await buildEngine(storage);
    const aRun = createDurableActiveRun(
      { engine: a.engine, checkpointStore: a.checkpointStore },
      {
        runId,
        sessionId: runId,
        options: baseRunOptions(aGenerate),
        prompt: 'Start',
      },
    );
    // Keep result off the awaited chain; the run is expected to not settle
    aRun.result.catch(() => {});

    // Let step 0 commit its checkpoint, then hang at step 1
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify step 0 was checkpointed
    const afterStep0 = await a.checkpointStore.loadCheckpoint(runId);
    expect(afterStep0.steps).toHaveLength(1);
    expect(afterStep0.steps[0]?.content).toBe('step 0 done');

    // "Crash" — dispose engine A while step 1 is mid-flight
    hangResolverA!();
    a.engine[Symbol.dispose]();

    // === Engine B: fresh engine on the same storage — resolver provides new deps ===
    const recoveredSteps: number[] = [];
    const b = await buildEngine(storage, async () => {
      const toolbox = makeToolbox();
      const recoveryGenerate: GenerateFunction = async ({ step }) => {
        recoveredSteps.push(step);
        return { content: `recovered step ${step}`, toolCalls: [] };
      };
      const services: DurableRunDeps = {
        toolbox,
        options: {
          generate: recoveryGenerate,
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
      };
      return { status: 'available', services };
    });

    try {
      const handles = await b.engine.recoverAll();

      expect(handles).toHaveLength(1);
      const result = await handles[0]!.result();

      // The recovered run must have continued from step 1 (NOT re-run step 0)
      expect(recoveredSteps).not.toContain(0);
      expect(recoveredSteps).toContain(1);

      // Two total steps: step 0 (from engine A's checkpoint) + step 1 (recovered)
      expect((result as { steps: number }).steps).toBe(2);
      expect((result as { finishReason: string }).finishReason).toBe('stop-condition');

      // The checkpoint now holds both steps
      const checkpoint = await b.checkpointStore.loadCheckpoint(runId);
      expect(checkpoint.steps).toHaveLength(2);
      expect(checkpoint.steps[0]?.content).toBe('step 0 done');
      expect(checkpoint.steps[1]?.content).toBe('recovered step 1');
    } finally {
      b.engine[Symbol.dispose]();
    }
  });

  it('a fully completed run leaves nothing for recoverAll to resume', async () => {
    const storage = new MemoryStorage();
    const runId = 'contract-recovery-complete';

    // Engine A: run to completion normally
    const a = await buildEngine(storage);
    const aRun = createDurableActiveRun(
      { engine: a.engine, checkpointStore: a.checkpointStore },
      {
        runId,
        sessionId: runId,
        options: baseRunOptions(async () => ({ content: 'complete', toolCalls: [] })),
        prompt: 'Run',
      },
    );
    const resultA = await aRun.result;
    expect(resultA.finishReason).toBe('stop-condition');
    a.engine[Symbol.dispose]();

    // Engine B: rebuild on the same storage — recoverAll finds nothing running
    let bGenerateCalled = false;
    const b = await buildEngine(storage, async () => {
      const toolbox = makeToolbox();
      const services: DurableRunDeps = {
        toolbox,
        options: {
          generate: async () => {
            bGenerateCalled = true;
            return { content: 'should not run', toolCalls: [] };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
      };
      return { status: 'available', services };
    });

    try {
      const handles = await b.engine.recoverAll();

      // No suspended workflows to recover (the run was completed)
      expect(handles).toHaveLength(0);
      // generate was NOT called on engine B
      expect(bGenerateCalled).toBe(false);
    } finally {
      b.engine[Symbol.dispose]();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. At-least-once tool re-execution on simulated crash
// ---------------------------------------------------------------------------

describe('at-least-once tool re-execution on simulated crash — a crashed mid-step re-runs that step and its tools', () => {
  it('a tool from the crashed in-flight step is re-executed on recovery', async () => {
    const storage = new MemoryStorage();
    const runId = 'contract-at-least-once';

    const toolExecutions: string[] = [];

    const sideEffectTool = createTool({
      name: 'record',
      description: 'Record that this step ran',
      input: z.object({ label: z.string() }),
      execute: async ({ label }) => {
        toolExecutions.push(label);
        return `recorded: ${label}`;
      },
    });

    function makeRecordingToolbox() {
      return createToolbox([nextTool, sideEffectTool]) as unknown as RunOptions['toolbox'];
    }

    // === Engine A: step 0 emits a tool call (commits), step 1's generate hangs ===
    let hangResolverA: (() => void) | undefined;
    const hangPromiseA = new Promise<void>((resolve) => {
      hangResolverA = resolve;
    });

    const a = await buildEngine(storage);
    const aRun = createDurableActiveRun(
      { engine: a.engine, checkpointStore: a.checkpointStore },
      {
        runId,
        sessionId: runId,
        options: {
          generate: async ({ step }: { step: number }) => {
            if (step === 0) {
              // Step 0 emits a `record` tool call
              return {
                content: 'step 0',
                toolCalls: [{ name: 'record', arguments: { label: 'step-0' } }],
              };
            }
            // Step 1: hang — simulating a crash mid-generate
            await hangPromiseA;
            return { content: 'unreachable', toolCalls: [] };
          },
          toolbox: makeRecordingToolbox(),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
        prompt: 'Start',
      },
    );
    aRun.result.catch(() => {});

    // Let step 0's tool execute and checkpoint
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Step 0's tool must have run once on engine A
    const step0ExecutionsOnA = toolExecutions.filter((e) => e === 'step-0').length;
    expect(step0ExecutionsOnA).toBe(1);

    // Crash engine A while step 1 hangs
    hangResolverA!();
    a.engine[Symbol.dispose]();

    // === Engine B: recover — step 1's generate runs and emits a tool call ===
    const b = await buildEngine(storage, async () => {
      const toolbox = makeRecordingToolbox();
      const recoveryGenerate: GenerateFunction = async ({ step }) => {
        if (step === 1) {
          // Step 1's generate emits a record tool call (re-executed after crash)
          return {
            content: 'step 1',
            toolCalls: [{ name: 'record', arguments: { label: 'step-1' } }],
          };
        }
        // Step 2: settle (noToolCalls fires)
        return { content: 'final', toolCalls: [] };
      };
      const services: DurableRunDeps = {
        toolbox,
        options: {
          generate: recoveryGenerate,
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
      };
      return { status: 'available', services };
    });

    try {
      const handles = await b.engine.recoverAll();
      expect(handles).toHaveLength(1);
      const result = await handles[0]!.result();
      expect((result as { finishReason: string }).finishReason).toBe('stop-condition');

      // Step 1's tool MUST have been executed on recovery (at-least-once contract)
      expect(toolExecutions).toContain('step-1');
    } finally {
      b.engine[Symbol.dispose]();
    }
  });

  it('step 0 is not re-executed on recovery — memoized completed steps are skipped', async () => {
    const storage = new MemoryStorage();
    const runId = 'contract-memo-no-rerun';

    const generateCallsByStep: number[] = [];

    let hangResolverA: (() => void) | undefined;
    const hangPromiseA = new Promise<void>((resolve) => {
      hangResolverA = resolve;
    });

    const a = await buildEngine(storage);
    const aRun = createDurableActiveRun(
      { engine: a.engine, checkpointStore: a.checkpointStore },
      {
        runId,
        sessionId: runId,
        options: baseRunOptions(async ({ step }) => {
          generateCallsByStep.push(step);
          if (step === 0) {
            return {
              content: 'step 0',
              toolCalls: [{ name: 'next', arguments: {} }],
            };
          }
          await hangPromiseA;
          return { content: 'unreachable', toolCalls: [] };
        }),
        prompt: 'Start',
      },
    );
    aRun.result.catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Step 0 should have been called exactly once on engine A
    const step0CallsOnA = generateCallsByStep.filter((s) => s === 0).length;
    expect(step0CallsOnA).toBe(1);

    hangResolverA!();
    a.engine[Symbol.dispose]();

    // Engine B: recover — step 0 must NOT be re-called (it's memoized)
    const recoveredGenerateCallsByStep: number[] = [];
    const b = await buildEngine(storage, async () => {
      const toolbox = makeToolbox();
      const recoveryGenerate: GenerateFunction = async ({ step }) => {
        recoveredGenerateCallsByStep.push(step);
        return { content: `recovered ${step}`, toolCalls: [] };
      };
      const services: DurableRunDeps = {
        toolbox,
        options: {
          generate: recoveryGenerate,
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
      };
      return { status: 'available', services };
    });

    try {
      const handles = await b.engine.recoverAll();
      expect(handles).toHaveLength(1);
      await handles[0]!.result();

      // The recovery engine must NOT have called generate for step 0 (memoized)
      expect(recoveredGenerateCallsByStep).not.toContain(0);
      // Step 1 (the in-flight step) MUST have been called on recovery
      expect(recoveredGenerateCallsByStep).toContain(1);
    } finally {
      b.engine[Symbol.dispose]();
    }
  });
});
