import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createSessionStore } from './create-session-store';
import { createSessionHandle, ForkThroughRunError } from './session-handle';
import {
  createInstantGenerate,
  createSessionHandleFixture,
  createTestRunOptions,
} from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('session.fork()', () => {
  it('creates a new session with a different id', async () => {
    const { handle } = createSessionHandleFixture();
    await handle.getSession(); // ensure session exists

    const forked = await handle.fork();
    expect(forked.id).not.toBe(handle.id);
  });

  it('the forked session starts with an empty runs[]', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-source', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });

    await h.run('first run').result();
    await yieldToPortableEventLoop();

    const forked = await h.fork();
    const forkedSession = await forked.getSession();

    expect(forkedSession.runs).toHaveLength(0);
  });

  it('the forked session copies the conversation history', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-history-source', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(createInstantGenerate('copied')),
    });

    await h.run('something').result();
    await yieldToPortableEventLoop();

    const sourceSession = await store.load('fork-history-source');
    const forked = await h.fork();
    const forkedSession = await forked.getSession();

    // Conversation history should be the same as the source.
    expect(forkedSession.conversationHistory).toEqual(sourceSession!.conversationHistory);
  });

  it('the forked handle returns itself from getSession()', async () => {
    const { handle } = createSessionHandleFixture();
    await handle.getSession();

    const forked = await handle.fork();
    const session = await forked.getSession();
    expect(session.id).toBe(forked.id);
  });

  // Regression: PRRT_kwDORvupsc6MXEmV — fork({ throughRun: n }) must not
  // silently include conversation history from runs after n. Without per-run
  // snapshots, forking before the last run is rejected with ForkThroughRunError
  // instead of silently returning a contaminated branch.
  it('throws ForkThroughRunError when throughRun points before the last run (contamination guard)', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-guard-source', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });

    // Complete two runs so that run 0 is followed by run 1 (last index = 1).
    await h.run('first run').result();
    await yieldToPortableEventLoop();
    await h.run('second run').result();
    await yieldToPortableEventLoop();

    // fork({ throughRun: 0 }) would branch before run 1, but the full history
    // includes run 1's messages — silently contaminating the branch. Must throw.
    let threw = false;
    try {
      await h.fork({ throughRun: 0 });
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(ForkThroughRunError);
    }
    expect(threw).toBe(true);
  });

  it('fork({ throughRun: lastIndex }) succeeds (no contamination possible)', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-guard-last', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });

    await h.run('first run').result();
    await yieldToPortableEventLoop();
    await h.run('second run').result();
    await yieldToPortableEventLoop();

    // throughRun: 1 is the last run index — no later runs exist, so the full
    // history is correct for this fork point.
    const forked = await h.fork({ throughRun: 1 });
    expect(forked.id).toBeDefined();
    const session = await forked.getSession();
    expect(session.runs).toHaveLength(0);
  });

  it('fork() with no options succeeds regardless of run count', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-guard-default', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });

    await h.run('first run').result();
    await yieldToPortableEventLoop();
    await h.run('second run').result();
    await yieldToPortableEventLoop();

    // Default fork (no throughRun) always copies full history — no guard needed.
    const forked = await h.fork();
    expect(forked.id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// sleep() — process-local delay
// ---------------------------------------------------------------------------
