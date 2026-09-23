import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle } from './session-handle';
import {
  createCheckpointStoreFixture,
  createInstantGenerate,
  createSessionHandleFixture,
  createTestRunOptions,
  errorMessage,
} from './session-handle-test-support';
import type { SessionStore } from './types';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('session.run() — durable engine and terminal authority', () => {
  it('PRRT_kwDORvupsc6MV8XO regression: persists running RunRef before awaiting completion', async () => {
    // Use a blocking generate so the run stays in-flight long enough to inspect.
    let resolveGenerate!: () => void;
    let signalGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      signalGenerateStarted = resolve;
    });

    const blockingGenerate: GenerateFunction = () => {
      return new Promise<{ content: string; toolCalls: [] }>((resolve) => {
        resolveGenerate = () => resolve({ content: 'done', toolCalls: [] });
        signalGenerateStarted();
      });
    };

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('running-ref-session', {
      store,
      agentName: 'test-agent',
      runOptions: {
        generate: blockingGenerate,
        toolbox: createToolbox([]),
        maximumSteps: 1,
      },
    });

    const run = h.run('do something');

    // Wait until generate is executing (i.e. the session has been loaded and
    // the 'running' ref has been persisted).
    await generateStarted;

    // The store MUST contain a running ref while the run is still in-flight.
    const mid = await store.load('running-ref-session');
    expect(mid).toBeDefined();
    expect(mid!.runs).toHaveLength(1);
    expect(mid!.runs[0]!.status).toBe('running');
    expect(mid!.runs[0]!.runId).toBe('running-ref-session:0');

    // Resolve the generate so the run can finish.
    resolveGenerate();
    await run.result();
    await yieldToPortableEventLoop();

    // After completion, the ref must be updated to a terminal status in-place
    // (still only 1 RunRef — not appended).
    const final = await store.load('running-ref-session');
    expect(final!.runs).toHaveLength(1);
    expect(final!.runs[0]!.status).toBe('completed');
    expect(final!.runs[0]!.runId).toBe('running-ref-session:0');
  });

  it('surfaces persistence failures after the inner run resolves', async () => {
    const kv = textValueStore(new MemoryStorage());
    const baseStore = createSessionStore(kv);
    let updateCalls = 0;
    const store: SessionStore = {
      ...baseStore,
      async update(...args) {
        updateCalls += 1;
        if (updateCalls === 2) {
          throw new Error('failed to persist terminal run');
        }
        return baseStore.update(...args);
      },
    };
    const handle = createSessionHandle('terminal-persist-fails', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(createInstantGenerate('done')),
    });

    const run = handle.run('hello');

    try {
      await run.result();
      throw new Error('expected run result to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(errorMessage(error)).toContain('failed to persist terminal run');
    }
    await yieldToPortableEventLoop();
    expect(updateCalls).toBe(2);
  });

  it('streams run events when iterating a session run', async () => {
    const { handle } = createSessionHandleFixture();
    const agentRun = handle.run('stream events');
    const eventTypes: string[] = [];

    for await (const event of agentRun) {
      eventTypes.push(event.type);
    }

    expect(eventTypes).toContain('run.started');
    expect(eventTypes).toContain('run.completed');
    const result = await agentRun.result();
    expect(result).toMatchObject({ finishReason: 'maximum-steps' });
  });

  it('aborts a running session run through the AgentRun handle', async () => {
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
    const handle = createSessionHandle('abort-agent-run-session', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(blockingGenerate),
    });

    const agentRun = handle.run('abort me');
    await generateStarted;
    agentRun.abort('user stopped it');

    const result = await agentRun.result();
    expect(result).toMatchObject({
      finishReason: 'aborted',
    });
  });

  // Regression: Finding PRRT_kwDORvupsc6MUE_1 — run() never routed through the
  // Weft durable engine even when engine+checkpointStore were present. After the
  // fix, a new run must start via engine.start() so it is checkpointed and
  // reachable via signal/update/query/recover().
  it('F2 regression: run() routes through the Weft engine when engine+checkpointStore are present', async () => {
    const startedIds: string[] = [];

    // A minimal fake engine that records the ids passed to start().
    const fakeEngine = createSessionEngine({
      start: async (_type: string, _input: unknown, opts: { id: string; services?: unknown }) => {
        startedIds.push(opts.id);
        // Return a minimal handle whose result() rejects so the run terminates.
        const aborted = AbortSignal.abort();
        return {
          id: opts.id,
          result: () => Promise.reject(new Error('fake engine')),
          abort: () => {},
          signal: aborted,
          addEventListener: () => {},
          removeEventListener: () => {},
          [Symbol.asyncIterator]: async function* () {},
        };
      },
      cancel: async () => {},
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    });

    const fakeCheckpointStore = createCheckpointStoreFixture(async (_runId: string) => ({
      conversation: null,
      cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
      steps: [],
    }));

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('f2-regression-session', {
      store,
      agentName: 'f2-agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]),
        maximumSteps: 1,
      },
    });

    // Start the run and let it settle (the fake engine immediately rejects,
    // so the result promise will reject too — we swallow that).
    const run = h.run('durable please');
    await run.result().catch(() => {});
    await yieldToPortableEventLoop();

    // The durable engine's start() must have been called with the derived id
    // in `${sessionId}:${sequence}` format.
    expect(startedIds).toHaveLength(1);
    expect(startedIds[0]).toBe('f2-regression-session:0');
  });

  it.each(['conflict', 'missing', 'matching'] as const)(
    'preserves terminal authority after an engine rejection with a %s commit',
    async (commitMode) => {
      const fakeEngine = createSessionEngine({
        start: async (_type: string, _input: unknown, options: { id: string }) => ({
          id: options.id,
          result: () => Promise.reject(new Error('engine infrastructure failure')),
          abort: () => {},
          signal: AbortSignal.abort(),
          addEventListener: () => {},
          removeEventListener: () => {},
          [Symbol.asyncIterator]: async function* () {},
        }),
        cancel: async () => {},
        signal: async () => {},
        update: async () => {},
        query: async () => {},
      });
      const baseStore = createSessionStore(textValueStore(new MemoryStorage()));
      let updateCalls = 0;
      const store: SessionStore = {
        ...baseStore,
        async update(...args) {
          updateCalls += 1;
          if (updateCalls === 2) {
            if (commitMode === 'missing') return undefined;
            await baseStore.update(args[0], (session) =>
              session
                ? {
                    ...session,
                    runs: session.runs.map((run) =>
                      run.status === 'running'
                        ? commitMode === 'conflict'
                          ? { ...run, status: 'aborted', outcome: { finishReason: 'aborted' } }
                          : { ...run, status: 'error', outcome: { finishReason: 'error' } }
                        : run,
                    ),
                  }
                : undefined,
            );
          }
          return baseStore.update(...args);
        },
      };
      const handle = createSessionHandle('reject-terminal-authority', {
        store,
        agentName: 'agent',
        engine: fakeEngine,
        checkpointStore: createCheckpointStoreFixture(async () => ({
          conversation: null,
          cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
          steps: [],
        })),
        runOptions: createTestRunOptions(),
      });

      expect(handle.run('prompt').result()).rejects.toThrow(
        commitMode === 'matching'
          ? 'engine infrastructure failure'
          : 'Failed to persist terminal failure',
      );
      const rejectedSession = await baseStore.load('reject-terminal-authority');
      expect(rejectedSession?.runs[0]?.outcome).toEqual(
        commitMode === 'missing'
          ? undefined
          : { finishReason: commitMode === 'conflict' ? 'aborted' : 'error' },
      );
      if (commitMode === 'matching') {
        const promptMessages = Object.values(
          rejectedSession?.conversationHistory.messages ?? {},
        ).filter((message) => message.role === 'user' && message.content === 'prompt');
        expect(promptMessages).toHaveLength(1);
      }
    },
  );
});
