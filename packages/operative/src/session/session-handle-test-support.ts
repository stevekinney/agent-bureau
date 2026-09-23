import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { activity, MemoryStorage, textValueStore, workflow } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import type { ConversationSnapshot } from 'conversationalist';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import type { CheckpointStore } from '../durable/checkpoint-store';
import type { RegistryAgnosticEngine } from '../durable/create-run-engine';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from '../durable/run-workflow-result';
import type { RunCheckpoint } from '../durable/types';
import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import type { SessionStore } from './types';

export const fixtureRuntime = createManualRuntimeServices();

export function createInstantGenerate(content = 'hello'): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

export function errorMessage(value: unknown): string {
  if (!(value instanceof Error)) throw new TypeError('Expected an Error');
  return value.message;
}

export function createCheckpointStoreFixture(
  loadCheckpoint: (runId: string) => Promise<{
    conversation: ConversationSnapshot | null;
    cursor: {
      totalUsage: Record<string, number>;
      lastContent: string;
      schemaAttempts: number;
    };
    steps: RunCheckpoint['steps'];
  }>,
): CheckpointStore {
  return {
    saveCursor: async () => {},
    loadCursor: async () => null,
    saveConversation: async () => {},
    loadConversation: async () => null,
    saveStep: async () => {},
    loadSteps: async () => [],
    async loadCheckpoint(runId) {
      const checkpoint = await loadCheckpoint(runId);
      return {
        ...checkpoint,
        runId,
        cursor: {
          step: 0,
          lastAppliedConfigVersion: 0,
          totalUsage: { prompt: 0, completion: 0, total: 0, ...checkpoint.cursor.totalUsage },
          lastContent: checkpoint.cursor.lastContent,
          schemaAttempts: checkpoint.cursor.schemaAttempts,
        },
      };
    },
    clear: async () => 0,
  };
}

export function createTestRunOptions(generate: GenerateFunction = createInstantGenerate()) {
  return { generate, toolbox: createToolbox([]), maximumSteps: 1 };
}

export function createSessionHandleFixture(overrides?: {
  sessionId?: string;
  engine?: RegistryAgnosticEngine;
  withoutRunOptions?: boolean;
}) {
  const sessionId = overrides?.sessionId ?? 'test-session';
  const store = createSessionStore(textValueStore(new MemoryStorage()));
  return {
    sessionId,
    store,
    handle: createSessionHandle(sessionId, {
      store,
      agentName: 'test-agent',
      engine: overrides?.engine,
      runOptions: overrides?.withoutRunOptions ? undefined : createTestRunOptions(),
    }),
  };
}

export function createUpdateGate(store: SessionStore): {
  readonly store: SessionStore;
  readonly release: () => void;
} {
  let releaseUpdate: (() => void) | undefined;
  const updateGate = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  return {
    store: {
      ...store,
      async update(...args) {
        await updateGate;
        return store.update(...args);
      },
    },
    release() {
      releaseUpdate?.();
    },
  };
}

export function collectEvents(emitter: EventTarget, type: string): Event[] {
  const collected: Event[] = [];
  emitter.addEventListener(type, (event) => collected.push(event));
  return collected;
}

export function makeProbeWorkflow() {
  const probe = activity({ name: 'probe', execute: async () => ({ ok: true }) });
  return workflow({ name: 'agentRun' })
    .activities({ probe })
    .execute(async function* (ctx) {
      yield* ctx.run('probe', {});
      return {
        schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
        runId: '',
        steps: 1,
        content: 'done',
        finishReason: 'stop-condition' as const,
      };
    });
}

export function makeParkingWorkflow(sleepMs: number) {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx) {
    yield* ctx.sleep(sleepMs);
    return {
      schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
      runId: '',
      steps: 1,
      content: 'resumed',
      finishReason: 'stop-condition' as const,
    };
  });
}

export function alreadyTerminalError(runId: string, status: string): Error {
  return new Error(
    `Cannot resume workflow "${runId}": status is "${status}", expected "running" or "suspended"`,
  );
}

export async function seedRunningSession(sessionId: string, runId: string): Promise<SessionStore> {
  const store = createSessionStore(textValueStore(new MemoryStorage()));
  await store.save(
    createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: sessionId,
      runs: [
        {
          runId,
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
      ],
    }),
  );
  return store;
}

export function dispatchOnToolboxContext(context: unknown, event: Event): void {
  if (
    context === null ||
    typeof context !== 'object' ||
    !('dispatchEvent' in context) ||
    typeof context.dispatchEvent !== 'function'
  ) {
    throw new TypeError('toolbox context does not expose dispatchEvent');
  }
  context.dispatchEvent(event);
}
