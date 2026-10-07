import { TypedEventTarget } from '@lostgradient/lifecycle';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import type { AgentSession } from '../agent-session';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from '../durable/run-workflow-result';
import { SessionRecoverEvent, type OperativeEventMap } from '../events';
import { UnsupportedRunResultVersionError } from '../run-envelope';
import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import { createSessionEngine, type SessionEngineBehavior } from './session-engine-test-fixture';
import { createSessionHandle } from './session-handle';
import { reconcileTerminalRunRef } from './session-handle-support';
import {
  alreadyTerminalError,
  collectEvents,
  createCheckpointStoreFixture,
  createTestRunOptions,
  fixtureRuntime,
  seedRunningSession,
} from './session-handle-test-support';
import type { SessionStore } from './types';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

function reconcileMetadata(session: AgentSession): AgentSession {
  return {
    ...session,
    conversationHistory: {
      ...session.conversationHistory,
      metadata: { changed: 'current', removed: true, concurrent: true },
    },
    runs: session.runs.map((run) => ({
      ...run,
      baseConversationMetadata: { changed: 'base', removed: true },
    })),
  };
}

function schemaValidation(schemaSuccess: boolean | undefined) {
  if (schemaSuccess === undefined) return {};
  if (schemaSuccess)
    return {
      schemaValidation: { success: true, error: 'private-validation-canary' },
      output: { ok: true },
    };
  return { schemaValidation: { success: false, error: 'private-validation-canary' } };
}

function expectedOutcome(schemaSuccess: boolean | undefined) {
  if (schemaSuccess === false) {
    return {
      finishReason: 'stop-condition',
      error: { kind: 'output', code: 'INVALID_OUTPUT' },
    } as const;
  }
  return { finishReason: 'stop-condition' } as const;
}

describe('recover() — terminal reconciliation', () => {
  it('surfaces a session disappearance during terminal reconciliation', async () => {
    const sessionId = 'ab-28-reconcile-disappeared-session';
    const runId = `${sessionId}:0`;
    const baseStore = await seedRunningSession(sessionId, runId);
    const store: SessionStore = {
      ...baseStore,
      async update() {
        return undefined;
      },
    };
    const engine = createSessionEngine({
      get: async () => ({
        id: runId,
        status: 'completed',
        result: {
          schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
          runId,
          steps: 1,
          content: 'done',
          finishReason: 'stop-condition',
        },
      }),
    });
    const checkpointStore = createCheckpointStoreFixture(async () => ({
      conversation: null,
      cursor: { totalUsage: {}, lastContent: 'done', schemaAttempts: 0 },
      steps: [],
    }));

    expect(
      await throwingRejectionOf(
        reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, {
          runId,
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: 'agent',
        }),
      ),
    ).toThrow('disappeared while reconciling');
  });

  it.each([undefined, true, false])(
    'reconciles completed checkpoints with schema validation=%s',
    async (schemaSuccess) => {
      const sessionId = 'ab-28-completed-session';
      const runId = `${sessionId}:0`;
      const store = await seedRunningSession(sessionId, runId);

      await store.update(sessionId, (session) =>
        session ? reconcileMetadata(session) : undefined,
      );
      const recoveredConversation = new Conversation(
        createConversationHistory({ metadata: { changed: 'run', added: true } }),
      );
      recoveredConversation.appendUserMessage('hi');
      recoveredConversation.appendAssistantMessage('hello');

      const fakeEngine = createSessionEngine({
        resume: async () => {
          throw alreadyTerminalError(runId, 'completed');
        },
        get: async (id: string) => ({
          id,
          status: 'completed',
          result: {
            schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
            runId: id,
            steps: 1,
            content: 'hello',
            finishReason: 'stop-condition',
            ...schemaValidation(schemaSuccess),
          },
        }),
      });
      const fakeCheckpointStore = createCheckpointStoreFixture(async (_id: string) => ({
        conversation: recoveredConversation.snapshot(),
        cursor: { totalUsage: {}, lastContent: 'hello', schemaAttempts: 0 },
        steps: [],
      }));

      const h = createSessionHandle(sessionId, {
        store,
        agentName: 'agent',
        engine: fakeEngine,
        checkpointStore: fakeCheckpointStore,
        runOptions: createTestRunOptions(),
      });

      // Reconciliation is a side effect — recover() still returns null for a
      // terminal run; it does not resurrect it into a live AgentRun.
      expect(await h.recover()).toBeNull();

      const persisted = await store.load(sessionId);
      const reconciled = persisted!;
      expect(reconciled.runs.find((r) => r.runId === runId)?.status).toBe('completed');
      expect(reconciled.runs[0]?.outcome).toEqual(expectedOutcome(schemaSuccess));
      expect(JSON.stringify(reconciled.runs[0]?.outcome)).not.toContain(
        'private-validation-canary',
      );
      const contents = Object.values(reconciled.conversationHistory.messages).map((m) => m.content);
      expect(contents).toContain('hi');
      expect(contents).toContain('hello');
      expect(reconciled.conversationHistory.metadata).toEqual({
        changed: 'run',
        added: true,
        concurrent: true,
      });
      await store.update(sessionId, (session) =>
        session
          ? {
              ...session,
              conversationHistory: {
                ...session.conversationHistory,
                metadata: { changed: 'later' },
              },
            }
          : undefined,
      );
      expect(await h.recover()).toBeNull();
      const laterSession = await store.load(sessionId);
      expect(laterSession?.conversationHistory.metadata).toEqual({
        changed: 'later',
      });
    },
  );

  it('reconciles a recovered run whose finishReason was "error" to "error", not "completed"', async () => {
    const sessionId = 'ab-28-error-session';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);

    const fakeEngine = createSessionEngine({
      resume: async () => {
        throw alreadyTerminalError(runId, 'completed');
      },
      get: async (id: string) => ({
        id,
        status: 'completed',
        result: {
          schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
          runId: id,
          steps: 1,
          content: '',
          finishReason: 'error',
          errorMessage: 'boom',
        },
      }),
    });
    const fakeCheckpointStore = createCheckpointStoreFixture(async (_id: string) => ({
      conversation: null,
      cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
      steps: [],
    }));

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: createTestRunOptions(),
    });

    expect(await h.recover()).toBeNull();

    const persisted = await store.load(sessionId);
    expect(persisted?.runs.find((r) => r.runId === runId)?.status).toBe('error');
  });

  it('contains unsupported terminal result versions as recover failures', async () => {
    const sessionId = 'ab-28-unsupported-version-session';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const events = collectEvents(emitter, 'session.recover');

    const fakeEngine = createSessionEngine({
      resume: async () => {
        throw alreadyTerminalError(runId, 'completed');
      },
      get: async (id: string) => ({
        id,
        status: 'completed',
        result: {
          schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION + 1,
          runId: id,
          steps: 1,
          content: '',
          finishReason: 'stop-condition',
        },
      }),
    });
    const fakeCheckpointStore = createCheckpointStoreFixture(async () => ({
      conversation: null,
      cursor: { totalUsage: {}, lastContent: '', schemaAttempts: 0 },
      steps: [],
    }));

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      emitter,
      engine: fakeEngine,
      checkpointStore: fakeCheckpointStore,
      runOptions: createTestRunOptions(),
    });

    expect(await h.recover()).toBeNull();
    expect(events).toHaveLength(1);
    const recoverEvent = events[0];
    if (!(recoverEvent instanceof SessionRecoverEvent)) {
      throw new TypeError('Expected recover event');
    }
    expect(recoverEvent.failures[0]?.error).toBeInstanceOf(UnsupportedRunResultVersionError);

    const persisted = await store.load(sessionId);
    expect(persisted?.runs.find((r) => r.runId === runId)?.status).toBe('running');
  });
});

describe('reconcileTerminalRunRef — a checkpoint that cannot be read', () => {
  async function failingReadWorld() {
    const sessionId = 'cor-851-unreadable-checkpoint';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);
    const engine = createSessionEngine({
      get: async () => ({
        id: runId,
        status: 'completed',
        result: {
          schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
          runId,
          steps: 1,
          content: 'done',
          finishReason: 'stop-condition',
        },
      }),
    });
    let reads = 0;
    const recovered = new Conversation(createConversationHistory());
    recovered.appendUserMessage('hi');
    const checkpointStore = createCheckpointStoreFixture(async () => {
      reads += 1;
      if (reads === 1) throw new Error('storage hiccup');
      return {
        conversation: recovered.snapshot(),
        cursor: { totalUsage: {}, lastContent: 'done', schemaAttempts: 0 },
        steps: [],
      };
    });
    const running = {
      runId,
      sequence: 0,
      status: 'running',
      startedAt: fixtureRuntime.clock.nowISO(),
      agentName: 'agent',
    } as const;
    return { sessionId, store, engine, checkpointStore, running };
  }

  it('by default marks the run terminal without its transcript, as recover() always has', async () => {
    const { sessionId, store, engine, checkpointStore, running } = await failingReadWorld();

    await reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, running);

    const session = await store.load(sessionId);
    const ref = session?.runs[0];
    expect(ref?.status).toBe('completed');
    expect(ref?.conversationBoundary).toBeUndefined();
  });

  it('when the transcript is required, leaves the run open so the read can be retried', async () => {
    const { sessionId, store, engine, checkpointStore, running } = await failingReadWorld();

    expect(
      await throwingRejectionOf(
        reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, running, {
          requireConversation: true,
        }),
      ),
    ).toThrow('storage hiccup');
    const stranded = await store.load(sessionId);
    expect(stranded?.runs[0]?.status).toBe('running');

    await reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, running, {
      requireConversation: true,
    });
    const settled = await store.load(sessionId);
    const ref = settled?.runs[0];
    expect(ref?.status).toBe('completed');
    expect(ref?.conversationBoundary).toBeDefined();
  });
});

describe('reconcileTerminalRunRef — a completed run whose checkpoint holds no conversation', () => {
  async function nullConversationWorld() {
    const sessionId = 'cor-851-null-conversation';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);
    const engine = createSessionEngine({
      get: async () => ({
        id: runId,
        status: 'completed',
        result: {
          schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
          runId,
          steps: 1,
          content: 'done',
          finishReason: 'stop-condition',
        },
      }),
    });
    let conversation: ReturnType<Conversation['snapshot']> | null = null;
    const checkpointStore = createCheckpointStoreFixture(async () => ({
      conversation,
      cursor: { totalUsage: {}, lastContent: 'done', schemaAttempts: 0 },
      steps: [],
    }));
    const running = {
      runId,
      sequence: 0,
      status: 'running',
      startedAt: fixtureRuntime.clock.nowISO(),
      agentName: 'agent',
    } as const;
    return {
      sessionId,
      store,
      engine,
      checkpointStore,
      running,
      commitConversation: () => {
        const recovered = new Conversation(createConversationHistory());
        recovered.appendUserMessage('hi');
        conversation = recovered.snapshot();
      },
    };
  }

  it('by default marks the run terminal without its transcript, as recover() always has', async () => {
    const { sessionId, store, engine, checkpointStore, running } = await nullConversationWorld();

    await reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, running);

    const session = await store.load(sessionId);
    const ref = session?.runs[0];
    expect(ref?.status).toBe('completed');
    expect(ref?.conversationBoundary).toBeUndefined();
  });

  it('when the transcript is required, leaves the run open until a conversation is committed', async () => {
    const { sessionId, store, engine, checkpointStore, running, commitConversation } =
      await nullConversationWorld();

    expect(
      await throwingRejectionOf(
        reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, running, {
          requireConversation: true,
        }),
      ),
    ).toThrow('no conversation');
    const stranded = await store.load(sessionId);
    expect(stranded?.runs[0]?.status).toBe('running');

    commitConversation();
    await reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, running, {
      requireConversation: true,
    });
    const settled = await store.load(sessionId);
    const ref = settled?.runs[0];
    expect(ref?.status).toBe('completed');
    expect(ref?.conversationBoundary).toBeDefined();
  });
});

describe('reconcileTerminalRunRef — a required transcript never resolves without a commit', () => {
  const completedResult = (runId: string) => ({
    schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
    runId,
    steps: 1,
    content: 'done',
    finishReason: 'stop-condition' as const,
  });

  async function world(get: NonNullable<SessionEngineBehavior['get']>) {
    const sessionId = 'cor-851-required-read';
    const runId = `${sessionId}:0`;
    const store = await seedRunningSession(sessionId, runId);
    const engine = createSessionEngine({ get: () => get(runId) });
    const recovered = new Conversation(createConversationHistory());
    recovered.appendUserMessage('hi');
    const checkpointStore = createCheckpointStoreFixture(async () => ({
      conversation: recovered.snapshot(),
      cursor: { totalUsage: {}, lastContent: 'done', schemaAttempts: 0 },
      steps: [],
    }));
    const running = {
      runId,
      sequence: 0,
      status: 'running',
      startedAt: fixtureRuntime.clock.nowISO(),
      agentName: 'agent',
    } as const;
    return { sessionId, runId, store, engine, checkpointStore, running };
  }

  async function refStatus(store: SessionStore, sessionId: string) {
    const session = await store.load(sessionId);
    return session?.runs[0]?.status;
  }

  it('rejects, leaving the ref running, when the engine read fails transiently', async () => {
    let reads = 0;
    const { sessionId, store, engine, checkpointStore, running } = await world(async (runId) => {
      reads += 1;
      if (reads === 1) throw new Error('engine hiccup');
      return { id: runId, status: 'completed', result: completedResult(runId) };
    });

    expect(
      await throwingRejectionOf(
        reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, running, {
          requireConversation: true,
        }),
      ),
    ).toThrow('engine hiccup');
    expect(await refStatus(store, sessionId)).toBe('running');

    await reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, running, {
      requireConversation: true,
    });
    expect(await refStatus(store, sessionId)).toBe('completed');
  });

  it('by default still treats a failed engine read as nothing to reconcile', async () => {
    const { sessionId, store, engine, checkpointStore, running } = await world(async () => {
      throw new Error('engine hiccup');
    });

    await reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, running);

    expect(await refStatus(store, sessionId)).toBe('running');
  });

  it('rejects when the engine has no record of the run', async () => {
    const { sessionId, store, engine, checkpointStore, running } = await world(async () => null);

    expect(
      await throwingRejectionOf(
        reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, running, {
          requireConversation: true,
        }),
      ),
    ).toThrow('no record');
    expect(await refStatus(store, sessionId)).toBe('running');
  });

  it('rejects when the run is not yet terminal', async () => {
    const { sessionId, store, engine, checkpointStore, running } = await world(async (runId) => ({
      id: runId,
      status: 'running',
    }));

    expect(
      await throwingRejectionOf(
        reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, running, {
          requireConversation: true,
        }),
      ),
    ).toThrow('not yet terminal');
    expect(await refStatus(store, sessionId)).toBe('running');
  });

  it('rejects, rather than commit a completed run without a transcript, when there is no checkpoint store', async () => {
    const { sessionId, store, engine, running } = await world(async (runId) => ({
      id: runId,
      status: 'completed',
      result: completedResult(runId),
    }));

    expect(
      await throwingRejectionOf(
        reconcileTerminalRunRef(store, engine, undefined, sessionId, running, {
          requireConversation: true,
        }),
      ),
    ).toThrow('checkpoint store');
    expect(await refStatus(store, sessionId)).toBe('running');
  });
});
