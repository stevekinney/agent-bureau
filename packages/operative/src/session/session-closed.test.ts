import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import { createSessionHandleFixture, createTestRunOptions } from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('session.closed()', () => {
  it('resolves not-required immediately when no run is currently live on the handle', async () => {
    const { handle } = createSessionHandleFixture();

    expect(await handle.closed()).toEqual({ status: 'not-required' });
  });

  it('resolves not-required again after a run has completed and cleared currentRun', async () => {
    const { handle } = createSessionHandleFixture();

    const run = handle.run('hello');
    await run.result();
    await Promise.resolve();

    expect(await handle.closed()).toEqual({ status: 'not-required' });
  });

  it("delegates to the live run's own closed() and returns the IDENTICAL CleanupAcknowledgement object when a run is live", async () => {
    let signalGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      signalGenerateStarted = resolve;
    });
    const blockingGenerate: GenerateFunction = async ({ signal }) => {
      signalGenerateStarted();
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('session run aborted')), {
          once: true,
        });
      });
      throw new Error('abort signal was not delivered');
    };
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const handle = createSessionHandle('session-closed-delegates', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(blockingGenerate),
    });

    const run = handle.run('abort me');
    await generateStarted;

    // `currentRun` is live (synchronously set inside `run()`, see
    // session-handle.ts) — `session.closed()` must delegate to THIS run's
    // own `closed()`, not resolve `not-required` on its own.
    const sessionClosed = handle.closed();
    const runClosed = run.closed();

    run.abort('user stopped it');
    const result = await run.result();
    expect(result.finishReason).toBe('aborted');

    const [sessionAcknowledgement, runAcknowledgement] = await Promise.all([
      sessionClosed,
      runClosed,
    ]);
    expect(sessionAcknowledgement).not.toEqual({ status: 'not-required' });
    // Identity, not merely deep equality — session.closed() must return the
    // SAME cached object the inner run's own closed() resolved, per the
    // acceptance criterion.
    expect(sessionAcknowledgement).toBe(runAcknowledgement);
  });

  it("forwards a caller-supplied signal to the delegated run's closed(), bounding only this caller's own wait", async () => {
    let signalGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      signalGenerateStarted = resolve;
    });
    const blockingGenerate: GenerateFunction = async ({ signal }) => {
      signalGenerateStarted();
      await new Promise<never>(() => {
        signal?.addEventListener('abort', () => {
          // Never settles on its own — only this test's explicit `run.abort()`
          // (never called) would resolve the inner run. The point of this
          // fixture is that the run stays in flight for the whole test.
        });
      });
      // Unreachable — `await`ing a `Promise<never>` never resolves, so the
      // function's inferred return type is `never`, assignable to the
      // declared `Promise<GenerateResponse>` `GenerateFunction` signature.
      throw new Error('unreachable');
    };
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const handle = createSessionHandle('session-closed-signal', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(blockingGenerate),
    });

    handle.run('never finishes');
    await generateStarted;

    const controller = new AbortController();
    const closedPromise = handle.closed({ signal: controller.signal });
    controller.abort();

    expect(await closedPromise).toEqual({ status: 'unresolved', reason: 'timed-out' });
  });
});

// ---------------------------------------------------------------------------
// recover() — re-attach to the in-flight run
// ---------------------------------------------------------------------------
