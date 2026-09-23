import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle } from './session-handle';
import {
  createCheckpointStoreFixture,
  createInstantGenerate,
  fixtureRuntime,
} from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('regression — durable abort and cancel', () => {
  it('calls engine.cancel() on the durable run when AgentRun.abort() is called', async () => {
    const cancelledIds: string[] = [];

    // Signal from inside engine.start() so the test knows driveStarted=true and
    // the inner ActiveRun is live. Using start() rather than generate() because
    // the generate is called by the Weft workflow body, which is never reached
    // with a fake engine — start() is called synchronously in the microtask
    // immediately after driveStarted becomes true.
    let signalStarted!: () => void;
    const engineStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    // cancel() resolves this so the blocked handle.result() can reject and the
    // run can terminate after the assertion.
    let rejectHandle!: (err: Error) => void;
    const handleResult = new Promise<never>((_resolve, reject) => {
      rejectHandle = reject;
    });

    // Fake engine that:
    //   start() — signals the test, then returns a handle that blocks on result()
    //   cancel() — records the runId (assertion target) and unblocks the handle
    const fakeEngine = createSessionEngine({
      start: async (_type: string, _input: unknown, opts: { id: string; services?: unknown }) => {
        signalStarted();
        return {
          id: opts.id,
          result: () => handleResult,
          abort: () => {},
          signal: AbortSignal.abort(),
          addEventListener: () => {},
          removeEventListener: () => {},
          [Symbol.asyncIterator]: async function* () {},
        };
      },
      cancel: async (id: string) => {
        cancelledIds.push(id);
        // Unblock the handle so driveDurableRun can complete and the run settles.
        rejectHandle(new Error('cancelled by test'));
      },
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
    const sessionId = 'abort-forward-session';

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'abort-agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]),
        maximumSteps: 1,
      },
    });

    const agentRun = h.run('go');

    // Wait until engine.start() has been called — at this point driveStarted is
    // true and `activeInnerRun` is set, so abort() will forward to the inner run.
    await engineStarted;

    // Abort the outer AgentRun.
    agentRun.abort('test-abort');

    // Allow the abort to propagate through the promise chain.
    await yieldToPortableEventLoop();

    // engine.cancel() must have been called, proving the abort was forwarded
    // through the inner durable ActiveRun to the Weft engine. Without the fix
    // only the AbortController signal fires and any parked Weft workflow is
    // never cancelled.
    expect(cancelledIds).toContain(`${sessionId}:0`);

    // Swallow the result promise to avoid unhandled rejection (the fake engine's
    // start() returns a never-settling handle, so result() never resolves).
    await agentRun.result().catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6Ma-Dr — [Symbol.dispose]() forwards to the inner
// durable run so engine.cancel() is called for parked workflows
// ---------------------------------------------------------------------------

describe('regression: [Symbol.dispose]() forwards to the durable inner run (PRRT_kwDORvupsc6Ma-Dr)', () => {
  it('calls engine.cancel() on the durable run when AgentRun[Symbol.dispose]() is called', async () => {
    const cancelledIds: string[] = [];

    // Signal from inside engine.start() so we know activeInnerRun is set.
    let signalStarted!: () => void;
    const engineStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    // cancel() resolves this so the blocked handle.result() can reject and the
    // run can terminate after the assertion.
    let rejectHandle!: (err: Error) => void;
    const handleResult = new Promise<never>((_resolve, reject) => {
      rejectHandle = reject;
    });

    // Fake engine: start() signals the test and blocks; cancel() records the id.
    const fakeEngine = createSessionEngine({
      start: async (_type: string, _input: unknown, opts: { id: string; services?: unknown }) => {
        signalStarted();
        return {
          id: opts.id,
          result: () => handleResult,
          abort: () => {},
          signal: AbortSignal.abort(),
          addEventListener: () => {},
          removeEventListener: () => {},
          [Symbol.asyncIterator]: async function* () {},
        };
      },
      cancel: async (id: string) => {
        cancelledIds.push(id);
        rejectHandle(new Error('cancelled by dispose'));
      },
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
    const sessionId = 'dispose-forward-session';

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'dispose-agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]),
        maximumSteps: 1,
      },
    });

    const agentRun = h.run('go');

    // Wait until engine.start() has been called — activeInnerRun is now set.
    await engineStarted;

    // Dispose the outer AgentRun handle (the public API named in the finding).
    agentRun[Symbol.dispose]();

    // Allow disposal to propagate through the promise chain.
    await yieldToPortableEventLoop();

    // engine.cancel() must have been called, proving [Symbol.dispose]() forwarded
    // through activeInnerRun to the Weft engine — not just firing the AbortController.
    // Before the fix, cancel() was never called, leaving parked workflows running.
    expect(cancelledIds).toContain(`${sessionId}:0`);

    // Swallow the result promise to avoid unhandled rejection.
    await agentRun.result().catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6MZ-vp — only mark session aborted when cancel succeeds
// ---------------------------------------------------------------------------

describe('regression: cancel() only persists aborted status when engine.cancel() succeeds (PRRT_kwDORvupsc6MZ-vp)', () => {
  it('persists a safe aborted outcome and preserves the originating user message id', async () => {
    const sessionId = 'cancel-success-session';
    const runId = `${sessionId}:0`;
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(
      createAgentSession({
        agentName: 'durable-agent',
        conversationHistory: createConversationHistory(),
        id: sessionId,
        runs: [
          {
            runId,
            sequence: 0,
            status: 'running',
            startedAt: fixtureRuntime.clock.nowISO(),
            agentName: 'durable-agent',
            userMessageId: 'originating-user-message',
          },
        ],
      }),
    );
    const engine = createSessionEngine({
      cancel: async () => {},
      get: async () => ({ id: runId, status: 'cancelled' }),
    });
    const handle = createSessionHandle(sessionId, {
      store,
      agentName: 'durable-agent',
      engine,
      runOptions: { generate: createInstantGenerate(), toolbox: createToolbox([]) },
    });

    await handle.cancel();

    const persisted = await store.load(sessionId);
    const run = persisted?.runs[0];
    expect(run?.status).toBe('aborted');
    expect(run?.userMessageId).toBe('originating-user-message');
    expect(run?.outcome).toEqual({
      finishReason: 'aborted',
      error: { kind: 'abort', code: 'ABORTED' },
    });
  });

  it('preserves a fresh terminal status written while engine.cancel is pending', async () => {
    const sessionId = 'cancel-concurrent-terminal-session';
    const runId = `${sessionId}:0`;
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(
      createAgentSession({
        agentName: 'durable-agent',
        conversationHistory: createConversationHistory(),
        id: sessionId,
        runs: [
          {
            runId,
            sequence: 0,
            status: 'running',
            startedAt: fixtureRuntime.clock.nowISO(),
            agentName: 'durable-agent',
            userMessageId: 'originating-user-message',
          },
        ],
      }),
    );
    const cancelStarted = Promise.withResolvers<void>();
    const releaseCancel = Promise.withResolvers<void>();
    const engine = createSessionEngine({
      cancel: async () => {
        cancelStarted.resolve();
        await releaseCancel.promise;
      },
      get: async () => ({ id: runId, status: 'cancelled' }),
    });
    const handle = createSessionHandle(sessionId, {
      store,
      agentName: 'durable-agent',
      engine,
      runOptions: { generate: createInstantGenerate(), toolbox: createToolbox([]) },
    });

    const cancelling = handle.cancel();
    await cancelStarted.promise;
    await store.update(sessionId, (session) =>
      session
        ? {
            ...session,
            runs: session.runs.map((run) =>
              run.runId === runId
                ? {
                    ...run,
                    status: 'completed' as const,
                    outcome: { finishReason: 'stop-condition' as const },
                  }
                : run,
            ),
          }
        : undefined,
    );
    releaseCancel.resolve();
    await cancelling;

    const persisted = await store.load(sessionId);
    const run = persisted?.runs[0];
    expect(run?.status).toBe('completed');
    expect(run?.outcome).toEqual({ finishReason: 'stop-condition' });
  });

  it('does not update the session store to aborted when engine.cancel() throws', async () => {
    const fakeEngine = createSessionEngine({
      cancel: async (_id: string) => {
        throw new Error('storage fault');
      },
      signal: async () => {},
      update: async () => {},
      query: async () => {},
    });

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    // Pre-load a session with a running run ref so cancel() has something to act on.
    const runningSession = createAgentSession({
      agentName: 'durable-agent',
      conversationHistory: createConversationHistory(),
      id: 'cancel-throws-session',
      runs: [
        {
          runId: 'cancel-throws-session:0',
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: 'durable-agent',
        },
      ],
    });
    await store.save(runningSession);

    const h = createSessionHandle('cancel-throws-session', {
      store,
      agentName: 'durable-agent',
      engine: fakeEngine,
      runOptions: {
        generate: createInstantGenerate(),
        toolbox: createToolbox([]),
      },
    });

    // cancel() must not reject even when engine.cancel() throws — the error is
    // non-fatal per the architecture comment. `await h.cancel()` would throw if
    // the rejection propagated; passing here proves it is swallowed correctly.
    const cancelResult = await h.cancel();
    expect(cancelResult).toBeUndefined();

    // The session must NOT be marked 'aborted' because the durable workflow
    // cancel failed — its actual status is still 'running' in Weft's store.
    const updated = await store.load('cancel-throws-session');
    expect(updated!.runs[0]!.status).toBe('running');
  });
});
