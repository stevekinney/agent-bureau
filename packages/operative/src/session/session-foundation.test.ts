import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { createSessionStore } from './create-session-store';
import { createSessionHandle, deriveRunId } from './session-handle';
import { createInstantGenerate, createSessionHandleFixture } from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('deriveRunId', () => {
  it('produces sessionId:sequence format', () => {
    expect(deriveRunId('user-123', 0)).toBe('user-123:0');
    expect(deriveRunId('user-123', 5)).toBe('user-123:5');
  });

  it('is self-describing — session and sequence are both recoverable from the id', () => {
    const id = deriveRunId('my-session', 3);
    const [session, seq] = id.split(':');
    expect(session).toBe('my-session');
    expect(Number(seq)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// createSessionHandle — basic structure
// ---------------------------------------------------------------------------

describe('createSessionHandle', () => {
  it('exposes the session id on the handle', () => {
    const { handle, sessionId } = createSessionHandleFixture();
    expect(handle.id).toBe(sessionId);
  });

  it('getSession() creates a new session when none exists', async () => {
    const { handle, sessionId } = createSessionHandleFixture();
    const session = await handle.getSession();
    expect(session.id).toBe(sessionId);
    expect(session.runs).toEqual([]);
  });

  it('getSession() loads an existing session', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const existing = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: createConversationHistory(),
      id: 'existing-session',
    });
    await store.save(existing);

    const handle = createSessionHandle('existing-session', {
      store,
      agentName: 'test-agent',
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]),
      },
    });

    const session = await handle.getSession();
    expect(session.id).toBe('existing-session');
  });
});

// ---------------------------------------------------------------------------
// run() — starts a run and updates session on completion
// ---------------------------------------------------------------------------
