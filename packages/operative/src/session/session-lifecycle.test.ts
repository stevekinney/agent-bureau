import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import { createSessionHandleFixture } from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('session full lifecycle', () => {
  it('run then recover then cancel follows disconnect-vs-stop model', async () => {
    let resolveGenerate: (() => void) | undefined;
    const blockingGenerate: GenerateFunction = () =>
      new Promise<{ content: string; toolCalls: [] }>((resolve) => {
        resolveGenerate = () => resolve({ content: 'done', toolCalls: [] });
      });

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('lifecycle-session', {
      store,
      agentName: 'lifecycle-agent',
      runOptions: {
        generate: blockingGenerate,
        toolbox: createToolbox([]),
        maximumSteps: 1,
      },
    });

    // Start the run.
    const run = h.run('start');
    expect(run).toBeDefined();

    // Yield to let the run loop start.
    await Promise.resolve();

    // A "disconnect" — recover() returns the same handle (keep going).
    const recovered = await h.recover();
    expect(recovered).toBe(run);

    // A "deliberate stop" — cancel() aborts the run.
    await h.cancel();

    // After cancel, recover() returns null.
    expect(await h.recover()).toBeNull();

    // Clean up.
    resolveGenerate?.();
  });
});

// ---------------------------------------------------------------------------
// RunRef sequence invariant
// ---------------------------------------------------------------------------

describe('RunRef sequence invariant', () => {
  it('runId is always ${sessionId}:${sequence}', async () => {
    const { handle, store } = createSessionHandleFixture({ sessionId: 'seq-test' });

    await handle.run('run 0').result();
    await yieldToPortableEventLoop();
    await handle.run('run 1').result();
    await yieldToPortableEventLoop();
    await handle.run('run 2').result();
    await yieldToPortableEventLoop();

    const session = await store.load('seq-test');
    expect(session!.runs).toHaveLength(3);
    for (const ref of session!.runs) {
      expect(ref.runId).toBe(`seq-test:${ref.sequence}`);
    }
  });

  it('sequences are monotonically increasing starting from 0', async () => {
    const { handle, store } = createSessionHandleFixture({ sessionId: 'monotonic-test' });

    await handle.run('a').result();
    await yieldToPortableEventLoop();
    await handle.run('b').result();
    await yieldToPortableEventLoop();

    const session = await store.load('monotonic-test');
    const sequences = session!.runs.map((r) => r.sequence);
    expect(sequences).toEqual([0, 1]);
  });
});
