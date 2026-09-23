import { TypedEventTarget } from '@lostgradient/lifecycle';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import type { AgentSession } from '../agent-session';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from '../durable/run-workflow-result';
import { SessionRecoverEvent, type OperativeEventMap } from '../events';
import { UnsupportedRunResultVersionError } from '../run-envelope';
import { createSessionEngine } from './session-engine-test-fixture';
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
  return { schemaValidation: { success: schemaSuccess, error: 'private-validation-canary' } };
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
      reconcileTerminalRunRef(store, engine, checkpointStore, sessionId, {
        runId,
        sequence: 0,
        status: 'running',
        startedAt: fixtureRuntime.clock.nowISO(),
        agentName: 'agent',
      }),
    ).rejects.toThrow('disappeared while reconciling');
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
