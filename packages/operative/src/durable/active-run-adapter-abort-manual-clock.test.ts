import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { createManualRuntimeServices } from 'lifecycle';

import { stopWhen } from '../conditions/index';
import { createActiveRun } from '../create-run';
import { spyEngine } from '../test/durable-engine';
import type { RunOptions } from '../types';
import { createDurableActiveRun } from './active-run-adapter';
import { createCheckpointStore } from './checkpoint-store';
import { createRunEngine } from './create-run-engine';
import { createRunWorkflow } from './run-workflow';

/**
 * AB-348: split out of `active-run-adapter.test.ts`'s "B6 — abort-into-generate
 * load-bearing abort" describe block (originally AB-330). The original form
 * measured real elapsed wall-clock time (`performance.now()` before/after
 * `abort()`, asserting settlement within ~1 second), reasoned as necessary
 * because "nothing here is manually advanced; the assertion IS that the real
 * wall clock barely moves."
 *
 * `abort()` (read directly in both `create-run.ts` and
 * `active-run-adapter.ts`) is purely synchronous — `abortController.abort()`
 * — and never registers a real or `RuntimeServices` timer on either path;
 * the settlement chain the ~1s bound was guarding is entirely microtask-
 * driven promise resolution, not anything a clock advance could represent.
 * Both `createActiveRun` and `createDurableActiveRun` already accept an
 * injectable `runtime` (AB-92/AB-252/AB-253 seam) — these tests supply a
 * `ManualRuntimeServices` and, instead of measuring how much real wall-clock
 * time settlement took, assert directly on the property the wall-clock bound
 * was a proxy for: the manual clock's `monotonic.now()` is unchanged and it
 * has zero pending timers after `abort()` settles — proving nothing here
 * ever needed a timer or a clock tick to resolve, load-bearing or otherwise.
 * The original `setTimeout(resolve, 10)` warm-up wait (letting the deferred-
 * microtask `drive()` call start and `generate` begin) is replaced with a
 * bounded poll driven by `yieldToPortableEventLoop` (Weft's own
 * `MessageChannel`-based macrotask-plus-microtask-drain yield, not a real
 * timer — it falls back to `setTimeout(0)` only where `MessageChannel` is
 * unavailable, never a nonzero delay) for the durable path, whose
 * `Engine.start()` genuinely needs a macrotask boundary before `generate`
 * runs; the in-memory path's `drive()` starts via a bare
 * `Promise.resolve().then(...)` microtask, so a pure microtask flush
 * suffices there.
 */

// Bounded poll — never waits a nonzero real duration, so a regression that
// makes the awaited condition depend on an actual timer delay fails loudly
// (attempts exhausted) rather than silently passing.
const EVENT_LOOP_POLL_MAX_ATTEMPTS = 200;
async function waitForEventLoop(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < EVENT_LOOP_POLL_MAX_ATTEMPTS; attempt++) {
    if (predicate()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('waitForEventLoop exceeded its attempt bound before the condition held');
}

const MICROTASK_POLL_MAX_ATTEMPTS = 2000;
async function waitForMicrotasks(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < MICROTASK_POLL_MAX_ATTEMPTS; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('waitForMicrotasks exceeded its attempt bound before the condition held');
}

async function buildContext() {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const runWorkflow = createRunWorkflow(checkpointStore);
  const { engine } = await createRunEngine({ storage, runWorkflow, recover: false });
  return { engine, checkpointStore };
}

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

describe('B6 — abort-into-generate load-bearing abort — manual-clock proof', () => {
  it('abort() fires the generate AbortSignal immediately and calls engine.cancel in parallel (durable path)', async () => {
    const context = await buildContext();
    const spy = spyEngine(context.engine);
    const { generate, abortFired, receivedSignal } = makeBlockingGenerate();
    const runtime = createManualRuntimeServices();

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
          runtime,
        },
        prompt: 'Hello',
      },
    );

    // Wait for the deferred drive() to start and the workflow to register
    // with the engine, then enter the blocking generate call — an
    // event-loop-turn poll, no real timer delay.
    await waitForEventLoop(() => receivedSignal.value !== undefined);

    const monotonicBeforeAbort = runtime.monotonic.now();
    activeRun.abort('cancel during streaming');

    const result = await activeRun.result;

    // ACCEPTANCE criterion 1: the generate AbortSignal fired — proving the
    // signal reaches the in-flight provider call and drops the connection.
    expect(abortFired.value).toBe(true);

    // ACCEPTANCE criterion 2: spy.cancels has the run id — proving engine.cancel
    // was called in parallel with the AbortController abort (not sequentially).
    expect(spy.cancels).toContain(runId);

    // ACCEPTANCE criterion 3 (replaces the ~1s wall-clock bound): the run
    // settled with the manual clock's monotonic reading UNCHANGED and no
    // timer left pending — proving settlement never depended on any clock
    // tick or timer firing, load-bearing or otherwise (not merely "fast").
    expect(runtime.monotonic.now()).toBe(monotonicBeforeAbort);
    expect(runtime.pendingTimers()).toHaveLength(0);

    // The generate AbortSignal was correctly threaded end-to-end.
    expect(receivedSignal.value).toBeInstanceOf(AbortSignal);

    // Sanity: the run finished as aborted.
    expect(result.finishReason).toBe('aborted');

    context.engine[Symbol.dispose]();
  });

  it('abort() on the in-memory path fires the generate AbortSignal and settles with no clock tick needed', async () => {
    // Proves the signal seam works on the in-memory (non-durable) path too.
    // Both paths share the same AbortController → combined signal → generate()
    // channel, so this test documents the seam is wired on both paths.
    const { generate, abortFired, receivedSignal } = makeBlockingGenerate();
    const runtime = createManualRuntimeServices();

    const activeRun = createActiveRun({
      generate,
      toolbox: createToolbox([]),
      conversation: createConversationHistory(),
      stopWhen: stopWhen.noToolCalls(),
      runtime,
    });

    // Let the deferred-microtask start fire and the generate call begin —
    // microtask-only, no real timer.
    await waitForMicrotasks(() => receivedSignal.value !== undefined);

    const monotonicBeforeAbort = runtime.monotonic.now();
    activeRun.abort('cancel during streaming in-memory');

    const result = await activeRun.result;

    expect(abortFired.value).toBe(true);
    expect(receivedSignal.value).toBeInstanceOf(AbortSignal);
    expect(runtime.monotonic.now()).toBe(monotonicBeforeAbort);
    expect(runtime.pendingTimers()).toHaveLength(0);
    expect(result.finishReason).toBe('aborted');
  });
});
