import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import { appendConversationMessages } from './session-handle-support';
import { createInstantGenerate, createTestRunOptions } from './session-handle-test-support';
import type { SessionStore } from './types';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('regression — concurrent terminal commits', () => {
  it('rejects when the reservation update does not invoke its mutator', async () => {
    const baseStore = createSessionStore(textValueStore(new MemoryStorage()));
    const store: SessionStore = {
      ...baseStore,
      async update() {
        return undefined;
      },
    };
    const handle = createSessionHandle('reservation-noop-session', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(),
    });

    expect(handle.run('prompt').result()).rejects.toThrow('Failed to reserve a run');
  });

  it('rejects when the runtime cannot mint an originating user message id', async () => {
    const runtime = createManualRuntimeServices();
    Object.defineProperty(runtime.identifiers, 'next', { value: () => '' });
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const handle = createSessionHandle('reservation-empty-user-id', {
      store,
      agentName: 'agent',
      runtime,
      runOptions: createTestRunOptions(),
    });

    expect(handle.run('prompt').result()).rejects.toThrow('Failed to identify the user message');
  });

  it('rejects the run when its terminal session update becomes a no-op', async () => {
    const sessionId = 'terminal-commit-deleted-session';
    const baseStore = createSessionStore(textValueStore(new MemoryStorage()));
    let updateCount = 0;
    const store: SessionStore = {
      ...baseStore,
      async update(...args) {
        updateCount += 1;
        if (updateCount === 2) return undefined;
        return baseStore.update(...args);
      },
    };
    const handle = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(),
    });

    expect(handle.run('prompt').result()).rejects.toThrow('disappeared');
    expect(await baseStore.load(sessionId)).toBeDefined();
  });

  it('keeps fresh conversation metadata while appending the run transcript', async () => {
    const sessionId = 'terminal-commit-metadata-session';
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const seed = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(createInstantGenerate('seed')),
    });
    await seed.run('seed').result();
    await store.update(sessionId, (session) =>
      session
        ? {
            ...session,
            conversationHistory: {
              ...session.conversationHistory,
              metadata: { version: 'old' },
            },
          }
        : undefined,
    );

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const handle = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      runOptions: {
        ...createTestRunOptions(),
        generate: async () => {
          entered.resolve();
          await release.promise;
          return { content: 'result', toolCalls: [] };
        },
      },
    });
    const run = handle.run('racing prompt');
    await entered.promise;
    const reservedSession = await store.load(sessionId);
    expect(reservedSession?.runs.at(-1)?.baseConversationMetadata).toEqual({
      version: 'old',
    });
    await store.update(sessionId, (session) =>
      session
        ? {
            ...session,
            conversationHistory: {
              ...session.conversationHistory,
              metadata: { version: 'new', concurrent: true },
            },
          }
        : undefined,
    );
    release.resolve();
    await run.result();

    const storedSession = await store.load(sessionId);
    expect(storedSession?.conversationHistory.metadata).toEqual({
      version: 'new',
      concurrent: true,
    });
  });

  it('applies candidate metadata additions, changes, and deletions against the reservation base', () => {
    const base = {
      ...createConversationHistory(),
      metadata: { changed: 'base', removed: 'base' },
    };
    const current = {
      ...base,
      metadata: {
        changed: 'concurrent',
        removed: 'concurrent',
        independent: 'current',
      },
    };
    const candidate = {
      ...base,
      metadata: { changed: 'run', added: 'run' },
    };

    const merged = appendConversationMessages(current, candidate, base);
    expect(merged.metadata).toEqual({
      changed: 'run',
      independent: 'current',
      added: 'run',
    });
  });

  it('rejects when a concurrent update removes the reserved RunRef', async () => {
    const baseStore = createSessionStore(textValueStore(new MemoryStorage()));
    let updateCount = 0;
    const store: SessionStore = {
      ...baseStore,
      async update(...args) {
        updateCount += 1;
        if (updateCount >= 2) {
          const current = await baseStore.load(args[0]);
          if (!current) return undefined;
          const missingRunSession = { ...current, runs: [] };
          await baseStore.save(missingRunSession);
          return args[1](missingRunSession);
        }
        return baseStore.update(...args);
      },
    };
    const handle = createSessionHandle('terminal-commit-missing-ref', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(),
    });

    expect(handle.run('prompt').result()).rejects.toThrow('disappeared');
  });

  it('rejects a conflicting local result when a concurrent terminal commit is authoritative', async () => {
    const baseStore = createSessionStore(textValueStore(new MemoryStorage()));
    let updateCount = 0;
    const store: SessionStore = {
      ...baseStore,
      async update(...args) {
        updateCount += 1;
        if (updateCount >= 2) {
          const current = await baseStore.load(args[0]);
          if (!current) return undefined;
          const authoritativeSession = {
            ...current,
            runs: current.runs.map((run) =>
              run.status === 'running'
                ? {
                    ...run,
                    status: 'aborted' as const,
                    outcome: { finishReason: 'aborted' as const },
                  }
                : run,
            ),
          };
          await baseStore.save(authoritativeSession);
          return args[1](authoritativeSession);
        }
        return baseStore.update(...args);
      },
    };
    const handle = createSessionHandle('terminal-commit-conflict', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(),
    });

    expect(handle.run('prompt').result()).rejects.toThrow('conflicting terminal');
    const conflictedSession = await baseStore.load('terminal-commit-conflict');
    expect(conflictedSession?.runs[0]?.outcome).toEqual({
      finishReason: 'aborted',
    });
  });
});
