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

describe('session.recover()', () => {
  it('returns null when no run is in flight', async () => {
    const { handle } = createSessionHandleFixture();
    expect(await handle.recover()).toBeNull();
  });

  it('returns the same AgentRun handle while a run is in progress', async () => {
    // Use a blocking generate to keep the run in-flight.
    let resolveGenerate: ((r: { content: string; toolCalls: [] }) => void) | undefined;
    const blockingGenerate: GenerateFunction = () =>
      new Promise<{ content: string; toolCalls: [] }>((resolve) => {
        resolveGenerate = resolve;
      });

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const blockingHandle = createSessionHandle('blocking-session', {
      store,
      agentName: 'test-agent',
      runOptions: {
        generate: blockingGenerate,
        toolbox: createToolbox([]),
        maximumSteps: 1,
      },
    });

    const run = blockingHandle.run('hold on');
    const recovered = await blockingHandle.recover();

    // The handle is set synchronously in run(), recovered after one await tick.
    expect(recovered).toBe(run);

    // Yield a tick so the run loop starts and resolveGenerate is assigned.
    await yieldToPortableEventLoop();

    // Clean up: resolve the blocking generate so the run can finish.
    resolveGenerate?.({ content: 'done', toolCalls: [] });
    await run.result();
  });

  it('returns null after the run completes', async () => {
    const { handle } = createSessionHandleFixture();

    const run = handle.run('quick run');
    await run.result();
    // Allow the `.finally()` callback to clear currentRun.
    await yieldToPortableEventLoop();

    expect(await handle.recover()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cancel() — abort the in-flight run
// ---------------------------------------------------------------------------
