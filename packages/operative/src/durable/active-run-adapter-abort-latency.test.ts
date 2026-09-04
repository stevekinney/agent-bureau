import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { stopWhen } from '../conditions/index';
import { createActiveRun } from '../create-run';
import { spyEngine } from '../test/durable-engine';
import type { RunOptions } from '../types';
import { createDurableActiveRun } from './active-run-adapter';
import { createCheckpointStore } from './checkpoint-store';
import { createRunEngine } from './create-run-engine';
import { createRunWorkflow } from './run-workflow';

/**
 * AB-330: split out of `active-run-adapter.test.ts`'s "B6 — abort-into-generate
 * load-bearing abort" describe block — just the two sub-tests that measure
 * real elapsed wall-clock time (`performance.now()` before/after `abort()`,
 * asserting settlement within ~1 second). That elapsed duration is a genuine
 * property of a real, unmocked async chain (the durable engine's actual drive
 * and cancel path, or the in-memory path's actual generate/abort race) — a
 * manual clock cannot substitute because nothing here is manually advanced;
 * the assertion IS that the real wall clock barely moves. Real-runtime-
 * exempted in `scripts/determinism-manifest.json`, owned by this issue
 * (AB-330). The deterministic sibling tests in this describe block (pre-start
 * abort, post-driveStarted abort) stay in `active-run-adapter.test.ts`.
 */

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

describe('B6 — abort-into-generate load-bearing abort — real elapsed-time proof', () => {
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

  it('abort() on the in-memory path fires the generate AbortSignal and settles within ~1s', async () => {
    // Proves the signal seam works on the in-memory (non-durable) path too.
    // Both paths share the same AbortController → combined signal → generate()
    // channel, so this test documents the seam is wired on both paths.
    const { generate, abortFired, receivedSignal } = makeBlockingGenerate();

    const activeRun = createActiveRun({
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
