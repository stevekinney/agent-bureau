import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AbortAgentRunError,
  type ActiveRun,
  type AgentInput,
  type AgentRunContext,
  type CombinedOperativeEventMap,
  createAgent,
  createAgentSession,
  createScheduleWakeupTool,
  createSessionStore,
  DEFAULT_MAXIMUM_STEPS,
  type DefinitionResolvingAgent,
  DurableCapabilityUnavailableError,
  type GenerateFunction,
  type GenerateResponse,
  HumanWaitParkedEvent,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  RunAbortedEvent,
  type RunnableAgent,
  SchedulerTaskCompletedEvent,
  SchedulerTaskFailedEvent,
  StepCompletedEvent,
  stopWhen,
  type StreamEventMap,
  TaskCancelledEvent,
  TaskDispatchedEvent,
  TaskPreemptedEvent,
  type Toolbox,
} from '@lostgradient/operative';
import {
  type DurableEventEnvelope,
  type DurableRunDeps,
  type ScheduledAgentRunInput,
  SCHEDULER_ORIGIN_TAG,
  startDurableRunResult,
} from '@lostgradient/operative/durable';
import { createModelCatalog } from '@lostgradient/operative/providers';
import { createStore } from '@lostgradient/operative/store';
import { createMockGenerate as createSequentialGenerate } from '@lostgradient/operative/test';
import { encode, ScheduleHandle } from '@lostgradient/weft';
import { KEYS, MemoryStorage, resolveStorage, textValueStore } from '@lostgradient/weft/storage';
import type { ConditionalTextValueStore } from '@lostgradient/weft/storage/text-value-store';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import {
  ApprovalBindingError,
  createProcessLocalApprovalStateStore,
  createTool,
  createToolbox,
} from 'armorer';
import { createMockTool, createTestToolbox } from 'armorer/test';
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Conversation, createConversationHistory, getMessages } from 'conversationalist';
import { CompletableEventTarget, createManualRuntimeServices, TypedEventTarget } from 'lifecycle';
import { createMemory, type Memory } from 'memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from 'memory/test';
import { z } from 'zod';

import type { AuditRecord } from './audit-trail';
import * as auditTrailModule from './audit-trail';
import {
  BureauError,
  classifyRecoveredRun,
  classifyRecoveredRunDetailed,
  createBureau,
  createDefaultSessionPersistenceSleep,
  detachBestEffortPromise,
  emptyRecoveredStepMetadata,
  hasRecoverableTransportAuthority,
  isRecoverableScheduledFireInput,
  isSessionAuthorityAuthorized,
  isSessionRunTerminal,
  isTerminalApprovalBindingError,
  loadExistingScheduledSessionId,
  monitorRecoveredCatalogRun,
  monitorRecoveredScheduledFire,
  omitKeysWithPrefix,
  recordedSessionAuthorityPrincipalId,
  recoveredRequestContextFromMetadata,
  resolveCancelDurableRun,
  ScheduleLocatorUnavailableError,
  wireFlowControlSchedulerEvents,
  wireStreamEventTargetFrames,
} from './create-bureau';
import type {
  CatalogRefreshHandle,
  CatalogRefreshRequest,
  ModelCatalogService,
} from './model-catalog-refresh';
import { createModelCatalogService } from './model-catalog-refresh';
import {
  createHumanWaitContext,
  createMemoryPersistHook,
  createRuntimeComposition,
  createWakeupContext,
} from './runtime-composition';
import { waitForCondition, waitForRunState } from './test';
import {
  type Bureau,
  type BureauDiagnostic,
  type ConfigurationResponse,
  type ServerFrame,
} from './types';

let recoveryDatabaseCounter = 0;

function createTextStoreProxy(
  backingStore: ConditionalTextValueStore,
  overrides: Partial<ConditionalTextValueStore> = {},
): ConditionalTextValueStore {
  return {
    get: overrides.get ?? ((key) => backingStore.get(key)),
    set: overrides.set ?? ((key, value) => backingStore.set(key, value)),
    delete: overrides.delete ?? ((key) => backingStore.delete(key)),
    list: overrides.list ?? ((prefix) => backingStore.list(prefix)),
    has: overrides.has ?? ((key) => backingStore.has(key)),
    deletePrefix: overrides.deletePrefix ?? ((prefix) => backingStore.deletePrefix(prefix)),
    close: overrides.close ?? (() => backingStore.close()),
    conditionalBatch:
      overrides.conditionalBatch ??
      ((conditions, operations) => backingStore.conditionalBatch(conditions, operations)),
  };
}

function persistedApprovalToken(
  session: Awaited<ReturnType<Bureau['getSession']>>,
  reviewId: string,
): string {
  const overrides = session?.metadata['pendingApprovalOverrides'];
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new Error('Expected pending approval overrides metadata');
  }
  const approval = (overrides as Record<string, unknown>)[reviewId];
  if (typeof approval !== 'object' || approval === null || Array.isArray(approval)) {
    throw new Error(`Expected pending approval override for "${reviewId}"`);
  }
  const approvalToken = (approval as { approvalToken?: unknown }).approvalToken;
  if (typeof approvalToken !== 'string') {
    throw new Error(`Expected persisted approval token for "${reviewId}"`);
  }
  return approvalToken;
}

/** A no-op `next` tool that lets a run take multiple steps. */
function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

type HasApiKey<T> = 'apiKey' extends keyof T ? true : false;

function createMockGenerate(content = 'Done.'): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

function createBlockingGenerate(): {
  generate: GenerateFunction;
  resolve: (response: GenerateResponse) => void;
} {
  let resolveResponse: ((response: GenerateResponse) => void) | undefined;
  const pendingResponse = new Promise<GenerateResponse>((resolve) => {
    resolveResponse = resolve;
  });

  const generate: GenerateFunction = async (context) => {
    if (context.signal?.aborted) {
      return { content: 'aborted', toolCalls: [] };
    }

    return Promise.race([
      pendingResponse,
      new Promise<GenerateResponse>((resolve) => {
        context.signal?.addEventListener(
          'abort',
          () => resolve({ content: 'aborted', toolCalls: [] }),
          { once: true },
        );
      }),
    ]);
  };

  return { generate, resolve: resolveResponse! };
}

async function waitForRunCompletion(bureau: Bureau, runId: string) {
  await waitForRunState(bureau, runId);
  // Drain Weft's deferred inline-launch queue (its `setTimeout(0)` starts) so the
  // terminal session-persistence listeners settle. yieldToPortableEventLoop is a
  // macrotask (MessageChannel), which advances that queue — a microtask flush
  // would not. Ten yields match the prior drainMicrotasks(10) budget.
  for (let i = 0; i < 10; i++) {
    await yieldToPortableEventLoop();
  }
}

/**
 * Poll `check` up to `attempts` times, yielding one macrotask between tries.
 * Each yield also drains Weft's deferred inline-launch queue (its `setTimeout(0)`
 * starts), so a recovered run can advance — bounded, not a fixed wall-clock sleep
 * that flakes on loaded hosts. `check` may be async (e.g. re-reading the session
 * store each iteration). The cap is generous (20) because each tick is a cheap
 * `setTimeout(0)` and a multi-step durable recovery yields several times (launch
 * → resolver → per-step memo → saveConversation/recordStep/saveCursor); a tight
 * cap would itself flake on a loaded host. A `check` that resolves earlier returns
 * immediately, so the generous cap costs nothing on the happy path.
 */
async function pollUntil(check: () => boolean | Promise<boolean>, attempts = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return true;
    await yieldToPortableEventLoop();
  }
  return check();
}

// Drain Weft's deferred inline-launch queue between tests — a pending setTimeout(0)
// inline-launch left by one durable run can starve a later one under full
// `bun test` concurrency (CI). 0.3.0's dispose-drain does not replace this flush.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('create-bureau helper coverage', () => {
  it('detaches best-effort promises without surfacing rejected cleanup work', async () => {
    detachBestEffortPromise(Promise.resolve('done'));
    detachBestEffortPromise(Promise.reject(new Error('best-effort failure')));

    await Promise.resolve();
  });

  it('uses the default session persistence sleep timer with the requested delay', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const timerCalls: Array<number | undefined> = [];
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
      timerCalls.push(timeout);
      expect(typeof handler).toBe('function');
      (handler as (...args: unknown[]) => void)();
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    try {
      await createDefaultSessionPersistenceSleep()(42);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(timerCalls).toEqual([42]);
  });

  it('wires scheduler lifecycle events to the flow controller and removes the listeners on dispose', () => {
    const scheduler = new EventTarget();
    const calls: string[] = [];
    const cleanup = wireFlowControlSchedulerEvents(scheduler, {
      settle: (taskId) => calls.push(`settle:${taskId}`),
      markParked: (taskId) => calls.push(`park:${taskId}`),
      markResumed: (taskId) => calls.push(`resume:${taskId}`),
    });

    scheduler.dispatchEvent(new SchedulerTaskCompletedEvent('completed-task', {} as never));
    scheduler.dispatchEvent(new SchedulerTaskFailedEvent('failed-task', new Error('boom')));
    scheduler.dispatchEvent(new TaskCancelledEvent('cancelled-task', 'queued'));
    scheduler.dispatchEvent(new TaskPreemptedEvent('requeued-task', 'higher priority task', true));
    scheduler.dispatchEvent(
      new TaskPreemptedEvent('dropped-task', 'cancelled during preemption', false),
    );
    scheduler.dispatchEvent(new TaskDispatchedEvent('dispatched-task', 'background'));

    expect(calls).toEqual([
      'settle:completed-task',
      'settle:failed-task',
      'settle:cancelled-task',
      'park:requeued-task',
      'settle:dropped-task',
      'resume:dispatched-task',
    ]);

    cleanup.forEach((dispose) => dispose());
    scheduler.dispatchEvent(new TaskDispatchedEvent('ignored-after-cleanup', 'background'));
    expect(calls).toEqual([
      'settle:completed-task',
      'settle:failed-task',
      'settle:cancelled-task',
      'park:requeued-task',
      'settle:dropped-task',
      'resume:dispatched-task',
    ]);
  });

  it('finds recovered scheduled sessions by explicit id and stateless session naming', async () => {
    const kv = textValueStore(new MemoryStorage());
    const sessionStore = createSessionStore(kv);
    const runId = 'scheduled-run-id';

    await sessionStore.save(
      createAgentSession({
        id: 'explicit-scheduled-session',
        agentName: 'scheduler',
        conversationHistory: createConversationHistory({ id: 'explicit-scheduled-session' }),
        metadata: { lastScheduledFireRunId: runId },
      }),
    );
    await sessionStore.save(
      createAgentSession({
        id: `sched-nightly-${runId}`,
        agentName: 'scheduler',
        conversationHistory: createConversationHistory({ id: `sched-nightly-${runId}` }),
        metadata: { lastScheduledFireRunId: runId },
      }),
    );

    const explicitInput: ScheduledAgentRunInput = {
      agentName: 'scheduler',
      input: 'run nightly',
      sessionId: 'explicit-scheduled-session',
    };
    const statelessInput: ScheduledAgentRunInput = {
      agentName: 'scheduler',
      input: 'run nightly',
    };

    expect(await loadExistingScheduledSessionId(sessionStore, explicitInput, runId)).toBe(
      'explicit-scheduled-session',
    );
    expect(await loadExistingScheduledSessionId(sessionStore, statelessInput, runId)).toBe(
      `sched-nightly-${runId}`,
    );
    expect(
      await loadExistingScheduledSessionId(
        sessionStore,
        { ...explicitInput, sessionId: 'missing-session' },
        runId,
      ),
    ).toBeUndefined();
  });

  it('wires stream events to live frames and removes every listener on dispose', () => {
    const streamEventTarget = new TypedEventTarget<StreamEventMap>();
    const frames: ServerFrame[] = [];
    let sequence = 0;
    const dispose = wireStreamEventTargetFrames(
      streamEventTarget,
      'run-stream',
      (frame) => frames.push(frame),
      () => ++sequence,
    );

    streamEventTarget.dispatchEvent(
      new CustomEvent('stream:text-delta', {
        detail: {
          type: 'stream:text-delta',
          content: 'Hel',
          accumulated: 'Hel',
        },
      }),
    );
    streamEventTarget.dispatchEvent(
      new CustomEvent('stream:tool-call-start', {
        detail: {
          type: 'stream:tool-call-start',
          toolName: 'lookup',
          blockId: 'block-1',
        },
      }),
    );
    streamEventTarget.dispatchEvent(
      new CustomEvent('stream:tool-call-delta', {
        detail: {
          type: 'stream:tool-call-delta',
          toolName: 'lookup',
          blockId: 'block-1',
          partialArguments: '{"id"',
        },
      }),
    );
    streamEventTarget.dispatchEvent(
      new CustomEvent('stream:tool-call-complete', {
        detail: {
          type: 'stream:tool-call-complete',
          toolName: 'lookup',
          blockId: 'block-1',
          arguments: { id: '123' },
        },
      }),
    );
    streamEventTarget.dispatchEvent(
      new CustomEvent('stream:complete', {
        detail: {
          type: 'stream:complete',
          state: 'done',
        },
      }),
    );
    streamEventTarget.dispatchEvent(
      new CustomEvent('stream:error', {
        detail: {
          type: 'stream:error',
          error: new Error('stream failed'),
        },
      }),
    );

    expect(frames.map((frame) => frame.type)).toEqual([
      'stream:text-delta',
      'stream:tool-call-start',
      'stream:tool-call-delta',
      'stream:tool-call-complete',
      'stream:complete',
      'stream:error',
    ]);
    expect(frames.map((frame) => ('runSeq' in frame ? frame.runSeq : undefined))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);

    dispose();
    streamEventTarget.dispatchEvent(
      new CustomEvent('stream:complete', {
        detail: {
          type: 'stream:complete',
          state: 'done',
        },
      }),
    );

    expect(frames).toHaveLength(6);
  });

  it('binds the human wait context to the durable services reference once available', () => {
    const servicesRef: { current?: DurableRunDeps } = {};
    const context = createHumanWaitContext(servicesRef, 'run-human-wait');

    expect(context.runId).toBe('run-human-wait');
    expect(context.pendingHumanWait).toBeUndefined();

    const pendingWait = {
      prompt: 'Need approval',
      signalName: 'human-input:run-human-wait',
    } as DurableRunDeps['pendingHumanWait'];

    context.pendingHumanWait = pendingWait;
    expect(context.pendingHumanWait).toBeUndefined();

    servicesRef.current = {} as DurableRunDeps;
    context.pendingHumanWait = pendingWait;
    expect(servicesRef.current.pendingHumanWait).toBe(pendingWait);
    expect(context.pendingHumanWait).toBe(pendingWait);
  });
});

describe('createBureau', () => {
  it('rebuilds only valid persisted request authority for recovered runs', () => {
    const fixedNow = 1_700_000_000_000;
    const now = () => fixedNow;
    expect(
      recoveredRequestContextFromMetadata(
        {
          lastRequestAuthorities: {
            'run-authorized': {
              agentId: 'per-run-billing-agent',
              principalId: 'principal-1',
              tenantId: 'tenant-1',
              ownerId: 'owner-1',
              capabilities: ['tools:execute', 'payments:charge'],
              authorizationRevision: 'authorization-7',
              audience: 'operator',
            },
          },
        },
        'run-authorized',
        'billing-agent',
        now,
      ),
    ).toEqual({
      authority: {
        principalId: 'principal-1',
        tenantId: 'tenant-1',
        ownerId: 'owner-1',
        capabilities: ['tools:execute', 'payments:charge'],
        authorizationRevision: 'authorization-7',
      },
      audience: 'operator',
      agentId: 'per-run-billing-agent',
      runId: 'run-authorized',
    });

    expect(
      recoveredRequestContextFromMetadata(
        { lastRequestAuthorities: { 'other-run': {} } },
        'run-missing',
        'billing-agent',
        now,
      ),
    ).toBeUndefined();

    expect(
      recoveredRequestContextFromMetadata(
        {
          lastRequestAuthority: {
            principalId: 'api-key:legacy',
            tenantId: 'tenant-1',
            ownerId: 'owner-1',
            capabilities: ['tools:execute'],
            authorizationRevision: 'gateway:api-key:legacy',
          },
        },
        'legacy-run',
        'billing-agent',
        now,
      ),
    ).toEqual({
      authority: {
        principalId: 'api-key:legacy',
        tenantId: 'tenant-1',
        ownerId: 'owner-1',
        capabilities: ['tools:execute'],
        authorizationRevision: 'gateway:api-key:legacy',
      },
      audience: 'operator',
      agentId: 'billing-agent',
      runId: 'legacy-run',
    });
    expect(
      recoveredRequestContextFromMetadata(
        {
          lastRequestAuthorities: {
            'run-malformed': {
              principalId: 'principal-1',
              tenantId: 'tenant-1',
              ownerId: 'owner-1',
              capabilities: [42],
              authorizationRevision: 'authorization-7',
            },
          },
        },
        'run-malformed',
        'billing-agent',
        now,
      ),
    ).toBeUndefined();

    const futureDeadline = fixedNow + 60_000;
    expect(
      recoveredRequestContextFromMetadata(
        {
          lastRequestAuthorities: {
            'run-deadline': {
              principalId: 'principal-1',
              tenantId: 'tenant-1',
              ownerId: 'owner-1',
              capabilities: ['tools:execute'],
              authorizationRevision: 'authorization-7',
              deadline: futureDeadline,
            },
          },
        },
        'run-deadline',
        'billing-agent',
        now,
      )?.deadline,
    ).toBe(futureDeadline);
    expect(
      recoveredRequestContextFromMetadata(
        {
          lastRequestAuthorities: {
            'run-expired': {
              principalId: 'principal-1',
              tenantId: 'tenant-1',
              ownerId: 'owner-1',
              capabilities: ['tools:execute'],
              authorizationRevision: 'authorization-7',
              deadline: fixedNow - 1,
            },
          },
        },
        'run-expired',
        'billing-agent',
        now,
      ),
    ).toBeUndefined();
  });

  it('does not defer recovery for terminal sessions with transport authority', () => {
    const authority = {
      principalId: 'api-key:terminal',
      tenantId: 'tenant-1',
      ownerId: 'owner-1',
      capabilities: ['tools:execute'],
      authorizationRevision: 'gateway:api-key:terminal',
    };

    expect(
      hasRecoverableTransportAuthority({
        lastRunStatus: 'completed',
        lastRunId: 'run-terminal',
        lastRequestAuthority: authority,
      }),
    ).toBe(false);
    expect(
      hasRecoverableTransportAuthority({
        lastRunStatus: 'running',
        lastRunId: 'run-active',
        lastRequestAuthorities: { 'run-active': authority },
      }),
    ).toBe(true);
    expect(
      hasRecoverableTransportAuthority({
        lastRunStatus: 'running',
        lastRunId: 'run-active',
        lastRequestAuthorities: {
          'run-stale': authority,
        },
      }),
    ).toBe(false);
  });

  it('classifies only terminal approval binding failures as safe to suppress', () => {
    expect(
      isTerminalApprovalBindingError(
        new ApprovalBindingError('Approval binding was revoked.', 'revoked'),
      ),
    ).toBe(true);
    expect(
      isTerminalApprovalBindingError(
        new ApprovalBindingError('Approval binding does not match.', 'mismatch'),
      ),
    ).toBe(false);
    expect(isTerminalApprovalBindingError(undefined)).toBe(false);
    expect(emptyRecoveredStepMetadata()).toEqual({});
    expect(
      omitKeysWithPrefix(
        { 'approval:run-a:call-a': 'remove', 'approval:run-b:call-b': 'keep' },
        'approval:run-a:',
      ),
    ).toEqual({ 'approval:run-b:call-b': 'keep' });
  });

  it('is not ready when no generate function is configured', async () => {
    const bureau = await createBureau({
      agents: {},
    });
    expect(bureau.ready).toBe(false);
  });

  it('is ready when a generate function is configured', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
    });
    expect(bureau.ready).toBe(true);
  });

  it('rejects the factory (not just createRuntimeComposition) on an initialization failure', async () => {
    // AB-22: "initialization ... failures reject the factory." createBureau
    // awaits createRuntimeComposition(options) with no surrounding try/catch
    // (unlike durable-run RECOVERY below, which is deliberately caught and
    // diagnosed so a single corrupted workflow can't block boot) — a
    // synchronous validation throw inside composition must propagate as a
    // rejection of createBureau's own returned promise, not just of
    // createRuntimeComposition called directly.
    expect(
      createBureau({
        agents: {},
        generate: createMockGenerate(),
        durableExecution: true,
        persistence: textValueStore(new MemoryStorage()),
      }),
    ).rejects.toThrow(/durableExecution: true is incompatible/);
  });

  it('uses a provided store when one is supplied', async () => {
    const store = createStore();
    const bureau = await createBureau({
      agents: {},
      store,
    });
    expect(bureau.store).toBe(store);
  });

  it('exposes the event facade through the public bureau surface', async () => {
    const bureau = await createBureau({
      agents: {},
    });
    const listener = () => {};

    bureau.addEventListener('bureau.disposed', listener);
    bureau.removeEventListener('bureau.disposed', listener);
    bureau.on('bureau.disposed');
    bureau.once('bureau.disposed', listener);
    const subscription = bureau.subscribe('bureau.disposed', listener);
    const observableSubscription = bureau.toObservable().subscribe(listener);
    const iterator = bureau.events('bureau.disposed');

    subscription.unsubscribe();
    observableSubscription.unsubscribe();
    await iterator.return?.();
    bureau.complete();

    expect(bureau.completed).toBe(true);
    expect(bureau.signal.aborted).toBe(true);
  });

  it('throws NOT_CONFIGURED when createRun is called without a generate function', async () => {
    const bureau = await createBureau({
      agents: {},
    });

    const error = await bureau.createRun({ message: 'Hello' }).then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  it('throws BAD_REQUEST when createRun is called with an empty message', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
    });

    const error = await bureau.createRun({ message: '' }).then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('throws BAD_REQUEST when createRun is called with a blank session identifier', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
    });

    const error = await bureau.createRun({ message: 'Hello', sessionId: '   ' }).then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('creates runs with a session identifier and registers them in the store', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const summary = await bureau.createRun({ message: 'Hello' });

    expect(summary.id).toBeString();
    expect(summary.sessionId).toBeString();
    expect(summary.status).toBe('running');
    expect(bureau.store.getRun(summary.id)).toBeDefined();
  });

  it('AB-88/AB-214: getRun(id).liveness is a JSON-safe plain-data snapshot', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const summary = await bureau.createRun({ message: 'Hello' });
    const detail = bureau.getRun(summary.id);

    expect(detail?.liveness).toBeDefined();
    expect(detail?.liveness.kind).toBe('agent-run');
    expect(detail?.liveness.id).toBe(summary.id);
    // Round-trips through JSON — proves toJsonSafe ran over it.
    expect(() => JSON.stringify(detail)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(detail));
    expect(parsed.liveness.id).toBe(summary.id);
  });

  it('AB-88/AB-214 review (PRRT_kwDORvupsc6esZTF): getRun(id).liveness.owner carries the authenticated principal that started the run', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const summary = await bureau.createRun({ message: 'Hello', principal: 'user-42' });
    const detail = bureau.getRun(summary.id);

    expect(detail?.liveness.owner).toBe('user-42');
  });

  it('AB-88/AB-214: getRun(id).liveness.owner is absent when the run has no authenticated principal', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const summary = await bureau.createRun({ message: 'Hello' });
    const detail = bureau.getRun(summary.id);

    expect(detail?.liveness.owner).toBeUndefined();
  });

  it('AB-88/AB-214: subscribeRunSnapshot delivers the current snapshot synchronously, then live updates', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const summary = await bureau.createRun({ message: 'Hello' });

    const received: string[] = [];
    const subscription = bureau.subscribeRunSnapshot(summary.id, (snapshot) => {
      received.push(snapshot.status);
    });

    expect(received.length).toBeGreaterThan(0);
    subscription.unsubscribe();
  });

  it('AB-88/AB-214: subscribeRunSnapshot throws NOT_FOUND for an unknown run id', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    expect(() => bureau.subscribeRunSnapshot('does-not-exist', () => {})).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });

  it('stamps tool.started events with agentName and runId when agentName is supplied (regression PRRT_kwDORvupsc6MV8Xf)', async () => {
    // REGRESSION: createRunFromRequest omitted `agentName` and `runId` from
    // the RunOptions passed to createActiveRun, so curated tool.* bubble events
    // were stamped with empty metadata ({agentName:'', runId:'', step:0}) even
    // when the caller supplied a named dispatch route. The fix threads
    // request.agentName and the run's own runId into RunOptions.
    const capturedStamps: Array<{ agentName: string; runId: string }> = [];

    // A generate function that calls the `next` tool on step 0 so a tool.started
    // event fires, then completes on step 1. The toolbox must be a real createToolbox
    // (not empty) so toolbox addEventListener is wired and the event bubbles.
    const bureau = await createBureau({
      agents: {},
      generate: async ({ step }) =>
        step === 0
          ? { content: 'calling', toolCalls: [{ name: 'next', arguments: {} }] }
          : { content: 'done', toolCalls: [] },
      toolbox: createToolbox([createNextTool()]),
      stopWhen: stopWhen.noToolCalls(),
    });

    const summary = await bureau.createRun({
      message: 'Stamp test',
      agentName: 'audit-agent',
    });

    // Capture tool.started events via the ActiveRun's event surface.
    const runState = bureau.store.getRun(summary.id);
    runState?.activeRun.addEventListener('tool.started', (event) => {
      capturedStamps.push({
        agentName: event.agentName,
        runId: event.runId,
      });
    });

    await waitForRunCompletion(bureau, summary.id);

    // At least one tool.started event must have fired (step 0 called `next`).
    expect(capturedStamps.length).toBeGreaterThan(0);
    // Every stamped event must carry the caller's agentName and the run's own id.
    for (const stamp of capturedStamps) {
      expect(stamp.agentName).toBe('audit-agent');
      expect(stamp.runId).toBe(summary.id);
    }
  });

  it('stamps tool.started events with the default bureau agent when agentName is omitted (regression PRRT_kwDORvupsc6MY2xf)', async () => {
    // REGRESSION: a request WITHOUT agentName passed `agentName: request.agentName`
    // (undefined → empty string in createActiveRun) into the run, while the session
    // is stamped with the default 'bureau'. So tool.* events + durable input carried
    // a blank agent while the session said 'bureau' — mismatched attribution. The
    // fix falls back to BUREAU_AGENT_NAME ('bureau') when the request omits agentName.
    const capturedStamps: Array<{ agentName: string; runId: string }> = [];

    const bureau = await createBureau({
      agents: {},
      generate: async ({ step }) =>
        step === 0
          ? { content: 'calling', toolCalls: [{ name: 'next', arguments: {} }] }
          : { content: 'done', toolCalls: [] },
      toolbox: createToolbox([createNextTool()]),
      stopWhen: stopWhen.noToolCalls(),
    });

    // No agentName on the request — the common interactive path.
    const summary = await bureau.createRun({ message: 'Stamp test, no agent' });

    const runState = bureau.store.getRun(summary.id);
    runState?.activeRun.addEventListener('tool.started', (event) => {
      capturedStamps.push({ agentName: event.agentName, runId: event.runId });
    });

    await waitForRunCompletion(bureau, summary.id);

    expect(capturedStamps.length).toBeGreaterThan(0);
    // Must stamp 'bureau' (the session default), NOT an empty string.
    for (const stamp of capturedStamps) {
      expect(stamp.agentName).toBe('bureau');
      expect(stamp.runId).toBe(summary.id);
    }
  });

  it('stamps the session record with the dispatched agentName, not always bureau (regression PRRT_kwDORvupsc6MbUsN)', async () => {
    // Regression: createRunFromRequest stamped the run with request.agentName but
    // saveSession always created/kept the session as agentName:'bureau', so session
    // APIs/persistence never reflected the dispatched agent. Now the session is
    // stamped with (or promoted to) the named agent.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
      stopWhen: stopWhen.noToolCalls(),
    });

    const run = await bureau.createRun({ message: 'Named dispatch', agentName: 'researcher' });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.agentName).toBe('researcher');
  });

  it('stamps the session with the default bureau agent when no agentName is dispatched', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });

    const run = await bureau.createRun({ message: 'Unnamed dispatch' });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.agentName).toBe('bureau');
  });

  it('persists and resumes sessions through the session store', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });

    const firstRun = await bureau.createRun({ message: 'First message' });
    await waitForRunCompletion(bureau, firstRun.id);

    const secondRun = await bureau.createRun({
      message: 'Second message',
      sessionId: firstRun.sessionId,
    });
    await waitForRunCompletion(bureau, secondRun.id);

    expect(secondRun.sessionId).toBe(firstRun.sessionId);

    const session = await bureau.getSession(firstRun.sessionId);
    expect(session).toBeDefined();
    expect(session?.conversationHistory.ids.length).toBeGreaterThanOrEqual(4);
  });

  it('preserves both turns from concurrent createRun writers on one session', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });
    const sessionId = 'concurrent-bureau-session';

    const [firstRun, secondRun] = await Promise.all([
      bureau.createRun({ message: 'First concurrent bureau message', sessionId }),
      bureau.createRun({ message: 'Second concurrent bureau message', sessionId }),
    ]);
    await Promise.all([
      waitForRunCompletion(bureau, firstRun.id),
      waitForRunCompletion(bureau, secondRun.id),
    ]);

    const session = await bureau.getSession(sessionId);
    expect(session).toBeDefined();
    const contents = session!.conversationHistory.ids.map(
      (id) => session!.conversationHistory.messages[id]!.content,
    );
    expect(contents).toContain('First concurrent bureau message');
    expect(contents).toContain('Second concurrent bureau message');
  });

  it('preserves conversation edits from one concurrent createRun without dropping another turn', async () => {
    const persistence = textValueStore(new MemoryStorage());
    const sessionStore = createSessionStore(persistence);
    const sessionId = 'concurrent-bureau-redaction-session';
    const baseConversation = new Conversation();
    baseConversation.appendUserMessage('sensitive bureau original');
    await sessionStore.save({
      id: sessionId,
      agentName: 'bureau',
      conversationHistory: baseConversation.current,
      runs: [],
      metadata: {},
      revision: 0,
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z',
    });

    const bureau = await createBureau({
      agents: {},
      generate: async (context) => {
        if (
          context.conversation
            .getMessages()
            .some((message) => message.content === 'Redact concurrent bureau message')
        ) {
          context.conversation.redactMessageAtPosition(0, 'redacted bureau original');
        }
        return { content: 'Done.', toolCalls: [] };
      },
      toolbox: createEmptyToolbox(),
      persistence,
    });

    const [redactingRun, appendingRun] = await Promise.all([
      bureau.createRun({ message: 'Redact concurrent bureau message', sessionId }),
      bureau.createRun({ message: 'Append concurrent bureau message', sessionId }),
    ]);
    await Promise.all([
      waitForRunCompletion(bureau, redactingRun.id),
      waitForRunCompletion(bureau, appendingRun.id),
    ]);

    const session = await bureau.getSession(sessionId);
    expect(session).toBeDefined();
    const contents = session!.conversationHistory.ids.map(
      (id) => session!.conversationHistory.messages[id]!.content,
    );
    expect(contents).toContain('redacted bureau original');
    expect(contents).not.toContain('sensitive bureau original');
    expect(contents).toContain('Append concurrent bureau message');
  });

  it('aligns a new session history identifier with the requested session identifier', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });
    const sessionId = 'session-aligned';

    const run = await bureau.createRun({
      message: 'First message',
      sessionId,
    });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(sessionId);
    expect(session?.id).toBe(sessionId);
    expect(session?.conversationHistory.id).toBe(sessionId);
  });

  it('persists completed session metadata for fast runs', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
      stopWhen: stopWhen.noToolCalls(),
    });

    const run = await bureau.createRun({ message: 'Fast completion' });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastRunId']).toBe(run.id);
    expect(session?.metadata['lastRunStatus']).toBe('completed');
  });

  // Regression: PRRT_kwDORvupsc6MZEri — createRunFromRequest did not persist
  // maximumTokens to session metadata, so recovery (buildRunDepsFromSession) could
  // not restore it and recovered generate calls silently received undefined.
  it('persists maximumTokens as lastMaximumTokens in session metadata when a run is created with a token cap', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });

    const run = await bureau.createRun({ message: 'Capped run', maximumTokens: 128 });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastMaximumTokens']).toBe(128);
  });

  it('writes null for lastMaximumTokens in session metadata when maximumTokens is absent (clears any stale cap)', async () => {
    // The field is always written — null when absent — so a reused session never
    // inherits a previous run's cap (PRRT_kwDORvupsc6MZ1Mb).
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });

    const run = await bureau.createRun({ message: 'Uncapped run' });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastMaximumTokens']).toBeNull();
  });

  it('persists maximumSteps as lastMaximumSteps in session metadata when a run is created with a step cap (regression PRRT_kwDORvupsc6MZfl5)', async () => {
    // REGRESSION: the per-request maximumSteps cap was not persisted to session
    // metadata, so a recovered run fell back to the bureau default and could
    // exceed the caller's step limit. saveSession now writes lastMaximumSteps,
    // and buildRunDepsFromSession reads it back during recovery (mirroring the
    // lastMaximumTokens recovery fix).
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });

    const run = await bureau.createRun({ message: 'Capped run', maximumSteps: 3 });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastMaximumSteps']).toBe(3);
  });

  it('writes null for lastMaximumSteps in session metadata when maximumSteps is absent (clears any stale cap)', async () => {
    // The field is always written — null when absent — so a reused session never
    // inherits a previous run's step cap (PRRT_kwDORvupsc6MZ1Mb).
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });

    const run = await bureau.createRun({ message: 'Uncapped run' });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastMaximumSteps']).toBeNull();
  });

  // Regression: PRRT_kwDORvupsc6MZ1Mb — a reused session was inheriting stale
  // lastMaximumTokens / lastMaximumSteps from a previous run when the new run
  // omitted those caps. The saveSession merge used conditional spreads that
  // contributed nothing when the field was absent, leaving the old numeric value
  // in place. buildRunDepsFromSession then read it back during recovery and applied
  // the previous run's limit to the new run.
  it('clears stale cap metadata when a follow-up run omits maximumTokens (regression PRRT_kwDORvupsc6MZ1Mb)', async () => {
    const persistence = textValueStore(new MemoryStorage());
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence,
    });

    // Run 1: explicitly capped
    const run1 = await bureau.createRun({ message: 'Capped run', maximumTokens: 512 });
    await waitForRunCompletion(bureau, run1.id);

    const sessionAfterRun1 = await bureau.getSession(run1.sessionId);
    expect(sessionAfterRun1?.metadata['lastMaximumTokens']).toBe(512);

    // Run 2: on the same session, no cap — previous cap must NOT be inherited
    const run2 = await bureau.createRun({
      message: 'Follow-up, no cap',
      sessionId: run1.sessionId,
    });
    await waitForRunCompletion(bureau, run2.id);

    const sessionAfterRun2 = await bureau.getSession(run1.sessionId);
    // Must be null (explicitly cleared), not 512
    expect(sessionAfterRun2?.metadata['lastMaximumTokens']).toBeNull();
  });

  it('clears stale step cap metadata when a follow-up run omits maximumSteps (regression PRRT_kwDORvupsc6MZ1Mb)', async () => {
    const persistence = textValueStore(new MemoryStorage());
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence,
    });

    // Run 1: explicitly capped at 3 steps
    const run1 = await bureau.createRun({ message: 'Capped run', maximumSteps: 3 });
    await waitForRunCompletion(bureau, run1.id);

    const sessionAfterRun1 = await bureau.getSession(run1.sessionId);
    expect(sessionAfterRun1?.metadata['lastMaximumSteps']).toBe(3);

    // Run 2: on the same session, no step cap — previous cap must NOT be inherited
    const run2 = await bureau.createRun({
      message: 'Follow-up, no cap',
      sessionId: run1.sessionId,
    });
    await waitForRunCompletion(bureau, run2.id);

    const sessionAfterRun2 = await bureau.getSession(run1.sessionId);
    // Must be null (explicitly cleared), not 3
    expect(sessionAfterRun2?.metadata['lastMaximumSteps']).toBeNull();
  });

  // Regression: PRRT_kwDORvupsc6Mddv3 — a reused session was carrying its PREVIOUS
  // run's lastActiveSkills snapshot into the start of a new run. The snapshot is
  // otherwise written only after the new run's first onStep boundary, so a crash
  // before that first snapshot let durable recovery seed the new run's
  // SkillSession with stale skills (load_skill_resource/list_skills treating
  // skills as active that a fresh run would not have). The start-of-run
  // saveSession now writes lastActiveSkills: null to clear it.
  it('clears stale lastActiveSkills at the start of a follow-up run on a reused session (regression PRRT_kwDORvupsc6Mddv3)', async () => {
    const persistence = textValueStore(new MemoryStorage());

    // Run 1 succeeds (to create the session); run 2 FAILS before completing a
    // step. This is the exact window the fix protects: the start-of-run
    // saveSession null-write lands (it runs before createActiveRun), then the run
    // crashes before the first onStep boundary — so createSkillStateSnapshotHook
    // never fires to overwrite the null. A successful run 2 would instead
    // overwrite the null with the snapshot hook's empty-set value, and the
    // assertion would pass identically with the fix reverted (testing the hook,
    // not the start-of-run reset).
    let call = 0;
    const failOnSecondRun: GenerateFunction = async () => {
      call += 1;
      if (call === 1) return { content: 'Done.', toolCalls: [] };
      throw new Error('provider crashed before first step');
    };

    const bureau = await createBureau({
      agents: {},
      generate: failOnSecondRun,
      toolbox: createEmptyToolbox(),
      persistence,
    });

    // Run 1: creates the session.
    const run1 = await bureau.createRun({ message: 'First run' });
    await waitForRunCompletion(bureau, run1.id);

    // Simulate a prior run having recorded an active-skill snapshot: write a
    // stale lastActiveSkills array directly to the session metadata (the same
    // shape createSkillStateSnapshotHook writes).
    const seedStore = createSessionStore(persistence);
    await seedStore.updateMetadata(run1.sessionId, {
      lastActiveSkills: [{ name: 'researcher-skill' }],
    });
    const seeded = await bureau.getSession(run1.sessionId);
    expect(seeded?.metadata['lastActiveSkills']).toEqual([{ name: 'researcher-skill' }]);

    // Run 2: on the SAME session, fails before its first onStep snapshot. The
    // start-of-run metadata write must have already reset lastActiveSkills so a
    // crash-before-first-snapshot recovery starts with NO active skills, exactly
    // as a fresh run would.
    const run2 = await bureau.createRun({ message: 'Follow-up run', sessionId: run1.sessionId });
    await waitForRunCompletion(bureau, run2.id);

    const sessionAfterRun2 = await bureau.getSession(run1.sessionId);
    // Must be null (explicitly cleared at start-of-run), not the stale
    // ['researcher-skill'] and not overwritten by a snapshot hook that never ran.
    expect(sessionAfterRun2?.metadata['lastActiveSkills']).toBeNull();
  });

  it('retries terminal session persistence after a transient save failure', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    let sessionSaveCount = 0;

    const flakyStore = createTextStoreProxy(backingStore, {
      async conditionalBatch(conditions, operations) {
        if (
          conditions.some((condition) => condition.key.startsWith('agent-session:')) ||
          operations.some((operation) => operation.key.startsWith('agent-session:'))
        ) {
          sessionSaveCount += 1;
          if (sessionSaveCount === 2) {
            throw new Error('temporary persistence failure');
          }
        }

        return backingStore.conditionalBatch(conditions, operations);
      },
    });

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: flakyStore,
      sessionPersistenceSleep: async () => {},
      stopWhen: stopWhen.noToolCalls(),
    });

    const run = await bureau.createRun({ message: 'Retry completion' });
    await waitForRunCompletion(bureau, run.id);
    await waitForCondition(async () => {
      const session = await bureau.getSession(run.sessionId);
      return session?.metadata['lastRunStatus'] === 'completed';
    }, 'completed session metadata was not persisted after retry');

    const session = await bureau.getSession(run.sessionId);
    expect(sessionSaveCount).toBe(3);
    expect(session?.metadata['lastRunId']).toBe(run.id);
    expect(session?.metadata['lastRunStatus']).toBe('completed');
  });

  it('recovers an in-flight durable run across a process restart, rebuilding deps from config', async () => {
    // THE CROSS-PROCESS PROOF (5d/5e): two bureaus share one persistent SQLite
    // backend the way two processes would. Bureau A crashes mid-run; bureau B
    // boots on the same file, reconstructs the run's behavior from its own config
    // + the persisted session (NOTHING hand-injected), and resumes to completion.
    const databasePath = join(
      tmpdir(),
      `bureau-recovery-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      // === Bureau A: step 0 commits a tool call, then step 1's generate HANGS.
      // Disposing while suspended simulates a process dying mid-run: the Weft
      // workflow is left in a non-terminal state for recoverAll to pick up. ===
      //
      // DETERMINISTIC crash anchor: the durable workflow runs step 0's whole
      // memo (generate + tool), then `yield* saveConversation/recordStep/
      // saveCursor`, THEN loops into step 1's memo. The `yield*` on saveCursor
      // cannot resolve until that checkpoint is durably written — so entering
      // `generate({ step: 1 })` PROVES step 0 is fully checkpointed. We crash
      // exactly there, with no timing guess. (The earlier toolbox-action anchor
      // raced: that event fires INSIDE step 0's memo, before any checkpoint yield.)
      let bureauAReachedStep1 = false;
      const bureauA = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true; // step 0's saveCursor has committed
          // Hang forever — the "process" dies here.
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const run = await bureauA.createRun({ message: 'Recover me' });
      // Crash once step 1's generate is entered — i.e. step 0 is durably
      // checkpointed (see the anchor rationale above).
      await pollUntil(() => bureauAReachedStep1);
      expect(bureauAReachedStep1).toBe(true);
      // AB-207: deliberately NOT disposing bureauA here. `dispose()`
      // now fully awaits `activeRun.abort()`'s durable-engine `cancel()`
      // handoff before returning, which genuinely completes the
      // in-flight workflow's cancellation and removes it from a fresh
      // engine's `recoverAll()` candidate set — a properly graceful
      // shutdown correctly leaves nothing to recover. Simulating a real
      // crash (the durable workflow still owned by a dead worker, which
      // IS recoverable) means leaving bureauA un-disposed here: it stays
      // parked at step 1's hung `generate()` call until disposed at the
      // end of this test, well after bureauB's recovery.

      // === FRESH PROCESS: bureau B is a wholly separate bureau over the same
      // SQLite file, with its own engine and its own `resolveWorkflowServices`
      // resolver. There is no shared in-process state — disposing bureau A tore
      // down its engine (and the per-run `services` it held), so the recovered
      // run can ONLY advance on deps bureau B's resolver rebuilds from config +
      // the persisted session. ===

      // === Bureau B: same SQLite file, a generate that settles. On boot it
      // reconstructs deps from config + the persisted session and resumes. ===
      const bSteps: number[] = [];
      const bureauB = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          bSteps.push(step);
          return { content: `B recovered step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        // Recovery ran during boot, but the detached monitor drives the resumed
        // run to completion AFTER createBureau returns (non-blocking boot). Poll
        // (bounded) until the resumed run has taken step 1 — each poll drains the
        // deferred Weft launch, so this is deterministic, not a fixed sleep.
        await pollUntil(() => bSteps.includes(1));

        // The run resumed at step 1 (not 0) and took ONLY step 1 — proving
        // config-reconstructed deps short-circuited the completed step 0, not a
        // restart from the top.
        expect(bSteps).toEqual([1]);

        // #3/#5b LIVE VISIBILITY: the recovered run is reattached as a live
        // ActiveRun and `store.register`d, so it rejoins `getRun(...)` — it is no
        // longer invisible to the live surface the way a pre-#5b recovered run was.
        // (Registration is synchronous in `recoverDurableRuns`, so the run is
        // visible from the moment boot returned, even while it was still resuming.)
        const recoveredDetail = bureauB.getRun(run.id);
        expect(recoveredDetail).toBeDefined();
        expect(recoveredDetail?.id).toBe(run.id);

        // AB-12 run-inspector: reattachment itself never fires as an
        // observable run event (it happens before `store.register`'s
        // subscription exists to see it) — `reattachRecoveredRun` stamps a
        // synthetic `workflow.reattached` marker via `store.recordAction` so
        // the timeline shows the recovery boundary. Assert it landed with no
        // version mismatch (both bureaus use the default workflow version).
        const reattachEvent = recoveredDetail?.events.find(
          (event) => event.event === 'workflow.reattached',
        );
        expect(reattachEvent).toBeDefined();
        expect(reattachEvent?.detail).toMatchObject({ versionMismatch: false });
        // It is stamped immediately on reattach, ordered before the resumed
        // run's own step events by sequence number.
        const laterEvent = recoveredDetail?.events.find((event) => event.event === 'step.started');
        if (laterEvent) {
          expect(reattachEvent!.sequence).toBeLessThan(laterEvent.sequence);
        }

        // The session is no longer stuck `running`: the detached monitor persisted
        // its terminal status. Poll (re-reading the store each iteration) until
        // that write lands — it happens after the resumed run completes, off the
        // boot path.
        await pollUntil(async () => {
          const current = await bureauB.getSession(run.sessionId);
          return current?.metadata['lastRunStatus'] !== 'running';
        });
        const session = await bureauB.getSession(run.sessionId);
        expect(session?.metadata['lastRunStatus']).toBe('completed');
        // The session conversation must include step 1's content — written by the
        // durable checkpoint on the resumed process, NOT the stale pre-crash history
        // that was in the session store. If settleRecoveredRun fell back to the
        // session store, 'B recovered step 1' would be absent.
        const messages = session?.conversationHistory
          ? getMessages(session.conversationHistory)
          : [];
        const hasBStep1 = messages.some(
          (m) => typeof m.content === 'string' && m.content.includes('B recovered step 1'),
        );
        expect(hasBStep1).toBe(true);
      } finally {
        bureauB.dispose();
      }
      // AB-207: release bureauA's engine now that bureauB's
      // recovery-dependent assertions are done (its scheduler would
      // otherwise keep polling storage after this test deletes the sqlite
      // file below).
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it("reattaches a catalog-dispatched bureau.run() across a process restart, rebuilding deps from the catalog agent's OWN OPERATIVE_RESOLVE_RUN_OPTIONS (AB-240)", async () => {
    // Same cross-process proof as the interactive-run recovery test above,
    // but through `bureau.run(name, input)` — a catalog dispatch, which has
    // no bureau session at all. Bureau A's `echo` agent and bureau B's
    // `echo` agent are TWO SEPARATE `createAgent(...)` instances with
    // DIFFERENT `generate` functions — bureau B's own generate (not bureau
    // A's, not any bureau-level default — there IS no bureau-level generate
    // configured here at all) is what must produce step 1's content, proving
    // reattachment rebuilt deps from the CATALOG AGENT's own resolved run
    // options, never a Bureau default runtime composition (this feature's
    // rollback trigger).
    const databasePath = join(
      tmpdir(),
      `bureau-catalog-recovery-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      let bureauAReachedStep1 = false;
      const bureauA = await createBureau({
        agents: {
          echo: createAgent({
            generate: async ({ step }) => {
              if (step === 0) {
                return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
              }
              bureauAReachedStep1 = true; // step 0's saveCursor has committed
              return new Promise<never>(() => {}); // the "process" dies here
            },
            toolbox: createToolbox([createNextTool()]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        // No bureau-level generate/toolbox/provider at all — `bureau.run()`
        // dispatches entirely through the catalog agent's own composition.
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      bureauA.run('echo', 'Recover me');
      await pollUntil(() => bureauAReachedStep1);
      expect(bureauAReachedStep1).toBe(true);
      // `AgentRun.snapshot().id` is the CATALOG NAME ('echo'), not the
      // minted workflow id — read the real durable workflow id back off the
      // engine's own listing, the same way `bureau.run()`'s own
      // "checkpointed and discoverable" test does.
      const beforeRestart = await bureauA.listDurableRuns();
      const runId = beforeRestart?.items.find((item) => item.id.startsWith('agent-run-'))?.id;
      expect(runId).toBeDefined();
      // Deliberately NOT disposing bureauA — see the interactive recovery
      // test's comment above for the graceful-shutdown-vs-crash rationale;
      // it applies identically here.

      const bSteps: number[] = [];
      const bureauB = await createBureau({
        agents: {
          echo: createAgent({
            generate: async ({ step }) => {
              bSteps.push(step);
              return { content: `B recovered step ${step}`, toolCalls: [] };
            },
            toolbox: createToolbox([createNextTool()]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        await pollUntil(() => bSteps.includes(1));
        // Resumed at step 1 (not 0) and took ONLY step 1 — the checkpointed
        // step 0 short-circuited, proving this is a resume, not a restart
        // from the top.
        expect(bSteps).toEqual([1]);

        const completed = await pollUntil(async () => {
          const after = await bureauB.listDurableRuns();
          return after?.items.find((item) => item.id === runId)?.status === 'completed';
        });
        expect(completed).toBe(true);
      } finally {
        await bureauB.dispose();
      }
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it("fails the workflow observably (never silently unavailable) when a catalog-dispatched run's agent is no longer in the catalog on restart (AB-240 / AB-29 precedent)", async () => {
    // Weft's own contract for `{ status: 'unavailable' }` (services-resolution.ts):
    // "a deliberate, named outcome ... that fails just that recovered run" — so
    // a missing catalog agent must surface as an observable terminal `'failed'`
    // workflow, discoverable via `listDurableRuns()` (the same surface every
    // other durable-run assertion in this suite uses), never a run that just
    // silently stops advancing with no visible outcome.
    const databasePath = join(
      tmpdir(),
      `bureau-catalog-recovery-missing-agent-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      let bureauAReachedStep1 = false;
      const bureauA = await createBureau({
        agents: {
          echo: createAgent({
            generate: async ({ step }) => {
              if (step === 0) {
                return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
              }
              bureauAReachedStep1 = true;
              return new Promise<never>(() => {});
            },
            toolbox: createToolbox([createNextTool()]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      bureauA.run('echo', 'Recover me');
      await pollUntil(() => bureauAReachedStep1);
      expect(bureauAReachedStep1).toBe(true);
      // `AgentRun.snapshot().id` is the CATALOG NAME ('echo'), not the
      // minted workflow id — read the real durable workflow id back off the
      // engine's own listing, the same way `bureau.run()`'s own
      // "checkpointed and discoverable" test does.
      const beforeRestart = await bureauA.listDurableRuns();
      const runId = beforeRestart?.items.find((item) => item.id.startsWith('agent-run-'))?.id;
      expect(runId).toBeDefined();

      // Bureau B's catalog has NO "echo" agent at all — simulates a
      // deployment where the agent was retired between restarts.
      const bureauB = await createBureau({
        agents: {},
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        const failed = await pollUntil(async () => {
          const after = await bureauB.listDurableRuns();
          return after?.items.find((item) => item.id === runId)?.status === 'failed';
        });
        expect(failed).toBe(true);
      } finally {
        await bureauB.dispose();
      }
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('fails the workflow observably with a distinct reason when the catalog agent exists on restart but no longer supports durable definition resolution (AB-240 review finding)', async () => {
    // Distinct from the "no longer in the catalog" case above: here the name
    // IS still present, but between restarts it was reconfigured to a
    // hand-written `RunnableAgent` that never exposed
    // `OPERATIVE_RESOLVE_RUN_OPTIONS` — proving `createBureau`'s registered
    // catalog resolver returns `'not-durable-capable'`, not the misleading
    // `'missing-agent'`, for this distinct failure mode.
    const databasePath = join(
      tmpdir(),
      `bureau-catalog-recovery-not-durable-capable-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      let bureauAReachedStep1 = false;
      const bureauA = await createBureau({
        agents: {
          echo: createAgent({
            generate: async ({ step }) => {
              if (step === 0) {
                return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
              }
              bureauAReachedStep1 = true;
              return new Promise<never>(() => {});
            },
            toolbox: createToolbox([createNextTool()]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      bureauA.run('echo', 'Recover me');
      await pollUntil(() => bureauAReachedStep1);
      expect(bureauAReachedStep1).toBe(true);

      const beforeRestart = await bureauA.listDurableRuns();
      const runId = beforeRestart?.items.find((item) => item.id.startsWith('agent-run-'))?.id;
      expect(runId).toBeDefined();

      // Bureau B's "echo" is a hand-written agent with no
      // OPERATIVE_RESOLVE_RUN_OPTIONS — same shape as the non-lazy
      // "falls back to direct execution" fixture in bureau-run.test.ts.
      const nonResolvingAgent: RunnableAgent<never, false> = {
        name: 'echo',
        hasOutput: false,
        run: (input, context) =>
          createAgent({ generate: async () => ({ content: 'plain', toolCalls: [] }) }).run(
            input,
            context,
          ),
      };
      const bureauB = await createBureau({
        agents: { echo: nonResolvingAgent },
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        const failed = await pollUntil(async () => {
          const after = await bureauB.listDurableRuns();
          return after?.items.find((item) => item.id === runId)?.status === 'failed';
        });
        expect(failed).toBe(true);
      } finally {
        await bureauB.dispose();
      }
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  // AB-291 (AC4): `runAgent`'s durable catalog-dispatch branch remembers a
  // cancellation requested BEFORE `dispatchedActiveRun` exists
  // (`cancellationRequested`) and forwards it once the durable `ActiveRun`
  // is created. But `createDeferredAgentRun`'s OWN `requestAbort` settles
  // its synthetic `result()` — and therefore its `closed()` — IMMEDIATELY
  // when abort arrives before its resolver has settled (the shared async
  // dispatch is deliberately left running in the background, uncancelled,
  // matching `createLazyAgent`'s module-load precedent). Left unfixed, the
  // returned handle's `closed()` would report `completed` before the
  // forwarded cancellation's own durable cleanup has even started.
  it("awaits the forwarded cancellation's own durable ActiveRun.closed() before reporting closed() completed, for an abort requested before the durable ActiveRun exists (AB-291 AC4)", async () => {
    const realAgent = createAgent({
      generate: async () => ({ content: 'unused', toolCalls: [] }),
      toolbox: createToolbox([]),
      stopWhen: stopWhen.noToolCalls(),
    });
    const realResolver = (realAgent as unknown as DefinitionResolvingAgent)[
      OPERATIVE_RESOLVE_RUN_OPTIONS
    ]!;

    // Gates `resolveDurableAgent`'s FIRST await — the point strictly BEFORE
    // it creates the durable `ActiveRun` and forwards the cancellation onto
    // it — so this test can deterministically observe `closed()` mid-flight
    // rather than racing real timing.
    let releaseResolver: (() => void) | undefined;
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    let resolverReached = false;
    const gatedAgent = {
      ...realAgent,
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: async (input: AgentInput, context?: AgentRunContext) => {
        resolverReached = true;
        await resolverGate;
        return realResolver(input, context);
      },
    };

    const bureau = await createBureau({
      agents: { echo: gatedAgent },
      storage: { type: 'memory' },
      durableExecution: true,
    });

    try {
      const handle = bureau.run('echo', 'hi');
      // Synchronously, in the same tick `run()` returned — before ANY of
      // `resolveDurableAgent`'s internal awaits have had a chance to run,
      // so `dispatchedActiveRun` is guaranteed still undefined here.
      handle.abort('early abort, before the durable run was dispatched');

      let settled = false;
      void handle.closed().then(() => {
        settled = true;
      });

      // Let the resolver's own gate actually get reached, proving the
      // deferred dispatch genuinely started (this test isn't just racing an
      // unstarted resolver).
      for (let tick = 0; tick < 10 && !resolverReached; tick++) {
        await Promise.resolve();
      }
      expect(resolverReached).toBe(true);

      // `dispatchedActiveRun` cannot exist yet — the resolver is still
      // parked on `resolverGate` — so the forward has not run, and
      // `closed()` must not have settled either.
      for (let tick = 0; tick < 25; tick++) {
        await Promise.resolve();
      }
      expect(settled).toBe(false);

      // Release the resolver: `resolveDurableAgent` now creates the durable
      // `ActiveRun`, forwards the cancellation onto it, and captures its
      // OWN `closed()` as the cancellation forward.
      releaseResolver?.();

      const acknowledgement = await handle.closed();
      expect(acknowledgement).toEqual({ status: 'completed' });
      expect(settled).toBe(true);

      // The forward genuinely reached a REAL durable `ActiveRun` — not a
      // synthetic one `closed()` merely delegated to eagerly — proven by
      // `resolveDurableAgent` actually constructing `dispatchedActiveRun`
      // and calling ITS OWN `closed()` as the cancellation forward (the
      // property this test's `settled`/`acknowledgement` assertions above
      // already establish). AB-339 changed what happens ONE LAYER DEEPER,
      // inside that real `ActiveRun`: since ITS OWN `abort()` also runs
      // before ITS OWN deferred microtask fires (synchronously, right
      // after `createActiveRun` returns, same as this test's own outer
      // abort), `drive()` skips `context.engine.start` too — so no durable
      // workflow record is ever written for a run that was already doomed
      // before dispatch. `bureau.listDurableRuns()` correctly stays empty
      // of it; asserting the OPPOSITE (as this test did pre-AB-339) would
      // reassert the exact false-leak-causing durable launch AB-339 fixed.
      const durableRuns = await bureau.listDurableRuns();
      expect(durableRuns?.items.some((item) => item.id.startsWith('agent-run-'))).toBe(false);
    } finally {
      await bureau.dispose();
    }
  });

  // AB-291 (AC4) — `options.signal` bounds ONE caller's own wait on the
  // guardedRun's `closed()` (mirroring `createClosedAcknowledgement`'s own
  // per-call `signal` contract): it never affects the shared
  // `closedSettlement` cache other callers (or a later signal-less call)
  // observe.
  it('bounds guardedRun.closed() by a caller-supplied signal without affecting the shared settlement (AB-291 AC4)', async () => {
    const bureau = await createBureau({
      agents: {
        echo: createAgent({
          generate: async () => ({ content: 'unused', toolCalls: [] }),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'memory' },
      durableExecution: true,
    });

    try {
      const handle = bureau.run('echo', 'hi');
      handle.abort('early abort, before the durable run was dispatched');

      // Already-aborted signal: resolves immediately, unresolved/timed-out,
      // without waiting on the shared settlement at all.
      const preAborted = new AbortController();
      preAborted.abort();
      expect(await handle.closed({ signal: preAborted.signal })).toEqual({
        status: 'unresolved',
        reason: 'timed-out',
      });

      // A live signal that fires BEFORE the shared settlement resolves —
      // bounds THIS caller's own wait only.
      const bounding = new AbortController();
      const boundedAcknowledgement = handle.closed({ signal: bounding.signal });
      bounding.abort();
      expect(await boundedAcknowledgement).toEqual({ status: 'unresolved', reason: 'timed-out' });

      // Let the real durable dispatch and its cancellation forward settle —
      // the shared settlement is unaffected by either bounded call above.
      const settled = await handle.closed();
      expect(settled).toEqual({ status: 'completed' });

      // A live signal that's never aborted, called AFTER the shared
      // settlement already resolved, still resolves to the same outcome.
      const nonAborting = new AbortController();
      expect(await handle.closed({ signal: nonAborting.signal })).toEqual({
        status: 'completed',
      });

      // Review finding: an ALREADY-aborted signal, passed AFTER the shared
      // settlement genuinely resolved, still returns the identical cached
      // acknowledgement — the post-settlement idempotency guarantee — not
      // a fresh unresolved/timed-out manufactured from a signal that
      // arrived too late to mean anything.
      const postSettlementAborted = new AbortController();
      postSettlementAborted.abort();
      expect(await handle.closed({ signal: postSettlementAborted.signal })).toEqual({
        status: 'completed',
      });
    } finally {
      await bureau.dispose();
    }
  });

  // AB-15 regression: a recovered run's runSeq generation must never overlap
  // the pre-restart generation, or a browser reconnecting with a pre-restart
  // cursor (e.g. `since: 25`) would have every post-restart frame filtered
  // out by `getFramesSince` as "already seen" — a silent frame loss.
  it('seeds a recovered run with a runSeq far above its pre-restart high-water mark (AB-15)', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-recovery-runseq-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      let bureauAReachedStep1 = false;
      const runSeqsFromA: number[] = [];
      const bureauA = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const unsubscribeA = bureauA.subscribeLiveFrames((frame) => {
        if ('runSeq' in frame) {
          runSeqsFromA.push(frame.runSeq);
        }
      });

      const run = await bureauA.createRun({ message: 'Recover me' });
      await pollUntil(() => bureauAReachedStep1);
      expect(bureauAReachedStep1).toBe(true);
      // Bureau A's own generation stays small (single-digit run-scoped
      // frames for a two-step run) — this is the pre-restart high-water mark
      // a reconnecting client's cursor would be based on.
      const preRestartMaxRunSeq = Math.max(...runSeqsFromA);
      expect(preRestartMaxRunSeq).toBeGreaterThan(0);
      expect(preRestartMaxRunSeq).toBeLessThan(1000);
      unsubscribeA();
      // AB-207: deliberately NOT disposing bureauA here. `dispose()`
      // now fully awaits `activeRun.abort()`'s durable-engine `cancel()`
      // handoff before returning, which genuinely completes the
      // in-flight workflow's cancellation and removes it from a fresh
      // engine's `recoverAll()` candidate set — a properly graceful
      // shutdown correctly leaves nothing to recover. Simulating a real
      // crash (the durable workflow still owned by a dead worker, which
      // IS recoverable) means leaving bureauA un-disposed here: it stays
      // parked at step 1's hung `generate()` call until disposed at the
      // end of this test, well after bureauB's recovery.

      const bSteps: number[] = [];
      const runSeqsFromB: number[] = [];
      const bureauB = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          bSteps.push(step);
          return { content: `B recovered step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const unsubscribeB = bureauB.subscribeLiveFrames((frame) => {
        if ('runSeq' in frame && frame.runId === run.id) {
          runSeqsFromB.push(frame.runSeq);
        }
      });

      try {
        await pollUntil(() => bSteps.includes(1));
        expect(runSeqsFromB.length).toBeGreaterThan(0);

        // Every post-restart runSeq must be strictly greater than the
        // pre-restart high-water mark — a stale `since: preRestartMaxRunSeq`
        // cursor from before the crash must not filter out ANY of these.
        for (const seq of runSeqsFromB) {
          expect(seq).toBeGreaterThan(preRestartMaxRunSeq);
        }
      } finally {
        unsubscribeB();
        bureauB.dispose();
      }
      // AB-207: release bureauA's engine now that bureauB's
      // recovery-dependent assertions are done (its scheduler would
      // otherwise keep polling storage after this test deletes the sqlite
      // file below).
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  // AB-10 — workflow versioning: end-to-end cross-process proof that
  // `BureauOptions.workflowVersion` threads through to both the stamp
  // (createRunWorkflow) and the recovery comparison (createRunEngine), and
  // that a mismatch is observed (warned + classified) WITHOUT blocking the
  // recovered run's completion.
  it('recovers an in-flight run across a workflowVersion change, warning but not blocking (AB-10)', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-version-mismatch-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      let bureauAReachedStep1 = false;
      const bureauA = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
        workflowVersion: 'v1',
      });

      const run = await bureauA.createRun({ message: 'Recover me under a new version' });
      await pollUntil(() => bureauAReachedStep1);
      expect(bureauAReachedStep1).toBe(true);
      // AB-207: deliberately NOT disposing bureauA here. `dispose()`
      // now fully awaits `activeRun.abort()`'s durable-engine `cancel()`
      // handoff before returning, which genuinely completes the
      // in-flight workflow's cancellation and removes it from a fresh
      // engine's `recoverAll()` candidate set — a properly graceful
      // shutdown correctly leaves nothing to recover. Simulating a real
      // crash (the durable workflow still owned by a dead worker, which
      // IS recoverable) means leaving bureauA un-disposed here: it stays
      // parked at step 1's hung `generate()` call until disposed at the
      // end of this test, well after bureauB's recovery.

      const warnSpy = spyOn(console, 'warn');
      const bSteps: number[] = [];
      const bureauB = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          bSteps.push(step);
          return { content: `B recovered step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
        // Different version than bureau A stamped — simulates a deploy that
        // shipped while this run was in flight.
        workflowVersion: 'v2',
      });

      try {
        // The mismatch is detected during boot recovery, before the resumed
        // run advances — assert it was warned about immediately, independent
        // of how long the run itself takes to complete.
        const mismatchWarnings = warnSpy.mock.calls.filter((call) =>
          String(call[0]).includes(run.id),
        );
        expect(mismatchWarnings.length).toBeGreaterThan(0);
        expect(String(mismatchWarnings[0]?.[0])).toContain('v1');
        expect(String(mismatchWarnings[0]?.[0])).toContain('v2');

        // AB-12 run-inspector: the mismatch detail (not just the boolean
        // `classifyRecoveredRun` needs) is stamped into the run's timeline as
        // a `workflow.reattached` marker, so the run-detail view can surface
        // "resumed under a different workflow version" without re-deriving
        // it from a console.warn string.
        const reattachEvent = bureauB
          .getRun(run.id)
          ?.events.find((event) => event.event === 'workflow.reattached');
        expect(reattachEvent?.detail).toMatchObject({
          versionMismatch: true,
          storedVersion: 'v1',
          registeredVersion: 'v2',
        });

        // The run still recovers and completes normally — the mismatch is a
        // pin-and-warn signal, not a block.
        await pollUntil(() => bSteps.includes(1));
        expect(bSteps).toEqual([1]);
        await pollUntil(async () => {
          const current = await bureauB.getSession(run.sessionId);
          return current?.metadata['lastRunStatus'] !== 'running';
        });
        const session = await bureauB.getSession(run.sessionId);
        expect(session?.metadata['lastRunStatus']).toBe('completed');
      } finally {
        warnSpy.mockRestore();
        bureauB.dispose();
      }
      // AB-207: release bureauA's engine now that bureauB's
      // recovery-dependent assertions are done (its scheduler would
      // otherwise keep polling storage after this test deletes the sqlite
      // file below).
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('cancels a recovered handle with undefined launch metadata without aborting boot', async () => {
    const probe = await createRuntimeComposition({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      recoverAll: () => Promise<unknown[]>;
      cancel: (runId: string) => Promise<void>;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();

    const recoverAllSpy = spyOn(enginePrototype, 'recoverAll').mockResolvedValue([
      {
        id: 'undefined-metadata-run',
        getLaunchMetadata: async () => undefined,
      },
    ]);
    const cancelSpy = spyOn(enginePrototype, 'cancel').mockResolvedValue(undefined);

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
      });

      try {
        await pollUntil(() => cancelSpy.mock.calls.length === 1);
        expect(cancelSpy).toHaveBeenCalledWith('undefined-metadata-run');
      } finally {
        bureau.dispose();
      }
    } finally {
      recoverAllSpy.mockRestore();
      cancelSpy.mockRestore();
    }
  });

  it('monitors markerless legacy scheduled fires when Weft has a schedule-run marker', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-legacy-scheduled-fire-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runId = 'legacy-scheduled-fire-run';
    const scheduleId = 'legacy-digest-schedule';
    const sessionId = `sched-${scheduleId}-${runId}`;

    try {
      const firstRuntime = await createRuntimeComposition({
        generate: async () => new Promise<never>(() => {}),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(firstRuntime.durable).toBeDefined();
        const toolbox = createEmptyToolbox();
        const services: DurableRunDeps = {
          toolbox,
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: toolbox,
            conversation: createConversationHistory(),
            stopWhen: stopWhen.noToolCalls(),
          },
        };

        const handle = await firstRuntime.durable!.engine.start(
          'agentRun',
          { agentName: 'researcher', input: 'legacy scheduled prompt' },
          { id: runId, services },
        );
        void handle.result().catch(() => {});
        await firstRuntime.durable!.engine.storage.put(KEYS.scheduleRun(runId), encode(scheduleId));

        const running = await pollUntil(async () => {
          const state = await firstRuntime.durable!.engine.get(runId);
          return state?.status === 'running';
        });
        expect(running).toBe(true);
      } finally {
        firstRuntime.durable?.engine[Symbol.dispose]?.();
        firstRuntime.disposeStorage?.();
      }

      const bureau = await createBureau({
        agents: {},
        generate: async () => ({ content: 'legacy scheduled recovery completed', toolCalls: [] }),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        const completed = await pollUntil(async () => {
          const state = await bureau.getDurableRun(runId);
          return state?.status === 'completed';
        });
        expect(completed).toBe(true);

        const session = await bureau.getSession(sessionId);
        expect(session).not.toBeNull();
        expect(
          getMessages(session!.conversationHistory).some(
            (message) => message.content === 'legacy scheduled recovery completed',
          ),
        ).toBe(true);
      } finally {
        bureau.dispose();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('monitors markerless scheduled fires when Weft has a schedule-run marker OBJECT (Weft 0.10+ metadata)', async () => {
    // REGRESSION (#235): Weft 0.10+ writes `KEYS.scheduleRun(...)` as a metadata
    // object (`{ id, occurrence? }`), not the legacy plain string. Before the fix,
    // `loadScheduleIdForRecoveredRun`'s `typeof decoded === 'string'` check treated
    // any non-string marker as missing, so a recovered stateless scheduled fire
    // whose only proof of ownership was this object marker was classified as an
    // unowned foreign run and CANCELLED instead of monitored.
    const databasePath = join(
      tmpdir(),
      `bureau-object-marker-scheduled-fire-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runId = 'object-marker-scheduled-fire-run';
    const scheduleId = 'object-marker-digest-schedule';
    const sessionId = `sched-${scheduleId}-${runId}`;

    try {
      const firstRuntime = await createRuntimeComposition({
        generate: async () => new Promise<never>(() => {}),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        expect(firstRuntime.durable).toBeDefined();
        const toolbox = createEmptyToolbox();
        const services: DurableRunDeps = {
          toolbox,
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: toolbox,
            conversation: createConversationHistory(),
            stopWhen: stopWhen.noToolCalls(),
          },
        };

        const handle = await firstRuntime.durable!.engine.start(
          'agentRun',
          { agentName: 'researcher', input: 'object marker scheduled prompt' },
          { id: runId, services },
        );
        void handle.result().catch(() => {});
        // Weft 0.10+ native marker shape: an object, not a bare string. A
        // fixed literal occurrence marker — this test only asserts the
        // recovered run reaches 'running', never compares this value against
        // real time.
        await firstRuntime.durable!.engine.storage.put(
          KEYS.scheduleRun(runId),
          encode({ id: scheduleId, occurrence: 1_700_000_000_000 }),
        );

        const running = await pollUntil(async () => {
          const state = await firstRuntime.durable!.engine.get(runId);
          return state?.status === 'running';
        });
        expect(running).toBe(true);
      } finally {
        firstRuntime.durable?.engine[Symbol.dispose]?.();
        firstRuntime.disposeStorage?.();
      }

      const bureau = await createBureau({
        agents: {},
        generate: async () => ({ content: 'object marker recovery completed', toolCalls: [] }),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        const completed = await pollUntil(async () => {
          const state = await bureau.getDurableRun(runId);
          return state?.status === 'completed';
        });
        expect(completed).toBe(true);

        const session = await bureau.getSession(sessionId);
        expect(session).not.toBeNull();
        expect(
          getMessages(session!.conversationHistory).some(
            (message) => message.content === 'object marker recovery completed',
          ),
        ).toBe(true);
      } finally {
        bureau.dispose();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('captures a recovered run that settles during boot in the durable audit trail (regression #114)', async () => {
    // REGRESSION (#114): the durable audit trail (Layer B) must be subscribed
    // BEFORE `recoverDurableRuns()` runs, not after. If recovery reattaches a run
    // whose handle is already settled — or one that settles during the awaits
    // inside recovery — its terminal `run.completed` / tool actions are dispatched
    // through the store before the trail subscribes, so they land only in the live
    // store and never reach the KV-backed trail. The recovered run then disappears
    // from durable `/api/v1/audit` after a restart. Wiring the trail ahead of
    // recovery guarantees those actions are persisted.
    const databasePath = join(
      tmpdir(),
      `bureau-recovery-audit-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      // Bureau A: step 0 commits a tool call, then step 1's generate hangs (crash),
      // leaving a non-terminal durable workflow for recoverAll to pick up.
      let bureauAReachedStep1 = false;
      const bureauA = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const run = await bureauA.createRun({ message: 'Recover into the audit trail' });
      await pollUntil(() => bureauAReachedStep1);
      await bureauA.sessionStore!.update(run.sessionId, (session) => ({
        ...session!,
        metadata: {
          ...session!.metadata,
          resolvedReviewIds: [
            `approval:${run.id}:recovered-approval`,
            `human-wait:${run.id}:recovered-signal`,
          ],
        },
      }));
      // AB-207: deliberately NOT disposing bureauA here. `dispose()`
      // now fully awaits `activeRun.abort()`'s durable-engine `cancel()`
      // handoff before returning, which genuinely completes the
      // in-flight workflow's cancellation and removes it from a fresh
      // engine's `recoverAll()` candidate set — a properly graceful
      // shutdown correctly leaves nothing to recover. Simulating a real
      // crash (the durable workflow still owned by a dead worker, which
      // IS recoverable) means leaving bureauA un-disposed here: it stays
      // parked at step 1's hung `generate()` call until disposed at the
      // end of this test, well after bureauB's recovery.

      // Observe boot ordering via a spy on `createAuditTrail`. Recovery REATTACHES
      // each recovered run and `store.register`s it SYNCHRONOUSLY inside
      // `recoverDurableRuns()` (so `getRun(runId)` resolves the moment recovery
      // returns). Therefore, if the recovered run is already visible at the instant
      // `createAuditTrail` runs, the trail subscribed too late — exactly the window
      // in which recovered-run actions are lost. The fix creates the trail first,
      // so the recovered run must NOT yet be registered when the spy fires.
      const realCreateAuditTrail = auditTrailModule.createAuditTrail;
      let recoveredRunVisibleWhenAuditCreated: boolean | undefined;
      const auditTrailSpy = spyOn(auditTrailModule, 'createAuditTrail').mockImplementation(
        (observedBureau, kv) => {
          recoveredRunVisibleWhenAuditCreated = observedBureau.getRun(run.id) !== undefined;
          return realCreateAuditTrail(observedBureau, kv);
        },
      );

      let bureauB: Bureau;
      try {
        // Bureau B: a wholly separate bureau over the same SQLite file. On boot it
        // recovers the run, which resumes at step 1 and settles.
        bureauB = await createBureau({
          agents: {},
          generate: async ({ step }) => ({ content: `B recovered step ${step}`, toolCalls: [] }),
          toolbox: createToolbox([createNextTool()]),
          storage: { type: 'sqlite', path: databasePath },
          durableExecution: true,
          stopWhen: stopWhen.noToolCalls(),
        });
      } finally {
        auditTrailSpy.mockRestore();
      }

      try {
        // ORDERING: the audit trail was created before recovery reattached the run.
        expect(recoveredRunVisibleWhenAuditCreated).toBe(false);

        // Wait until the recovered run reaches a terminal session status.
        await pollUntil(async () => {
          const current = await bureauB.getSession(run.sessionId);
          return current?.metadata['lastRunStatus'] !== 'running';
        });

        // DURABILITY: the recovered run's terminal transition is persisted in the
        // KV-backed trail (written fire-and-forget after the terminal event fires),
        // so it survives the restart and is queryable from the durable trail.
        let auditRecords: AuditRecord[] = [];
        await pollUntil(async () => {
          auditRecords = (await bureauB.auditTrail?.query({ runId: run.id })) ?? [];
          return auditRecords.some((record) => record.type === 'run.completed');
        });
        const completed = auditRecords.filter((record) => record.type === 'run.completed');
        expect(completed.length).toBeGreaterThan(0);
        expect(completed.every((record) => record.runId === run.id)).toBe(true);
      } finally {
        bureauB.dispose();
      }
      // AB-207: release bureauA's engine now that bureauB's
      // recovery-dependent assertions are done (its scheduler would
      // otherwise keep polling storage after this test deletes the sqlite
      // file below).
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('forwards toolbox events from a recovered run to the live surface during resume (#28)', async () => {
    // #28: before this fix a recovered run fired only TERMINAL events — its
    // per-step toolbox:* actions were silent. The awaited Weft recovery hook now
    // installs and registers the recovered event surface before replay, so a tool
    // executed by the resumed step is observable on bureau B's `action` surface.
    const databasePath = join(
      tmpdir(),
      `bureau-recovery-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      // Bureau A: step 0 commits a tool call, then step 1's generate hangs (crash).
      let reachedStep1 = false;
      const bureauA = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          reachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });
      const run = await bureauA.createRun({ message: 'Recover with a tool' });
      await pollUntil(() => reachedStep1);
      // AB-207: deliberately NOT disposing bureauA here. `dispose()`
      // now fully awaits `activeRun.abort()`'s durable-engine `cancel()`
      // handoff before returning, which genuinely completes the
      // in-flight workflow's cancellation and removes it from a fresh
      // engine's `recoverAll()` candidate set — a properly graceful
      // shutdown correctly leaves nothing to recover. Simulating a real
      // crash (the durable workflow still owned by a dead worker, which
      // IS recoverable) means leaving bureauA un-disposed here: it stays
      // parked at step 1's hung `generate()` call until disposed at the
      // end of this test, well after bureauB's recovery.

      // Bureau B: resumes at step 1, which calls the `next` tool again before
      // settling — so a toolbox action fires on the RECOVERED run's surface.
      const actions: string[] = [];
      const bureauB = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          if (step === 1) {
            return { content: 'B resume step 1', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          return { content: `B step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });
      bureauB.addEventListener('action', (event) => {
        actions.push(event.action.type);
      });

      try {
        // Wait until the recovered run reaches a terminal session status (its
        // resumed steps have run, including the tool execution on step 1).
        await pollUntil(async () => {
          const current = await bureauB.getSession(run.sessionId);
          return current?.metadata['lastRunStatus'] !== 'running';
        });

        // The recovered run's toolbox events reached the live surface — previously
        // silent on the recovery path. This is the seam-#10/#28 closure.
        expect(actions.some((type) => type.startsWith('toolbox.'))).toBe(true);
      } finally {
        bureauB.dispose();
      }
      // AB-207: release bureauA's engine now that bureauB's
      // recovery-dependent assertions are done (its scheduler would
      // otherwise keep polling storage after this test deletes the sqlite
      // file below).
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('forwards run-envelope frames (step, tool-pre/post) for a RECOVERED run, not just run-finished (regression PRRT_kwDORvupsc6PxWjc)', async () => {
    // AB-96 codex review: `reattachRecoveredRun` only ever emitted a terminal
    // `run-finished` frame — it never wired `createRunFrameForwarder`, so a
    // `subscribeLiveFrames` consumer relying on the AB-96 run-envelope stream
    // missed every resumed `step`/`tool-pre`/`tool-post` frame for a recovered
    // run, even though those events already reach the recovered run's plain
    // ActiveRun listeners (see the #28 test above). The fix wires the same
    // forwarder the live-run path uses onto the recovered run.
    const databasePath = join(
      tmpdir(),
      `bureau-recovery-envelope-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      // Bureau A: step 0 commits a tool call, then step 1's generate hangs (crash).
      let bureauAReachedStep1 = false;
      const bureauA = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const run = await bureauA.createRun({ message: 'Recover with envelope frames' });
      await pollUntil(() => bureauAReachedStep1);
      // AB-207: deliberately NOT disposing bureauA here. `dispose()`
      // now fully awaits `activeRun.abort()`'s durable-engine `cancel()`
      // handoff before returning, which genuinely completes the
      // in-flight workflow's cancellation and removes it from a fresh
      // engine's `recoverAll()` candidate set — a properly graceful
      // shutdown correctly leaves nothing to recover. Simulating a real
      // crash (the durable workflow still owned by a dead worker, which
      // IS recoverable) means leaving bureauA un-disposed here: it stays
      // parked at step 1's hung `generate()` call until disposed at the
      // end of this test, well after bureauB's recovery.

      // Bureau B: resumes at step 1, which calls the `next` tool again before
      // settling — so step/tool-pre/tool-post frames should surface on the
      // recovered run's run-envelope stream, not just the terminal one.
      const bureauB = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          if (step === 1) {
            return { content: 'B resume step 1', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          return { content: `B step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const envelopeFrameTypes: string[] = [];
      bureauB.subscribeLiveFrames((frame) => {
        if (frame.type === 'run-envelope' && frame.runId === run.id) {
          envelopeFrameTypes.push(frame.frame.type);
        }
      });

      try {
        await pollUntil(async () => {
          const current = await bureauB.getSession(run.sessionId);
          return current?.metadata['lastRunStatus'] !== 'running';
        });

        // Before the fix, only 'run-finished' would ever appear here.
        expect(envelopeFrameTypes).toContain('step');
        expect(envelopeFrameTypes).toContain('tool-pre');
        expect(envelopeFrameTypes).toContain('tool-post');
        expect(envelopeFrameTypes).toContain('run-finished');
      } finally {
        bureauB.dispose();
      }
      // AB-207: release bureauA's engine now that bureauB's
      // recovery-dependent assertions are done (its scheduler would
      // otherwise keep polling storage after this test deletes the sqlite
      // file below).
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('stamps tool.started events with agentName and runId on a RECOVERED run (regression PRRT_kwDORvupsc6MXoT3)', async () => {
    // REGRESSION: the recovery resolver wired the toolbox-forward but omitted the
    // C3 stamping block, so tool.* bubble events from a recovered run carried
    // blank ids ({agentName:'', runId:'', step:0}) instead of the agentName and
    // runId from the durable input. The fix adds the C3 block to resolveRunServices.
    const databasePath = join(
      tmpdir(),
      `bureau-recovery-c3-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      // Bureau A: step 0 commits a tool call, then step 1's generate hangs (crash).
      let bureauAReachedStep1 = false;
      const bureauA = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const run = await bureauA.createRun({
        message: 'C3 recovery stamp test',
        agentName: 'recovery-agent',
      });
      await pollUntil(() => bureauAReachedStep1);
      // AB-207: deliberately NOT disposing bureauA here. `dispose()`
      // now fully awaits `activeRun.abort()`'s durable-engine `cancel()`
      // handoff before returning, which genuinely completes the
      // in-flight workflow's cancellation and removes it from a fresh
      // engine's `recoverAll()` candidate set — a properly graceful
      // shutdown correctly leaves nothing to recover. Simulating a real
      // crash (the durable workflow still owned by a dead worker, which
      // IS recoverable) means leaving bureauA un-disposed here: it stays
      // parked at step 1's hung `generate()` call until disposed at the
      // end of this test, well after bureauB's recovery.

      // Bureau B: resumes at step 1, which calls the `next` tool. After recovery
      // the resolver now wires the C3 block so the tool.started event emitted
      // during resume carries {agentName:'recovery-agent', runId}.
      const capturedStamps: Array<{ agentName: string; runId: string }> = [];
      const bureauB = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          if (step === 1) {
            return { content: 'B resume', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          return { content: `B step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      // Subscribe to tool.started on the reattached ActiveRun BEFORE recovery
      // events drain. bureauB's createBureau calls recoverDurableRuns synchronously
      // before returning, so store.getRun may already resolve.
      const runState = bureauB.store.getRun(run.id);
      runState?.activeRun.addEventListener('tool.started', (event) => {
        capturedStamps.push({ agentName: event.agentName, runId: event.runId });
      });

      try {
        await pollUntil(async () => {
          const current = await bureauB.getSession(run.sessionId);
          return current?.metadata['lastRunStatus'] !== 'running';
        });

        // At least one tool.started event must have fired (resumed step 1 calls `next`).
        expect(capturedStamps.length).toBeGreaterThan(0);
        // Every stamped event must carry the durable input's agentName and the runId.
        for (const stamp of capturedStamps) {
          expect(stamp.agentName).toBe('recovery-agent');
          expect(stamp.runId).toBe(run.id);
        }
      } finally {
        bureauB.dispose();
      }
      // AB-207: release bureauA's engine now that bureauB's
      // recovery-dependent assertions are done (its scheduler would
      // otherwise keep polling storage after this test deletes the sqlite
      // file below).
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('persists aborted metadata when a recovered run is aborted after reattach', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-recovery-abort-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      let bureauAReachedStep1 = false;
      const bureauA = await createBureau({
        agents: {},
        generate: async ({ step, signal }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true;
          return new Promise<GenerateResponse>((resolve) => {
            signal?.addEventListener(
              'abort',
              () => resolve({ content: 'aborted before crash', toolCalls: [] }),
              { once: true },
            );
          });
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const run = await bureauA.createRun({ message: 'Recover then abort' });
      await pollUntil(() => bureauAReachedStep1);
      // AB-207: deliberately NOT disposing bureauA here. `dispose()`
      // now fully awaits `activeRun.abort()`'s durable-engine `cancel()`
      // handoff before returning, which genuinely completes the
      // in-flight workflow's cancellation and removes it from a fresh
      // engine's `recoverAll()` candidate set — a properly graceful
      // shutdown correctly leaves nothing to recover. Simulating a real
      // crash (the durable workflow still owned by a dead worker, which
      // IS recoverable) means leaving bureauA un-disposed here: it stays
      // parked at step 1's hung `generate()` call until disposed at the
      // end of this test, well after bureauB's recovery.

      const bureauB = await createBureau({
        agents: {},
        generate: async ({ signal }) =>
          new Promise<GenerateResponse>((resolve) => {
            signal?.addEventListener(
              'abort',
              () => resolve({ content: 'aborted after recovery', toolCalls: [] }),
              { once: true },
            );
          }),
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        await pollUntil(() => bureauB.getRun(run.id)?.status === 'running');
        bureauB.abortRun(run.id);
        await pollUntil(async () => {
          const current = await bureauB.getSession(run.sessionId);
          return current?.metadata['lastRunStatus'] === 'aborted';
        });

        const session = await bureauB.getSession(run.sessionId);
        expect(session?.metadata['lastRunStatus']).toBe('aborted');
        expect(session?.metadata['lastFinishReason']).toBe('aborted');
      } finally {
        bureauB.dispose();
      }
      // AB-207: release bureauA's engine now that bureauB's
      // recovery-dependent assertions are done (its scheduler would
      // otherwise keep polling storage after this test deletes the sqlite
      // file below).
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('reconciles an in-flight session to error when recovery cannot rebuild its deps', async () => {
    // The resolver-unavailable path: bureau A crashes mid-run, then bureau B
    // boots over the same SQLite file WITHOUT a generate function. Its recovery
    // resolver finds the `running` session but `createRunRuntime` throws ("No
    // generate function configured") while rebuilding deps — so the run cannot be
    // reconstructed. `resolveRunServices` reconciles that owning session to
    // `error` synchronously (it has the sessionId in hand) instead of leaving it
    // stuck `running`, and bureau B still boots cleanly.
    const databasePath = join(
      tmpdir(),
      `bureau-unrecoverable-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      let bureauAReachedStep1 = false;
      const bureauA = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true;
          return new Promise<never>(() => {}); // hang — the "process" dies here
        },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const run = await bureauA.createRun({ message: 'Recover me' });
      await pollUntil(() => bureauAReachedStep1);
      expect(bureauAReachedStep1).toBe(true);
      // AB-207: deliberately NOT disposing bureauA here. `dispose()`
      // now fully awaits `activeRun.abort()`'s durable-engine `cancel()`
      // handoff before returning, which genuinely completes the
      // in-flight workflow's cancellation and removes it from a fresh
      // engine's `recoverAll()` candidate set — a properly graceful
      // shutdown correctly leaves nothing to recover. Simulating a real
      // crash (the durable workflow still owned by a dead worker, which
      // IS recoverable) means leaving bureauA un-disposed here: it stays
      // parked at step 1's hung `generate()` call until disposed at the
      // end of this test, well after bureauB's recovery.

      // === Bureau B: same file, durable forced on, but NO generate and NO
      // provider — so reconstructing the run's deps throws on this process. ===
      const bureauB = await createBureau({
        agents: {},
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        // The resolver runs synchronously during boot recovery and reconciles the
        // session. Poll (bounded) until the reconciliation write lands.
        await pollUntil(async () => {
          const current = await bureauB.getSession(run.sessionId);
          return current?.metadata['lastRunStatus'] !== 'running';
        });

        const session = await bureauB.getSession(run.sessionId);
        // Reconciled to `error`, not left stale `running`.
        expect(session?.metadata['lastRunStatus']).toBe('error');
        const lastError = session?.metadata['lastError'];
        expect(typeof lastError).toBe('string');
        expect(lastError as string).toContain('could not be reconstructed');
        // A run the resolver failed (session reconciled to `error`) must NOT be
        // reattached + store.register'd — otherwise its write-free-rejecting
        // handle would leave a store entry stuck `running` forever (committee/
        // Bugbot review). It was cancelled, not registered.
        expect(bureauB.getRun(run.id)).toBeUndefined();
      } finally {
        bureauB.dispose();
      }
      // AB-207: release bureauA's engine now that bureauB's
      // recovery-dependent assertions are done (its scheduler would
      // otherwise keep polling storage after this test deletes the sqlite
      // file below).
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('routes runs through the durable engine end-to-end when durableExecution is on', async () => {
    // The seam #7 closure, validated through the REAL gateway wiring: a durable
    // run must fire run.completed so store.register sees completion and the
    // session is marked completed — exactly as an in-memory run does.
    //
    // NOTE: no `persistence` — it would shadow `storage`, leaving `durableStorage`
    // undefined so NO engine is built (and, with `durableExecution: true`, the
    // composition now throws on that contradiction). `storage: memory` +
    // `durableExecution: true` is what actually builds the in-memory durable
    // engine, so this test genuinely exercises the durable path.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    const run = await bureau.createRun({ message: 'Durable hello' });
    // Wait deterministically for the deferred-microtask start + durable workflow
    // to drive the registered run to a terminal state (no fixed-wall-clock sleep).
    await waitForRunCompletion(bureau, run.id);

    // The run is registered and observed to completion through the durable path.
    const detail = bureau.getRun(run.id);
    expect(detail).toBeDefined();
    expect(detail?.status).toBe('completed');
    expect(detail?.finishReason).toBe('stop-condition');

    // run.completed fired → the session was persisted as completed.
    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastRunId']).toBe(run.id);
    expect(session?.metadata['lastRunStatus']).toBe('completed');
  });

  it('routes a sqlite-backed run through the durable engine BY DEFAULT at observable parity', async () => {
    // The flip's gate: sqlite storage and NO `durableExecution` flag now routes
    // through Weft (the default-on contract). This must be at OBSERVABLE PARITY
    // with the in-memory loop — the rich event surface gateway depends on
    // (`action` events, toolbox events from a tool call, `run.completed`, and the
    // persisted session status) must all fire exactly as for an in-memory run.
    // Asserting WITHOUT the flag is the whole point: a test that set
    // `durableExecution: true` would retest the old opt-in path and prove nothing
    // about the flip.
    const databasePath = join(
      tmpdir(),
      `default-on-parity-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    try {
      const bureau = await createBureau({
        agents: {},
        // Step 0 commits a tool call (so toolbox events must fire on the durable
        // path); step 1 has no tool call, so `noToolCalls()` stops the run.
        generate: async ({ step }) =>
          step === 0
            ? { content: 'calling tool', toolCalls: [{ name: 'next', arguments: {} }] }
            : { content: 'done', toolCalls: [] },
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        // NOTE: no `durableExecution` — relying on the default-on flip.
        stopWhen: stopWhen.noToolCalls(),
      });

      const actions: string[] = [];
      bureau.addEventListener('action', (event) => {
        actions.push(event.action.type);
      });

      const run = await bureau.createRun({ message: 'Drive the durable default' });
      await waitForRunCompletion(bureau, run.id);

      // The observable surface fired on the durable path: `action` events flowed,
      // the run is registered and observed to completion, and the session landed
      // `completed` — full parity with the in-memory loop, with no opt-in.
      expect(actions.length).toBeGreaterThan(0);
      // A `toolbox.*` action proves the toolbox-event forwarding the adapter wires
      // (active-run-adapter.ts) actually fired on the durable path — step 0's tool
      // call must surface, not merely the run-lifecycle events.
      expect(actions.some((type) => type.startsWith('toolbox.'))).toBe(true);
      const detail = bureau.getRun(run.id);
      expect(detail).toBeDefined();
      expect(detail?.status).toBe('completed');
      expect(detail?.finishReason).toBe('stop-condition');

      const session = await bureau.getSession(run.sessionId);
      expect(session?.metadata['lastRunStatus']).toBe('completed');

      bureau.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('logs terminal session persistence failures when retry sleep rejects', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    let sessionSaveCount = 0;
    let retrySleepCount = 0;

    const flakyStore = createTextStoreProxy(backingStore, {
      async conditionalBatch(conditions, operations) {
        if (
          conditions.some((condition) => condition.key.startsWith('agent-session:')) ||
          operations.some((operation) => operation.key.startsWith('agent-session:'))
        ) {
          sessionSaveCount += 1;
          if (sessionSaveCount === 2) {
            throw new Error('temporary persistence failure');
          }
        }

        return backingStore.conditionalBatch(conditions, operations);
      },
    });

    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        persistence: flakyStore,
        sessionPersistenceSleep: async () => {
          retrySleepCount += 1;
          throw new Error('retry sleep aborted');
        },
        stopWhen: stopWhen.noToolCalls(),
      });

      const run = await bureau.createRun({ message: 'Retry sleep failure' });
      await waitForRunCompletion(bureau, run.id);
      await waitForCondition(
        () => errorSpy.mock.calls.length === 1,
        'session persistence error was not logged after retry sleep failed',
      );

      expect(sessionSaveCount).toBe(2);
      expect(retrySleepCount).toBe(1);

      const callArgs = errorSpy.mock.calls[0] as unknown[];
      const errorMessage = String(callArgs[0]);
      expect(errorMessage).toContain('Failed to persist completed session state');
      expect(errorMessage).toContain('retry sleep aborted');
    } finally {
      console.error = originalError;
    }
  });

  it('does not register a run when initial session persistence fails', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    const failingStore = createTextStoreProxy(backingStore, {
      async conditionalBatch(conditions, operations) {
        if (
          conditions.some((condition) => condition.key.startsWith('agent-session:')) ||
          operations.some((operation) => operation.key.startsWith('agent-session:'))
        ) {
          throw new Error('persistence failed');
        }

        return backingStore.conditionalBatch(conditions, operations);
      },
    });

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: failingStore,
    });

    const error = await bureau.createRun({ message: 'Ghost run?' }).then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('persistence failed');
    expect(bureau.listRuns()).toHaveLength(0);
  });

  it('persists error session metadata when runs finish with an error', async () => {
    const generate: GenerateFunction = async () => {
      throw new Error('Explode');
    };

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });

    const run = await bureau.createRun({ message: 'Explode' });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastRunId']).toBe(run.id);
    expect(session?.metadata['lastRunStatus']).toBe('error');
    expect(JSON.parse(session?.metadata['lastError'] as string)).toMatchObject({
      name: 'AgentRunError',
      message: 'Explode',
      kind: 'generate',
      code: 'UNKNOWN',
      cause: {
        name: 'Error',
        message: 'Explode',
      },
    });
  });

  it('persists a guardrail tripwire halt as lastRunStatus: error with lastError set (regression PRRT_kwDORvupsc6PxCXP)', async () => {
    // Before the fix, the run.completed listener only mapped
    // `finishReason === 'error'` to `lastRunStatus: 'error'` — a tripwire halt
    // (`finishReason: 'tripwire'`) fell into the `'completed'` branch and never
    // wrote `lastError`, so a malicious/flagged prompt that hard-halted the run
    // was persisted to session metadata as an ordinary successful completion.
    const generate: GenerateFunction = async () => ({ content: 'ok', toolCalls: [] });

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
      guardrails: {
        mode: 'tripwire',
        input: {
          detectors: [
            {
              name: 'always-trip',
              detect: async () => ({ triggered: true, confidence: 1, category: 'test' }),
            },
          ],
        },
      },
    });

    const run = await bureau.createRun({ message: 'trip me' });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastRunStatus']).toBe('error');
    expect(session?.metadata['lastFinishReason']).toBe('tripwire');
    expect(session?.metadata['lastError']).toBeDefined();
    expect(typeof session?.metadata['lastError']).toBe('string');
  });

  it('persists error session state once after the initial running save', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    let sessionSaveCount = 0;

    const trackingStore = createTextStoreProxy(backingStore, {
      async conditionalBatch(conditions, operations) {
        if (
          conditions.some((condition) => condition.key.startsWith('agent-session:')) ||
          operations.some((operation) => operation.key.startsWith('agent-session:'))
        ) {
          sessionSaveCount += 1;
        }

        return backingStore.conditionalBatch(conditions, operations);
      },
    });

    const generate: GenerateFunction = async () => {
      throw new Error('Explode once');
    };

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      persistence: trackingStore,
    });

    const run = await bureau.createRun({ message: 'Explode once' });
    await waitForRunCompletion(bureau, run.id);

    expect(sessionSaveCount).toBe(2);
  });

  it('fails runs when the model emits tool calls without a configured toolbox', async () => {
    const generate: GenerateFunction = async () => ({
      content: '',
      toolCalls: [{ name: 'missing_tool', arguments: {} }],
    });

    const bureau = await createBureau({
      agents: {},
      generate,
    });

    const run = await bureau.createRun({ message: 'Need a tool' });
    await waitForRunCompletion(bureau, run.id);

    const detail = bureau.getRun(run.id);
    expect(detail?.status).toBe('error');
    expect(detail?.error).toContain('No toolbox configured but tool calls were received');
  });

  it('lists runs and filters them by status', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    await waitForRunCompletion(bureau, run.id);

    const allRuns = bureau.listRuns();
    const completedRuns = bureau.listRuns('completed');

    expect(allRuns.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(completedRuns)).toBe(true);
  });

  it('retains session identifiers for completed run summaries and details', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    await waitForRunCompletion(bureau, run.id);

    const summary = bureau.listRuns().find((entry) => entry.id === run.id);
    const detail = bureau.getRun(run.id);

    expect(summary?.sessionId).toBe(run.sessionId);
    expect(detail?.sessionId).toBe(run.sessionId);
  });

  it('returns a run detail payload with events and step details', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate('Detailed response'),
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    await waitForRunCompletion(bureau, run.id);

    const detail = bureau.getRun(run.id);

    expect(detail).toBeDefined();
    expect(detail?.sessionId).toBe(run.sessionId);
    expect(detail?.events.length).toBeGreaterThan(0);
    expect(detail?.stepDetails.length).toBeGreaterThan(0);
  });

  it('aborts a running run, reporting the transitional aborting status (AB-205)', async () => {
    // `abortRun` no longer fabricates a terminal `'aborted'` status before
    // teardown has actually started (AB-37) — it reports the transitional
    // `'aborting'` status instead, cleared to the real terminal status only
    // once the run's own terminal event settles.
    const generate: GenerateFunction = () => new Promise(() => {});
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });

    const aborted = bureau.abortRun(run.id);
    expect(aborted.status).toBe('aborting');

    // `getRun`/`listRuns` deliberately keep reporting the run's real,
    // unmodified status (still `'running'` — the run has not actually
    // stopped yet) rather than `abortRun`'s own transitional value, so the
    // widely used "`status !== 'running'` means settled" idiom (e.g.
    // `waitForRunState`) is never falsely satisfied before teardown starts.
    expect(bureau.getRun(run.id)?.status).toBe('running');
    expect(bureau.listRuns().find((entry) => entry.id === run.id)?.status).toBe('running');

    await pollUntil(() => bureau.getRun(run.id)?.status === 'aborted');
    expect(bureau.getRun(run.id)?.status).toBe('aborted');

    bureau.dispose();
  });

  it('abortRun is idempotent: a second call on the same still-running run does not throw and reports aborting or later (AB-205)', async () => {
    const generate: GenerateFunction = () => new Promise(() => {});
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });

    const first = bureau.abortRun(run.id);
    const second = bureau.abortRun(run.id);

    expect(first.status).toBe('aborting');
    expect(second.status).toBe('aborting');

    await pollUntil(() => bureau.getRun(run.id)?.status === 'aborted');

    bureau.dispose();
  });

  it('abortRun is idempotent against a terminal run: returns the current summary instead of throwing CONFLICT (AB-205)', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    await pollUntil(() => bureau.getRun(run.id)?.status !== 'running');

    expect(bureau.getRun(run.id)?.status).toBe('completed');

    // A repeat call after the run finished on its own no longer throws
    // `CONFLICT` — it returns the run's current (real, terminal) summary.
    const repeat = bureau.abortRun(run.id);
    expect(repeat.status).toBe('completed');

    bureau.dispose();
  });

  it('abortRun is idempotent for a run that was already aborted: a second call after teardown returns the aborted summary (AB-205)', async () => {
    const generate: GenerateFunction = () => new Promise(() => {});
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    bureau.abortRun(run.id);
    await pollUntil(() => bureau.getRun(run.id)?.status === 'aborted');

    const repeat = bureau.abortRun(run.id);
    expect(repeat.status).toBe('aborted');

    bureau.dispose();
  });

  describe('cancelDurableRun (AB-205)', () => {
    it('resolves unsupported-capability when no durable engine is composed', async () => {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
      });

      const outcome = await bureau.cancelDurableRun('anything');
      expect(outcome).toEqual({ status: 'unsupported-capability' });

      bureau.dispose();
    });

    it('resolves not-found against an unknown runId', async () => {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
      });

      const outcome = await bureau.cancelDurableRun('does-not-exist');
      expect(outcome).toEqual({ status: 'not-found' });

      bureau.dispose();
    });

    it('resolves already-terminal against an already-completed durable workflow', async () => {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
      });

      const run = await bureau.createRun({ message: 'Hello' });
      await pollUntil(async () => {
        const state = await bureau.getDurableRun(run.id);
        return state?.status === 'completed';
      });

      const outcome = await bureau.cancelDurableRun(run.id);
      expect(outcome).toEqual({ status: 'already-terminal' });

      bureau.dispose();
    });

    it('resolves requested against a running durable workflow only after the post-cancel re-read observes cancelled', async () => {
      const generate: GenerateFunction = () => new Promise(() => {});
      const bureau = await createBureau({
        agents: {},
        generate,
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
      });

      const run = await bureau.createRun({ message: 'Hello' });
      await pollUntil(async () => {
        const state = await bureau.getDurableRun(run.id);
        return state?.status === 'running';
      });

      const outcome = await bureau.cancelDurableRun(run.id);
      expect(outcome).toEqual({ status: 'requested' });

      const state = await bureau.getDurableRun(run.id);
      expect(state?.status).toBe('cancelled');

      bureau.dispose();
    });

    describe('resolveCancelDurableRun (dependency-injected resolution algorithm)', () => {
      it('resolves already-terminal WITHOUT calling cancel when the workflow is already outside the forcibly-terminable statuses', async () => {
        let cancelCalls = 0;
        const outcome = await resolveCancelDurableRun('run-1', {
          getDurableRun: async () =>
            ({ id: 'run-1', type: 'agentRun', status: 'completed', input: undefined }) as never,
          cancel: async () => {
            cancelCalls += 1;
          },
        });

        expect(outcome).toEqual({ status: 'already-terminal' });
        expect(cancelCalls).toBe(0);
      });

      it('resolves already-terminal, never requested, when a race lets the workflow complete normally during the cancel call (regression fixture)', async () => {
        // `cancel` resolves without proof it actually committed the
        // cancellation — it can just as easily resolve because the workflow
        // raced to `'completed'` on its own first. The post-cancel re-read
        // is what tells the two apart; this fixture forces that exact race
        // by having `getDurableRun` report `'running'` on the FIRST call
        // (the pre-cancel read) and `'completed'` on the SECOND (the
        // post-cancel re-read) — the workflow-completed-during-cancel case.
        let getDurableRunCalls = 0;
        const outcome = await resolveCancelDurableRun('run-2', {
          getDurableRun: async () => {
            getDurableRunCalls += 1;
            return getDurableRunCalls === 1
              ? ({ id: 'run-2', type: 'agentRun', status: 'running', input: undefined } as never)
              : ({ id: 'run-2', type: 'agentRun', status: 'completed', input: undefined } as never);
          },
          // `cancel` resolves normally (it lost the race — the engine's own
          // `allowedStatuses` guard silently no-ops against an already-
          // terminal workflow), which is exactly why a re-read is required.
          cancel: async () => {},
        });

        expect(outcome).toEqual({ status: 'already-terminal' });
        expect(getDurableRunCalls).toBe(2);
      });

      it('resolves requested only when the post-cancel re-read observes cancelled', async () => {
        let getDurableRunCalls = 0;
        const outcome = await resolveCancelDurableRun('run-3', {
          getDurableRun: async () => {
            getDurableRunCalls += 1;
            return getDurableRunCalls === 1
              ? ({ id: 'run-3', type: 'agentRun', status: 'pending', input: undefined } as never)
              : ({ id: 'run-3', type: 'agentRun', status: 'cancelled', input: undefined } as never);
          },
          cancel: async () => {},
        });

        expect(outcome).toEqual({ status: 'requested' });
      });

      it('resolves failed with the error attached when cancel rejects', async () => {
        const cancelError = new Error('engine unavailable');
        const outcome = await resolveCancelDurableRun('run-4', {
          getDurableRun: async () =>
            ({ id: 'run-4', type: 'agentRun', status: 'suspended', input: undefined }) as never,
          cancel: async () => {
            throw cancelError;
          },
        });

        expect(outcome).toEqual({ status: 'failed', error: cancelError });
      });

      it('never rejects: an unexpected getDurableRun rejection resolves failed instead', async () => {
        const readError = new Error('storage unavailable');
        const outcome = await resolveCancelDurableRun('run-5', {
          getDurableRun: async () => {
            throw readError;
          },
          cancel: async () => {},
        });

        expect(outcome).toEqual({ status: 'failed', error: readError });
      });

      it('resolves failed, not already-terminal, when the post-cancel re-read still reports a forcibly-terminable status (code-review regression fixture)', async () => {
        // `cancel` resolving without rejecting is not proof the cancellation
        // committed. If the post-cancel re-read still reports a status
        // WITHIN the forcibly-terminable set (the cancellation genuinely
        // never landed — neither committed nor lost to a race with normal
        // completion), reporting `'already-terminal'` would be a false
        // positive and `'requested'` would be an unproven claim; only
        // `'failed'` is honest.
        let getDurableRunCalls = 0;
        const outcome = await resolveCancelDurableRun('run-6', {
          getDurableRun: async () => {
            getDurableRunCalls += 1;
            return { id: 'run-6', type: 'agentRun', status: 'running', input: undefined } as never;
          },
          cancel: async () => {},
        });

        expect(outcome.status).toBe('failed');
        expect(getDurableRunCalls).toBe(2);
      });

      it('resolves not-found when the post-cancel re-read observes the run was purged', async () => {
        let getDurableRunCalls = 0;
        const outcome = await resolveCancelDurableRun('run-7', {
          getDurableRun: async () => {
            getDurableRunCalls += 1;
            return getDurableRunCalls === 1
              ? ({ id: 'run-7', type: 'agentRun', status: 'suspended', input: undefined } as never)
              : null;
          },
          cancel: async () => {},
        });

        expect(outcome).toEqual({ status: 'not-found' });
      });

      it('resolves unsupported-capability when the post-cancel re-read observes no durable engine composed', async () => {
        let getDurableRunCalls = 0;
        const outcome = await resolveCancelDurableRun('run-8', {
          getDurableRun: async () => {
            getDurableRunCalls += 1;
            return getDurableRunCalls === 1
              ? ({ id: 'run-8', type: 'agentRun', status: 'pending', input: undefined } as never)
              : undefined;
          },
          cancel: async () => {},
        });

        expect(outcome).toEqual({ status: 'unsupported-capability' });
      });
    });
  });

  it('persists both lastRunStatus and lastFinishReason when a run is aborted', async () => {
    // An aborted session's metadata must be internally consistent: status AND
    // finishReason both `aborted`, so a prior run's stale `lastFinishReason` on
    // the same session cannot linger. Boot recovery relies on this too — a
    // recovered run that aborts settles through this same listener.
    const generate: GenerateFunction = () => new Promise(() => {});
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    bureau.abortRun(run.id);

    // The session write happens after the run.aborted event settles; poll until
    // the status leaves `running`.
    await pollUntil(async () => {
      const current = await bureau.getSession(run.sessionId);
      return current?.metadata['lastRunStatus'] === 'aborted';
    });

    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastRunStatus']).toBe('aborted');
    expect(session?.metadata['lastFinishReason']).toBe('aborted');
    expect(JSON.parse(session?.metadata['lastError'] as string)).toMatchObject({
      name: 'AbortAgentRunError',
      kind: 'abort',
      code: 'ABORTED',
    });
  });

  it('persists the checkpointed conversation when a durable run is aborted after a checkpoint (regression PRRT_kwDORvupsc6Mddv3 / #113)', async () => {
    // On the durable path the workflow mutates per-step checkpoint SNAPSHOTS, not
    // the launch-time `Conversation` the run was created with. So a durable run
    // that aborts AFTER checkpointed steps — e.g. when engine.cancel() wins the
    // abort race — reconstructs its abort RunResult from the checkpoint. The
    // run.aborted listener must persist THAT conversation (carried on the abort
    // event), not the launch-time seed; otherwise the session history is clobbered
    // back to just the seed message and the checkpointed steps are lost.
    let reachedStep1 = false;
    const bureau = await createBureau({
      agents: {},
      generate: async ({ step }) => {
        if (step === 0) {
          // Step 0 commits a tool call so the workflow checkpoints it before
          // looping into step 1 (saveConversation/recordStep/saveCursor).
          return { content: 'checkpointed step 0', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        // Entering step 1's generate proves step 0 is durably checkpointed (its
        // saveCursor yield resolved). Hang here, ignoring the abort signal, so the
        // ONLY way to terminate is engine.cancel() winning the abort race — the
        // post-checkpoint durable abort the regression is about.
        reachedStep1 = true;
        return new Promise<never>(() => {});
      },
      toolbox: createToolbox([createNextTool()]),
      storage: { type: 'memory' },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const run = await bureau.createRun({ message: 'Abort me after a checkpoint' });
      await pollUntil(() => reachedStep1);
      expect(reachedStep1).toBe(true);

      // engine.cancel() terminalizes the workflow; its result rejects and the
      // abort RunResult is reconstructed from the checkpoint, carrying step 0.
      bureau.abortRun(run.id);

      await pollUntil(async () => {
        const current = await bureau.getSession(run.sessionId);
        return current?.metadata['lastRunStatus'] === 'aborted';
      });

      const session = await bureau.getSession(run.sessionId);
      expect(session?.metadata['lastRunStatus']).toBe('aborted');

      // The persisted history must include the checkpointed step 0, not just the
      // launch-time seed. Before the fix the listener wrote the seed `conversation`
      // closure (only the user message), so this content was absent.
      const messages = session?.conversationHistory ? getMessages(session.conversationHistory) : [];
      const hasCheckpointedStep = messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('checkpointed step 0'),
      );
      expect(hasCheckpointedStep).toBe(true);
    } finally {
      bureau.dispose();
    }
  });

  it('throws CONFLICT when deleting a running run', async () => {
    const generate: GenerateFunction = () => new Promise(() => {});
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    expect(bureau.getRun(run.id)?.status).toBe('running');

    let deletionError: unknown;
    try {
      await bureau.deleteRun(run.id);
    } catch (error) {
      deletionError = error;
    }
    expect(deletionError).toBeInstanceOf(BureauError);
  });

  it('revokes pending approval bindings before deleting a terminal run', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    let deletionPersistenceAttempts = 0;
    let failNextDeletionPersistence = false;
    const persistence = createTextStoreProxy(backingStore, {
      async conditionalBatch(conditions, operations) {
        if (
          failNextDeletionPersistence &&
          operations.some((operation) => operation.key.startsWith('agent-session:'))
        ) {
          failNextDeletionPersistence = false;
          deletionPersistenceAttempts += 1;
          throw new Error('deletion persistence unavailable');
        }
        if (deletionPersistenceAttempts > 0) deletionPersistenceAttempts += 1;
        return backingStore.conditionalBatch(conditions, operations);
      },
    });
    const baseApprovalStore = createProcessLocalApprovalStateStore();
    let revocations = 0;
    const approvalStateStore = {
      ...baseApprovalStore,
      async revoke(binding: Parameters<typeof baseApprovalStore.revoke>[0]) {
        revocations += 1;
        return baseApprovalStore.revoke(binding);
      },
    };
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'delete-run-approval', name: 'delete-run-tool', arguments: {} }],
        },
      ]),
      toolbox: createToolbox(
        [
          createTool({
            name: 'delete-run-tool',
            version: '1.0.0',
            description: 'Must be revoked when its run is deleted',
            input: z.object({}),
            async execute() {
              return 'unexpected';
            },
          }),
        ],
        {
          approvalSecret: 'delete-run-secret',
          approvalStateStore,
          policy: {
            beforeExecute: () => ({
              allow: false,
              status: 'needs_approval',
              reason: 'Operator approval required',
              action: { message: 'Approve deletion test' },
            }),
          },
        },
      ),
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence,
      sessionPersistenceSleep: async () => {},
    });
    const run = await bureau.createRun({ message: 'Request approval then delete the run' });
    await waitForRunCompletion(bureau, run.id);
    expect(bureau.listPendingReviews()).toHaveLength(1);

    failNextDeletionPersistence = true;
    await bureau.deleteRun(run.id);
    expect(revocations).toBe(1);
    expect(deletionPersistenceAttempts).toBe(4);
    const persistedSession = await bureau.getSession(run.sessionId);
    expect(persistedSession?.metadata['pendingApprovalOverrides']).toEqual({});
    expect(persistedSession?.metadata['approvalResolutionStartedIds']).toEqual([]);
    bureau.dispose();
  });

  it('revokes persisted approval bindings before deleting their session', async () => {
    const baseApprovalStore = createProcessLocalApprovalStateStore();
    let revocations = 0;
    const approvalStateStore = {
      ...baseApprovalStore,
      async revoke(binding: Parameters<typeof baseApprovalStore.revoke>[0]) {
        revocations += 1;
        return baseApprovalStore.revoke(binding);
      },
    };
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [
            { id: 'delete-session-approval', name: 'delete-session-tool', arguments: {} },
          ],
        },
      ]),
      toolbox: createToolbox(
        [
          createTool({
            name: 'delete-session-tool',
            version: '1.0.0',
            description: 'Must be revoked when its session is deleted',
            input: z.object({}),
            async execute() {
              return 'unexpected';
            },
          }),
        ],
        {
          approvalSecret: 'delete-session-secret',
          approvalStateStore,
          policy: {
            beforeExecute: () => ({
              allow: false,
              status: 'needs_approval',
              reason: 'Operator approval required',
              action: { message: 'Approve deletion test' },
            }),
          },
        },
      ),
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence: textValueStore(new MemoryStorage()),
    });
    const run = await bureau.createRun({ message: 'Request approval then delete the session' });
    await waitForRunCompletion(bureau, run.id);
    expect(bureau.listPendingReviews()).toHaveLength(1);

    await bureau.deleteSession(run.sessionId);
    expect(revocations).toBe(1);
    bureau.dispose();
  });

  it('throws NOT_CONFIGURED for session APIs when persistence is not configured', async () => {
    const bureau = await createBureau({
      agents: {},
    });

    const error = await bureau.listSessions().then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  it('lists, loads, and deletes sessions from the canonical session store', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    await waitForRunCompletion(bureau, run.id);

    const sessions = await bureau.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(run.sessionId);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.id).toBe(run.sessionId);

    await bureau.deleteRun(run.id);

    await bureau.deleteSession(run.sessionId);
    const deleted = await bureau.getSession(run.sessionId);
    expect(deleted).toBeUndefined();
  });

  it('returns configuration data with provider and tool summaries', async () => {
    const bureau = await createBureau({
      agents: {},
      provider: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'secret-value',
      },
    });

    const configuration = bureau.getConfiguration();
    const configurationProviderHasNoApiKey: HasApiKey<
      NonNullable<ConfigurationResponse['provider']>
    > = false;
    const routedConfigurationProviderHasNoApiKey: HasApiKey<
      ConfigurationResponse['providers'][number]['provider']
    > = false;

    expect(configuration.maximumSteps).toBe(DEFAULT_MAXIMUM_STEPS);
    expect(configuration.provider?.provider).toBe('anthropic');
    expect(configuration.providers).toHaveLength(1);
    expect(configuration.provider).not.toHaveProperty('apiKey');
    expect(configuration.providers[0]?.provider).not.toHaveProperty('apiKey');
    expect(configurationProviderHasNoApiKey).toBeFalse();
    expect(routedConfigurationProviderHasNoApiKey).toBeFalse();
  });

  it("stops a run with no explicit maximumSteps at operative's DEFAULT_MAXIMUM_STEPS (regression #251: bureau must not silently diverge from operative's step cap)", async () => {
    // REGRESSION: bureau exported its own DEFAULT_MAXIMUM_STEPS = 10 (dead code)
    // and runtime-composition hardcoded `?? 10`, while operative's loop actually
    // used DEFAULT_MAXIMUM_STEPS = 25. A bureau-created run silently capped at 10
    // steps instead of the 25 the same agent would get through operative directly.
    // This test drives a REAL run — not just getConfiguration() — past the
    // boundary so any future re-divergence between the two entry points fails here.
    const bureau = await createBureau({
      agents: {},
      generate: async () => ({
        content: 'calling',
        toolCalls: [{ name: 'next', arguments: {} }],
      }),
      toolbox: createToolbox([createNextTool()]),
      persistence: textValueStore(new MemoryStorage()),
      // No maximumSteps and no stopWhen — the run stops solely on the bureau's
      // default step cap, exercising the exact seam that diverged.
    });

    const run = await bureau.createRun({ message: 'Never settles' });
    await waitForRunCompletion(bureau, run.id);

    const detail = bureau.getRun(run.id);
    expect(detail?.finishReason).toBe('maximum-steps');
    expect(detail?.steps).toBe(DEFAULT_MAXIMUM_STEPS);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastRunStatus']).toBe('error');
    expect(session?.metadata['lastFinishReason']).toBe('maximum-steps');
    expect(session?.metadata['lastError']).toContain(
      `Agent run exceeded maximumSteps (${DEFAULT_MAXIMUM_STEPS}).`,
    );
  });

  it('configures a scheduler for routed multi-provider runtimes', async () => {
    const bureau = await createBureau({
      agents: {},
      providers: [
        {
          name: 'fast',
          provider: { provider: 'openai', model: 'gpt-4.1-mini' },
        },
        {
          name: 'deep',
          provider: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
        },
      ],
      routing: {
        type: 'step-based',
        first: 'fast',
        middle: 'deep',
      },
      scheduler: { enabled: true, idleDelay: 1 },
      toolbox: createEmptyToolbox(),
    });

    expect(bureau.scheduler).toBeDefined();
    bureau.dispose();
  });

  it('does not configure a scheduler unless it is explicitly enabled', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    expect(bureau.scheduler).toBeUndefined();
    bureau.dispose();
  });

  it('submits scheduler tasks with the configured runtime toolbox', async () => {
    const echoTool = createMockTool({
      name: 'echo',
      impl: () => 'echoed',
    });

    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ name: 'echo', arguments: {} }],
        },
        {
          content: 'done',
          toolCalls: [],
        },
      ]),
      scheduler: { enabled: true, idleDelay: 1 },
      toolbox: createTestToolbox([echoTool]),
    });

    const response = await bureau.submitSchedulerTask({
      message: 'Run a scheduled tool task',
      priority: 'background',
    });

    await waitForCondition(
      () => bureau.scheduler?.getState().completedCount === 1,
      'scheduled task did not complete',
    );

    expect(response.status).toBe('queued');
    expect(echoTool.calls).toHaveLength(1);
    expect(bureau.scheduler?.getState().completedCount).toBe(1);

    bureau.dispose();
  });

  it('throws BAD_REQUEST when submitSchedulerTask receives invalid scheduler-specific fields', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      scheduler: { enabled: true, idleDelay: 1 },
      toolbox: createEmptyToolbox(),
    });

    const invalidRequest = {
      message: 'Run a scheduled task',
      priority: 'urgent',
    } as unknown as Parameters<typeof bureau.submitSchedulerTask>[0];

    const error = await Promise.resolve()
      .then(() => bureau.submitSchedulerTask(invalidRequest))
      .then(
        () => undefined,
        (rejection) => rejection,
      );

    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect((error as Error).message).toBe(
      '"priority" must be one of: immediate, scheduled, background, ambient',
    );

    bureau.dispose();
  });

  it('returns tool summaries', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    expect(bureau.getTools()).toEqual([]);
  });

  it('returns run reports for unknown, active, and completed runs', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    expect(bureau.getRunReport('missing-report-run')).toBeUndefined();

    const active = createParkedActiveRun();
    bureau.store.register(active.activeRun, 'active-report-run');
    expect(bureau.getRunReport('active-report-run')).toMatchObject({
      runId: 'active-report-run',
    });

    const completed = await bureau.createRun({ message: 'Completed report' });
    await waitForRunCompletion(bureau, completed.id);
    expect(bureau.getRunReport(completed.id)?.runId).toBe(completed.id);

    bureau.dispose();
  });

  it('does not abort run setup when a subscribeLiveFrames listener throws (regression PRRT_kwDORvupsc6PxP_w)', async () => {
    // AB-96 codex review: `emitLiveFrame` fired listeners with no isolation. The
    // 'run-started' run-envelope frame is emitted BEFORE `store.register` +
    // the terminal listeners are installed, so a throwing subscriber there
    // used to propagate out of `createRun`, leaving the session persisted as
    // `running` and the ActiveRun launched but never registered — `getRun`
    // would return `undefined` forever for a run that is actually executing.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const goodFrameTypes: string[] = [];
    bureau.subscribeLiveFrames(() => {
      throw new Error('boom — a badly behaved subscriber');
    });
    bureau.subscribeLiveFrames((frame) => {
      goodFrameTypes.push(frame.type);
    });

    try {
      // createRun must not throw even though the first listener always throws.
      const run = await bureau.createRun({ message: 'Survive a throwing subscriber' });

      // The run must have been fully registered — not aborted mid-setup.
      expect(bureau.getRun(run.id)).toBeDefined();
      // A well-behaved sibling listener still received frames despite the
      // other listener throwing on every one of them.
      expect(goodFrameTypes.length).toBeGreaterThan(0);
    } finally {
      bureau.dispose();
    }
  });

  describe('onDiagnostic (#253)', () => {
    afterEach(() => {
      (console.error as unknown as { mockRestore?: () => void }).mockRestore?.();
    });

    it('routes a throwing subscribeLiveFrames listener to the diagnostic sink instead of the console', async () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const received: Array<{ level: string; scope: string; message: string; cause?: unknown }> =
        [];

      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        onDiagnostic: (diagnostic) => received.push(diagnostic),
      });

      bureau.subscribeLiveFrames(() => {
        throw new Error('boom — a badly behaved subscriber');
      });

      try {
        await bureau.createRun({ message: 'Route the throw to onDiagnostic' });

        expect(received.length).toBeGreaterThan(0);
        for (const diagnostic of received) {
          expect(diagnostic).toMatchObject({ level: 'error', scope: 'live-frames' });
        }
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        bureau.dispose();
      }
    });

    it('with no sink configured, a throwing subscribeLiveFrames listener still logs to the console', async () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
      });

      bureau.subscribeLiveFrames(() => {
        throw new Error('boom — a badly behaved subscriber');
      });

      try {
        await bureau.createRun({ message: 'Fall back to console with no sink' });

        expect(errorSpy).toHaveBeenCalled();
      } finally {
        bureau.dispose();
      }
    });

    it('falls back to the console for a diagnostic whose configured sink throws, without crashing the run', async () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        onDiagnostic: () => {
          throw new Error('a misbehaving diagnostic sink');
        },
      });

      bureau.subscribeLiveFrames(() => {
        throw new Error('boom — a badly behaved subscriber');
      });

      try {
        const run = await bureau.createRun({ message: 'Survive a throwing sink' });

        expect(bureau.getRun(run.id)).toBeDefined();
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        bureau.dispose();
      }
    });
  });

  it('emits one scheduler preempted frame with current state', async () => {
    const { generate: slowGenerate, resolve } = createBlockingGenerate();
    const schedulerFrames: Extract<
      ServerFrame,
      { type: 'scheduler.state' | 'scheduler.task.preempted' }
    >[] = [];

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      scheduler: { enabled: true, idleDelay: 1 },
    });

    const unsubscribe = bureau.subscribeLiveFrames((frame) => {
      if (frame.type === 'scheduler.state' || frame.type === 'scheduler.task.preempted') {
        schedulerFrames.push(frame);
      }
    });

    const backgroundResult = bureau.scheduler!.submit({
      id: 'background-task',
      priority: 'background',
      requeue: false,
      createRun: () => ({
        generate: slowGenerate,
        toolbox: createEmptyToolbox(),
        conversation: new Conversation(),
        maximumSteps: 5,
      }),
    });

    await waitForCondition(
      () => bureau.scheduler?.getState().activeTask?.id === 'background-task',
      'background task was not dispatched',
    );
    schedulerFrames.length = 0;

    const immediateResult = bureau.scheduler!.submitImmediate(() => ({
      generate: createMockGenerate('immediate-done'),
      toolbox: createEmptyToolbox(),
      conversation: new Conversation(),
      maximumSteps: 1,
    }));

    resolve({ content: 'background-step', toolCalls: [] });

    await immediateResult;
    await backgroundResult;
    await waitForCondition(
      () => schedulerFrames.some((frame) => frame.type === 'scheduler.task.preempted'),
      'scheduler preempted frame was not emitted',
    );

    const preemptedFrames = schedulerFrames.filter(
      (frame): frame is Extract<ServerFrame, { type: 'scheduler.task.preempted' }> =>
        frame.type === 'scheduler.task.preempted',
    );

    expect(preemptedFrames).toHaveLength(1);
    expect(preemptedFrames[0]?.taskId).toBe('background-task');
    expect(preemptedFrames[0]?.state.preemptedCount).toBeGreaterThanOrEqual(1);

    unsubscribe();
    bureau.dispose();
  });

  it('emits action events from live runs', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const actions: string[] = [];
    bureau.addEventListener('action', (event) => {
      actions.push(event.action.type);
    });

    const run = await bureau.createRun({ message: 'Hello' });
    await waitForRunCompletion(bureau, run.id);

    expect(actions.length).toBeGreaterThan(0);
  });

  it('disposes cleanly more than once', async () => {
    const bureau = await createBureau({
      agents: {},
    });
    await bureau.dispose();
    await bureau.dispose();
  });

  it('continues disposal when toolbox shutdown rejects', async () => {
    const toolbox = createEmptyToolbox();
    const diagnostics: string[] = [];
    const bureau = await createBureau({
      agents: {},
      toolbox,
      onDiagnostic: (event) => diagnostics.push(event.message),
    });
    toolbox.shutdown = async () => {
      throw new Error('toolbox shutdown failed');
    };

    const disposal = bureau.dispose();
    expect(bureau.dispose()).toBe(disposal);
    await disposal;
    expect(diagnostics).toContainEqual(expect.stringContaining('Error during toolbox shutdown'));
  });

  it('disposes a sqlite-backed durable bureau cleanly more than once', async () => {
    // The idempotency guard: a persistent bureau owns an engine AND a raw SQLite
    // handle, both released on dispose. A second dispose must NOT re-close the
    // already-closed SQLite connection (runtime-dependent whether that throws).
    const databasePath = join(
      tmpdir(),
      `dispose-twice-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        stopWhen: stopWhen.noToolCalls(),
      });
      bureau.dispose();
      // Second dispose is a no-op (guard short-circuits before re-closing).
      expect(() => bureau.dispose()).not.toThrow();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('releases backend handles even when a toObservable subscriber throws during dispose', async () => {
    // dispose() dispatches BureauDisposedEvent through the emitter, which routes
    // through CompletableEventTarget.dispatchEvent — an UN-guarded loop over
    // toObservable() subscribers (lifecycle/completable.ts). A subscriber whose
    // `next` throws therefore propagates straight into dispose()'s pre-teardown.
    // This is a real, public path (`toObservable()` is on the Bureau surface), so
    // pre-teardown is best-effort: dispose must swallow the throw and STILL release
    // the SQLite handle, exactly like the already-best-effort scheduler/memory steps.
    const databasePath = join(
      tmpdir(),
      `dispose-throwing-subscriber-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        stopWhen: stopWhen.noToolCalls(),
      });
      // A public-API subscriber that throws on the disposed event. With no guard
      // in dispose(), this would propagate out of `emitter.dispatch(...)` and
      // strand the SQLite handle behind the now-true `disposed` flag.
      bureau.toObservable().subscribe(() => {
        throw new Error('subscriber boom');
      });

      // dispose() must NOT propagate the subscriber throw...
      expect(() => bureau.dispose()).not.toThrow();
      // ...and the SQLite handle must still have been released — the second
      // dispose is a clean no-op rather than a double-close of a live handle.
      expect(() => bureau.dispose()).not.toThrow();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('createSchedule registers a native schedule and returns its summary on a durable bureau (#109)', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const summary = await bureau.createSchedule({
        agentName: 'researcher',
        input: 'Summarize overnight activity',
        spec: '0 9 * * *',
        sessionId: 'daily-digest',
      });

      expect(summary).toBeDefined();
      expect(summary?.workflowType).toBe('agentRun');
      expect(summary?.status).toBe('active');
      // A bare multi-field string is a cron expression (not duration shorthand).
      expect(summary?.cronExpression).toBe('0 9 * * *');
      expect(typeof summary?.id).toBe('string');

      // The schedule is then visible through the read surface.
      const fetched = await bureau.getSchedule(summary!.id);
      expect(fetched?.id).toBe(summary!.id);
      const listed = await bureau.listSchedules();
      expect(listed?.items.some((schedule) => schedule.id === summary!.id)).toBe(true);
    } finally {
      bureau.dispose();
    }
  });

  it('exposes optional service getters and the completable event surface', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    expect(bureau.auditTrail).toBeUndefined();
    expect(bureau.webhookNotifier).toBeUndefined();
    expect(bureau.onlineEvalSampler).toBeUndefined();
    expect(bureau.completed).toBe(false);
    expect(bureau.signal.aborted).toBe(false);

    const subscription = bureau.subscribe('action', () => {});
    subscription.unsubscribe();
    bureau.complete();

    expect(bureau.completed).toBe(true);
    expect(bureau.signal.aborted).toBe(true);
    bureau.dispose();
  });

  it('createSchedule registers a fixed-interval schedule for a weft duration spec', async () => {
    // A weft duration grammar string (e.g. '6h', '5 minutes') is a fixed interval,
    // not cron — toScheduleSpec wraps it as { every } so weft parses it as an
    // interval. ISO-8601 (`PT6H`) is NOT weft duration grammar and stays cron.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const hourly = await bureau.createSchedule({ agentName: 'a', input: 'x', spec: '6h' });
      expect(hourly?.intervalMs).toBe(6 * 60 * 60 * 1000);
      expect(hourly?.cronExpression).toBeUndefined();

      // Multi-word weft durations are intervals too (the prior single-token regex
      // wrongly routed these to cron).
      const everyFive = await bureau.createSchedule({
        agentName: 'a',
        input: 'x',
        spec: '5 minutes',
      });
      expect(everyFive?.intervalMs).toBe(5 * 60 * 1000);
      expect(everyFive?.cronExpression).toBeUndefined();
    } finally {
      bureau.dispose();
    }
  });

  it('createSchedule rejects a blank recurring sessionId and overlap:allow with a session (codex)', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });

    try {
      const blank = await bureau
        .createSchedule({ agentName: 'a', input: 'x', spec: '0 9 * * *', sessionId: '   ' })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      expect(blank).toBeInstanceOf(BureauError);
      expect((blank as BureauError).code).toBe('BAD_REQUEST');

      const overlapping = await bureau
        .createSchedule({
          agentName: 'a',
          input: 'x',
          spec: '0 9 * * *',
          sessionId: 'digest',
          overlap: 'allow',
        })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      expect(overlapping).toBeInstanceOf(BureauError);
      expect((overlapping as BureauError).code).toBe('BAD_REQUEST');

      // overlap:'allow' WITHOUT a session is fine (stateless fires may run concurrently).
      const ok = await bureau.createSchedule({
        agentName: 'a',
        input: 'x',
        spec: '0 9 * * *',
        overlap: 'allow',
      });
      expect(ok?.status).toBe('active');
    } finally {
      bureau.dispose();
    }
  });

  it('createSchedule throws NOT_CONFIGURED on a durable bureau with no generate (codex Mn69W)', async () => {
    // A durable bureau with no generate/provider would register a schedule whose
    // every fire throws "No generate function configured" at runtime. Reject up
    // front rather than hand back a healthy-looking summary for a broken schedule.
    const bureau = await createBureau({
      agents: {},
      storage: { type: 'memory' },
      durableExecution: true,
    });

    try {
      const error = await bureau
        .createSchedule({ agentName: 'a', input: 'x', spec: '0 9 * * *' })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('NOT_CONFIGURED');
      expect((error as BureauError).subject).toBe('generate');
    } finally {
      bureau.dispose();
    }
  });

  it('createSchedule returns undefined (no-op) on a non-durable bureau', async () => {
    // Without a durable engine there is nothing to schedule; the method short-
    // circuits to undefined before any registration, matching the other
    // durable-only accessors.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    try {
      const result = await bureau.createSchedule({
        agentName: 'researcher',
        input: 'noop',
        spec: '0 9 * * *',
      });
      expect(result).toBeUndefined();
    } finally {
      bureau.dispose();
    }
  });

  it('createSchedule throws ScheduleLocatorUnavailableError naming the scheduleId when describe() rejects after registration', async () => {
    // Stub weft's own `ScheduleHandle.describe()` — what `createAgentSchedule`
    // delegates `handle.describe()` to on the successful-registration path —
    // to reject exactly once, simulating a schedule that registered but whose
    // summary could not be retrieved immediately after. `createSchedule` must
    // wrap that rejection in a typed `ScheduleLocatorUnavailableError` naming
    // the scheduleId rather than letting the bare `Error` propagate untyped.
    const describeFailure = new Error('Schedule "whatever" not found');
    const describeSpy = spyOn(ScheduleHandle.prototype, 'describe').mockRejectedValueOnce(
      describeFailure,
    );

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      let caught: unknown;
      try {
        await bureau.createSchedule({
          agentName: 'researcher',
          input: 'Summarize overnight activity',
          spec: '0 9 * * *',
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ScheduleLocatorUnavailableError);
      const locatorError = caught as ScheduleLocatorUnavailableError;
      expect(locatorError.code).toBe('ScheduleLocatorUnavailableError');
      expect(locatorError.category).toBe('unavailable');
      expect(locatorError.retryable).toBe(false);
      // `createSchedule` had no stable `id` to pass through (no `id` field on
      // `DurableScheduleDefinition` — the uuid is Weft-assigned), so
      // `.scheduleId` is the value this test can actually assert equals the
      // one minted internally — not a generic placeholder — and `.message`
      // names the same id.
      expect(locatorError.scheduleId).toBeTruthy();
      expect(locatorError.message).toContain(locatorError.scheduleId);
      // The original `describe()` rejection is preserved for debugging, not
      // discarded.
      expect(locatorError.cause).toBe(describeFailure);

      // The schedule IS registered despite the describe() failure — a fresh
      // describe (via getSchedule, unaffected by the mockRejectedValueOnce)
      // proves registration succeeded and only the locator call failed.
      const fetched = await bureau.getSchedule(locatorError.scheduleId);
      expect(fetched?.status).toBe('active');
    } finally {
      describeSpy.mockRestore();
      bureau.dispose();
    }
  });
});

describe('createBureau: AB-64/AB-250 selection planning wiring', () => {
  it('flips selectorAvailable to true so a selectable Agent’s catalog-read profile reports selector: available', async () => {
    const seed = createModelCatalog();
    const geminiDescriptor = seed.descriptors.find(
      (descriptor) => descriptor.provider === 'gemini',
    );
    if (!geminiDescriptor) throw new Error('expected at least one seed gemini descriptor');

    const selectable = createAgent({
      generate: createSequentialGenerate([]),
      name: 'selectable',
      allowedCandidates: [{ provider: geminiDescriptor.provider, model: geminiDescriptor.model }],
    });

    const bureau = await createBureau({ agents: { selectable } });
    try {
      expect(bureau.agents.generationProfile('selectable')?.selector).toBe('available');
    } finally {
      bureau.dispose();
    }
  });

  it('a profile read directly off a standalone createAgent agent still reports unavailable, unaffected by Bureau wiring', async () => {
    const seed = createModelCatalog();
    const geminiDescriptor = seed.descriptors.find(
      (descriptor) => descriptor.provider === 'gemini',
    );
    if (!geminiDescriptor) throw new Error('expected at least one seed gemini descriptor');

    const selectable = createAgent({
      generate: createSequentialGenerate([]),
      name: 'selectable',
      allowedCandidates: [{ provider: geminiDescriptor.provider, model: geminiDescriptor.model }],
    });

    // Bureau's own wiring flips the CATALOG-READ profile — the standalone
    // agent's own `readGenerationProfile` answer is unaffected, permanently
    // (AB-64's decision record: a standalone `createAgent` agent has no
    // Bureau, no policy, and no catalog, so it can never select).
    const bureau = await createBureau({ agents: { selectable } });
    try {
      expect(selectable.generationProfile?.selector).toBe('unavailable');
      expect(bureau.agents.generationProfile('selectable')?.selector).toBe('available');
    } finally {
      bureau.dispose();
    }
  });

  it('bureau.planSelection builds a full SelectionPlan without starting a run or refreshing the catalog', async () => {
    const seed = createModelCatalog();
    const anthropicDescriptor = seed.descriptors.find(
      (descriptor) => descriptor.provider === 'anthropic',
    );
    if (!anthropicDescriptor) throw new Error('expected at least one seed anthropic descriptor');

    const fixed = createAgent({
      generate: createSequentialGenerate([]),
      name: 'fixed',
    });

    const bureau = await createBureau({ agents: { fixed } });
    try {
      const revisionBefore = bureau.modelCatalog.catalog().revision;
      const plan = bureau.planSelection({ agentName: 'fixed' });

      expect(plan).not.toBeInstanceOf(Promise);
      expect(bureau.modelCatalog.catalog().revision).toBe(revisionBefore);
    } finally {
      bureau.dispose();
    }
  });
});

describe('createBureau durable inspection surface', () => {
  it('getDurableRun and listDurableRuns return undefined when no durable engine is composed', async () => {
    // A memory-backed bureau with no durableExecution flag has no engine, so the
    // durable read accessors report "no durable surface" via undefined.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    expect(await bureau.getDurableRun('any-run')).toBeUndefined();
    expect(await bureau.listDurableRuns()).toBeUndefined();
    expect(await bureau.runDurableMaintenance()).toBeUndefined();
  });

  it('forwards host-driven maintenance to the durable engine', async () => {
    const probe = await createRuntimeComposition({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      runMaintenance: (now?: number) => Promise<void>;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();
    const maintenanceSpy = spyOn(enginePrototype, 'runMaintenance').mockResolvedValue(undefined);

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
        durableBackgroundTasks: 'manual',
      });
      try {
        expect(await bureau.runDurableMaintenance(123_456)).toBe(true);
        expect(maintenanceSpy).toHaveBeenCalledWith(123_456);
      } finally {
        bureau.dispose();
      }
    } finally {
      maintenanceSpy.mockRestore();
    }
  });

  it('getDurableRun returns null for an unknown run and state for a completed run', async () => {
    // durableExecution:true on a memory backend builds an engine, so the
    // accessors pass through to engine.get / engine.list.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });

    expect(await bureau.getDurableRun('nonexistent-run')).toBeNull();

    const run = await bureau.createRun({ message: 'durable inspection' });
    await waitForRunCompletion(bureau, run.id);

    const state = await bureau.getDurableRun(run.id);
    expect(state).not.toBeNull();
    expect(state?.status).toBe('completed');

    const listed = await bureau.listDurableRuns();
    expect(listed).toBeDefined();
    expect(listed!.items.some((summary) => summary.id === run.id)).toBe(true);
  });
});

describe('createBureau schedule management sentinel (regression PRRT_kwDORvupsc6MXEmg)', () => {
  // pauseSchedule / resumeSchedule / cancelSchedule previously returned void (i.e.
  // undefined) on success — indistinguishable from the undefined sentinel meaning
  // "no durable engine". Routes checking `result === undefined` would therefore
  // return 501 even when the operation succeeded.

  it('pauseSchedule / resumeSchedule / cancelSchedule return undefined when no durable engine is composed', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      // No storage / durableExecution — no engine
    });

    expect(await bureau.pauseSchedule('sched-1')).toBeUndefined();
    expect(await bureau.resumeSchedule('sched-1')).toBeUndefined();
    expect(await bureau.cancelSchedule('sched-1')).toBeUndefined();

    bureau.dispose();
  });

  it('pauseSchedule / resumeSchedule / cancelSchedule return true when a durable engine is composed', async () => {
    // Build a throwaway probe so we can reach the bundled Engine prototype.
    const probe = await createRuntimeComposition({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const realEngineProto = Object.getPrototypeOf(probe.durable!.engine) as object;
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();

    // Spy on the engine-level void methods so we don't need a real schedule in storage.
    const engineProtoTyped = realEngineProto as {
      pauseSchedule: (id: string) => Promise<void>;
      resumeSchedule: (id: string) => Promise<void>;
      cancelSchedule: (id: string) => Promise<void>;
    };
    const pauseSpy = spyOn(engineProtoTyped, 'pauseSchedule').mockResolvedValue(undefined);
    const resumeSpy = spyOn(engineProtoTyped, 'resumeSchedule').mockResolvedValue(undefined);
    const cancelSpy = spyOn(engineProtoTyped, 'cancelSchedule').mockResolvedValue(undefined);

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
      });

      try {
        // Each method must return true (operation performed), not undefined (no engine).
        expect(await bureau.pauseSchedule('sched-1')).toBe(true);
        expect(await bureau.resumeSchedule('sched-1')).toBe(true);
        expect(await bureau.cancelSchedule('sched-1')).toBe(true);

        // Confirm the engine methods were actually called through.
        expect(pauseSpy).toHaveBeenCalledWith('sched-1');
        expect(resumeSpy).toHaveBeenCalledWith('sched-1');
        expect(cancelSpy).toHaveBeenCalledWith('sched-1');
      } finally {
        bureau.dispose();
      }
    } finally {
      pauseSpy.mockRestore();
      resumeSpy.mockRestore();
      cancelSpy.mockRestore();
    }
  });
});

describe('createBureau scheduler-origin crash semantics (#25)', () => {
  let schedulerSweepDatabaseCounter = 0;

  it('sweeps a suspended scheduler-origin run left by a crash on the next boot', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-sched-sweep-${process.pid}-${schedulerSweepDatabaseCounter++}.sqlite`,
    );

    try {
      // === "Process 1": compose a durable engine over the SQLite file and start a
      // scheduler-origin durable run (tagged SCHEDULER_ORIGIN_TAG, with the phantom
      // sessionId === runId the real scheduler uses). Let it reach step 0, then
      // suspend it — simulating a preemption — and dispose the composition WITHOUT
      // resuming. That leaves a `suspended` scheduler run dangling in storage, the
      // exact hard-crash residue #25 must clean up. ===
      const runId = 'scheduler-run-sweep-me-1';
      // LEGACY residue: a scheduler-run-* id with the phantom sessionId but NO
      // SCHEDULER_ORIGIN_TAG — i.e. a suspended run left by a release before the
      // tag existed. A tag-only sweep would miss it; the prefix-based sweep must
      // still cancel it (Bugbot #38).
      const legacyRunId = 'scheduler-run-legacy-untagged-9';
      const composition = await createRuntimeComposition({
        generate: async () => new Promise<never>(() => {}), // hang so it stays in flight
        toolbox: createToolbox([]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });
      const engine = composition.durable!.engine;
      const checkpointStore = composition.durable!.checkpointStore;

      // Start the scheduler-origin runs (do not await — they hang in generate).
      // Their result() promises reject when the engine is disposed below
      // (EngineDisposed for a still-pending run); swallow that — it is the expected
      // crash semantic, not a test failure. One TAGGED (new-style), one UNTAGGED
      // (legacy residue).
      void startDurableRunResult(
        { engine, checkpointStore },
        {
          runId,
          sessionId: runId, // phantom: scheduler runs use sessionId === runId
          tags: [SCHEDULER_ORIGIN_TAG],
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: createToolbox([]),
            conversation: new Conversation(),
            stopWhen: stopWhen.noToolCalls(),
          },
        },
      ).catch(() => {});
      void startDurableRunResult(
        { engine, checkpointStore },
        {
          runId: legacyRunId,
          sessionId: legacyRunId,
          // NO tags — legacy residue from before SCHEDULER_ORIGIN_TAG existed.
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: createToolbox([]),
            conversation: new Conversation(),
            stopWhen: stopWhen.noToolCalls(),
          },
        },
      ).catch(() => {});

      // Wait until both runs are running, then suspend them.
      for (const id of [runId, legacyRunId]) {
        await pollUntil(async () => {
          const state = await engine.get(id);
          return state?.status === 'running';
        });
        await engine.suspend(id);
        const suspendedState = await engine.get(id);
        expect(suspendedState?.status).toBe('suspended');
      }

      // Tear down in the SAME order the production dispose path uses: dispose the
      // engine FIRST (it holds the open SQLite connection), THEN release the raw
      // storage handle. A single disposeStorage call — disposing twice could close
      // an already-closed handle.
      engine[Symbol.dispose]?.();
      composition.disposeStorage?.();

      // === "Process 2": a fresh bureau over the same SQLite file. recoverDurableRuns
      // runs the suspended-scheduler sweep at boot. The dangling suspended run must
      // be cancelled. ===
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      try {
        // The sweep is a multi-round-trip SQLite list+cancel on a cold boot — use a
        // generous poll bound (matching the other cross-process recovery tests),
        // and assert the poll actually succeeded rather than letting a timeout fall
        // through to a confusing downstream assertion. BOTH the tagged and the
        // untagged (legacy) scheduler runs must be cancelled — the sweep matches by
        // id prefix, not by tag.
        const swept = await pollUntil(async () => {
          const tagged = await bureau.getDurableRun(runId);
          const legacy = await bureau.getDurableRun(legacyRunId);
          return tagged?.status === 'cancelled' && legacy?.status === 'cancelled';
        }, 50);
        expect(swept).toBe(true);
        const taggedFinal = await bureau.getDurableRun(runId);
        const legacyFinal = await bureau.getDurableRun(legacyRunId);
        expect(taggedFinal?.status).toBe('cancelled');
        expect(legacyFinal?.status).toBe('cancelled');
      } finally {
        bureau.dispose();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });
});

describe('createBureau effectful hook idempotency (#27)', () => {
  // List only the experiential memories in a namespace (avoids the lint against
  // accessing a member directly off an await expression at each call site).
  // Pages the whole namespace — memory.list's 100-record default page would
  // under-count a long namespace (the same trap the production dedup guard pages
  // around), which the >1-page pagination test below depends on.
  async function listExperiential(memory: Memory, namespace: string) {
    const all: Awaited<ReturnType<Memory['list']>> = [];
    const pageSize = 200;
    for (let offset = 0; ; offset += pageSize) {
      const page = await memory.list({ namespace, limit: pageSize, offset });
      all.push(...page);
      if (page.length < pageSize) break;
    }
    return all.filter((entry) => entry.metadata['source'] === 'experiential');
  }

  it('persists an experiential memory tagged with a deterministic (runId:step) dedupeKey + effectful replay', async () => {
    const memory = createMemory({
      embedder: createMockEmbedder(128),
      storage: createInMemoryMemoryRecordStorage(),
    });
    await memory.init();

    const sessionId = 'memory-idempotency-session';
    const bureau = await createBureau({
      agents: {},
      generate: async () => ({ content: 'the stable remembered fact', toolCalls: [] }),
      toolbox: createEmptyToolbox(),
      memory,
      stopWhen: stopWhen.noToolCalls(),
      persistence: textValueStore(new MemoryStorage()),
    });

    try {
      const run = await bureau.createRun({ message: 'remember this', sessionId });
      await waitForRunCompletion(bureau, run.id);
      const persisted = await listExperiential(memory, sessionId);
      expect(persisted.length).toBe(1);
      // The dedupeKey is the durable operation's identity — runId:step — NOT a
      // content hash, so a divergent regenerate on replay still maps to one record.
      expect(persisted[0]!.metadata['dedupeKey']).toBe(`${run.id}:0`);
      expect(persisted[0]!.metadata['replay']).toBe('effectful');
    } finally {
      bureau.dispose();
    }
  });

  it('re-firing the persist hook for the same (runId, step) is a no-op even when content differs', async () => {
    // The real at-least-once hazard: a durable recovery re-runs the crashed final
    // step, firing the effectful persist hook AGAIN for the SAME (runId, step) —
    // and `generate` re-runs, so the regenerated content may DIFFER. Idempotency is
    // keyed on runId:step (not on content), so the re-fire must be a no-op against
    // a shared memory backend. Tested directly against the hook, which is the
    // deterministic way to exercise the re-fire without racing a real mid-memo
    // crash. (Skip-on-replay would instead DROP the write; this proves we dedup,
    // not drop, AND that a divergent regenerate does not slip a duplicate through.)
    const memory = createMemory({
      embedder: createMockEmbedder(128),
      storage: createInMemoryMemoryRecordStorage(),
    });
    await memory.init();

    const namespace = 'hook-idempotency-ns';
    const runId = 'run-fixed-id';
    const hook = createMemoryPersistHook(memory, namespace, runId);
    for (let i = 0; i < 125; i++) {
      await memory.remember(`seed memory ${i} with unique content ${i * 7919}`, {
        namespace,
        source: 'manual',
      });
    }
    expect(await memory.count(namespace)).toBe(125);

    // A minimal final StepResult for step 0; only final/content/step are read.
    const stepResult = (content: string) => ({
      step: 0,
      conversation: new Conversation(),
      content,
      toolCalls: [] as never[],
      results: [] as never[],
      final: true,
    });

    // First fire (pre-crash execution): persists one experiential memory.
    await hook(stepResult('original content'));
    const afterFirst = await listExperiential(memory, namespace);
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0]!.metadata['dedupeKey']).toBe(`${runId}:0`);

    // Re-fire (recovery replay) for the SAME (runId, step) but DIVERGENT content.
    // The dedupeKey guard skips the write — count stays 1, not 2.
    await hook(stepResult('different regenerated content'));
    const afterRefire = await listExperiential(memory, namespace);
    expect(afterRefire.length).toBe(1);
    expect(await memory.count(namespace)).toBe(126);
    // The original write survived (not overwritten/dropped) — at-least-once is safe.
    expect(afterRefire[0]!.content).toBe('original content');
  });

  it('persists distinct memories for different (runId, step) pairs', async () => {
    // Idempotency must not OVER-dedup: distinct durable operations (a different run
    // or a different step) are different memories. Use distinct content per write
    // so the memory store's own near-identical vector dedup does not merge them —
    // the point here is that the per-(runId,step) key guard does not wrongly skip a
    // genuinely-different operation.
    const memory = createMemory({
      embedder: createMockEmbedder(128),
      storage: createInMemoryMemoryRecordStorage(),
    });
    await memory.init();

    const namespace = 'hook-distinct-ns';
    const stepResult = (step: number, content: string) => ({
      step,
      conversation: new Conversation(),
      content,
      toolCalls: [] as never[],
      results: [] as never[],
      final: true,
    });

    await createMemoryPersistHook(memory, namespace, 'run-A')(stepResult(0, 'fact from run A'));
    await createMemoryPersistHook(
      memory,
      namespace,
      'run-B',
    )(stepResult(0, 'a wholly separate fact from run B'));

    const persisted = await listExperiential(memory, namespace);
    const keys = persisted.map((e) => e.metadata['dedupeKey']).sort();
    expect(keys).toEqual(['run-A:0', 'run-B:0']);
  });
});

describe('classifyRecoveredRun', () => {
  const base = {
    handleId: 'run-1',
    scheduledFire: false,
    ownedSessionId: 'session-1' as string | undefined,
    metadataReadFailed: false,
    hasSessionStore: true,
    sessionLoad: { ok: true as const, session: { lastRunId: 'run-1', lastRunStatus: 'running' } },
  };

  it('reattaches an owned, in-flight run whose session confirms ownership', () => {
    expect(classifyRecoveredRun(base)).toBe('reattach');
  });

  it('monitors a scheduled fire without cancelling or reattaching it', () => {
    expect(
      classifyRecoveredRun({
        ...base,
        scheduledFire: true,
        ownedSessionId: undefined,
        sessionLoad: { ok: true, session: null },
      }),
    ).toBe('monitor');
  });

  it('prefers confirmed interactive ownership over a scheduled-fire flag', () => {
    expect(classifyRecoveredRun({ ...base, scheduledFire: true })).toBe('reattach');
  });

  it('reattaches even when the engine-finished-fast run still shows running in its session', () => {
    // The session monitor has not written the terminal status yet — must reattach
    // so the completion is persisted (gate on SESSION status, not engine status).
    expect(
      classifyRecoveredRun({
        ...base,
        sessionLoad: { ok: true, session: { lastRunId: 'run-1', lastRunStatus: 'running' } },
      }),
    ).toBe('reattach');
  });

  it('cancels a run whose launch metadata could not be read', () => {
    expect(classifyRecoveredRun({ ...base, metadataReadFailed: true })).toBe('cancel');
  });

  it('cancels a run that is not a bureau-owned agentRun (no owned session id)', () => {
    expect(classifyRecoveredRun({ ...base, ownedSessionId: undefined })).toBe('cancel');
  });

  it('cancels a run whose owning session is absent', () => {
    expect(classifyRecoveredRun({ ...base, sessionLoad: { ok: true, session: null } })).toBe(
      'cancel',
    );
  });

  it('cancels a run whose session now owns a different run', () => {
    expect(
      classifyRecoveredRun({
        ...base,
        sessionLoad: { ok: true, session: { lastRunId: 'other-run', lastRunStatus: 'running' } },
      }),
    ).toBe('cancel');
  });

  it('cancels a run whose session is already terminal (resolver reconciled it to error)', () => {
    expect(
      classifyRecoveredRun({
        ...base,
        sessionLoad: { ok: true, session: { lastRunId: 'run-1', lastRunStatus: 'error' } },
      }),
    ).toBe('cancel');
  });

  it('SKIPS (does not cancel) when the session load failed transiently — never kills a recovering run', () => {
    // The Bugbot finding: a transient storage read failure must not terminate a
    // legitimately-recovered in-flight run. Ownership is UNKNOWN → skip, not cancel.
    expect(classifyRecoveredRun({ ...base, sessionLoad: { ok: false } })).toBe('skip');
  });

  it('skips an owned run when no session store is configured (cannot reattach, must not cancel)', () => {
    expect(classifyRecoveredRun({ ...base, hasSessionStore: false })).toBe('skip');
  });

  // AB-10 — workflow versioning: a run that would otherwise reattach is flagged
  // distinctly (not blocked) when the durable engine detected a stamped-version
  // mismatch during recovery.
  it('flags a reattaching run as reattach-version-mismatch when versionMismatch is set', () => {
    expect(classifyRecoveredRun({ ...base, versionMismatch: true })).toBe(
      'reattach-version-mismatch',
    );
  });

  it('reattaches normally when versionMismatch is false or omitted', () => {
    expect(classifyRecoveredRun({ ...base, versionMismatch: false })).toBe('reattach');
    expect(classifyRecoveredRun(base)).toBe('reattach');
  });

  it('does not flag a cancelled run as version-mismatched even when versionMismatch is set', () => {
    // versionMismatch only distinguishes the 'reattach' outcome — an unowned /
    // cancelled run stays 'cancel' regardless of the durable engine's version flag.
    expect(
      classifyRecoveredRun({ ...base, ownedSessionId: undefined, versionMismatch: true }),
    ).toBe('cancel');
  });
});

describe('classifyRecoveredRunDetailed', () => {
  const base = {
    handleId: 'run-1',
    scheduledFire: false,
    ownedSessionId: 'session-1' as string | undefined,
    metadataReadFailed: false,
    hasSessionStore: true,
    sessionLoad: { ok: true as const, session: { lastRunId: 'run-1', lastRunStatus: 'running' } },
  };

  it('carries no rejection reason for a reattach verdict', () => {
    expect(classifyRecoveredRunDetailed(base)).toEqual({ verdict: 'reattach' });
  });

  it('carries no rejection reason for a monitor verdict', () => {
    expect(
      classifyRecoveredRunDetailed({
        ...base,
        scheduledFire: true,
        ownedSessionId: undefined,
        sessionLoad: { ok: true, session: null },
      }),
    ).toEqual({ verdict: 'monitor' });
  });

  it('carries no rejection reason for a skip verdict (session load failed transiently)', () => {
    expect(classifyRecoveredRunDetailed({ ...base, sessionLoad: { ok: false } })).toEqual({
      verdict: 'skip',
    });
  });

  it('carries no rejection reason for a skip verdict (no session store)', () => {
    expect(classifyRecoveredRunDetailed({ ...base, hasSessionStore: false })).toEqual({
      verdict: 'skip',
    });
  });

  it("reports 'metadata-read-failed' when the launch metadata read threw", () => {
    expect(classifyRecoveredRunDetailed({ ...base, metadataReadFailed: true })).toEqual({
      verdict: 'cancel',
      rejection: 'metadata-read-failed',
    });
  });

  it("reports 'foreign-input' for a non-bureau-owned, non-scheduled-fire handle", () => {
    expect(classifyRecoveredRunDetailed({ ...base, ownedSessionId: undefined })).toEqual({
      verdict: 'cancel',
      rejection: 'foreign-input',
    });
  });

  it("reports 'session-absent' when the owning session no longer exists", () => {
    expect(
      classifyRecoveredRunDetailed({ ...base, sessionLoad: { ok: true, session: null } }),
    ).toEqual({ verdict: 'cancel', rejection: 'session-absent' });
  });

  it("reports 'session-run-mismatch' when the session now owns a different run", () => {
    expect(
      classifyRecoveredRunDetailed({
        ...base,
        sessionLoad: { ok: true, session: { lastRunId: 'other-run', lastRunStatus: 'running' } },
      }),
    ).toEqual({ verdict: 'cancel', rejection: 'session-run-mismatch' });
  });

  it("reports 'session-not-running' when the session is already terminal", () => {
    expect(
      classifyRecoveredRunDetailed({
        ...base,
        sessionLoad: { ok: true, session: { lastRunId: 'run-1', lastRunStatus: 'error' } },
      }),
    ).toEqual({ verdict: 'cancel', rejection: 'session-not-running' });
  });

  it('reports reattach-version-mismatch with no rejection reason', () => {
    expect(classifyRecoveredRunDetailed({ ...base, versionMismatch: true })).toEqual({
      verdict: 'reattach-version-mismatch',
    });
  });

  it("classifyRecoveredRun's plain verdict always matches classifyRecoveredRunDetailed's verdict", () => {
    for (const args of [
      base,
      {
        ...base,
        scheduledFire: true,
        ownedSessionId: undefined,
        sessionLoad: { ok: true as const, session: null },
      },
      { ...base, metadataReadFailed: true },
      { ...base, ownedSessionId: undefined },
      { ...base, sessionLoad: { ok: false as const } },
      { ...base, hasSessionStore: false },
      { ...base, versionMismatch: true },
    ]) {
      expect(classifyRecoveredRun(args)).toBe(classifyRecoveredRunDetailed(args).verdict);
    }
  });
});

describe('isRecoverableScheduledFireInput', () => {
  it('requires the scheduled input shape and a non-empty persisted schedule marker', () => {
    expect(
      isRecoverableScheduledFireInput({
        agentName: 'researcher',
        input: 'scheduled prompt',
        scheduleId: 'daily-digest',
      }),
    ).toBe(true);
    expect(
      isRecoverableScheduledFireInput({
        agentName: 'researcher',
        input: 'scheduled prompt',
      }),
    ).toBe(false);
    expect(
      isRecoverableScheduledFireInput({
        agentName: 'researcher',
        input: 'scheduled prompt',
        scheduleId: '   ',
      }),
    ).toBe(false);
  });
});

describe('monitorRecoveredScheduledFire', () => {
  it('logs resolved error finish reasons from recovered scheduled fires', async () => {
    const originalError = console.error;
    const messages: string[] = [];
    console.error = (...args: unknown[]) => {
      messages.push(args.map(String).join(' '));
    };

    try {
      await monitorRecoveredScheduledFire({
        id: 'scheduled-fire-1',
        result: async () => ({
          runId: 'scheduled-fire-1',
          steps: 0,
          content: '',
          finishReason: 'error',
          errorMessage: 'generate failed',
        }),
      });
    } finally {
      console.error = originalError;
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('scheduled-fire-1');
    expect(messages[0]).toContain('finished with error');
    expect(messages[0]).toContain('generate failed');
  });

  it('logs maximum-steps from recovered scheduled fires as failures', async () => {
    const messages: string[] = [];

    await monitorRecoveredScheduledFire(
      {
        id: 'scheduled-fire-maximum',
        result: async () => ({
          runId: 'scheduled-fire-maximum',
          steps: 3,
          content: 'looping',
          finishReason: 'maximum-steps',
        }),
      },
      (diagnostic) => {
        messages.push(diagnostic.message);
      },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('scheduled-fire-maximum');
    expect(messages[0]).toContain('finished with maximum-steps');
  });
});

describe('monitorRecoveredCatalogRun (AB-240)', () => {
  it('logs resolved error finish reasons from a recovered catalog run', async () => {
    const messages: string[] = [];

    await monitorRecoveredCatalogRun(
      {
        id: 'agent-run-catalog-1',
        result: async () => ({
          runId: 'agent-run-catalog-1',
          steps: 1,
          content: '',
          finishReason: 'error',
          errorMessage: 'provider unavailable',
        }),
      },
      'echo',
      (diagnostic) => {
        messages.push(diagnostic.message);
      },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('agent-run-catalog-1');
    expect(messages[0]).toContain('echo');
    expect(messages[0]).toContain('finished with error');
    expect(messages[0]).toContain('provider unavailable');
  });

  it('logs maximum-steps from a recovered catalog run as a failure', async () => {
    const messages: string[] = [];

    await monitorRecoveredCatalogRun(
      {
        id: 'agent-run-catalog-2',
        result: async () => ({
          runId: 'agent-run-catalog-2',
          steps: 25,
          content: 'looping',
          finishReason: 'maximum-steps',
        }),
      },
      'echo',
      (diagnostic) => {
        messages.push(diagnostic.message);
      },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('agent-run-catalog-2');
    expect(messages[0]).toContain('finished with maximum-steps');
  });

  it('does not diagnose a successfully completed recovered catalog run', async () => {
    const messages: string[] = [];

    await monitorRecoveredCatalogRun(
      {
        id: 'agent-run-catalog-3',
        result: async () => ({
          runId: 'agent-run-catalog-3',
          steps: 1,
          content: 'done',
          finishReason: 'completed',
        }),
      },
      'echo',
      (diagnostic) => {
        messages.push(diagnostic.message);
      },
    );

    expect(messages).toHaveLength(0);
  });

  it('logs a rejected result() (the handle itself failed, not just a bad finishReason)', async () => {
    const messages: string[] = [];

    await monitorRecoveredCatalogRun(
      {
        id: 'agent-run-catalog-4',
        result: async () => {
          throw new Error('engine.recoverAll rejected this handle');
        },
      },
      'echo',
      (diagnostic) => {
        messages.push(diagnostic.message);
      },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('agent-run-catalog-4');
    expect(messages[0]).toContain('echo');
    expect(messages[0]).toContain('engine.recoverAll rejected this handle');
  });

  it('defaults to the shared diagnostic sink when none is supplied', async () => {
    const originalError = console.error;
    const messages: string[] = [];
    console.error = (...args: unknown[]) => {
      messages.push(args.map(String).join(' '));
    };

    try {
      await monitorRecoveredCatalogRun(
        {
          id: 'agent-run-catalog-5',
          result: async () => ({
            runId: 'agent-run-catalog-5',
            steps: 1,
            content: '',
            finishReason: 'error',
            errorMessage: 'default sink',
          }),
        },
        'echo',
      );
    } finally {
      console.error = originalError;
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('default sink');
  });
});

describe('createBureau session signal/update/query without durable engine', () => {
  // Regression for findings PRRT_kwDORvupsc6MXEmd and PRRT_kwDORvupsc6MXEmm:
  // signalSession / updateSession / querySession must throw BureauError('NOT_CONFIGURED')
  // when no durable engine is composed, not return undefined. Returning undefined was
  // indistinguishable from a void signal result or a handler that returns undefined,
  // causing the gateway route to respond 501 even on successful signal delivery.

  it('signalSession throws NOT_CONFIGURED when no durable engine is composed', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const error = await bureau
      .signalSession('any-session', 'any-signal')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_CONFIGURED');
    expect((error as BureauError).subject).toBe('durable');
  });

  it('updateSession throws NOT_CONFIGURED when no durable engine is composed', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const error = await bureau
      .updateSession('any-session', 'any-update')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_CONFIGURED');
    expect((error as BureauError).subject).toBe('durable');
  });

  it('querySession throws NOT_CONFIGURED when no durable engine is composed', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const error = await bureau
      .querySession('any-session', 'any-query')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_CONFIGURED');
    expect((error as BureauError).subject).toBe('durable');
  });
});

describe('createBureau session update/query capability unavailability (AB-192)', () => {
  // AB-41 coordinator ruling: updateSession/querySession are kept, not
  // withdrawn, but the built-in agentRun workflow registers no
  // ctx.onUpdate/ctx.onQuery handler, so both unconditionally throw
  // BureauError('UNSUPPORTED_CAPABILITY') once a durable engine IS configured
  // and the session has an active run — never reaching engine.update/query.

  it('updateSession throws UNSUPPORTED_CAPABILITY when a durable engine is configured', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const run = await bureau.createRun({ message: 'Wait for a signal' });
      await pollUntil(async () => {
        const session = await bureau.getSession(run.sessionId);
        return session?.metadata['lastRunStatus'] === 'running';
      });

      const error = await bureau.updateSession(run.sessionId, 'any-update').then(
        () => undefined,
        (rejection) => rejection,
      );

      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('UNSUPPORTED_CAPABILITY');
    } finally {
      await bureau.dispose();
    }
  });

  it('querySession throws UNSUPPORTED_CAPABILITY when a durable engine is configured', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const run = await bureau.createRun({ message: 'Wait for a signal' });
      await pollUntil(async () => {
        const session = await bureau.getSession(run.sessionId);
        return session?.metadata['lastRunStatus'] === 'running';
      });

      const error = await bureau.querySession(run.sessionId, 'any-query').then(
        () => undefined,
        (rejection) => rejection,
      );

      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('UNSUPPORTED_CAPABILITY');
    } finally {
      await bureau.dispose();
    }
  });

  it('exposes sessionVerbCapabilities reporting update and query as unsupported', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });
    try {
      expect(bureau.sessionVerbCapabilities).toEqual({ signal: true, update: false, query: false });
    } finally {
      await bureau.dispose();
    }
  });
});

describe('recordedSessionAuthorityPrincipalId / isSessionAuthorityAuthorized (AB-194)', () => {
  it('returns undefined when the session has recorded no authority at all', () => {
    expect(recordedSessionAuthorityPrincipalId({})).toBeUndefined();
  });

  it('reads the per-run principalId from lastRequestAuthorities keyed by lastRunId', () => {
    const principalId = recordedSessionAuthorityPrincipalId({
      lastRunId: 'run-1',
      lastRequestAuthorities: {
        'run-1': {
          principalId: 'alice',
          tenantId: 'bureau',
          ownerId: 'agent',
          capabilities: ['tools:execute'],
          authorizationRevision: 'bureau:1',
        },
      },
    });
    expect(principalId).toBe('alice');
  });

  it('does NOT fall back to legacy when lastRequestAuthorities is non-empty but uncorrelated to lastRunId (concurrent-run shape) — fails closed instead', () => {
    // Regression (Codex review, fifth pass): a non-empty map holding some
    // OTHER run's entry, alongside a legacy field, is exactly the shape two
    // concurrent runs on one session produce — run B's dispatch overwrites
    // the singular legacy field with B's authority while A is still running;
    // A's own terminal cleanup later prunes only A's key, leaving B's
    // (unrelated) entry and B's legacy authority behind. Trusting legacy
    // here would authorize B's principal against A's terminal session. This
    // is checked BEFORE the legacy fallback specifically to prevent that:
    // a non-empty-but-uncorrelated map fails closed rather than consulting
    // an unrelated concurrent run's legacy authority.
    const metadata = {
      lastRunId: 'run-1',
      lastRequestAuthorities: {
        'some-other-run': {
          principalId: 'someone-else',
          tenantId: 'bureau',
          ownerId: 'agent',
          capabilities: ['tools:execute'],
          authorizationRevision: 'bureau:1',
        },
      },
      lastRequestAuthority: {
        principalId: 'legacy-alice',
        tenantId: 'bureau',
        ownerId: 'agent',
        capabilities: ['tools:execute'],
        authorizationRevision: 'bureau:1',
      },
    };
    expect(recordedSessionAuthorityPrincipalId(metadata)).toBeUndefined();
    expect(isSessionAuthorityAuthorized(metadata, 'legacy-alice')).toBe(false);
    expect(isSessionAuthorityAuthorized(metadata, 'someone-else')).toBe(false);
  });

  it('falls back to the legacy lastRequestAuthority when lastRequestAuthorities is an empty object', () => {
    const principalId = recordedSessionAuthorityPrincipalId({
      lastRunId: 'run-1',
      lastRequestAuthorities: {},
      lastRequestAuthority: {
        principalId: 'legacy-carol',
        tenantId: 'bureau',
        ownerId: 'agent',
        capabilities: ['tools:execute'],
        authorizationRevision: 'bureau:1',
      },
    });
    expect(principalId).toBe('legacy-carol');
  });

  it('falls back to the legacy lastRequestAuthority when no lastRunId is recorded', () => {
    const principalId = recordedSessionAuthorityPrincipalId({
      lastRequestAuthority: {
        principalId: 'legacy-bob',
        tenantId: 'bureau',
        ownerId: 'agent',
        capabilities: ['tools:execute'],
        authorizationRevision: 'bureau:1',
      },
    });
    expect(principalId).toBe('legacy-bob');
  });

  it('returns undefined when the recorded authority candidate is malformed', () => {
    expect(
      recordedSessionAuthorityPrincipalId({
        lastRunId: 'run-1',
        lastRequestAuthorities: { 'run-1': 'not-an-object' },
      }),
    ).toBeUndefined();
    expect(
      recordedSessionAuthorityPrincipalId({
        lastRequestAuthority: ['not-an-object'],
      }),
    ).toBeUndefined();
    expect(
      recordedSessionAuthorityPrincipalId({
        lastRunId: 'run-1',
        lastRequestAuthorities: { 'run-1': { principalId: 42 } },
      }),
    ).toBeUndefined();
  });

  it('treats a session with no recorded authority as open (every principal authorized)', () => {
    expect(isSessionAuthorityAuthorized({}, 'anyone')).toBe(true);
  });

  it('authorizes the exact recorded principal and rejects every other principal', () => {
    const metadata = {
      lastRunId: 'run-1',
      lastRequestAuthorities: {
        'run-1': {
          principalId: 'alice',
          tenantId: 'bureau',
          ownerId: 'agent',
          capabilities: ['tools:execute'],
          authorizationRevision: 'bureau:1',
        },
      },
    };
    expect(isSessionAuthorityAuthorized(metadata, 'alice')).toBe(true);
    expect(isSessionAuthorityAuthorized(metadata, 'mallory')).toBe(false);
  });

  it('fails closed (denies every principal) when the per-run authority entry is malformed, even with a valid legacy fallback available', () => {
    // Regression (Codex review): a recorded-but-malformed per-run entry must
    // NOT be conflated with "no authority recorded at all" (which
    // isSessionAuthorityAuthorized treats as open) and must NOT silently
    // fall back to a legacy field that happens to be valid — a corrupted or
    // partially-written record denies access rather than granting it.
    const metadata = {
      lastRunId: 'run-1',
      lastRequestAuthorities: {
        'run-1': { principalId: 42 },
      },
      lastRequestAuthority: {
        principalId: 'legacy-alice',
        tenantId: 'bureau',
        ownerId: 'agent',
        capabilities: ['tools:execute'],
        authorizationRevision: 'bureau:1',
      },
    };
    expect(isSessionAuthorityAuthorized(metadata, 'legacy-alice')).toBe(false);
    expect(isSessionAuthorityAuthorized(metadata, 'anyone-else')).toBe(false);
    expect(recordedSessionAuthorityPrincipalId(metadata)).toBeUndefined();
  });

  it('fails closed (denies every principal) when lastRequestAuthorities itself is a malformed container, even with no legacy fallback at all', () => {
    // Regression (Codex review, second pass): a PRESENT-but-malformed
    // lastRequestAuthorities value (an array or string, not a map) is itself
    // evidence something was recorded and corrupted — it must fail closed
    // regardless of lastRunId or a legacy field, never be read as "nothing
    // recorded" (which would authorize any principal).
    expect(
      isSessionAuthorityAuthorized(
        { lastRunId: 'run-1', lastRequestAuthorities: ['not-a-map'] },
        'anyone',
      ),
    ).toBe(false);
    expect(
      isSessionAuthorityAuthorized(
        { lastRunId: 'run-1', lastRequestAuthorities: 'not-a-map' },
        'anyone',
      ),
    ).toBe(false);
    expect(
      recordedSessionAuthorityPrincipalId({
        lastRunId: 'run-1',
        lastRequestAuthorities: ['not-a-map'],
      }),
    ).toBeUndefined();
  });

  it('fails closed (denies every principal) when a non-empty lastRequestAuthorities map cannot be correlated to lastRunId and no legacy fallback exists', () => {
    // Regression (Codex review, third pass): a valid, NON-EMPTY
    // lastRequestAuthorities map that simply doesn't name an entry for this
    // lastRunId (missing/corrupt lastRunId, or entries keyed to other runs)
    // is recorded-but-uncorrelated evidence, not "nothing recorded" — it
    // must fail closed too, when there is no legacy field to fall back to.
    const metadataMissingLastRunId = {
      lastRequestAuthorities: {
        'some-run': {
          principalId: 'someone',
          tenantId: 'bureau',
          ownerId: 'agent',
          capabilities: ['tools:execute'],
          authorizationRevision: 'bureau:1',
        },
      },
    };
    expect(isSessionAuthorityAuthorized(metadataMissingLastRunId, 'anyone')).toBe(false);
    expect(recordedSessionAuthorityPrincipalId(metadataMissingLastRunId)).toBeUndefined();

    const metadataUncorrelatedLastRunId = {
      lastRunId: 'run-not-in-map',
      lastRequestAuthorities: {
        'some-other-run': {
          principalId: 'someone',
          tenantId: 'bureau',
          ownerId: 'agent',
          capabilities: ['tools:execute'],
          authorizationRevision: 'bureau:1',
        },
      },
    };
    expect(isSessionAuthorityAuthorized(metadataUncorrelatedLastRunId, 'anyone')).toBe(false);
  });

  it("authorizes against an explicitly targeted run's own entry, not lastRunId, when a different concurrent run's more recent terminal transition left the map uncorrelated to lastRunId (PR #430 review, Codex P2, second wave — 'Authorize against the targeted live run')", () => {
    // Two concurrent runs, A (still live) and B (completed first). B's own
    // terminal transition prunes ONLY lastRequestAuthorities[B] (per this
    // file's own pruning rule near `remainingAuthorities`), leaving
    // lastRunId: 'run-b' and A's now-uncorrelated 'run-a' entry behind —
    // exactly the shape the previous test proves fails closed for EVERY
    // principal under the default (lastRunId-only) lookup.
    const metadata = {
      lastRunId: 'run-b',
      lastRequestAuthorities: {
        'run-a': {
          principalId: 'alice',
          tenantId: 'bureau',
          ownerId: 'agent',
          capabilities: ['tools:execute'],
          authorizationRevision: 'bureau:1',
        },
      },
    };
    // The default (no targetRunId) lookup still fails closed — unchanged.
    expect(isSessionAuthorityAuthorized(metadata, 'alice')).toBe(false);

    // A command explicitly targeting the still-live run A resolves against
    // A's own entry directly, authorizing alice and rejecting anyone else.
    expect(isSessionAuthorityAuthorized(metadata, 'alice', 'run-a')).toBe(true);
    expect(isSessionAuthorityAuthorized(metadata, 'mallory', 'run-a')).toBe(false);

    // Targeting a run with no entry of its own at all still fails closed —
    // this is defense against authorizing a run this map says nothing
    // about, not a general bypass of the uncorrelated-map rule.
    expect(isSessionAuthorityAuthorized(metadata, 'alice', 'run-c')).toBe(false);
  });
});

describe('isSessionRunTerminal (AB-194)', () => {
  it('is false when lastRunStatus is running', () => {
    expect(isSessionRunTerminal({ lastRunStatus: 'running' })).toBe(false);
  });

  it('is true for every non-running status, including absent', () => {
    expect(isSessionRunTerminal({ lastRunStatus: 'completed' })).toBe(true);
    expect(isSessionRunTerminal({ lastRunStatus: 'error' })).toBe(true);
    expect(isSessionRunTerminal({ lastRunStatus: 'aborted' })).toBe(true);
    expect(isSessionRunTerminal({})).toBe(true);
  });
});

describe('createBureau submitSessionInput pre-admission checks (AB-194)', () => {
  // AB-42's fixed pre-admission check order: authorization, then session
  // lifecycle, then capability/capacity. No adopted @lostgradient/weft
  // version exposes WFT-84's durable mailbox yet, so every authorized,
  // non-terminal request unconditionally returns 'unsupported-capability' —
  // 'admitted'/'replayed'/'conflict'/'backlog-exhausted' are structurally
  // unreachable until ab-42-bureau-b lands. A `runtime.durable` with no
  // mailbox composed is exactly today's real configuration, per the issue's
  // testing plan — no mailbox double needed.

  it('returns not-found for an unknown sessionId', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const outcome = await bureau.submitSessionInput('unknown-session', {
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'hello',
      });
      expect(outcome).toEqual({ outcome: 'not-found' });
    } finally {
      await bureau.dispose();
    }
  });

  it('returns not-found (not a NOT_CONFIGURED throw) when no session store is composed', async () => {
    // Regression (Codex review): an ephemeral bureau (no persistence/storage)
    // is a supported configuration, unlike signalSession/updateSession/
    // querySession which throw BureauError('NOT_CONFIGURED') in that case.
    // Every sessionId is necessarily unknown without a session store, so the
    // correct outcome per this method's own contract is not-found.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });
    try {
      const outcome = await bureau.submitSessionInput('any-session', {
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'hello',
      });
      expect(outcome).toEqual({ outcome: 'not-found' });
    } finally {
      await bureau.dispose();
    }
  });

  it('returns not-found for an unauthorized caller, indistinguishable from an unknown session', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const run = await bureau.createRun({ message: 'Wait for a signal', principal: 'alice' });
      await pollUntil(async () => {
        const session = await bureau.getSession(run.sessionId);
        return session?.metadata['lastRunStatus'] === 'running';
      });

      const outcome = await bureau.submitSessionInput(run.sessionId, {
        principal: 'mallory',
        deliveryMode: 'steer',
        payload: 'hello',
      });
      expect(outcome).toEqual({ outcome: 'not-found' });
    } finally {
      await bureau.dispose();
    }
  });

  it('returns session-terminal for an authorized caller naming an already-terminal session', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const run = await bureau.createRun({ message: 'Complete me', principal: 'alice' });
      await waitForRunCompletion(bureau, run.id);

      const session = await bureau.getSession(run.sessionId);
      expect(session?.metadata['lastRunStatus']).toBe('completed');

      const outcome = await bureau.submitSessionInput(run.sessionId, {
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'hello',
      });
      expect(outcome).toEqual({ outcome: 'session-terminal', sessionId: run.sessionId });
    } finally {
      await bureau.dispose();
    }
  });

  it('returns not-found (not session-terminal) for an unauthorized caller after the per-run authority entry was pruned by terminal cleanup', async () => {
    // Regression (Copilot/Codex review): a completed run's
    // lastRequestAuthorities[lastRunId] entry is pruned on terminal
    // transition while lastRequestAuthority is retained. Authorization must
    // still fall back to the retained legacy authority — an unauthorized
    // caller here must NOT be misread as hitting an "open" session (which
    // would incorrectly authorize them and leak session-terminal instead of
    // the required indistinguishable not-found).
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const run = await bureau.createRun({ message: 'Complete me', principal: 'alice' });
      await waitForRunCompletion(bureau, run.id);

      const session = await bureau.getSession(run.sessionId);
      expect(session?.metadata['lastRunStatus']).toBe('completed');
      const authorities = session?.metadata['lastRequestAuthorities'];
      expect(
        authorities && typeof authorities === 'object' && !Array.isArray(authorities)
          ? (authorities as Record<string, unknown>)[run.id]
          : undefined,
      ).toBeUndefined();

      const outcome = await bureau.submitSessionInput(run.sessionId, {
        principal: 'mallory',
        deliveryMode: 'steer',
        payload: 'hello',
      });
      expect(outcome).toEqual({ outcome: 'not-found' });
    } finally {
      await bureau.dispose();
    }
  });

  it('returns unsupported-capability for an authorized, non-terminal-session request', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const run = await bureau.createRun({ message: 'Wait for a signal', principal: 'alice' });
      await pollUntil(async () => {
        const session = await bureau.getSession(run.sessionId);
        return session?.metadata['lastRunStatus'] === 'running';
      });

      const outcome = await bureau.submitSessionInput(run.sessionId, {
        principal: 'alice',
        deliveryMode: 'steer',
        payload: 'hello',
      });
      expect(outcome).toEqual({
        outcome: 'unsupported-capability',
        reason: 'durable-mailbox-unavailable',
      });

      const sessionAfter = await bureau.getSession(run.sessionId);
      // No SessionInputRecord created, no id consumed — the session's
      // metadata is untouched by this call beyond the pre-existing keys.
      expect(sessionAfter?.metadata['lastRunStatus']).toBe('running');
    } finally {
      await bureau.dispose();
    }
  });

  it('returns unsupported-capability for an open session (no recorded authority) with any principal', async () => {
    const storage = await resolveStorage({ type: 'memory' });
    const sessionStore = createSessionStore(textValueStore(storage));
    await sessionStore.save(
      createAgentSession({
        id: 'session-open',
        agentName: 'open-agent',
        conversationHistory: createConversationHistory({ id: 'session-open' }),
        metadata: {
          lastRunId: 'run-open',
          lastRunStatus: 'running',
        },
      }),
    );

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage,
      durableExecution: true,
    });
    try {
      const outcome = await bureau.submitSessionInput('session-open', {
        principal: 'anyone-at-all',
        deliveryMode: 'steer',
        payload: 'hello',
      });
      expect(outcome).toEqual({
        outcome: 'unsupported-capability',
        reason: 'durable-mailbox-unavailable',
      });
    } finally {
      await bureau.dispose();
    }
  });
});

describe('createBureau submitSteeringCommand (AB-67/AB-199)', () => {
  // Pre-admission checks reuse submitSessionInput's fixed order (AB-42):
  // authorization, then session lifecycle, then capability. Gate state
  // machine details (idempotency, replay, conflict, agent-identity
  // deferral, run-terminal transitions) are covered directly in
  // steering.test.ts; this suite covers the checks unique to
  // submitSteeringCommand and the end-to-end pause/resume gating rollback
  // trigger names ("a pause that fails to gate runStep").

  it('returns not-found for an unknown sessionId', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
    });
    try {
      const outcome = await bureau.submitSteeringCommand('unknown-session', {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(outcome).toEqual({ outcome: 'not-found' });
    } finally {
      await bureau.dispose();
    }
  });

  it('returns not-found for an unauthorized caller, indistinguishable from an unknown session', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
    });
    try {
      const run = await bureau.createRun({ message: 'Wait forever', principal: 'alice' });
      await pollUntil(async () => {
        const session = await bureau.getSession(run.sessionId);
        return session?.metadata['lastRunStatus'] === 'running';
      });

      const outcome = await bureau.submitSteeringCommand(run.sessionId, {
        principal: 'mallory',
        requestedValue: { target: 'pause' },
      });
      expect(outcome).toEqual({ outcome: 'not-found' });
    } finally {
      await bureau.dispose();
    }
  });

  it('returns session-terminal for an authorized caller naming an already-terminal session', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const run = await bureau.createRun({ message: 'Complete me', principal: 'alice' });
      await waitForRunCompletion(bureau, run.id);

      const outcome = await bureau.submitSteeringCommand(run.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(outcome).toEqual({ outcome: 'session-terminal', sessionId: run.sessionId });
    } finally {
      await bureau.dispose();
    }
  });

  it('returns unsupported-capability/selector-unavailable for every target other than pause/resume', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
    });
    try {
      const run = await bureau.createRun({ message: 'Wait forever', principal: 'alice' });
      await pollUntil(async () => {
        const session = await bureau.getSession(run.sessionId);
        return session?.metadata['lastRunStatus'] === 'running';
      });

      for (const requestedValue of [
        { target: 'route', override: 'r1' },
        { target: 'model', override: 'm1' },
        { target: 'provider', override: 'p1' },
        { target: 'effort', override: 'high' },
        { target: 'agent-identity', override: 'reviewer' },
      ] as const) {
        const outcome = await bureau.submitSteeringCommand(run.sessionId, {
          principal: 'alice',
          requestedValue,
        });
        expect(outcome).toEqual({
          outcome: 'unsupported-capability',
          reason: 'selector-unavailable',
        });
      }
    } finally {
      await bureau.dispose();
    }
  });

  it('returns unsupported-capability/durable-steering-unavailable for pause/resume when runtime.durable is configured', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const run = await bureau.createRun({ message: 'Wait forever', principal: 'alice' });
      await pollUntil(async () => {
        const session = await bureau.getSession(run.sessionId);
        return session?.metadata['lastRunStatus'] === 'running';
      });

      const outcome = await bureau.submitSteeringCommand(run.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(outcome).toEqual({
        outcome: 'unsupported-capability',
        reason: 'durable-steering-unavailable',
      });
    } finally {
      await bureau.dispose();
    }
  });

  it('accepts a pause, is idempotent against a second distinct pause, and replays an exact retry', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
    });
    try {
      const run = await bureau.createRun({ message: 'Wait forever', principal: 'alice' });
      await pollUntil(async () => {
        const session = await bureau.getSession(run.sessionId);
        return session?.metadata['lastRunStatus'] === 'running';
      });

      const first = await bureau.submitSteeringCommand(run.sessionId, {
        id: 'pause-1',
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(first.outcome).toBe('accepted');

      const second = await bureau.submitSteeringCommand(run.sessionId, {
        id: 'pause-2',
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(second.outcome).toBe('accepted');
      if (first.outcome === 'accepted' && second.outcome === 'accepted') {
        // The distinct second pause was idempotent: no new configVersion.
        expect(second.command.configVersion).toBe(first.command.configVersion);
      }

      const replay = await bureau.submitSteeringCommand(run.sessionId, {
        id: 'pause-1',
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(replay.outcome).toBe('replayed');
      if (first.outcome === 'accepted' && replay.outcome === 'replayed') {
        expect(replay.command).toEqual(first.command);
      }
    } finally {
      await bureau.dispose();
    }
  });

  it('returns a typed target-mismatch conflict for a same-id reuse across pause and resume', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
    });
    try {
      const run = await bureau.createRun({ message: 'Wait forever', principal: 'alice' });
      await pollUntil(async () => {
        const session = await bureau.getSession(run.sessionId);
        return session?.metadata['lastRunStatus'] === 'running';
      });

      await bureau.submitSteeringCommand(run.sessionId, {
        id: 'shared-id',
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      const outcome = await bureau.submitSteeringCommand(run.sessionId, {
        id: 'shared-id',
        principal: 'alice',
        requestedValue: { target: 'resume' },
      });
      expect(outcome.outcome).toBe('conflict');
      if (outcome.outcome === 'conflict') {
        expect(outcome.conflict.reason).toBe('target-mismatch');
      }
    } finally {
      await bureau.dispose();
    }
  });

  it('a resume against a session that is not currently paused is accepted as a no-op', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
    });
    try {
      const run = await bureau.createRun({ message: 'Wait forever', principal: 'alice' });
      await pollUntil(async () => {
        const session = await bureau.getSession(run.sessionId);
        return session?.metadata['lastRunStatus'] === 'running';
      });

      const outcome = await bureau.submitSteeringCommand(run.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'resume' },
      });
      expect(outcome.outcome).toBe('accepted');
    } finally {
      await bureau.dispose();
    }
  });

  it('a paused session actually blocks the run at the runStep boundary, and resume releases it (rollback trigger: a pause that fails to gate runStep)', async () => {
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const nextTool = createTool({
      name: 'next',
      description: 'continue',
      input: z.object({}),
      execute: async () => {
        await toolGate;
        return 'ok';
      },
    });
    const generate = createSequentialGenerate([
      { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] },
      { content: 'done', toolCalls: [] },
    ]);

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createToolbox([nextTool]),
      storage: { type: 'memory' },
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const run = await bureau.createRun({ message: 'go', principal: 'alice' });

      // Wait until step 0's generate call has happened and the "next" tool
      // is executing (blocked on toolGate) — the window between step 0's
      // generate and step 1's boundary read.
      await pollUntil(() => generate.callCount === 1);

      const pause = await bureau.submitSteeringCommand(run.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(pause.outcome).toBe('accepted');

      releaseTool!();

      // Step 1's boundary is now reached, but the pause must block it —
      // generate must NOT be called a second time no matter how long we
      // give the loop to (wrongly) proceed.
      for (let i = 0; i < 10; i++) {
        await yieldToPortableEventLoop();
      }
      expect(generate.callCount).toBe(1);

      const resume = await bureau.submitSteeringCommand(run.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'resume' },
      });
      expect(resume.outcome).toBe('accepted');

      await waitForRunCompletion(bureau, run.id);
      expect(generate.callCount).toBe(2);

      const session = await bureau.getSession(run.sessionId);
      expect(session?.metadata['lastRunStatus']).toBe('completed');
    } finally {
      await bureau.dispose();
    }
  });

  it('an accepted pause bound to a run that aborts while paused does not prevent the abort from completing cleanly', async () => {
    // The rollback-trigger's "failed/run-terminal" transition (AB-67's
    // Abort row: pause/resume never carries into a future run) is covered
    // directly in steering.test.ts's `failAcceptedForRun` suite — Bureau
    // exposes no read surface for a steering command's own state (no AB-88
    // snapshot yet), and the session itself goes terminal the instant the
    // abort settles, so `submitSteeringCommand` short-circuits to
    // `session-terminal` before any inspection could reach the gate. This
    // test instead proves the WIRING this issue adds at the abort listener
    // (`steeringGate?.failAcceptedForRun(...)`) runs without throwing and
    // the run still reaches its terminal state normally.
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const nextTool = createTool({
      name: 'next',
      description: 'continue',
      input: z.object({}),
      execute: async () => {
        await toolGate;
        return 'ok';
      },
    });
    const generate = createSequentialGenerate([
      { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] },
      { content: 'done', toolCalls: [] },
    ]);

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createToolbox([nextTool]),
      storage: { type: 'memory' },
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const run = await bureau.createRun({ message: 'go', principal: 'alice' });
      await pollUntil(() => generate.callCount === 1);

      const pause = await bureau.submitSteeringCommand(run.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(pause.outcome).toBe('accepted');
      releaseTool!();

      bureau.abortRun(run.id);
      await waitForRunCompletion(bureau, run.id);

      const session = await bureau.getSession(run.sessionId);
      expect(session?.metadata['lastRunStatus']).toBe('aborted');
    } finally {
      await bureau.dispose();
    }
  });

  it('deleteSession while a run is genuinely paused releases it at the runStep boundary instead of leaving its steering channel — and the run itself — stuck forever (PR #430 review, Codex P2, "Settle paused runs before deleting their steering gate")', async () => {
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const nextTool = createTool({
      name: 'next',
      description: 'continue',
      input: z.object({}),
      execute: async () => {
        await toolGate;
        return 'ok';
      },
    });
    const generate = createSequentialGenerate([
      { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] },
      { content: 'done', toolCalls: [] },
    ]);

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createToolbox([nextTool]),
      storage: { type: 'memory' },
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const run = await bureau.createRun({ message: 'go', principal: 'alice' });
      await pollUntil(() => generate.callCount === 1);

      const pause = await bureau.submitSteeringCommand(run.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(pause.outcome).toBe('accepted');
      releaseTool!();

      // Step 1's boundary is now reached, but the pause blocks it.
      for (let i = 0; i < 10; i++) {
        await yieldToPortableEventLoop();
      }
      expect(generate.callCount).toBe(1);

      // The session is deleted WHILE the run remains paused — no later
      // `submitSteeringCommand` could ever reach a resume through the
      // now-deleted session, so this must be the moment the paused run is
      // released, not left blocked on a promise the discarded gate alone
      // held.
      await bureau.deleteSession(run.sessionId);

      await waitForRunCompletion(bureau, run.id);
      expect(generate.callCount).toBe(2);
    } finally {
      await bureau.dispose();
    }
  });

  it('deleteSession does not let a run released from a pause recreate the session once it later completes (PR #430 review, Codex P1, second wave — "Prevent released runs from recreating deleted sessions")', async () => {
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const nextTool = createTool({
      name: 'next',
      description: 'continue',
      input: z.object({}),
      execute: async () => {
        await toolGate;
        return 'ok';
      },
    });
    const generate = createSequentialGenerate([
      { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] },
      { content: 'done', toolCalls: [] },
    ]);

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createToolbox([nextTool]),
      storage: { type: 'memory' },
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const run = await bureau.createRun({ message: 'go', principal: 'alice' });
      await pollUntil(() => generate.callCount === 1);

      const pause = await bureau.submitSteeringCommand(run.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(pause.outcome).toBe('accepted');
      releaseTool!();
      for (let i = 0; i < 10; i++) {
        await yieldToPortableEventLoop();
      }
      expect(generate.callCount).toBe(1);

      await bureau.deleteSession(run.sessionId);
      expect(await bureau.getSession(run.sessionId)).toBeUndefined();

      // The released run keeps executing to its own natural completion —
      // that part is unchanged — but its terminal `saveSession` call must
      // not resurrect the record `deleteSession` just removed.
      await waitForRunCompletion(bureau, run.id);
      expect(generate.callCount).toBe(2);
      expect(await bureau.getSession(run.sessionId)).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });

  it('a second run on the same session does not re-fire steering.applied for a configVersion a prior run already applied (cross-run dedupe, end-to-end)', async () => {
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const nextTool = createTool({
      name: 'next',
      description: 'continue',
      input: z.object({}),
      execute: async () => {
        await toolGate;
        return 'ok';
      },
    });
    const generate = createSequentialGenerate([
      { content: 'run 1 step 0', toolCalls: [{ name: 'next', arguments: {} }] },
      { content: 'run 1 done', toolCalls: [] },
      { content: 'run 2 done', toolCalls: [] },
    ]);

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createToolbox([nextTool]),
      storage: { type: 'memory' },
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const run1Events: Array<{ event: string; runId: string }> = [];
      const unsubscribeRun1 = bureau.subscribeLiveFrames((frame) => {
        if (frame.type === 'event') run1Events.push({ event: frame.event, runId: frame.runId });
      });

      const run1 = await bureau.createRun({ message: 'go', principal: 'alice' });
      await pollUntil(() => generate.callCount === 1);

      const pause = await bureau.submitSteeringCommand(run1.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(pause.outcome).toBe('accepted');
      releaseTool!();
      for (let i = 0; i < 5; i++) {
        await yieldToPortableEventLoop();
      }
      const resume = await bureau.submitSteeringCommand(run1.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'resume' },
      });
      expect(resume.outcome).toBe('accepted');
      await waitForRunCompletion(bureau, run1.id);
      unsubscribeRun1();

      // Sanity: the mechanism is real — run-1 DID fire steering.applied for
      // its own resume, so the run-2 negative assertion below is not
      // vacuously true.
      expect(
        run1Events.filter((e) => e.runId === run1.id && e.event === 'steering.applied').length,
      ).toBeGreaterThan(0);

      // run-1's own runStep boundary already observed and applied
      // configVersion 2 (the resume). Collect every live event frame from
      // here on, then filter to run-2's own — it must NOT re-fire
      // steering.applied for that same already-applied version.
      const events: Array<{ event: string; runId: string }> = [];
      const unsubscribe = bureau.subscribeLiveFrames((frame) => {
        if (frame.type === 'event') events.push({ event: frame.event, runId: frame.runId });
      });
      const run2 = await bureau.createRun({
        message: 'go again',
        principal: 'alice',
        sessionId: run1.sessionId,
      });
      await waitForRunCompletion(bureau, run2.id);
      unsubscribe();

      const run2Events = events.filter((e) => e.runId === run2.id).map((e) => e.event);
      expect(run2Events).not.toContain('steering.applied');
    } finally {
      await bureau.dispose();
    }
  });

  it('two concurrent runs on the same session: an unscoped pause is run-ambiguous, an explicitly-scoped pause blocks only its own run (PR #430 review, Codex P2 — genuine live-run enumeration)', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
    });
    try {
      const runA = await bureau.createRun({ message: 'go A', principal: 'alice' });
      // A second run reusing runA's sessionId, so both are simultaneously
      // 'running' — genuine concurrency, not a scheduling artifact.
      const runB = await bureau.createRun({
        message: 'go B',
        principal: 'alice',
        sessionId: runA.sessionId,
      });
      await pollUntil(async () => {
        const detailA = bureau.getRun(runA.id);
        const detailB = bureau.getRun(runB.id);
        return detailA?.status === 'running' && detailB?.status === 'running';
      });

      // No runId: two live runs on this session — ambiguous.
      const ambiguous = await bureau.submitSteeringCommand(runA.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(ambiguous).toEqual({
        outcome: 'rejected',
        failure: expect.objectContaining({ reason: 'run-ambiguous' }),
      });

      // Explicit runId: scopes correctly, and does not affect the OTHER run.
      const scoped = await bureau.submitSteeringCommand(runA.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
        runId: runA.id,
      });
      expect(scoped.outcome).toBe('accepted');
    } finally {
      await bureau.dispose();
    }
  });

  it("end-to-end: a pause explicitly targeting still-live run A is authorized after concurrent run B completes and prunes its own authority entry (PR #430 review, Codex P2, second wave — 'Authorize against the targeted live run')", async () => {
    const bureau = await createBureau({
      agents: {},
      generate: async (context) => {
        const isRunB = context.conversation
          .getMessages()
          .some((message) => message.content === 'go B');
        if (isRunB) return { content: 'B done', toolCalls: [] };
        return new Promise<never>(() => {});
      },
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const runA = await bureau.createRun({ message: 'go A', principal: 'alice' });
      const runB = await bureau.createRun({
        message: 'go B',
        principal: 'alice',
        sessionId: runA.sessionId,
      });
      await waitForRunCompletion(bureau, runB.id);
      await pollUntil(async () => bureau.getRun(runA.id)?.status === 'running');

      // B's own terminal transition pruned lastRequestAuthorities[B],
      // leaving lastRunId: B and A's now-uncorrelated entry behind — a
      // command explicitly targeting still-live A must still authorize.
      const scoped = await bureau.submitSteeringCommand(runA.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
        runId: runA.id,
      });
      expect(scoped.outcome).toBe('accepted');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('createBureau sessionInput backlog-limit validation (AB-194)', () => {
  it('accepts a positive integer sessionBacklogLimit and principalBacklogLimit', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      sessionInput: { sessionBacklogLimit: 5, principalBacklogLimit: 10 },
    });
    await bureau.dispose();
  });

  it('applies the exported defaults when sessionInput is omitted', async () => {
    // The defaults themselves are not load-bearing beyond being enforced
    // once the mailbox-backed admission path lands — this verifies
    // construction succeeds with no sessionInput option at all.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });
    await bureau.dispose();
  });

  it.each([
    ['sessionBacklogLimit', 0],
    ['sessionBacklogLimit', -1],
    ['sessionBacklogLimit', 1.5],
    ['principalBacklogLimit', 0],
    ['principalBacklogLimit', -1],
    ['principalBacklogLimit', 1.5],
  ])('rejects a non-positive-integer %s (%p) at construction time', async (key, value) => {
    const error = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      sessionInput: { [key]: value },
    }).then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('BAD_REQUEST');
  });
});

describe('createBureau session signal/update/query with terminal sessions', () => {
  // Regression for findings PRRT_kwDORvupsc6MT46y and PRRT_kwDORvupsc6MUE_7:
  // requireSessionRunId must check lastRunStatus, not just lastRunId. A completed,
  // aborted, or errored session retains its lastRunId but has no active workflow
  // handle — routing signal/update/query to a terminal run yields a low-level engine
  // error instead of the expected "no active run" NOT_FOUND response.

  it('signalSession throws NOT_FOUND when lastRunStatus is completed (not running)', async () => {
    // Full-stack regression: in a durable bureau (memory engine + built-in session
    // store), complete a run, then verify that signalSession throws NOT_FOUND instead
    // of routing to the now-terminal engine handle.
    //
    // `storage: { type: 'memory' }` with `durableExecution: true` gives us both a
    // durable engine AND a built-in session store (created from the same Memory
    // storage backend) — the combination required to hit requireSessionRunId.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    // Complete a run — the session listener writes lastRunStatus: 'completed'.
    const run = await bureau.createRun({ message: 'Complete me' });
    await waitForRunCompletion(bureau, run.id);

    // Verify the session is persisted as completed (the guard condition).
    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastRunStatus']).toBe('completed');
    expect(session?.metadata['lastRunId']).toBe(run.id);

    // signalSession must throw NOT_FOUND (not route to the terminal engine handle).
    const error = await bureau.signalSession(run.sessionId, 'any-signal').then(
      () => undefined,
      (rejection) => rejection,
    );
    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_FOUND');

    bureau.dispose();
  });

  it('updateSession throws NOT_FOUND when lastRunStatus is completed (not running)', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });

    const run = await bureau.createRun({ message: 'Complete me' });
    await waitForRunCompletion(bureau, run.id);

    const error = await bureau.updateSession(run.sessionId, 'any-update').then(
      () => undefined,
      (rejection) => rejection,
    );
    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_FOUND');

    bureau.dispose();
  });

  it('querySession throws NOT_FOUND when lastRunStatus is completed (not running)', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });

    const run = await bureau.createRun({ message: 'Complete me' });
    await waitForRunCompletion(bureau, run.id);

    const error = await bureau.querySession(run.sessionId, 'any-query').then(
      () => undefined,
      (rejection) => rejection,
    );
    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_FOUND');

    bureau.dispose();
  });

  it('signalSession throws NOT_FOUND when lastRunStatus is aborted (not running)', async () => {
    const generate: GenerateFunction = () => new Promise(() => {});
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });

    const run = await bureau.createRun({ message: 'Abort me' });
    bureau.abortRun(run.id);

    // Wait for the abort to propagate and the session status to update.
    await pollUntil(async () => {
      const current = await bureau.getSession(run.sessionId);
      return current?.metadata['lastRunStatus'] === 'aborted';
    });

    const error = await bureau.signalSession(run.sessionId, 'any-signal').then(
      () => undefined,
      (rejection) => rejection,
    );
    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_FOUND');

    bureau.dispose();
  });
});

describe('createBureau session signal authority revalidation', () => {
  it('fails closed for transport-issued authority without a validator on live runs', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
    });
    try {
      const error = await bureau
        .createRun({
          message: 'Do not admit unvalidated authority',
          requestContext: {
            authority: {
              principalId: 'api-key:missing-validator',
              tenantId: 'tenant-a',
              ownerId: 'owner-a',
              capabilities: ['tools:execute'],
              authorizationRevision: 'gateway:api-key:missing-validator',
            },
            audience: 'tenant',
          },
        })
        .then(
          () => undefined,
          (rejection) => rejection,
        );
      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('CONFLICT');
      expect(bureau.listRuns()).toHaveLength(0);
    } finally {
      await bureau.dispose();
    }
  });

  it('rejects stale transport authority before flow-control admission or session persistence', async () => {
    let flowControlCalls = 0;
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      requestAuthorityValidator: () => false,
      flowControl: {
        concurrency: {
          limit: 1,
          key() {
            flowControlCalls += 1;
            return 'all-runs';
          },
        },
      },
    });
    try {
      const error = await bureau
        .createRun({
          message: 'Do not admit stale authority',
          sessionId: 'stale-authority-session',
          requestContext: {
            authority: {
              principalId: 'api-key:stale',
              tenantId: 'tenant-a',
              ownerId: 'owner-a',
              capabilities: ['tools:execute'],
              authorizationRevision: 'gateway:api-key:stale',
            },
            audience: 'tenant',
          },
        })
        .then(
          () => undefined,
          (rejection) => rejection,
        );

      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('CONFLICT');
      expect(flowControlCalls).toBe(0);
      expect(bureau.listRuns()).toHaveLength(0);
      expect(await bureau.getSession('stale-authority-session')).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });

  it('revalidates captured authority before delivering a direct session signal', async () => {
    let authorityCurrent = true;
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      requestAuthorityValidator: () => authorityCurrent,
    });
    const run = await bureau.createRun({
      message: 'Wait for a signal',
      requestContext: {
        authority: {
          principalId: 'api-key:revoked',
          tenantId: 'tenant-a',
          ownerId: 'owner-a',
          capabilities: ['tools:execute'],
          authorizationRevision: 'gateway:api-key:revoked',
        },
        audience: 'tenant',
      },
    });

    await pollUntil(async () => {
      const session = await bureau.getSession(run.sessionId);
      return session?.metadata['lastRunStatus'] === 'running';
    });
    authorityCurrent = false;
    const error = await bureau.signalSession(run.sessionId, 'human-response').then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('CONFLICT');
    const updateError = await bureau.updateSession(run.sessionId, 'human-update').then(
      () => undefined,
      (rejection) => rejection,
    );
    expect(updateError).toBeInstanceOf(BureauError);
    expect((updateError as BureauError).code).toBe('CONFLICT');
    bureau.abortRun(run.id);
    bureau.dispose();
  });
});

// ── AB-20: review queue ──────────────────────────────────────────────

/**
 * Builds a bare-bones `ActiveRun` backed by a real `CompletableEventTarget`,
 * so a test can `store.register()` it and then dispatch events onto its
 * `toObservable()` stream exactly as `operative`'s run loop would — without
 * needing a full `generate`/toolbox-driven run. Used to simulate a durable
 * run parked on `requestHumanInput` (operative's F3 HITL tool), since no
 * caller in this monorepo yet wires that tool into a real durable run (a
 * separate, tracked gap — see the AB-20 PR description).
 */
function createParkedActiveRun(): {
  activeRun: ActiveRun;
  emitter: CompletableEventTarget<CombinedOperativeEventMap>;
} {
  const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
  // Casts mirror operative's own `createActiveRun`/`createDurableActiveRun`
  // (create-run.ts, active-run-adapter.ts): `ActiveRun`'s `on`/`once`/
  // `subscribe`/`events` are generic over `CombinedOperativeEventType`
  // (`keyof CombinedOperativeEventMap`, not intersected with `string`), which
  // `.bind()` on `CompletableEventTarget`'s `K extends string`-constrained
  // methods cannot structurally satisfy — the same cast operative's own
  // production adapters use for this exact assignment.
  const activeRun: ActiveRun = {
    result: new Promise<never>(() => {}),
    abort: () => {},
    // AB-204: mechanical addition — this never-settling stub run has no
    // cleanup to await, matching `abort`'s never-resolving `result` above.
    closed: () => new Promise(() => {}),
    addEventListener: emitter.addEventListener.bind(emitter),
    removeEventListener: emitter.removeEventListener.bind(emitter),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    subscribe: emitter.subscribe.bind(emitter),
    events: emitter.events.bind(emitter) as ActiveRun['events'],
    toObservable: emitter.toObservable.bind(emitter),
    complete: emitter.complete.bind(emitter),
    // AB-214: mechanical addition — this never-settling stub run reports a
    // static 'running' snapshot and delivers it once; matching `abort`'s
    // never-resolving `result` above, it never reaches a revision change.
    snapshot: () => ({
      id: 'parked',
      kind: 'agent-run',
      startedAt: new Date(0).toISOString(),
      revision: 0,
      status: 'running',
      lastTransitionAt: new Date(0).toISOString(),
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: 'process-local',
      cancellable: true,
      attempt: 0,
      reachability: 'unknown',
      progress: 'unknown',
      assessment: 'healthy',
      observedAt: 0,
      missedPulseCount: 0,
      policyVersion: 'ab-88/2026-09-01',
      evidence: [],
    }),
    subscribeSnapshot: (observer) => {
      observer(activeRun.snapshot());
      return { unsubscribe: () => {}, closed: false };
    },
    [Symbol.dispose]: () => {},
  };
  return { activeRun, emitter };
}

/** A `beforeExecute` policy that always requires approval. */
function createNeedsApprovalToolbox(approvalSecret: string, charges: number[]) {
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        version: '1.0.0',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          charges.push(cents);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret,
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'needs_approval',
            reason: 'Operator approval required',
            action: { message: 'Approve charge' },
          };
        },
      },
    },
  ) as unknown as Toolbox;
}

/**
 * A `beforeExecute` policy that changes its `reason` on the SECOND
 * evaluation — simulating a policy that re-gates a resumed approval (e.g.
 * because the policy changed between the original request and the resume)
 * rather than treating the prior approval as still satisfying it.
 */
function createRegatingApprovalToolbox(approvalSecret: string, charges: number[]) {
  let evaluationCount = 0;
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        version: '1.0.0',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          charges.push(cents);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret,
      policy: {
        beforeExecute() {
          evaluationCount += 1;
          return {
            allow: false,
            status: 'needs_approval',
            reason: `Operator approval required (evaluation ${evaluationCount})`,
            action: { message: 'Approve charge' },
          };
        },
      },
    },
  ) as unknown as Toolbox;
}

function createDenyingResumeApprovalToolbox(approvalSecret: string, charges: number[]) {
  let evaluationCount = 0;
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        version: '1.0.0',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        policy: {
          beforeExecute() {
            evaluationCount += 1;
            return evaluationCount === 1
              ? { status: 'allow' }
              : { status: 'deny', reason: 'Current policy denies this charge' };
          },
        },
        async execute({ cents }) {
          charges.push(cents);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret,
      policy: {
        beforeExecute() {
          return {
            status: 'needs_approval',
            reason: 'Operator approval required',
            action: { message: 'Approve charge' },
          };
        },
      },
    },
  ) as unknown as Toolbox;
}

describe('createBureau review queue (AB-20)', () => {
  it('restores terminal-session approval reviews without durable run recovery', async () => {
    const storage = await resolveStorage({ type: 'memory' });
    const sessionStore = createSessionStore(textValueStore(storage));
    const runId = 'run-terminal-review';
    const reviewId = `approval:${runId}:call-terminal`;
    const secondReviewId = `approval:${runId}:call-terminal-2`;
    const approval = {
      toolName: 'charge-card',
      arguments: { cents: 250 },
      approvalToken: 'persisted-approval-token',
      action: { message: 'Approve charge' },
    };
    await sessionStore.save(
      createAgentSession({
        id: 'session-terminal-review',
        agentName: 'terminal-agent',
        conversationHistory: createConversationHistory({ id: 'session-terminal-review' }),
        metadata: {
          lastRunId: runId,
          lastRunStatus: 'completed',
          lastRequestAuthorities: {
            [runId]: {
              principalId: 'principal-terminal',
              tenantId: 'bureau',
              ownerId: 'terminal-agent',
              capabilities: ['tools:execute'],
              authorizationRevision: 'bureau:1',
            },
          },
          pendingApprovalOverrides: {
            [reviewId]: {
              ...approval,
              callId: 'call-terminal',
            },
            [secondReviewId]: {
              ...approval,
              callId: 'call-terminal-2',
            },
          },
        },
      }),
    );

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage,
      durableExecution: true,
    });
    try {
      const reviews = bureau.listPendingReviews();
      expect(reviews).toHaveLength(2);
      expect(reviews[0]).toMatchObject({
        id: reviewId,
        kind: 'tool-approval',
        runId,
        sessionId: 'session-terminal-review',
        agentName: 'terminal-agent',
        approval: expect.objectContaining({
          callId: 'call-terminal',
          toolName: 'charge-card',
        }),
      });
      await bureau.resolveReview({ id: reviewId, decision: 'deny', principal: 'operator-a' });
      expect(bureau.listPendingReviews().map((review) => review.id)).toEqual([secondReviewId]);
      await bureau.resolveReview({ id: secondReviewId, decision: 'deny', principal: 'operator-a' });
      expect(bureau.listPendingReviews()).toHaveLength(0);
    } finally {
      await bureau.dispose();
    }
  });

  it('restores pending approvals for every terminal run retained by a reused session', async () => {
    const storage = await resolveStorage({ type: 'memory' });
    const sessionStore = createSessionStore(textValueStore(storage));
    const sessionId = 'session-reused-for-approvals';
    const olderRunId = 'run-older-approval';
    const newestRunId = 'run-newest-approval';
    const olderReviewId = `approval:${olderRunId}:older-call`;
    const newestReviewId = `approval:${newestRunId}:newest-call`;
    const approval = {
      toolName: 'charge-card',
      arguments: { cents: 250 },
      approvalToken: 'persisted-approval-token',
      action: { message: 'Approve charge' },
    };
    await sessionStore.save(
      createAgentSession({
        id: sessionId,
        agentName: 'terminal-agent',
        conversationHistory: createConversationHistory({ id: sessionId }),
        metadata: {
          lastRunId: newestRunId,
          lastRunStatus: 'completed',
          lastRequestAuthorities: {
            [olderRunId]: {
              agentId: 'older-run-agent',
              principalId: 'principal-older',
              tenantId: 'bureau',
              ownerId: 'terminal-agent',
              capabilities: ['tools:execute'],
              authorizationRevision: 'bureau:1',
            },
            [newestRunId]: {
              agentId: 'newest-run-agent',
              principalId: 'principal-newest',
              tenantId: 'bureau',
              ownerId: 'terminal-agent',
              capabilities: ['tools:execute'],
              authorizationRevision: 'bureau:1',
            },
          },
          pendingApprovalOverrides: {
            [olderReviewId]: { ...approval, callId: 'older-call' },
            [newestReviewId]: { ...approval, callId: 'newest-call' },
          },
        },
      }),
    );

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage,
      durableExecution: true,
    });
    try {
      expect(
        bureau
          .listPendingReviews()
          .map((review) => review.id)
          .sort(),
      ).toEqual([olderReviewId, newestReviewId].sort());
      expect(bureau.listPendingReviews().every((review) => review.sessionId === sessionId)).toBe(
        true,
      );
      expect(
        Object.fromEntries(
          bureau.listPendingReviews().map((review) => [review.runId, review.agentName]),
        ),
      ).toEqual({
        [olderRunId]: 'older-run-agent',
        [newestRunId]: 'newest-run-agent',
      });
      await bureau.deleteSession(sessionId);
      expect(bureau.listPendingReviews()).toHaveLength(0);
      expect(
        bureau.resolveReview({ id: olderReviewId, decision: 'approve', principal: 'operator-a' }),
      ).rejects.toThrow(`No pending review with id "${olderReviewId}"`);
    } finally {
      await bureau.dispose();
    }
  });

  it('prunes terminal approvals whose persisted request authority has expired', async () => {
    const storage = await resolveStorage({ type: 'memory' });
    const sessionStore = createSessionStore(textValueStore(storage));
    const runId = 'run-expired-terminal-review';
    const reviewId = `approval:${runId}:expired-call`;
    await sessionStore.save(
      createAgentSession({
        id: 'session-expired-terminal-review',
        agentName: 'terminal-agent',
        conversationHistory: createConversationHistory({ id: 'session-expired-terminal-review' }),
        metadata: {
          lastRunId: runId,
          lastRunStatus: 'completed',
          lastRequestAuthorities: {
            [runId]: {
              principalId: 'principal-expired',
              tenantId: 'bureau',
              ownerId: 'terminal-agent',
              capabilities: ['tools:execute'],
              authorizationRevision: 'bureau:1',
              // A fixed, unambiguously-past deadline rather than
              // `Date.now() - 1` — this only needs to be less than whatever
              // real clock the pruning check compares against.
              deadline: Date.parse('2020-01-01T00:00:00.000Z'),
            },
          },
          pendingApprovalOverrides: {
            [reviewId]: {
              callId: 'expired-call',
              toolName: 'charge-card',
              arguments: { cents: 500 },
              approvalToken: 'expired-token',
            },
          },
        },
      }),
    );

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage,
      durableExecution: true,
    });
    try {
      expect(bureau.listPendingReviews()).toHaveLength(0);
      const session = await bureau.getSession('session-expired-terminal-review');
      expect(session?.metadata['pendingApprovalOverrides']).not.toHaveProperty(reviewId);
      expect(session?.metadata['lastRequestAuthorities']).not.toHaveProperty(runId);
    } finally {
      await bureau.dispose();
    }
  });

  it('restores terminal approval authority, toolbox, and binding state across restart', async () => {
    const storage = await resolveStorage({ type: 'memory' });
    const charges: number[] = [];
    const bureauA = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'restart-call', name: 'charge-card', arguments: { cents: 375 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('restart-approval-secret', charges),
      storage,
      durableExecution: true,
      stopWhen: stopWhen.toolOutcome('action_required'),
    });
    const run = await bureauA.createRun({ message: 'Persist approval for restart' });
    await waitForRunCompletion(bureauA, run.id);
    expect(bureauA.listPendingReviews()).toHaveLength(1);
    await bureauA.dispose();

    const bureauB = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('restart-approval-secret', charges),
      storage,
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const [review] = bureauB.listPendingReviews();
      expect(review).toBeDefined();
      const outcome = await bureauB.resolveReview({
        id: review!.id,
        decision: 'approve',
        principal: 'operator-restart',
      });
      expect(outcome.decision).toBe('approve');
      expect(charges).toEqual([375]);
    } finally {
      await bureauB.dispose();
    }
  });

  it('listPendingReviews surfaces a tool call parked on needs_approval', async () => {
    const charges: number[] = [];
    const persistence = textValueStore(new MemoryStorage());
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('test-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence,
    });

    const run = await bureau.createRun({ message: 'Charge the customer' });
    await waitForRunCompletion(bureau, run.id);

    const reviews = bureau.listPendingReviews();
    expect(reviews).toHaveLength(1);
    const [review] = reviews;
    expect(review!.kind).toBe('tool-approval');
    if (review!.kind !== 'tool-approval') throw new Error('unreachable');
    expect(review!.runId).toBe(run.id);
    expect(review!.approval.callId).toBe('call-1');
    expect(review!.approval.toolName).toBe('charge-card');
    expect(review!.approval.arguments).toEqual({ cents: 500 });
    expect(review!.approval.approvalToken).toEqual(expect.any(String));
    const persistedSession = await bureau.getSession(run.sessionId);
    expect(persistedSession?.metadata['pendingApprovalOverrides']).toMatchObject({
      [review!.id]: expect.objectContaining({ approvalToken: review!.approval.approvalToken }),
    });
    expect(persistedSession?.metadata['lastRequestAuthorities']).toMatchObject({
      [run.id]: expect.objectContaining({
        agentId: 'bureau',
        principalId: expect.any(String),
        tenantId: expect.any(String),
        ownerId: expect.any(String),
      }),
    });
    expect(review!.ageMilliseconds).toBeGreaterThanOrEqual(0);
    expect(charges).toEqual([]); // not yet executed

    bureau.dispose();
  });

  it('listPendingReviews surfaces a run parked on a human-wait signal', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const { activeRun, emitter } = createParkedActiveRun();
    const runId = bureau.store.register(activeRun, 'run-parked-human-wait');
    emitter.dispatchEvent(
      new HumanWaitParkedEvent('human-response', runId, 'Approve this refund?'),
    );

    const reviews = bureau.listPendingReviews();
    expect(reviews).toHaveLength(1);
    const [review] = reviews;
    expect(review!.kind).toBe('human-wait');
    if (review!.kind !== 'human-wait') throw new Error('unreachable');
    expect(review!.runId).toBe(runId);
    expect(review!.signalName).toBe('human-response');
    expect(review!.prompt).toBe('Approve this refund?');
    expect(review!.ageMilliseconds).toBeGreaterThanOrEqual(0);

    bureau.dispose();
  });

  it('listPendingReviews still surfaces a human-wait run whose parking step has already completed', async () => {
    // Regression test for the real production ordering: `requestHumanInput`
    // dispatches `HumanWaitParkedEvent` from INSIDE the tool's `execute`
    // (mid-step), and the SAME step's own `step.completed` is recorded right
    // after it, well before the durable workflow's `ctx.waitForSignal`
    // actually suspends. A run must still be "still parked" even though a
    // same-step action was recorded after the park event — only a status
    // change away from `'running'` (the run resuming to completion) should
    // exclude it. See `listPendingReviews omits a human-wait run whose park
    // has resolved and the run completed` below for that side of the check.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const { activeRun, emitter } = createParkedActiveRun();
    const runId = bureau.store.register(activeRun, 'run-parked-human-wait-trailing-step');
    emitter.dispatchEvent(
      new HumanWaitParkedEvent('human-response', runId, 'Approve this refund?'),
    );
    emitter.dispatchEvent(
      new StepCompletedEvent({
        step: 0,
        conversation: new Conversation(),
        content: '',
        toolCalls: [],
        results: [],
        final: true,
      }),
    );

    const reviews = bureau.listPendingReviews();
    expect(reviews).toHaveLength(1);
    const [review] = reviews;
    expect(review!.kind).toBe('human-wait');
    if (review!.kind !== 'human-wait') throw new Error('unreachable');
    expect(review!.runId).toBe(runId);
    expect(review!.signalName).toBe('human-response');

    bureau.dispose();
  });

  it('listPendingReviews omits a human-wait run whose park has resolved and the run completed', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const { activeRun, emitter } = createParkedActiveRun();
    const runId = bureau.store.register(activeRun, 'run-resumed-human-wait');
    emitter.dispatchEvent(new HumanWaitParkedEvent('human-response', runId));
    // Resuming a `ctx.waitForSignal` park runs the durable workflow straight
    // through to completion (it does not start a new step) — the run's
    // status leaving `'running'` is what marks it no longer parked.
    emitter.dispatchEvent(
      new RunAbortedEvent(1, new Conversation(), new AbortAgentRunError('resumed')),
    );

    expect(bureau.listPendingReviews()).toHaveLength(0);

    bureau.dispose();
  });

  it('resolveReview approve resumes a tool-approval and executes the tool for real', async () => {
    const charges: number[] = [];
    let validatorCalls = 0;
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-2', name: 'charge-card', arguments: { cents: 750 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('test-secret-2', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      requestAuthorityValidator: () => {
        validatorCalls += 1;
        return false;
      },
    });

    const run = await bureau.createRun({ message: 'Charge the customer' });
    await waitForRunCompletion(bureau, run.id);

    const [review] = bureau.listPendingReviews();
    expect(review).toBeDefined();

    const outcome = await bureau.resolveReview({
      id: review!.id,
      decision: 'approve',
      principal: 'api-key:reviewer-1',
    });

    expect(outcome.decision).toBe('approve');
    expect(outcome.kind).toBe('tool-approval');
    expect((outcome.result as { result?: unknown } | undefined)?.result).toEqual({
      charged: 750,
    });
    expect(charges).toEqual([750]); // the tool genuinely ran
    expect(validatorCalls).toBe(0);

    // Resolved reviews disappear from the queue.
    expect(bureau.listPendingReviews()).toHaveLength(0);

    bureau.dispose();
  });

  it('revalidates captured request authority before approving a delayed tool call', async () => {
    const charges: number[] = [];
    let authorityCurrent = true;
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [
            { id: 'stale-authority-call', name: 'charge-card', arguments: { cents: 500 } },
          ],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('stale-authority-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
    });
    bureau.setRequestAuthorityValidator(() => authorityCurrent);
    const run = await bureau.createRun({
      message: 'Charge with authority that will be revoked',
      requestContext: {
        authority: {
          principalId: 'api-key:revoked',
          tenantId: 'bureau',
          ownerId: 'bureau',
          capabilities: ['tools:execute'],
          authorizationRevision: 'gateway:api-key:revoked',
        },
        audience: 'operator',
      },
    });
    await waitForRunCompletion(bureau, run.id);
    const [review] = bureau.listPendingReviews();
    authorityCurrent = false;

    const resolution = bureau.resolveReview({
      id: review!.id,
      decision: 'approve',
      principal: 'api-key:reviewer',
    });
    expect(resolution).rejects.toThrow('no longer current');
    expect(charges).toEqual([]);
    expect(bureau.listPendingReviews()).toHaveLength(1);
    bureau.dispose();
  });

  it('exposes the construction-time request authority validator for transport composition', async () => {
    const constructionValidator = () => true;
    const replacementValidator = () => false;
    const bureau = await createBureau({
      agents: {},
      requestAuthorityValidator: constructionValidator,
    });

    try {
      expect(bureau.getRequestAuthorityValidator()).toBe(constructionValidator);

      bureau.setRequestAuthorityValidator(replacementValidator);

      expect(bureau.getRequestAuthorityValidator()).toBe(replacementValidator);
    } finally {
      await bureau.dispose();
    }
  });

  it('dispatches recovery.attempted, then recovery.rejected, then recovery.lease-released for a cancelled, lease-released recovered handle (AB-90/ab90-09)', async () => {
    // Deferred-authority boot: recovery does NOT run inside createBureau(), so
    // listeners attached to the RETURNED bureau are guaranteed to be in place
    // before `setRequestAuthorityValidator` triggers the classification pass —
    // the only way to observe a boot-recovery dispatch, since it otherwise runs
    // synchronously before createBureau() resolves (see the sibling deferred
    // recovery tests above/below this one).
    const storage = new MemoryStorage();
    const sessionStore = createSessionStore(textValueStore(storage));
    await sessionStore.save(
      createAgentSession({
        id: 'deferred-lease-release',
        agentName: 'bureau',
        conversationHistory: createConversationHistory({ id: 'deferred-lease-release' }),
        metadata: {
          lastRunId: 'run-deferred-lease-release',
          lastRunStatus: 'running',
          lastRequestAuthorities: {
            'run-deferred-lease-release': {
              principalId: 'api-key:deferred-lease',
              tenantId: 'bureau',
              ownerId: 'bureau',
              capabilities: ['tools:execute'],
              authorizationRevision: 'gateway:api-key:deferred-lease',
            },
          },
        },
      }),
    );
    const probe = await createRuntimeComposition({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      recoverAll: () => Promise<unknown[]>;
      cancel: (runId: string) => Promise<void>;
      getLeaseHealth: () => unknown;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();

    const targetRunId = 'cancelled-lease-release-run';
    const recoverAllSpy = spyOn(enginePrototype, 'recoverAll').mockResolvedValue([
      {
        id: targetRunId,
        // undefined launch metadata: not a bureau-owned agentRun → 'cancel'
        // verdict with rejection reason 'foreign-input'.
        getLaunchMetadata: async () => undefined,
      },
    ]);
    const cancelSpy = spyOn(enginePrototype, 'cancel').mockResolvedValue(undefined);
    const contestedHealth = {
      mode: 'lease' as const,
      status: 'contested' as const,
      holdsLease: false as const,
      holderId: 'engine-b',
      heldSince: 100,
      expiresAt: 5000,
      lastRenewedAt: 4000,
      fencingEpoch: 9,
      lossReason: 'deposed' as const,
    };
    const getLeaseHealthSpy = spyOn(enginePrototype, 'getLeaseHealth').mockReturnValue(
      contestedHealth,
    );

    type RecoveryEvent =
      | { kind: 'attempted'; runId: string; verdict: string }
      | { kind: 'rejected'; runId: string; reason: string }
      | { kind: 'lease-released'; runId: string; lease: unknown };
    const observed: RecoveryEvent[] = [];

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage,
        durableExecution: true,
      });

      try {
        // Recovery has not run yet (deferred on gateway authority) — attach
        // listeners now, guaranteed ahead of the dispatch.
        expect(recoverAllSpy).not.toHaveBeenCalled();
        bureau.addEventListener('recovery.attempted', (event) => {
          observed.push({ kind: 'attempted', runId: event.runId, verdict: event.verdict });
        });
        bureau.addEventListener('recovery.rejected', (event) => {
          observed.push({ kind: 'rejected', runId: event.runId, reason: event.reason });
        });
        bureau.addEventListener('recovery.lease-released', (event) => {
          observed.push({ kind: 'lease-released', runId: event.runId, lease: event.lease });
        });

        bureau.setRequestAuthorityValidator(() => true);
        await bureau.waitForRecovery?.();

        expect(recoverAllSpy).toHaveBeenCalledTimes(1);
        expect(cancelSpy).toHaveBeenCalledWith(targetRunId);
        // Correctly ordered: attempted always precedes rejected, for the SAME
        // runId (the acceptance criterion's sequence requirement).
        expect(observed).toEqual([
          { kind: 'attempted', runId: targetRunId, verdict: 'cancel' },
          { kind: 'rejected', runId: targetRunId, reason: 'foreign-input' },
          {
            kind: 'lease-released',
            runId: targetRunId,
            lease: { holderId: 'engine-b', expiresAt: 5000, source: 'weft-workflow-lease' },
          },
        ]);
      } finally {
        await bureau.dispose();
      }
    } finally {
      recoverAllSpy.mockRestore();
      cancelSpy.mockRestore();
      getLeaseHealthSpy.mockRestore();
    }
  });

  it('does not dispatch recovery.lease-released when Weft reports no released lease (disabled engine)', async () => {
    const storage = new MemoryStorage();
    const sessionStore = createSessionStore(textValueStore(storage));
    await sessionStore.save(
      createAgentSession({
        id: 'deferred-no-lease-release',
        agentName: 'bureau',
        conversationHistory: createConversationHistory({ id: 'deferred-no-lease-release' }),
        metadata: {
          lastRunId: 'run-deferred-no-lease-release',
          lastRunStatus: 'running',
          lastRequestAuthorities: {
            'run-deferred-no-lease-release': {
              principalId: 'api-key:deferred-no-lease',
              tenantId: 'bureau',
              ownerId: 'bureau',
              capabilities: ['tools:execute'],
              authorizationRevision: 'gateway:api-key:deferred-no-lease',
            },
          },
        },
      }),
    );
    const probe = await createRuntimeComposition({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      recoverAll: () => Promise<unknown[]>;
      cancel: (runId: string) => Promise<void>;
      getLeaseHealth: () => unknown;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();

    const targetRunId = 'no-lease-release-run';
    const recoverAllSpy = spyOn(enginePrototype, 'recoverAll').mockResolvedValue([
      { id: targetRunId, getLaunchMetadata: async () => undefined },
    ]);
    const cancelSpy = spyOn(enginePrototype, 'cancel').mockResolvedValue(undefined);
    const getLeaseHealthSpy = spyOn(enginePrototype, 'getLeaseHealth').mockReturnValue({
      mode: 'none',
      status: 'disabled',
      holdsLease: false,
    });

    let leaseReleasedCount = 0;
    let attemptedCount = 0;

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage,
        durableExecution: true,
      });

      try {
        bureau.addEventListener('recovery.attempted', () => {
          attemptedCount += 1;
        });
        bureau.addEventListener('recovery.lease-released', () => {
          leaseReleasedCount += 1;
        });

        bureau.setRequestAuthorityValidator(() => true);
        await bureau.waitForRecovery?.();

        expect(cancelSpy).toHaveBeenCalledWith(targetRunId);
        expect(attemptedCount).toBe(1);
        expect(leaseReleasedCount).toBe(0);
      } finally {
        await bureau.dispose();
      }
    } finally {
      recoverAllSpy.mockRestore();
      cancelSpy.mockRestore();
      getLeaseHealthSpy.mockRestore();
    }
  });

  it('reports deferred durable recovery failures after the authority validator is attached', async () => {
    const storage = new MemoryStorage();
    const sessionStore = createSessionStore(textValueStore(storage));
    await sessionStore.save(
      createAgentSession({
        id: 'deferred-authority-recovery',
        agentName: 'bureau',
        conversationHistory: createConversationHistory({ id: 'deferred-authority-recovery' }),
        metadata: {
          lastRunId: 'run-deferred-authority',
          lastRunStatus: 'running',
          lastRequestAuthorities: {
            'run-deferred-authority': {
              principalId: 'api-key:deferred',
              tenantId: 'bureau',
              ownerId: 'bureau',
              capabilities: ['tools:execute'],
              authorizationRevision: 'gateway:api-key:deferred',
            },
          },
        },
      }),
    );
    const probe = await createRuntimeComposition({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      recoverAll: () => Promise<unknown[]>;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();
    const recoverAllSpy = spyOn(enginePrototype, 'recoverAll').mockRejectedValue(
      new Error('deferred recovery unavailable'),
    );
    const diagnostics: string[] = [];

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage,
        durableExecution: true,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      });

      try {
        expect(recoverAllSpy).not.toHaveBeenCalled();
        const recoveryBarrier = bureau.waitForRecovery?.();
        expect(recoveryBarrier).toBeDefined();
        expect(bureau.waitForRecovery?.()).toBe(recoveryBarrier);
        let recoverySettled = false;
        void recoveryBarrier!.then(() => {
          recoverySettled = true;
        });
        await Promise.resolve();
        expect(recoverySettled).toBe(false);
        bureau.setRequestAuthorityValidator(() => true);
        await recoveryBarrier;
        expect(recoverySettled).toBe(true);
        expect(diagnostics).toContainEqual(
          expect.stringContaining(
            'Deferred durable run recovery failed: deferred recovery unavailable',
          ),
        );
      } finally {
        await bureau.dispose();
      }
    } finally {
      recoverAllSpy.mockRestore();
    }
  });

  it('scans every session page before starting recovery', async () => {
    const storage = new MemoryStorage();
    const sessionStore = createSessionStore(textValueStore(storage));
    for (let index = 0; index < 100; index += 1) {
      await sessionStore.save(
        createAgentSession({
          id: `session-page-${index}`,
          agentName: 'bureau',
          conversationHistory: createConversationHistory({ id: `session-page-${index}` }),
          metadata: { lastRunStatus: 'completed' },
        }),
      );
    }
    await sessionStore.save(
      createAgentSession({
        id: 'session-page-100',
        agentName: 'bureau',
        conversationHistory: createConversationHistory({ id: 'session-page-100' }),
        metadata: {
          lastRunId: 'run-page-100',
          lastRunStatus: 'running',
          lastRequestAuthorities: {
            'run-page-100': {
              principalId: 'api-key:page-100',
              tenantId: 'tenant-a',
              ownerId: 'bureau',
              capabilities: ['tools:execute'],
              authorizationRevision: 'gateway:api-key:page-100',
            },
          },
        },
      }),
    );
    const probe = await createRuntimeComposition({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      recoverAll: () => Promise<unknown[]>;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();
    const recoverAllSpy = spyOn(enginePrototype, 'recoverAll').mockResolvedValue([]);
    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage,
        durableExecution: true,
      });
      try {
        expect(recoverAllSpy).not.toHaveBeenCalled();
        bureau.setRequestAuthorityValidator(() => true);
        await bureau.waitForRecovery?.();
        expect(recoverAllSpy).toHaveBeenCalledTimes(1);
      } finally {
        await bureau.dispose();
      }
    } finally {
      recoverAllSpy.mockRestore();
    }
  });

  it('does not defer recovery forever when session inspection fails with a validator', async () => {
    const storage = new MemoryStorage();
    const sessionStore = createSessionStore(textValueStore(storage));
    await sessionStore.save(
      createAgentSession({
        id: 'inspection-failure-session',
        agentName: 'bureau',
        conversationHistory: createConversationHistory({ id: 'inspection-failure-session' }),
        metadata: { lastRunStatus: 'completed' },
      }),
    );
    let scanCalls = 0;
    const originalGet = storage.get.bind(storage);
    (storage as unknown as { get: (key: string) => Promise<unknown> }).get = async (key) => {
      if (key.includes('agent-session')) {
        scanCalls += 1;
        throw new Error('session inspection unavailable');
      }
      return originalGet(key);
    };
    const diagnostics: string[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage,
      durableExecution: true,
      requestAuthorityValidator: () => true,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });
    try {
      await bureau.waitForRecovery?.();
      expect(scanCalls).toBeGreaterThan(0);
      expect(diagnostics).toContainEqual(
        expect.stringContaining('continuing with the configured authority validator'),
      );
    } finally {
      await bureau.dispose();
    }
  });

  it('reports durable recovery failures during Bureau-origin boot', async () => {
    const probe = await createRuntimeComposition({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      recoverAll: () => Promise<unknown[]>;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();
    const recoverAllSpy = spyOn(enginePrototype, 'recoverAll').mockRejectedValue(
      new Error('boot recovery unavailable'),
    );
    const diagnostics: string[] = [];

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      });

      try {
        expect(diagnostics).toContainEqual(
          expect.stringContaining(
            'Durable run recovery failed during boot: boot recovery unavailable',
          ),
        );
      } finally {
        await bureau.dispose();
      }
    } finally {
      recoverAllSpy.mockRestore();
    }
  });

  it('durably prunes approvals and request authority when approval restoration is permanently invalid', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-stale-approval-recovery-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const approvalSecret = 'expired-recovery-approval-secret';
    const charges: number[] = [];
    try {
      let bureauAReachedStep1 = false;
      const bureauA = await createBureau({
        agents: {},
        generate: async ({ step }) => {
          if (step === 0) {
            return {
              content: '',
              toolCalls: [
                { id: 'expired-recovery-call', name: 'charge-card', arguments: { cents: 875 } },
              ],
            };
          }
          bureauAReachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createNeedsApprovalToolbox(approvalSecret, charges),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const run = await bureauA.createRun({ message: 'Persist an approval that will expire' });
      await pollUntil(() => bureauAReachedStep1);
      const reviewId = `approval:${run.id}:expired-recovery-call`;
      const beforeRecovery = await bureauA.getSession(run.sessionId);
      expect(beforeRecovery?.metadata['pendingApprovalOverrides']).toMatchObject({
        [reviewId]: expect.objectContaining({ approvalToken: expect.any(String) }),
      });
      expect(beforeRecovery?.metadata['lastRequestAuthorities']).toMatchObject({
        [run.id]: expect.objectContaining({ authorizationRevision: 'bureau:1' }),
      });

      // AB-207: deliberately NOT disposing bureauA here. `dispose()`
      // now fully awaits `activeRun.abort()`'s durable-engine `cancel()`
      // handoff before returning, which genuinely completes the
      // in-flight workflow's cancellation and removes it from a fresh
      // engine's `recoverAll()` candidate set — a properly graceful
      // shutdown correctly leaves nothing to recover. Simulating a real
      // crash (the durable workflow still owned by a dead worker, which
      // IS recoverable) means leaving bureauA un-disposed here: it stays
      // parked at step 1's hung `generate()` call until disposed at the
      // end of this test, well after bureauB's recovery.

      const diagnostics: string[] = [];
      const bureauB = await createBureau({
        agents: {},
        generate: async () => ({
          content: 'Recovered after stale approval pruning',
          toolCalls: [],
        }),
        toolbox: createToolbox(
          [
            createTool({
              name: 'charge-card',
              version: '1.0.0',
              description: 'Charge a payment card',
              input: z.object({ cents: z.number() }),
              async execute({ cents }) {
                charges.push(cents);
                return { charged: cents };
              },
            }),
          ],
          {
            approvalSecret,
            // bureauA signed its approval binding at the REAL clock's
            // current time (default runtime, unconverted); bureauB's
            // validation must land past that binding's expiry to exercise
            // the "permanently invalid" recovery path this test asserts. A
            // fixed literal comfortably past any real wall-clock "now" for
            // the foreseeable future reproduces that skew deterministically
            // — unlike `Date.now() + 10 * 60_000`, it never depends on
            // reading the real clock at all.
            approvalNow: () => Date.parse('2099-01-01T00:00:00.000Z'),
            policy: {
              beforeExecute() {
                return {
                  allow: false,
                  status: 'needs_approval',
                  reason: 'Operator approval required',
                  action: { message: 'Approve charge' },
                };
              },
            },
          },
        ),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      });

      try {
        const restoredInvalidApproval = await pollUntil(() =>
          diagnostics.some((message) =>
            message.includes(`Failed to restore approval binding for "${reviewId}"`),
          ),
        );
        expect(restoredInvalidApproval).toBe(true);
        const afterRecovery = await bureauB.getSession(run.sessionId);
        expect(afterRecovery?.metadata['pendingApprovalOverrides']).not.toHaveProperty(reviewId);
        expect(afterRecovery?.metadata['lastRequestAuthorities']).not.toHaveProperty(run.id);
        expect(bureauB.listPendingReviews()).toHaveLength(0);
        expect(charges).toEqual([]);
      } finally {
        bureauB.dispose();
      }
      // AB-207: release bureauA's engine now that bureauB's
      // recovery-dependent assertions are done (its scheduler would
      // otherwise keep polling storage after this test deletes the sqlite
      // file below).
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('retries approval resolution persistence after a transient cleanup failure', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    let failedSessionUpdatesRemaining = 0;
    const persistence = createTextStoreProxy(backingStore, {
      async conditionalBatch(conditions, operations) {
        if (
          failedSessionUpdatesRemaining > 0 &&
          operations.some((operation) => operation.key.startsWith('agent-session:')) &&
          JSON.stringify(operations).includes('resolvedReviewIds')
        ) {
          failedSessionUpdatesRemaining -= 1;
          throw new Error('override cleanup unavailable');
        }
        return backingStore.conditionalBatch(conditions, operations);
      },
    });
    const diagnostics: string[] = [];
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'cleanup-call', name: 'charge-card', arguments: { cents: 425 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('cleanup-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
    });

    const run = await bureau.createRun({ message: 'Charge despite cleanup storage failure' });
    await waitForRunCompletion(bureau, run.id);
    const [review] = bureau.listPendingReviews();
    expect(review).toBeDefined();
    failedSessionUpdatesRemaining = 3;

    const resolutionError = await bureau
      .resolveReview({
        id: review!.id,
        decision: 'approve',
        principal: 'api-key:reviewer-cleanup',
        reason: 'approved after inspection',
      })
      .then(
        () => undefined,
        (error) => error,
      );
    expect(resolutionError).toBeInstanceOf(Error);
    expect((resolutionError as Error).message).toContain('override cleanup unavailable');

    expect(charges).toEqual([425]);
    expect(bureau.listPendingReviews()).toHaveLength(0);

    const persistedSession = await bureau.getSession(run.sessionId);
    expect(persistedSession?.metadata['approvalResolutionStartedIds']).toContain(review!.id);
    expect(persistedSession?.metadata['pendingApprovalOverrides']).toHaveProperty(review!.id);
    expect(diagnostics).toEqual([]);
    await bureau.dispose();

    const restartedBureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('cleanup-secret', charges),
      persistence,
    });
    try {
      expect(restartedBureau.listPendingReviews()).toHaveLength(0);
      expect(charges).toEqual([425]);
      const restartedResolutionError = await restartedBureau
        .resolveReview({
          id: review!.id,
          decision: 'approve',
          principal: 'api-key:reviewer-cleanup',
        })
        .then(
          () => undefined,
          (error) => error,
        );
      expect(restartedResolutionError).toMatchObject({ code: 'NOT_FOUND' });
      expect(charges).toEqual([425]);
    } finally {
      await restartedBureau.dispose();
    }
  });

  it('retries an initial approval binding persistence failure before exposing the live review', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    let failedApprovalPersistence = false;
    const persistence = createTextStoreProxy(backingStore, {
      async conditionalBatch(conditions, operations) {
        if (
          !failedApprovalPersistence &&
          JSON.stringify(operations).includes('pendingApprovalOverrides')
        ) {
          failedApprovalPersistence = true;
          throw new Error('approval binding persistence unavailable');
        }
        return backingStore.conditionalBatch(conditions, operations);
      },
    });
    const diagnostics: string[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'persist-call', name: 'charge-card', arguments: { cents: 725 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('persist-secret', []),
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      sessionPersistenceSleep: async () => {},
    });

    const run = await bureau.createRun({
      message: 'Keep the live approval after persistence fails',
    });
    await waitForRunCompletion(bureau, run.id);

    expect(failedApprovalPersistence).toBe(true);
    expect(bureau.listPendingReviews()).toHaveLength(1);
    const persistedSession = await bureau.getSession(run.sessionId);
    expect(persistedSession?.metadata['pendingApprovalOverrides']).toHaveProperty(
      bureau.listPendingReviews()[0]!.id,
    );
    expect(diagnostics).toEqual([]);
    bureau.dispose();
  });

  it('resolveReview approve keeps a review pending when the policy gates it again', async () => {
    // `createRegatingApprovalToolbox`'s policy returns a DIFFERENT reason on
    // its second evaluation, so `resumeApproval`'s re-run of `beforeExecute`
    // is not satisfied by the prior approval and gates the call again
    // instead of executing it. The review must stay resolvable, not vanish
    // from the queue: the tool never ran, so there is still a genuine
    // approval decision pending.
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-3', name: 'charge-card', arguments: { cents: 900 } }],
        },
      ]),
      toolbox: createRegatingApprovalToolbox('test-secret-3', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      storage: { type: 'memory' },
    });

    const run = await bureau.createRun({ message: 'Charge the customer' });
    await waitForRunCompletion(bureau, run.id);

    const [review] = bureau.listPendingReviews();
    expect(review).toBeDefined();
    await bureau.sessionStore!.update(run.sessionId, (session) => ({
      ...session!,
      metadata: { ...session!.metadata, resolvedReviewIds: [review!.id] },
    }));

    const outcome = await bureau.resolveReview({
      id: review!.id,
      decision: 'approve',
      principal: 'api-key:reviewer-3',
    });

    expect(outcome.decision).toBe('approve');
    expect(charges).toEqual([]); // the tool did NOT run — gated again

    // The review is still there to be resolved, not silently dropped.
    const stillPending = bureau.listPendingReviews();
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0]!.id).toBe(review!.id);
    const persistedSession = await bureau.getSession(run.sessionId);
    expect(persistedSession?.metadata['pendingApprovalOverrides']).toMatchObject({
      [review!.id]: expect.objectContaining({ approvalToken: expect.any(String) }),
    });

    bureau.dispose();
  });

  it('keeps a review pending when approval resume fails before execution admission', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'denied-call', name: 'charge-card', arguments: { cents: 900 } }],
        },
      ]),
      toolbox: createDenyingResumeApprovalToolbox('denied-resume-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      storage: { type: 'memory' },
    });

    const run = await bureau.createRun({ message: 'Charge the customer' });
    await waitForRunCompletion(bureau, run.id);
    const [review] = bureau.listPendingReviews();
    expect(review).toBeDefined();

    expect(
      bureau.resolveReview({
        id: review!.id,
        decision: 'approve',
        principal: 'api-key:reviewer-denied',
      }),
    ).rejects.toThrow('Cannot approve: Current policy denies this charge');

    expect(charges).toEqual([]);
    expect(bureau.listPendingReviews().map(({ id }) => id)).toEqual([review!.id]);
    const persistedSession = await bureau.getSession(run.sessionId);
    expect(persistedSession?.metadata['resolvedReviewIds'] ?? []).not.toContain(review!.id);
    expect(persistedSession?.metadata['pendingApprovalOverrides']).toHaveProperty(review!.id);
    expect(persistedSession?.metadata['approvalResolutionStartedIds'] ?? []).not.toContain(
      review!.id,
    );
    const approvedRecords = await bureau.auditTrail!.query({
      runId: run.id,
      type: 'review.tool-approval.approved',
    });
    expect(approvedRecords).toEqual([]);

    await bureau.dispose();
  });

  it('retries replacement approval persistence when a resumed approval gates again', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    let replacementPersistenceFailuresRemaining = 2;
    let failReplacementPersistence = false;
    let replacementPersistenceAttempts = 0;
    const originalApprovalTokenForFailure: { value: string | undefined } = { value: undefined };
    const persistence = createTextStoreProxy(backingStore, {
      async conditionalBatch(conditions, operations) {
        if (
          failReplacementPersistence &&
          operations.some((operation) => operation.key.startsWith('agent-session:')) &&
          JSON.stringify(operations).includes('pendingApprovalOverrides') &&
          originalApprovalTokenForFailure.value !== undefined &&
          !JSON.stringify(operations).includes(originalApprovalTokenForFailure.value)
        ) {
          replacementPersistenceAttempts += 1;
          if (replacementPersistenceFailuresRemaining > 0) {
            replacementPersistenceFailuresRemaining -= 1;
            throw new Error('replacement approval persistence unavailable');
          }
        }
        return backingStore.conditionalBatch(conditions, operations);
      },
    });
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [
            { id: 'replacement-retry-call', name: 'charge-card', arguments: { cents: 910 } },
          ],
        },
      ]),
      toolbox: createRegatingApprovalToolbox('replacement-retry-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence,
      sessionPersistenceSleep: async () => {},
    });

    const run = await bureau.createRun({ message: 'Charge the customer after retry' });
    await waitForRunCompletion(bureau, run.id);

    const [review] = bureau.listPendingReviews();
    expect(review?.kind).toBe('tool-approval');
    if (!review || review.kind !== 'tool-approval')
      throw new Error('Expected tool approval review');
    const originalApprovalToken = persistedApprovalToken(
      await bureau.getSession(run.sessionId),
      review.id,
    );
    originalApprovalTokenForFailure.value = originalApprovalToken;

    failReplacementPersistence = true;
    const outcome = await bureau.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: 'api-key:reviewer-replacement-retry',
    });

    expect(outcome.decision).toBe('approve');
    expect(replacementPersistenceAttempts).toBe(3);
    expect(charges).toEqual([]);
    const [stillPendingReview] = bureau.listPendingReviews();
    expect(stillPendingReview?.kind).toBe('tool-approval');
    if (!stillPendingReview || stillPendingReview.kind !== 'tool-approval') {
      throw new Error('Expected replacement approval review');
    }
    const replacementApprovalToken = stillPendingReview.approval.approvalToken;
    if (typeof replacementApprovalToken !== 'string') {
      throw new Error('Expected replacement approval token');
    }
    expect(stillPendingReview.id).toBe(review.id);
    expect(replacementApprovalToken).not.toBe(originalApprovalToken);
    expect(persistedApprovalToken(await bureau.getSession(run.sessionId), review.id)).toBe(
      replacementApprovalToken,
    );

    bureau.dispose();
  });

  it('keeps the replacement approval retryable when its persistence exhausts', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    let failReplacementPersistence = false;
    let replacementPersistenceAttempts = 0;
    const originalApprovalTokenForFailure: { value: string | undefined } = { value: undefined };
    const persistence = createTextStoreProxy(backingStore, {
      async conditionalBatch(conditions, operations) {
        if (
          failReplacementPersistence &&
          operations.some((operation) => operation.key.startsWith('agent-session:')) &&
          JSON.stringify(operations).includes('pendingApprovalOverrides') &&
          originalApprovalTokenForFailure.value !== undefined &&
          !JSON.stringify(operations).includes(originalApprovalTokenForFailure.value)
        ) {
          replacementPersistenceAttempts += 1;
          throw new Error('replacement approval persistence unavailable');
        }
        return backingStore.conditionalBatch(conditions, operations);
      },
    });
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [
            { id: 'replacement-exhaustion-call', name: 'charge-card', arguments: { cents: 920 } },
          ],
        },
      ]),
      toolbox: createRegatingApprovalToolbox('replacement-exhaustion-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence,
      sessionPersistenceSleep: async () => {},
    });

    const run = await bureau.createRun({ message: 'Charge the customer after exhaustion' });
    await waitForRunCompletion(bureau, run.id);

    const [review] = bureau.listPendingReviews();
    expect(review?.kind).toBe('tool-approval');
    if (!review || review.kind !== 'tool-approval')
      throw new Error('Expected tool approval review');
    const originalApprovalToken = review.approval.approvalToken;
    if (typeof originalApprovalToken !== 'string') {
      throw new Error('Expected original approval token');
    }
    expect(persistedApprovalToken(await bureau.getSession(run.sessionId), review.id)).toBe(
      originalApprovalToken,
    );
    originalApprovalTokenForFailure.value = originalApprovalToken;

    failReplacementPersistence = true;
    const resolutionError = await bureau
      .resolveReview({
        id: review.id,
        decision: 'approve',
        principal: 'api-key:reviewer-replacement-exhaustion',
      })
      .then(
        () => undefined,
        (error) => error,
      );
    expect(resolutionError).toBeInstanceOf(Error);
    expect((resolutionError as Error).message).toContain(
      'replacement approval persistence unavailable',
    );

    expect(replacementPersistenceAttempts).toBe(3);
    expect(charges).toEqual([]);
    const [stillPendingReview] = bureau.listPendingReviews();
    expect(stillPendingReview?.kind).toBe('tool-approval');
    if (!stillPendingReview || stillPendingReview.kind !== 'tool-approval') {
      throw new Error('Expected original approval review');
    }
    expect(stillPendingReview.id).toBe(review.id);
    expect(stillPendingReview.approval.approvalToken).not.toBe(originalApprovalToken);
    expect(persistedApprovalToken(await bureau.getSession(run.sessionId), review.id)).toBe(
      originalApprovalToken,
    );

    // The in-memory replacement remains the only retryable approval even
    // though durable persistence exhausted its attempts. Once storage
    // recovers, a subsequent resolution uses that replacement binding rather
    // than the consumed original descriptor.
    failReplacementPersistence = false;
    const retryOutcome = await bureau.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: 'api-key:reviewer-replacement-exhaustion',
    });
    expect(retryOutcome.decision).toBe('approve');
    expect(replacementPersistenceAttempts).toBe(3);

    bureau.dispose();
  });

  it('resolveReview approve on a human-wait review signals the parked session', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });

    // A run injected directly via `store.register()` (rather than through
    // `bureau.createRun()`) has no session association — bureau only tracks
    // the run→session mapping inside `createRunFromRequest`, which nothing in
    // this monorepo yet drives for a `requestHumanInput`-parked run (see the
    // AB-20 PR description). `review.sessionId` is therefore `''` here; what
    // this test verifies is that `resolveReview` forwards it — and the
    // signal name and payload — to `bureau.signalSession` UNCHANGED, which is
    // the actual resume wiring under test. `mockImplementation` bypasses the
    // real session lookup (already covered by the signalSession tests above)
    // so this test is purely about resolveReview's call, not signalSession's.
    const signalSpy = spyOn(bureau, 'signalSession').mockImplementation(async () => {});

    const { activeRun, emitter } = createParkedActiveRun();
    const runId = bureau.store.register(activeRun, 'run-approve-human-wait');
    emitter.dispatchEvent(new HumanWaitParkedEvent('human-response', runId, 'Approve?'));

    const [review] = bureau.listPendingReviews();
    expect(review).toBeDefined();

    const outcome = await bureau.resolveReview({
      id: review!.id,
      decision: 'approve',
      principal: 'api-key:reviewer-2',
      payload: { approved: true },
    });

    expect(outcome.decision).toBe('approve');
    expect(signalSpy).toHaveBeenCalledWith('', 'human-response', { approved: true });

    expect(bureau.listPendingReviews()).toHaveLength(0);

    bureau.dispose();
  });

  it('resolveReview deny records the decision without resuming, attributed to the principal', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-3', name: 'charge-card', arguments: { cents: 999 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('test-secret-3', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence: textValueStore(new MemoryStorage()),
    });

    const run = await bureau.createRun({ message: 'Charge the customer' });
    await waitForRunCompletion(bureau, run.id);

    const [review] = bureau.listPendingReviews();
    expect(review).toBeDefined();

    const outcome = await bureau.resolveReview({
      id: review!.id,
      decision: 'deny',
      principal: 'api-key:reviewer-3',
      reason: 'Amount looks fraudulent',
    });

    expect(outcome.decision).toBe('deny');
    expect(outcome.result).toBeUndefined();
    expect(charges).toEqual([]); // never executed

    // The audit trail record carries the ATTRIBUTED principal — this is the
    // NEUTER-VERIFIED assertion: dropping `principal: input.principal` from
    // resolveReview's `auditTrail.record(...)` call (or the `record()` write
    // path itself) makes this specific assertion fail, not just a vague
    // "record exists" check.
    const records = await bureau.auditTrail!.query({ runId: run.id });
    const denyRecord = records.find((record) => record.type === 'review.tool-approval.denied');
    expect(denyRecord).toBeDefined();
    expect(denyRecord!.principal).toBe('api-key:reviewer-3');
    expect((denyRecord!.detail as { reason?: string }).reason).toBe('Amount looks fraudulent');

    expect(bureau.listPendingReviews()).toHaveLength(0);
    const persistedSession = await bureau.getSession(run.sessionId);
    expect(persistedSession?.metadata['resolvedReviewIds']).toContain(review!.id);

    await bureau.deleteSession(run.sessionId);
    // Session deletion does not own the in-memory run's resolved-review
    // suppression. Until the run itself is deleted, the resolved approval
    // must not reappear in the review queue.
    expect(bureau.listPendingReviews()).toHaveLength(0);
    await bureau.deleteRun(run.id);
    await pollUntil(async () => {
      const session = await bureau.getSession(run.sessionId);
      const resolved = session?.metadata['resolvedReviewIds'];
      return !Array.isArray(resolved) || !resolved.includes(review!.id);
    });

    bureau.dispose();
  });

  it('resolveReview throws NOT_FOUND for an unknown or already-resolved review id', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const error = await bureau
      .resolveReview({ id: 'approval:nope:nope', decision: 'approve', principal: 'static-token' })
      .then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_FOUND');

    bureau.dispose();
  });

  it("deleteRun prunes that run's entries out of the resolved-review tracking set", async () => {
    // `resolvedReviewIds` grows monotonically otherwise (an unbounded
    // per-run leak on a long-lived gateway) — `deleteRun` must prune the
    // run's ids so a LATER run reusing the same run id is never permanently
    // suppressed from the review queue by a stale resolved-mark it never
    // itself produced. Reusing a run id doesn't happen in production (ids
    // are unique), but it is the only externally observable way to prove
    // the internal set was actually pruned rather than merely believed to
    // be pruned.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      durableExecution: true,
    });
    // AB-46: `resolveReview` deny on a `human-wait` review now delivers
    // `{ __abDenied: true, ... }` via the real `bureau.signalSession` (the
    // fix this record ships — a denied human-wait run must not stay parked
    // forever). This run has no real session association (registered
    // directly via `store.register()`, not `bureau.createRun()`), so
    // `signalSession` is stubbed exactly as the "resolveReview approve on a
    // human-wait review" test above does — this test is about
    // `resolvedReviewIds` pruning, not signal delivery.
    const signalSpy = spyOn(bureau, 'signalSession').mockImplementation(async () => {});

    const runId = 'run-prune-resolved-ids';
    const first = createParkedActiveRun();
    bureau.store.register(first.activeRun, runId);
    first.emitter.dispatchEvent(new HumanWaitParkedEvent('human-response', runId, 'Approve?'));

    const [review] = bureau.listPendingReviews();
    expect(review).toBeDefined();
    await bureau.resolveReview({
      id: review!.id,
      decision: 'deny',
      principal: 'api-key:reviewer-5',
    });
    expect(signalSpy).toHaveBeenCalledWith('', 'human-response', { __abDenied: true });
    expect(bureau.listPendingReviews()).toHaveLength(0);

    // Terminate and delete the run — deleteRun refuses a still-`running` run.
    first.emitter.dispatchEvent(
      new RunAbortedEvent(0, new Conversation(), new AbortAgentRunError('test-cleanup')),
    );
    await bureau.deleteRun(runId);

    // A new run REUSES the same run id and produces the exact same review id
    // (`human-wait:${runId}:human-response`). Before the fix, this id was
    // still in `resolvedReviewIds` from the first run, so it would never
    // surface — after the fix, deleting the first run pruned it.
    const second = createParkedActiveRun();
    bureau.store.register(second.activeRun, runId);
    second.emitter.dispatchEvent(
      new HumanWaitParkedEvent('human-response', runId, 'Approve again?'),
    );

    const reviewsAfterReuse = bureau.listPendingReviews();
    expect(reviewsAfterReuse).toHaveLength(1);
    expect(reviewsAfterReuse[0]!.id).toBe(review!.id);

    bureau.dispose();
  });
});

describe('createBureau review lifecycle (AB-46)', () => {
  it('resolveReview deny on a human-wait review delivers __abDenied and the parked run reaches a terminal status, not running forever', async () => {
    const generate = createSequentialGenerate([
      {
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'requestHumanInput',
            arguments: { signalName: 'human-response', prompt: 'Approve this refund?' },
          },
        ],
      },
      // AB-46/AB-41's continuation rule: a deny still runs ONE MORE
      // generation step (the fix this record ships — before it, this
      // review's run would stay `running` forever).
      { content: 'refund denied, closing the ticket', toolCalls: [] },
    ]);

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    });

    try {
      const run = await bureau.createRun({ message: 'Please refund this order' });
      await pollUntil(() => bureau.listPendingReviews().some((review) => review.runId === run.id));

      const [review] = bureau.listPendingReviews();
      expect(review!.kind).toBe('human-wait');
      expect(bureau.getRun(run.id)?.status).toBe('running');

      const outcome = await bureau.resolveReview({
        id: review!.id,
        decision: 'deny',
        principal: 'test-operator',
        reason: 'Fraud risk',
      });
      expect(outcome.decision).toBe('deny');

      await waitForRunCompletion(bureau, run.id);

      const finalRun = bureau.getRun(run.id);
      expect(finalRun?.status).toBe('completed');
      expect(bureau.listPendingReviews()).toHaveLength(0);
    } finally {
      bureau.dispose();
    }
  });

  it('resolveReview reject throws BAD_REQUEST before any state change when the reason is missing or empty', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-reject-1', name: 'charge-card', arguments: { cents: 500 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('reject-validation-secret', []),
      stopWhen: stopWhen.toolOutcome('action_required'),
    });

    try {
      const run = await bureau.createRun({ message: 'Charge the customer' });
      await waitForRunCompletion(bureau, run.id);
      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();

      const missingReasonError = await bureau
        .resolveReview({ id: review!.id, decision: 'reject', principal: 'operator-a' })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      expect(missingReasonError).toBeInstanceOf(BureauError);
      expect((missingReasonError as BureauError).code).toBe('BAD_REQUEST');
      expect((missingReasonError as BureauError).message).toBe('reject requires a reason');

      const emptyReasonError = await bureau
        .resolveReview({
          id: review!.id,
          decision: 'reject',
          principal: 'operator-a',
          reason: '   ',
        })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      expect(emptyReasonError).toBeInstanceOf(BureauError);
      expect((emptyReasonError as BureauError).code).toBe('BAD_REQUEST');

      // Neither rejected attempt changed any state — the review is still
      // pending exactly as it was.
      expect(bureau.listPendingReviews().map((candidate) => candidate.id)).toEqual([review!.id]);
    } finally {
      bureau.dispose();
    }
  });

  it('resolveReview reject on a human-wait review requires a reason too, and rejects before delivering a signal', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    try {
      const signalSpy = spyOn(bureau, 'signalSession').mockImplementation(async () => {});
      const { activeRun, emitter } = createParkedActiveRun();
      const runId = bureau.store.register(activeRun, 'run-reject-human-wait-validation');
      emitter.dispatchEvent(new HumanWaitParkedEvent('human-response', runId, 'Approve?'));

      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();

      const error = await bureau
        .resolveReview({ id: review!.id, decision: 'reject', principal: 'operator-a' })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('BAD_REQUEST');
      expect(signalSpy).not.toHaveBeenCalled();
      expect(bureau.listPendingReviews()).toHaveLength(1);
    } finally {
      bureau.dispose();
    }
  });

  it('resolveReview reject with a reason on a tool-approval review revokes the binding and echoes the reason as feedback', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-reject-2', name: 'charge-card', arguments: { cents: 750 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('reject-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence: textValueStore(new MemoryStorage()),
    });

    try {
      const run = await bureau.createRun({ message: 'Charge the customer' });
      await waitForRunCompletion(bureau, run.id);
      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();

      const outcome = await bureau.resolveReview({
        id: review!.id,
        decision: 'reject',
        principal: 'operator-b',
        reason: 'Duplicate charge',
      });
      expect(outcome.decision).toBe('reject');
      expect(outcome.feedback).toBe('Duplicate charge');
      expect(outcome.result).toBeUndefined();
      expect(charges).toEqual([]); // never executed

      const records = await bureau.auditTrail!.query({ runId: run.id });
      const rejectedRecord = records.find(
        (record) => record.type === 'review.tool-approval.rejected',
      );
      expect(rejectedRecord).toBeDefined();
      expect(rejectedRecord!.principal).toBe('operator-b');
      expect((rejectedRecord!.detail as { reason?: string }).reason).toBe('Duplicate charge');

      expect(bureau.listPendingReviews()).toHaveLength(0);
    } finally {
      bureau.dispose();
    }
  });

  it('resolveReview reject with a reason on a human-wait review delivers __abRejected on the signal channel', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    try {
      const signalSpy = spyOn(bureau, 'signalSession').mockImplementation(async () => {});
      const { activeRun, emitter } = createParkedActiveRun();
      const runId = bureau.store.register(activeRun, 'run-reject-human-wait');
      emitter.dispatchEvent(new HumanWaitParkedEvent('human-response', runId, 'Approve?'));

      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();

      const outcome = await bureau.resolveReview({
        id: review!.id,
        decision: 'reject',
        principal: 'operator-c',
        reason: 'Not authorized',
      });
      expect(outcome.decision).toBe('reject');
      expect(outcome.feedback).toBeUndefined(); // feedback is tool-approval-only
      expect(signalSpy).toHaveBeenCalledWith('', 'human-response', {
        __abRejected: true,
        reason: 'Not authorized',
      });
      expect(bureau.listPendingReviews()).toHaveLength(0);
    } finally {
      bureau.dispose();
    }
  });

  describe('getReview', () => {
    it('returns the live pending review for a still-pending id', async () => {
      const bureau = await createBureau({
        agents: {},
        generate: createSequentialGenerate([
          {
            content: '',
            toolCalls: [{ id: 'call-getreview-1', name: 'charge-card', arguments: { cents: 300 } }],
          },
        ]),
        toolbox: createNeedsApprovalToolbox('getreview-secret', []),
        stopWhen: stopWhen.toolOutcome('action_required'),
        persistence: textValueStore(new MemoryStorage()),
      });

      try {
        const run = await bureau.createRun({ message: 'Charge the customer' });
        await waitForRunCompletion(bureau, run.id);
        const [review] = bureau.listPendingReviews();
        expect(review).toBeDefined();

        const found = await bureau.getReview(review!.id);
        expect(found).toBeDefined();
        // `ageMilliseconds` is computed fresh on each `listPendingReviews()`
        // scan, so it can drift by a millisecond between the two live reads
        // above — compare everything else exactly.
        expect({ ...found, ageMilliseconds: 0 }).toEqual({ ...review, ageMilliseconds: 0 });
        expect(found?.status).toBe('pending');
      } finally {
        bureau.dispose();
      }
    });

    it('reconstructs a resolved review from the audit trail with its terminal status', async () => {
      const bureau = await createBureau({
        agents: {},
        generate: createSequentialGenerate([
          {
            content: '',
            toolCalls: [{ id: 'call-getreview-2', name: 'charge-card', arguments: { cents: 400 } }],
          },
        ]),
        toolbox: createNeedsApprovalToolbox('getreview-secret-2', []),
        stopWhen: stopWhen.toolOutcome('action_required'),
        persistence: textValueStore(new MemoryStorage()),
      });

      try {
        const run = await bureau.createRun({ message: 'Charge the customer' });
        await waitForRunCompletion(bureau, run.id);
        const [review] = bureau.listPendingReviews();
        expect(review).toBeDefined();

        await bureau.resolveReview({
          id: review!.id,
          decision: 'deny',
          principal: 'operator-d',
          reason: 'Looks fraudulent',
        });

        expect(bureau.listPendingReviews()).toHaveLength(0);
        const resolved = await bureau.getReview(review!.id);
        expect(resolved).toBeDefined();
        expect(resolved!.status).toBe('denied');
        expect(resolved!.kind).toBe('tool-approval');
        expect(resolved!.runId).toBe(run.id);
      } finally {
        bureau.dispose();
      }
    });

    it('returns undefined for a resolved id when no audit trail is configured (ephemeral bureau)', async () => {
      const bureau = await createBureau({
        agents: {},
        generate: createSequentialGenerate([
          {
            content: '',
            toolCalls: [{ id: 'call-getreview-3', name: 'charge-card', arguments: { cents: 200 } }],
          },
        ]),
        toolbox: createNeedsApprovalToolbox('getreview-secret-3', []),
        stopWhen: stopWhen.toolOutcome('action_required'),
      });

      try {
        const run = await bureau.createRun({ message: 'Charge the customer' });
        await waitForRunCompletion(bureau, run.id);
        const [review] = bureau.listPendingReviews();
        expect(review).toBeDefined();

        await bureau.resolveReview({ id: review!.id, decision: 'deny', principal: 'operator-e' });

        const resolved = await bureau.getReview(review!.id);
        expect(resolved).toBeUndefined();
      } finally {
        bureau.dispose();
      }
    });

    it('returns undefined for an id it has never seen', async () => {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        persistence: textValueStore(new MemoryStorage()),
      });

      try {
        expect(await bureau.getReview('malformed-id-no-colon')).toBeUndefined();
        expect(await bureau.getReview('approval:no-such-run:no-such-call')).toBeUndefined();
      } finally {
        bureau.dispose();
      }
    });

    it("decodes a 'review.tool-approval.superseded' audit record's status as 'superseded'", async () => {
      // No code path in this record writes a `review.*.superseded` audit
      // entry yet (AB-46 scopes that write to a future re-gate change) —
      // this writes one directly through the same public `auditTrail.record`
      // seam `recordReviewStatusTransition` uses, to prove `getReview`
      // decodes it correctly rather than silently falling through to
      // `'denied'` when that write lands.
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        persistence: textValueStore(new MemoryStorage()),
      });

      try {
        const runId = 'run-superseded-review';
        const reviewId = `approval:${runId}:call-superseded`;
        await bureau.auditTrail!.record({
          runId,
          type: 'review.tool-approval.superseded',
          detail: {
            review: {
              kind: 'tool-approval',
              id: reviewId,
              runId,
              sessionId: 'session-superseded',
              agentName: 'bureau',
              approval: {
                callId: 'call-superseded',
                toolName: 'charge-card',
                arguments: { cents: 100 },
                action: { message: 'Approve charge' },
              },
              requestedAt: 0,
              ageMilliseconds: 0,
              status: 'superseded',
            },
            status: 'superseded',
          },
          principal: 'system:supersession',
        });

        const resolved = await bureau.getReview(reviewId);
        expect(resolved?.status).toBe('superseded');
      } finally {
        bureau.dispose();
      }
    });
  });

  it('listPendingReviews excludes a tool-approval review past its binding expiresAt, and sweepExpiredReviews transitions it to expired', async () => {
    const runtime = createManualRuntimeServices();
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-expiry-1', name: 'charge-card', arguments: { cents: 900 } }],
        },
      ]),
      toolbox: createToolbox(
        [
          createTool({
            name: 'charge-card',
            version: '1.0.0',
            description: 'Charge a payment card',
            input: z.object({ cents: z.number() }),
            async execute({ cents }) {
              charges.push(cents);
              return { charged: cents };
            },
          }),
        ],
        {
          approvalSecret: 'expiry-secret',
          approvalBindingTtlMs: 1000,
          runtime,
          policy: {
            beforeExecute() {
              return {
                allow: false,
                status: 'needs_approval',
                reason: 'Operator approval required',
                action: { message: 'Approve charge' },
              };
            },
          },
        },
      ),
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence: textValueStore(new MemoryStorage()),
      runtime,
    });

    try {
      const run = await bureau.createRun({ message: 'Charge the customer' });
      await waitForRunCompletion(bureau, run.id);

      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();

      await runtime.advance(1500);

      expect(bureau.listPendingReviews()).toHaveLength(0);

      const sweptCount = await bureau.sweepExpiredReviews();
      expect(sweptCount).toBe(1);

      const secondSweepCount = await bureau.sweepExpiredReviews();
      expect(secondSweepCount).toBe(0);

      const resolved = await bureau.getReview(review!.id);
      expect(resolved?.status).toBe('expired');

      const records = await bureau.auditTrail!.query({ runId: run.id });
      const expiredRecord = records.find(
        (record) => record.type === 'review.tool-approval.expired',
      );
      expect(expiredRecord).toBeDefined();
      expect(expiredRecord!.principal).toBe('system:expiry-sweep');

      expect(charges).toEqual([]); // never executed
    } finally {
      bureau.dispose();
    }
  });

  it('listPendingReviews excludes a terminal-session-recovered tool-approval review past its binding expiresAt', async () => {
    const storage = await resolveStorage({ type: 'memory' });
    const sessionStore = createSessionStore(textValueStore(storage));
    const runId = 'run-terminal-review-expiry';
    const expiredReviewId = `approval:${runId}:call-expired`;
    const freshReviewId = `approval:${runId}:call-fresh`;
    await sessionStore.save(
      createAgentSession({
        id: 'session-terminal-review-expiry',
        agentName: 'terminal-agent',
        conversationHistory: createConversationHistory({ id: 'session-terminal-review-expiry' }),
        metadata: {
          lastRunId: runId,
          lastRunStatus: 'completed',
          lastRequestAuthorities: {
            [runId]: {
              principalId: 'principal-terminal',
              tenantId: 'bureau',
              ownerId: 'terminal-agent',
              capabilities: ['tools:execute'],
              authorizationRevision: 'bureau:1',
            },
          },
          pendingApprovalOverrides: {
            [expiredReviewId]: {
              toolName: 'charge-card',
              arguments: { cents: 250 },
              approvalToken: 'expired-token',
              action: { message: 'Approve charge' },
              callId: 'call-expired',
              approvalBinding: {
                version: 1,
                principalId: 'principal-terminal',
                tenantId: 'bureau',
                ownerId: 'terminal-agent',
                authorizationRevision: 'bureau:1',
                capabilitiesRevision: '[]',
                audience: 'operator',
                agentId: 'terminal-agent',
                runId,
                toolboxRevision: 'rev-1',
                toolDefinitionRevision: 'tool-rev-1',
                policyRevision: 'policy-rev-1',
                approvalRevision: 'approval-rev-1',
                issuedAt: 1,
                expiresAt: 2,
                nonce: 'nonce-expired',
                replayScope: `bureau:${runId}`,
              },
            },
            [freshReviewId]: {
              toolName: 'charge-card',
              arguments: { cents: 250 },
              approvalToken: 'fresh-token',
              action: { message: 'Approve charge' },
              callId: 'call-fresh',
            },
          },
        },
      }),
    );

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage,
      durableExecution: true,
    });
    try {
      const reviews = bureau.listPendingReviews();
      expect(reviews.map((review) => review.id)).toEqual([freshReviewId]);
    } finally {
      await bureau.dispose();
    }
  });

  it('abortRun transitions every still-pending review (both kinds) for the run to canceled', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
    });

    try {
      const { activeRun, emitter } = createParkedActiveRun();
      const runId = bureau.store.register(activeRun, 'run-abort-both-kinds');
      emitter.dispatchEvent(
        new StepCompletedEvent({
          step: 0,
          conversation: new Conversation(),
          content: '',
          toolCalls: [],
          results: [
            {
              callId: 'call-abort-1',
              outcome: 'action_required',
              content: 'needs approval',
              toolCallId: 'call-abort-1',
              toolName: 'charge-card',
              result: undefined,
              action: { type: 'approval', message: 'Approve charge' },
              pendingApproval: {
                callId: 'call-abort-1',
                toolName: 'charge-card',
                arguments: { cents: 500 },
                action: { type: 'approval', message: 'Approve charge' },
              },
            },
          ],
          final: true,
        }),
      );
      emitter.dispatchEvent(new HumanWaitParkedEvent('human-response', runId, 'Approve?'));

      const approvalReviewId = `approval:${runId}:call-abort-1`;
      const humanWaitReviewId = `human-wait:${runId}:human-response`;
      expect(
        bureau
          .listPendingReviews()
          .map((review) => review.id)
          .sort(),
      ).toEqual([approvalReviewId, humanWaitReviewId].sort());

      bureau.abortRun(runId);

      await pollUntil(() => bureau.listPendingReviews().length === 0);

      const resolvedApproval = await bureau.getReview(approvalReviewId);
      expect(resolvedApproval?.status).toBe('canceled');
      const resolvedHumanWait = await bureau.getReview(humanWaitReviewId);
      expect(resolvedHumanWait?.status).toBe('canceled');

      const records = await bureau.auditTrail!.query({ runId });
      expect(records.some((record) => record.type === 'review.tool-approval.canceled')).toBe(true);
      expect(records.some((record) => record.type === 'review.human-wait.canceled')).toBe(true);
      const reviewRecords = records.filter((record) => record.type.startsWith('review.'));
      expect(reviewRecords.length).toBeGreaterThan(0);
      expect(reviewRecords.every((record) => record.principal === 'system:run-abort')).toBe(true);

      const approveAfterCancel = await bureau
        .resolveReview({ id: approvalReviewId, decision: 'approve', principal: 'operator-f' })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      expect(approveAfterCancel).toBeInstanceOf(BureauError);
      expect((approveAfterCancel as BureauError).code).toBe('NOT_FOUND');

      const denyAfterCancel = await bureau
        .resolveReview({ id: humanWaitReviewId, decision: 'deny', principal: 'operator-f' })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      expect(denyAfterCancel).toBeInstanceOf(BureauError);
      expect((denyAfterCancel as BureauError).code).toBe('NOT_FOUND');
    } finally {
      bureau.dispose();
    }
  });

  it('cancelDurableRun transitions a pending human-wait review to canceled when cancellation actually commits', async () => {
    const generate = createSequentialGenerate([
      {
        content: '',
        toolCalls: [
          {
            id: 'call-cancel-1',
            name: 'requestHumanInput',
            arguments: { signalName: 'human-response' },
          },
        ],
      },
    ]);
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      stopWhen: stopWhen.toolCalled('requestHumanInput'),
    });

    try {
      const run = await bureau.createRun({ message: 'park-for-cancel' });
      await pollUntil(() => bureau.listPendingReviews().some((review) => review.runId === run.id));

      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();

      const outcome = await bureau.cancelDurableRun(run.id);
      expect(outcome.status).toBe('requested');

      await pollUntil(() => bureau.listPendingReviews().length === 0);

      const resolved = await bureau.getReview(review!.id);
      expect(resolved?.status).toBe('canceled');

      const records = await bureau.auditTrail!.query({ runId: run.id });
      const canceledRecord = records.find((record) => record.type === 'review.human-wait.canceled');
      expect(canceledRecord).toBeDefined();
      expect(canceledRecord!.principal).toBe('system:run-abort');

      const resolveAfterCancel = await bureau
        .resolveReview({ id: review!.id, decision: 'approve', principal: 'operator-g' })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      expect(resolveAfterCancel).toBeInstanceOf(BureauError);
      expect((resolveAfterCancel as BureauError).code).toBe('NOT_FOUND');
    } finally {
      bureau.dispose();
    }
  });
});

// ── AB-13: flow control ───────────────────────────────────────────────

async function rejectionOf<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/**
 * `submitSchedulerTask` is a plain (non-`async`) function — an admission
 * rejection throws SYNCHRONOUSLY rather than returning a rejected promise
 * (matching its existing `BAD_REQUEST`/`NOT_CONFIGURED` validation throws).
 * Defer the call through `Promise.resolve().then(...)` so `rejectionOf`'s
 * `.then()` chain has a promise to attach to.
 */
async function rejectionOfSchedulerSubmit(
  call: () => ReturnType<Bureau['submitSchedulerTask']>,
): Promise<unknown> {
  return rejectionOf(Promise.resolve().then(call));
}

describe('createBureau flow control (AB-13)', () => {
  it('enforces a concurrency cap, rejecting admission until a slot frees', async () => {
    const { generate } = createBlockingGenerate();
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      flowControl: { concurrency: { limit: 2 } },
    });

    const first = await bureau.createRun({ message: 'one' });
    const second = await bureau.createRun({ message: 'two' });

    const rejected = await rejectionOf(bureau.createRun({ message: 'three' }));
    expect(rejected).toBeInstanceOf(BureauError);
    expect((rejected as BureauError).code).toBe('RATE_LIMITED');
    expect((rejected as BureauError).message).toContain('concurrency');

    // Settling one run (abort → run.aborted → flowController.settle) frees its slot.
    bureau.abortRun(first.id);
    await waitForRunState(bureau, first.id);

    const third = await bureau.createRun({ message: 'three-retry' });
    expect(third.id).not.toBe(first.id);

    bureau.abortRun(second.id);
    bureau.abortRun(third.id);
    await waitForRunState(bureau, second.id);
    await waitForRunState(bureau, third.id);

    bureau.dispose();
  });

  it('isolates the concurrency cap per agent by default', async () => {
    const { generate } = createBlockingGenerate();
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      flowControl: { concurrency: { limit: 1 } },
    });

    const runA = await bureau.createRun({ message: 'a', agentName: 'agent-a' });
    const runB = await bureau.createRun({ message: 'b', agentName: 'agent-b' });
    expect(runA.id).not.toBe(runB.id);

    const rejectedA = await rejectionOf(bureau.createRun({ message: 'a2', agentName: 'agent-a' }));
    expect(rejectedA).toBeInstanceOf(BureauError);
    expect((rejectedA as BureauError).code).toBe('RATE_LIMITED');

    // agent-b's cap is a SEPARATE key — unaffected by agent-a's exhaustion.
    const rejectedB = await rejectionOf(bureau.createRun({ message: 'b2', agentName: 'agent-b' }));
    expect(rejectedB).toBeInstanceOf(BureauError);

    bureau.abortRun(runA.id);
    bureau.abortRun(runB.id);
    await waitForRunState(bureau, runA.id);
    await waitForRunState(bureau, runB.id);

    bureau.dispose();
  });

  it('isolates rate limits per an arbitrary key function', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      flowControl: {
        rateLimit: {
          limit: 1,
          windowMilliseconds: 60_000,
          key: (trigger) => trigger.principal ?? 'anonymous',
        },
      },
    });

    const alice = await bureau.createRun({ message: 'hi', principal: 'alice' });
    await waitForRunCompletion(bureau, alice.id);

    const aliceAgain = await rejectionOf(
      bureau.createRun({ message: 'hi again', principal: 'alice' }),
    );
    expect(aliceAgain).toBeInstanceOf(BureauError);
    expect((aliceAgain as BureauError).code).toBe('RATE_LIMITED');
    expect((aliceAgain as BureauError).message).toContain('rate-limit');

    // A different principal has its own, unconsumed limit.
    const bob = await bureau.createRun({ message: 'hi', principal: 'bob' });
    await waitForRunCompletion(bureau, bob.id);

    bureau.dispose();
  });

  it('dedupes a concurrent identical trigger via singleton, and admits again once it settles', async () => {
    const { generate } = createBlockingGenerate();
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      flowControl: { singleton: { key: (trigger) => trigger.sessionId ?? 'none' } },
    });

    const first = await bureau.createRun({ message: 'first', sessionId: 'shared-session' });

    const duplicate = await rejectionOf(
      bureau.createRun({ message: 'duplicate', sessionId: 'shared-session' }),
    );
    expect(duplicate).toBeInstanceOf(BureauError);
    expect((duplicate as BureauError).code).toBe('RATE_LIMITED');
    expect((duplicate as BureauError).message).toContain('singleton');

    // A different key is unaffected.
    const independent = await bureau.createRun({
      message: 'independent',
      sessionId: 'other-session',
    });
    expect(independent.id).not.toBe(first.id);

    bureau.abortRun(first.id);
    await waitForRunState(bureau, first.id);

    // Once the original settles, a fresh trigger with the same key is admitted.
    const afterSettle = await bureau.createRun({ message: 'retry', sessionId: 'shared-session' });
    expect(afterSettle.id).not.toBe(first.id);

    bureau.abortRun(independent.id);
    bureau.abortRun(afterSettle.id);
    await waitForRunState(bureau, independent.id);
    await waitForRunState(bureau, afterSettle.id);

    bureau.dispose();
  });

  it('covers scheduler-originated admission, and frees + reclaims the concurrency slot across a real preempt/resume cycle', async () => {
    // Task A's generate blocks until aborted, so A never settles on its own: it
    // is only ever preempted (aborted) or cancelled at the end of the test.
    const { generate } = createBlockingGenerate();
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      scheduler: { enabled: true, idleDelay: 1 },
      flowControl: { concurrency: { limit: 1 } },
    });

    // A (background priority) is admitted and dispatched — the only task, so
    // the scheduler starts it immediately, occupying the concurrency slot.
    const taskA = await bureau.submitSchedulerTask({ message: 'task A', priority: 'background' });
    await waitForCondition(
      () => bureau.scheduler?.getState().activeTask?.id === taskA.taskId,
      'task A was not dispatched',
    );

    // A SECOND submission is rejected outright — the cap is full.
    const rejectedWhileActive = await rejectionOfSchedulerSubmit(() =>
      bureau.submitSchedulerTask({ message: 'rejected while A runs', priority: 'background' }),
    );
    expect(rejectedWhileActive).toBeInstanceOf(BureauError);
    expect((rejectedWhileActive as BureauError).code).toBe('RATE_LIMITED');

    // Submit an IMMEDIATE task directly on the scheduler (bypassing bureau's
    // own admission gate — this is purely the mechanism to force a REAL
    // preemption of task A, not a flow-controlled trigger itself).
    //
    // The immediate task's generate BLOCKS until this test releases it. That is
    // load-bearing: while the immediate task occupies the scheduler, requeued
    // task A cannot be redispatched, so A stays parked — and its concurrency
    // slot stays free — for the whole task C sequence below. With a
    // self-completing generate here the scheduler was free to redispatch A (and
    // reclaim A's slot via TaskDispatchedEvent) before task C was submitted,
    // making C's admission a race that lost under CI contention (#246).
    const immediate = createBlockingGenerate();
    const immediateResult = bureau.scheduler!.submitImmediate(() => ({
      generate: immediate.generate,
      toolbox: createEmptyToolbox(),
      conversation: new Conversation(),
      maximumSteps: 1,
    }));
    await waitForCondition(
      () => (bureau.scheduler?.getState().preemptedCount ?? 0) >= 1,
      'task A was not preempted',
    );

    // AB-13 — task A's preemption (requeued) freed its concurrency slot: a
    // NEW scheduler-originated submission is now admitted.
    const taskC = await bureau.submitSchedulerTask({ message: 'task C', priority: 'background' });
    expect(taskC.taskId).not.toBe(taskA.taskId);

    // The cap is full again with C holding the reclaimed slot.
    const rejectedWithCHoldingSlot = await rejectionOfSchedulerSubmit(() =>
      bureau.submitSchedulerTask({
        message: 'rejected while C holds the slot',
        priority: 'background',
      }),
    );
    expect(rejectedWithCHoldingSlot).toBeInstanceOf(BureauError);

    // Free C's slot (it may still be queued behind the immediate task, so
    // cancel rather than abort — TaskCancelledEvent settles it either way).
    bureau.scheduler!.cancel(taskC.taskId);

    // Arm the redispatch listener BEFORE releasing the immediate task, so the
    // dispatch cannot slip through between the release and the subscription.
    // Awaiting the real TaskDispatchedEvent is deterministic; polling
    // `activeTask` instead raced the scheduler's redispatch timer and gave up
    // while task A was still on its way in (#246).
    const taskARedispatched = new Promise<void>((resolve) => {
      const onDispatched = (event: Event) => {
        if (!(event instanceof TaskDispatchedEvent) || event.taskId !== taskA.taskId) return;

        bureau.scheduler!.removeEventListener(TaskDispatchedEvent.type, onDispatched);
        resolve();
      };

      bureau.scheduler!.addEventListener(TaskDispatchedEvent.type, onDispatched);
    });

    // Release the immediate task so the scheduler redispatches task A (requeued
    // on preemption). Task A's own generate stays blocked, so A holds the
    // reclaimed slot for the assertion below rather than settling.
    immediate.resolve({ content: 'immediate-done', toolCalls: [] });
    await immediateResult;
    await taskARedispatched;

    // AB-13 — task A's resume (TaskDispatchedEvent) reclaimed its slot: with
    // C already cancelled/settled, a fresh submission is rejected again only
    // because A's resumed slot fills the cap.
    const rejectedAfterResume = await rejectionOfSchedulerSubmit(() =>
      bureau.submitSchedulerTask({ message: 'rejected after A resumed', priority: 'background' }),
    );
    expect(rejectedAfterResume).toBeInstanceOf(BureauError);
    expect((rejectedAfterResume as BureauError).code).toBe('RATE_LIMITED');

    bureau.scheduler!.cancel(taskA.taskId);
    bureau.dispose();
  });
});

// ── F3 real durable park wiring (bureau-durable-park-event-wiring) ────────
//
// Regression coverage for the pre-existing gap: `createRunFromRequest` never
// threaded a run's event emitter (or the real `ctx.services` object) into
// `requestHumanInput`, so a HumanWaitParkedEvent from an ACTUAL durable park
// never reached bureau's listeners — only synthetic `ActiveRun` fixtures
// (`createParkedActiveRun` above) exercised AB-13's `markParked`/`markResumed`
// and AB-20's `listPendingReviews` human-wait branch. These tests drive a
// REAL durable run through `requestHumanInput` end to end via the new
// `humanInput: true` bureau option.

describe('createBureau human input wiring — real durable park (F3)', () => {
  it('a real durable park frees the flow-control concurrency slot and reclaims it on resume', async () => {
    const parkingGenerate = createSequentialGenerate([
      {
        content: '',
        toolCalls: [
          { id: 'call-1', name: 'requestHumanInput', arguments: { signalName: 'human-response' } },
        ],
      },
    ]);

    const { generate: blockingGenerate, resolve: resolveBlocking } = createBlockingGenerate();

    // Route the FIRST generate call (run1's only step, before it parks) to the
    // HITL tool call, and every subsequent call (run2's step(s)) to the
    // blocking generate — the two runs are created strictly in that order, so
    // this call-index dispatch reliably distinguishes them without needing to
    // inspect conversation content.
    let callIndex = 0;
    const generate: GenerateFunction = async (context) => {
      const index = callIndex++;
      return index === 0 ? parkingGenerate(context) : blockingGenerate(context);
    };

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      flowControl: { concurrency: { limit: 1 } },
      // `toolCalled` stops run1's loop right after the HITL tool call (so the
      // post-loop park check sees `pendingHumanWait` set); `noToolCalls` stops
      // run2's loop on its first (tool-free) resolved step, once the test
      // releases `resolveBlocking`.
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    });

    try {
      // 1. Admit the run that will park — occupies the only slot.
      const run1 = await bureau.createRun({ message: 'park-me' });

      // 2. Wait for the REAL requestHumanInput tool call to fire
      // HumanWaitParkedEvent and free the slot (AB-13 markParked).
      await pollUntil(() =>
        bureau
          .listPendingReviews()
          .some((review) => review.kind === 'human-wait' && review.runId === run1.id),
      );

      // 3. The slot is free: a second run is admitted (would have been
      // rejected before the park freed it).
      const run2 = await bureau.createRun({ message: 'hold the slot' });
      expect(run2.id).not.toBe(run1.id);

      // 4. With run2 (blocked, never settling) holding the only slot, a third
      // admission is rejected — proves the slot is genuinely occupied at 1/1.
      const rejectedWhileRun2Holds = await rejectionOf(
        bureau.createRun({ message: 'rejected while run2 holds the slot' }),
      );
      expect(rejectedWhileRun2Holds).toBeInstanceOf(BureauError);
      expect((rejectedWhileRun2Holds as BureauError).code).toBe('RATE_LIMITED');

      // 5. Resume run1 via the real signal path. `signalSession` calls
      // `flowController.markResumed(runId)` synchronously right after the
      // engine accepts the signal — before Weft's inline-launch continuation
      // (a macrotask) has any chance to run and settle run1. A synchronous
      // admission check immediately after this `await` therefore reliably
      // observes run1's slot as reclaimed.
      await bureau.signalSession(run1.sessionId, 'human-response', { approved: true });

      // 6. Reclaim: run2 still holds its slot AND run1 just reclaimed its
      // own — a fourth admission is rejected again, proving `markResumed`
      // actually re-occupied the cap rather than leaving it permanently freed.
      const rejectedAfterResume = await rejectionOf(
        bureau.createRun({ message: 'rejected after run1 reclaimed its slot' }),
      );
      expect(rejectedAfterResume).toBeInstanceOf(BureauError);
      expect((rejectedAfterResume as BureauError).code).toBe('RATE_LIMITED');

      // Cleanup: free run2's slot and let run1 settle.
      resolveBlocking({ content: 'run2-done', toolCalls: [] });
      await waitForRunCompletion(bureau, run2.id);
      await waitForRunCompletion(bureau, run1.id);

      const finalRun1 = bureau.getRun(run1.id);
      expect(finalRun1?.status).toBe('completed');
    } finally {
      bureau.dispose();
    }
  });

  it('listPendingReviews surfaces a real durable park and resolveReview resumes it', async () => {
    const generate = createSequentialGenerate([
      {
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'requestHumanInput',
            arguments: { signalName: 'human-response', prompt: 'Approve this refund?' },
          },
        ],
      },
      // AB-44 — approving the review delivers the signal, which now CONTINUES
      // the run with one more generation step (never just unparks it).
      { content: 'refund approved and processed', toolCalls: [] },
    ]);

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      // `toolCalled('requestHumanInput')` stops the FIRST step right on the
      // park request; `noToolCalls()` stops the CONTINUATION step (AB-44 —
      // the resumed run's next generation step, which never itself calls
      // requestHumanInput again here) once it settles on plain content.
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    });

    try {
      const run = await bureau.createRun({ message: 'Please refund this order' });

      await pollUntil(() => bureau.listPendingReviews().some((review) => review.runId === run.id));

      const reviews = bureau.listPendingReviews();
      expect(reviews).toHaveLength(1);
      const [review] = reviews;
      expect(review!.kind).toBe('human-wait');
      if (review!.kind !== 'human-wait') throw new Error('unreachable');
      expect(review!.runId).toBe(run.id);
      expect(review!.sessionId).toBe(run.sessionId);
      expect(review!.signalName).toBe('human-response');
      expect(review!.prompt).toBe('Approve this refund?');

      // The run is genuinely still parked (a real durable ctx.waitForSignal,
      // not a synthetic fixture) — it has not settled.
      expect(bureau.getRun(run.id)?.status).toBe('running');

      const result = await bureau.resolveReview({
        id: review!.id,
        decision: 'approve',
        principal: 'test-operator',
      });
      expect(result.decision).toBe('approve');

      await waitForRunCompletion(bureau, run.id);

      const finalRun = bureau.getRun(run.id);
      expect(finalRun?.status).toBe('completed');

      // Resolved reviews disappear from the queue immediately.
      expect(bureau.listPendingReviews()).toHaveLength(0);
    } finally {
      bureau.dispose();
    }
  });

  it('revalidates captured request authority before approving a human wait', async () => {
    let authorityCurrent = true;
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [
            {
              id: 'human-wait-authority-call',
              name: 'requestHumanInput',
              arguments: { signalName: 'human-response', prompt: 'Approve this refund?' },
            },
          ],
        },
      ]),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      stopWhen: stopWhen.toolCalled('requestHumanInput'),
    });
    try {
      const signalSpy = spyOn(bureau, 'signalSession').mockImplementation(async () => {});
      bureau.setRequestAuthorityValidator(() => authorityCurrent);
      const run = await bureau.createRun({
        message: 'Please refund this order',
        requestContext: {
          authority: {
            principalId: 'api-key:revoked',
            tenantId: 'bureau',
            ownerId: 'bureau',
            capabilities: ['tools:execute'],
            authorizationRevision: 'gateway:api-key:revoked',
          },
          audience: 'operator',
        },
      });

      await pollUntil(() => bureau.listPendingReviews().some((review) => review.runId === run.id));
      const [review] = bureau.listPendingReviews();
      authorityCurrent = false;
      expect(
        bureau.resolveReview({
          id: review!.id,
          decision: 'approve',
          principal: 'test-operator',
        }),
      ).rejects.toThrow('no longer current');
      expect(signalSpy).not.toHaveBeenCalled();
      expect(bureau.listPendingReviews()).toHaveLength(1);
    } finally {
      bureau.dispose();
    }
  });
});

// ── AB-41 / AB-43: requestHumanInput availability across durability
// configurations ───────────────────────────────────────────────────────
//
// AB-41's decision record ratifies the durable-only park tools' contract: an
// unavailable capability is absent from the effective toolbox (preferred) or
// rejects with a stable typed `DurableCapabilityUnavailableError` (the
// standalone `createAgent` fallback, covered by
// packages/operative/src/create-request-human-input-tool.test.ts and
// create-schedule-wakeup-tool.test.ts). These tests cover the Bureau side of
// the four named configurations: a Bureau with no durable engine omits the
// tool; a Bureau with a durable engine backed by ephemeral MemoryStorage or
// by persistent SQLite storage both include it and actually park (the
// signal is `!!runtime.durable`, independent of checkpoint persistence).
describe('createBureau requestHumanInput availability across durability configurations (AB-43)', () => {
  it('createHumanWaitContext always signals durable: true (only ever constructed inside the runtime.durable guard)', () => {
    const context = createHumanWaitContext({}, 'run-1');
    expect(context.durable).toBe(true);
  });

  it('config 2 — omits requestHumanInput from the effective toolbox when no durable engine is attached', async () => {
    const seenTools: string[] = [];
    const generate: GenerateFunction = async (context) => {
      seenTools.push(...context.toolbox.tools().map((tool) => tool.name));
      return { content: 'no park here', toolCalls: [] };
    };

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      humanInput: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const run = await bureau.createRun({ message: 'no durable engine attached' });
      await waitForRunCompletion(bureau, run.id);

      expect(seenTools).not.toContain('requestHumanInput');
    } finally {
      bureau.dispose();
    }
  });

  it('config 3 — includes requestHumanInput and actually parks over ephemeral (MemoryStorage) durable storage', async () => {
    const seenTools: string[] = [];
    const generate = createSequentialGenerate([
      {
        content: '',
        toolCalls: [
          { id: 'call-1', name: 'requestHumanInput', arguments: { signalName: 'human-response' } },
        ],
      },
    ]);
    const wrappedGenerate: GenerateFunction = async (context) => {
      seenTools.push(...context.toolbox.tools().map((tool) => tool.name));
      return generate(context);
    };

    const bureau = await createBureau({
      agents: {},
      generate: wrappedGenerate,
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      stopWhen: stopWhen.toolCalled('requestHumanInput'),
    });

    try {
      const run = await bureau.createRun({ message: 'park over ephemeral memory storage' });
      await pollUntil(() => bureau.listPendingReviews().some((review) => review.runId === run.id));

      // Discovery: the model's first step already saw requestHumanInput as an
      // available tool (AC — discovery reveals availability before invocation).
      expect(seenTools).toContain('requestHumanInput');

      const [review] = bureau.listPendingReviews();
      expect(review?.kind).toBe('human-wait');
    } finally {
      bureau.dispose();
    }
  });

  it('config 4 — includes requestHumanInput and actually parks over persistent (SQLite) durable storage', async () => {
    const databasePath = join(
      tmpdir(),
      `ab-43-persistent-park-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      const seenTools: string[] = [];
      const generate = createSequentialGenerate([
        {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'human-response' },
            },
          ],
        },
      ]);
      const wrappedGenerate: GenerateFunction = async (context) => {
        seenTools.push(...context.toolbox.tools().map((tool) => tool.name));
        return generate(context);
      };

      const bureau = await createBureau({
        agents: {},
        generate: wrappedGenerate,
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        humanInput: true,
        stopWhen: stopWhen.toolCalled('requestHumanInput'),
      });

      try {
        const run = await bureau.createRun({ message: 'park over persistent sqlite storage' });
        await pollUntil(() =>
          bureau.listPendingReviews().some((review) => review.runId === run.id),
        );

        // Discovery: the model's first step already saw requestHumanInput as an
        // available tool (AC — discovery reveals availability before invocation).
        expect(seenTools).toContain('requestHumanInput');

        const [review] = bureau.listPendingReviews();
        expect(review?.kind).toBe('human-wait');
      } finally {
        bureau.dispose();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('a standalone requestHumanInput tool (no Bureau composition) rejects DurableCapabilityUnavailableError rather than omitting itself', () => {
    // Config 1 belongs to operative's factory-level tests
    // (create-request-human-input-tool.test.ts); this asserts only that the
    // SAME error class Bureau's composition never needs (because it prefers
    // omission) is the one a standalone caller sees, keeping both halves of
    // the "omit, or throw" contract anchored to one exported type.
    expect(DurableCapabilityUnavailableError).toBeDefined();
    const error = new DurableCapabilityUnavailableError('requestHumanInput');
    expect(error.code).toBe('DurableCapabilityUnavailableError');
    expect(error.category).toBe('unavailable');
    expect(error.retryable).toBe(false);
  });
});

// ── AB-201: scheduleWakeup wired into Bureau composition ────────────────
//
// Mirrors `requestHumanInput`'s own wiring (F3 / AB-43 above) exactly, per
// AB-41's decision record: `scheduleWakeup` is opt-in (`options.wakeup`),
// gated on `runtime.durable`, and forwards onto the run's real `ctx.services`
// object via the shared `servicesRef`/`onServices` capture. Unlike
// `requestHumanInput` (a signal wait, resumed via `bureau.signalSession`),
// `scheduleWakeup` parks via a durable `ctx.sleep` — there is no fake-clock
// harness anywhere in this repository's Weft-backed tests, so these tests
// drive the timer deterministically via `bureau.runDurableMaintenance(now)`
// (Weft's `Engine.runMaintenance` ticks `internals.scheduler.tick(now)`
// directly — the same seam `engine.scheduler.tick(deadline)` exercises at the
// operative layer, reached here through Bureau's own public host-maintenance
// surface since Bureau exposes no direct engine accessor). Composed with
// `durableBackgroundTasks: 'manual'` so the scheduler poller is disarmed:
// nothing but an explicit maintenance tick can ever fire the timer, which is
// exactly what proves a genuine park rather than a real-time race.
describe('createBureau scheduleWakeup wiring (AB-201)', () => {
  it('createWakeupContext always signals durable: true (only ever constructed inside the runtime.durable guard)', () => {
    const context = createWakeupContext({});
    expect(context.durable).toBe(true);
  });

  it('createWakeupContext forwards pendingWakeup reads/writes onto the shared servicesRef, not a detached copy', () => {
    const servicesRef: { current?: DurableRunDeps } = {};
    const context = createWakeupContext(servicesRef);

    // No live services yet: reads report undefined, writes are dropped rather
    // than throwing (mirrors createHumanWaitContext's own guard).
    expect(context.pendingWakeup).toBeUndefined();
    context.pendingWakeup = { duration: '6h' };
    expect(context.pendingWakeup).toBeUndefined();

    // Once `onServices` fires (simulated here), the SAME object the durable
    // workflow reads is mutated — not a copy the tool wrote to in isolation.
    servicesRef.current = {} as DurableRunDeps;
    context.pendingWakeup = { duration: '30m', note: 'check the deploy' };
    expect(servicesRef.current.pendingWakeup).toEqual({
      duration: '30m',
      note: 'check the deploy',
    });
    expect(context.pendingWakeup).toEqual({ duration: '30m', note: 'check the deploy' });
  });

  it('a standalone scheduleWakeup tool (no Bureau composition) rejects DurableCapabilityUnavailableError rather than omitting itself', () => {
    // The tool-level throw itself is out of scope for this issue (shipped by
    // AB-43 upstream, covered by operative's own
    // create-schedule-wakeup-tool.test.ts); this only anchors that the SAME
    // error class Bureau's composition never needs (because it prefers
    // omission, like config 2 below) is what a standalone caller sees.
    const tool = createScheduleWakeupTool({
      context: { pendingWakeup: undefined, durable: false },
    });
    let caught: unknown;
    try {
      tool.execute({ in: '6h' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DurableCapabilityUnavailableError);
    expect((caught as DurableCapabilityUnavailableError).code).toBe(
      'DurableCapabilityUnavailableError',
    );
    expect((caught as DurableCapabilityUnavailableError).category).toBe('unavailable');
    expect((caught as DurableCapabilityUnavailableError).retryable).toBe(false);
  });

  it('config 2 — omits scheduleWakeup from the effective toolbox when no durable engine is attached', async () => {
    const seenTools: string[] = [];
    const generate: GenerateFunction = async (context) => {
      seenTools.push(...context.toolbox.tools().map((tool) => tool.name));
      return { content: 'no park here', toolCalls: [] };
    };

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      wakeup: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const run = await bureau.createRun({ message: 'no durable engine attached' });
      await waitForRunCompletion(bureau, run.id);

      expect(seenTools).not.toContain('scheduleWakeup');
    } finally {
      bureau.dispose();
    }
  });

  it('config 3 — includes scheduleWakeup, genuinely parks over ephemeral (MemoryStorage) durable storage, and fires only on an explicit tick', async () => {
    const seenTools: string[] = [];
    const generate = createSequentialGenerate([
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'scheduleWakeup', arguments: { in: '6h' } }],
      },
      // AB-45 — a fired wakeup CONTINUES the same run with one more
      // generation step, never just unparks it.
      { content: 'resumed after the wakeup fired', toolCalls: [] },
    ]);
    const wrappedGenerate: GenerateFunction = async (context) => {
      seenTools.push(...context.toolbox.tools().map((tool) => tool.name));
      return generate(context);
    };

    const bureau = await createBureau({
      agents: {},
      generate: wrappedGenerate,
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      wakeup: true,
      durableBackgroundTasks: 'manual',
      stopWhen: stopWhen.some(stopWhen.toolCalled('scheduleWakeup'), stopWhen.noToolCalls()),
    });

    try {
      const run = await bureau.createRun({ message: 'park over ephemeral memory storage' });
      await pollUntil(() => generate.callCount >= 1);

      // Discovery: the model's first step already saw scheduleWakeup as an
      // available tool.
      expect(seenTools).toContain('scheduleWakeup');

      // Genuine park proof: with the scheduler poller disarmed
      // (durableBackgroundTasks: 'manual'), nothing can advance the durable
      // timer without an explicit tick — polling WITHOUT ticking must never
      // observe completion, and the continuation step must never run.
      const firedWithoutTick = await pollUntil(
        () => bureau.getRun(run.id)?.status === 'completed',
        5,
      );
      expect(firedWithoutTick).toBe(false);
      expect(bureau.getRun(run.id)?.status).not.toBe('completed');
      expect(generate.callCount).toBe(1);

      // Drive the scheduler directly past the wakeup's deadline — no real
      // wall-clock wait. `bureau.runDurableMaintenance(now)` is the
      // host-driven maintenance path, which ticks Weft's durable-timer
      // scheduler (`Engine.runMaintenance` calls `internals.scheduler.tick(now)`
      // internally) — the deterministic seam `engine.scheduler.tick(deadline)`
      // exercises directly at the operative layer.
      const deadline = Date.parse('2099-01-01T00:00:00.000Z');
      const completed = await pollUntil(async () => {
        await bureau.runDurableMaintenance(deadline);
        return bureau.getRun(run.id)?.status === 'completed';
      });
      expect(completed).toBe(true);
      expect(generate.callCount).toBe(2);
    } finally {
      bureau.dispose();
    }
  });

  it('config 4 — includes scheduleWakeup, genuinely parks over persistent (SQLite) durable storage, and the parked wakeup recovers and fires across a process restart via an explicit tick', async () => {
    const databasePath = join(
      tmpdir(),
      `ab-201-persistent-wakeup-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      // === Bureau A: schedules the wakeup and parks. "Crashes" while parked
      // — no tick is ever issued in this process, so the timer cannot have
      // fired here. ===
      const generateA = createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-1', name: 'scheduleWakeup', arguments: { in: '6h' } }],
        },
      ]);

      const bureauA = await createBureau({
        agents: {},
        generate: generateA,
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        wakeup: true,
        durableBackgroundTasks: 'manual',
        stopWhen: stopWhen.toolCalled('scheduleWakeup'),
      });

      const run = await bureauA.createRun({ message: 'park over persistent sqlite storage' });
      await pollUntil(() => generateA.callCount >= 1);

      // Genuine park proof, same as config 3: no tick is issued in this
      // process, so completion must never be observed here.
      const firedInBureauA = await pollUntil(
        () => bureauA.getRun(run.id)?.status === 'completed',
        5,
      );
      expect(firedInBureauA).toBe(false);
      // AB-207: deliberately NOT disposed here — `dispose()`/`shutdown()`'s
      // `'abort'` policy aborts every active run it still tracks, including
      // one durably parked on a `scheduleWakeup` wait, which calls
      // `engine.cancel()` and permanently marks the durable workflow record
      // `cancelled`. That is real cancellation, not a crash: a genuine
      // process crash never runs any graceful-shutdown code at all, so the
      // durable checkpoint is left exactly as last written and stays
      // recoverable. Simulating the crash by simply moving on to bureauB
      // without disposing bureauA (the same pattern every other
      // process-restart test in this file already uses — see the
      // `bureauA.dispose()` calls placed at the END of those tests, AFTER
      // bureauB's recovery assertions) is what actually proves recovery
      // survives a crash; disposing first proves only that `dispose()`
      // cancels active runs, a different (and already covered) property.

      // === FRESH PROCESS: bureau B is a wholly separate bureau over the same
      // SQLite file. Recovery re-arms the durable `ctx.sleep` timer with no
      // hand-injected state (AB-41: "Recovery: ctx.sleep is checkpointed;
      // recovery re-arms it") — the resumed continuation step's deps are
      // rebuilt from config, same as every other durable recovery test. ===
      const generateB = createSequentialGenerate([
        // AB-45 — the recovered run's continuation step after the wakeup fires.
        { content: 'resumed after restart and explicit tick', toolCalls: [] },
      ]);

      const bureauB = await createBureau({
        agents: {},
        generate: generateB,
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        wakeup: true,
        durableBackgroundTasks: 'manual',
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        // The recovered run is visible immediately on boot.
        expect(bureauB.getRun(run.id)).toBeDefined();
        expect(bureauB.getRun(run.id)?.status).not.toBe('completed');

        // Drive the rebooted engine's scheduler directly past the deadline —
        // no real wall-clock wait for the fire.
        const deadline = Date.parse('2099-01-01T00:00:00.000Z');
        const completed = await pollUntil(async () => {
          await bureauB.runDurableMaintenance(deadline);
          return bureauB.getRun(run.id)?.status === 'completed';
        });
        expect(completed).toBe(true);
        expect(generateB.callCount).toBe(1);

        const session = await bureauB.getSession(run.sessionId);
        expect(session?.metadata['lastRunStatus']).toBe('completed');
      } finally {
        bureauB.dispose();
      }
      // AB-207: release bureauA's engine now that bureauB's
      // recovery-dependent assertions are done — the same ordering every
      // other process-restart test in this file uses (see the comment
      // above where bureauA was deliberately left undisposed).
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });
});

describe('Bureau.modelCatalog (AB-246)', () => {
  it('is present regardless of D, and defaults to a service seeded from the operative static catalog', async () => {
    const bureau = await createBureau({ agents: {} });
    try {
      const before = bureau.modelCatalog.catalog();
      expect(before.descriptors.length).toBeGreaterThan(0);
      expect(before.stale).toBe(false);

      const handle = bureau.modelCatalog.refresh({
        id: 'default-refresh',
        requestedAt: '2030-01-01T00:00:00.000Z',
      });
      const result = await handle.result();

      expect(result.outcome).toBe('completed');
      expect(result.newRevision).toBe(before.revision + 1);
      expect(bureau.modelCatalog.catalog().revision).toBe(before.revision + 1);
    } finally {
      bureau.dispose();
    }
  });

  it('accepts a caller-supplied ModelCatalogService via BureauOptions.modelCatalog', async () => {
    const seed = createModelCatalog({ now: () => '2026-09-02T00:00:00.000Z' });
    const modelCatalog = createModelCatalogService({
      seed,
      descriptorSource: () => Promise.resolve([]),
      now: () => '2026-09-02T00:00:01.000Z',
      newRefreshId: () => 'injected-refresh',
    });
    const bureau = await createBureau({ agents: {}, modelCatalog });
    try {
      expect(bureau.modelCatalog).toBe(modelCatalog);
      // The service clones and deep-freezes its seed at construction (a
      // defensive copy, since a caller-supplied ModelCatalog is not
      // guaranteed to already be frozen), so check by value rather than
      // object identity.
      expect(bureau.modelCatalog.catalog().revision).toBe(seed.revision);
      expect(bureau.modelCatalog.catalog().descriptors.length).toBe(seed.descriptors.length);
    } finally {
      bureau.dispose();
    }
  });

  it('dispose() awaits an in-flight refresh before its returned promise resolves — it does not abort it', async () => {
    let resolveSource!: (descriptors: readonly []) => void;
    const source = new Promise<readonly []>((resolve) => {
      resolveSource = resolve;
    });
    const seed = createModelCatalog({ now: () => '2026-09-02T00:00:00.000Z' });
    const modelCatalog = createModelCatalogService({
      seed,
      descriptorSource: () => source,
      now: () => '2026-09-02T00:00:01.000Z',
      newRefreshId: () => 'in-flight-refresh',
    });
    const bureau = await createBureau({ agents: {}, modelCatalog });

    const handle = bureau.modelCatalog.refresh({
      id: 'req-1',
      requestedAt: '2026-09-02T00:00:00.000Z',
    });

    let disposeSettled = false;
    const disposePromise = bureau.dispose().then(() => {
      disposeSettled = true;
    });

    // Give dispose() every chance to resolve prematurely before the source
    // ever settles — it must not.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(disposeSettled).toBe(false);
    // abort() was never called: the refresh is still genuinely running.
    expect(handle.snapshot().status).toBe('pending');

    resolveSource([]);
    await disposePromise;

    expect(disposeSettled).toBe(true);
    const result = await handle.result();
    expect(result.outcome).toBe('completed');
  });

  it('a second dispose() call after an in-flight refresh already settled resolves immediately', async () => {
    const seed = createModelCatalog({ now: () => '2026-09-02T00:00:00.000Z' });
    const modelCatalog = createModelCatalogService({
      seed,
      descriptorSource: () => Promise.resolve([]),
      now: () => '2026-09-02T00:00:01.000Z',
      newRefreshId: () => 'settled-refresh',
    });
    const bureau = await createBureau({ agents: {}, modelCatalog });

    const handle = bureau.modelCatalog.refresh({
      id: 'req-1',
      requestedAt: '2026-09-02T00:00:00.000Z',
    });
    await handle.result();

    await bureau.dispose();
    await bureau.dispose();
    expect(bureau.modelCatalog.inFlightRefresh()).toBeUndefined();
  });

  it("dispose() awaits closed(), not just result() — a caller-supplied service's slower cleanup acknowledgement still blocks completion", async () => {
    const seedCatalog = createModelCatalog({ now: () => '2026-09-02T00:00:00.000Z' });
    let resolveClosed!: (value: 'completed') => void;
    const closedPromise = new Promise<'completed'>((resolve) => {
      resolveClosed = resolve;
    });

    const fakeHandle: CatalogRefreshHandle = {
      refreshId: 'fake-refresh',
      snapshot: () => {
        throw new Error('not exercised by this test');
      },
      subscribeSnapshot: () => () => {},
      abort: () => {},
      // result() resolves IMMEDIATELY (a pre-resolved promise) — only
      // closed() is deliberately slow, so a `dispose()` that captured
      // result() instead would resolve too early.
      result: () =>
        Promise.resolve({
          id: 'fake-refresh',
          outcome: 'completed' as const,
          previousRevision: seedCatalog.revision,
          newRevision: seedCatalog.revision + 1,
          completedAt: '2026-09-02T00:00:01.000Z',
        }),
      closed: () => closedPromise,
    };

    const fakeModelCatalog: ModelCatalogService = {
      catalog: () => seedCatalog,
      refresh: (_request: CatalogRefreshRequest) => fakeHandle,
      replaceCatalog: () => seedCatalog,
      inFlightRefresh: () => fakeHandle,
    };

    const bureau = await createBureau({ agents: {}, modelCatalog: fakeModelCatalog });

    let disposeSettled = false;
    const disposePromise = bureau.dispose().then(() => {
      disposeSettled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(disposeSettled).toBe(false);

    resolveClosed('completed');
    await disposePromise;
    expect(disposeSettled).toBe(true);
  });
});

describe('Bureau.shutdown() (AB-207)', () => {
  it('reports an empty owners array for a bureau composing no owners', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });
    const report = await bureau.shutdown();
    expect(report).toMatchObject({
      admissionClosed: true,
      policy: 'abort',
      requested: 0,
      completed: 0,
      failed: 0,
      unresolved: 0,
      notRequired: 0,
      owners: [],
    });
  });

  it('reports audit-trail and durable-engine owners for a persistent bureau, and no webhook-notifier when none is configured', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const report = await bureau.shutdown();
    const kinds = report.owners.map((owner) => owner.kind).sort();
    expect(kinds).toEqual(['audit-trail', 'durable-engine']);
    for (const owner of report.owners) {
      expect(owner.outcome).toBe('completed');
    }
    expect(report.requested).toBe(2);
    expect(report.completed).toBe(2);
  });

  it('does NOT compose an event-history owner over durableExecution-forced memory storage — "persistent" means the backend, not just runtime.durable', async () => {
    // Same construction as the previous test (memory storage, durable
    // execution forced on) — proves `eventHistory`'s persistence gate
    // checks the storage backend's own `capabilities().persistence`, not
    // merely whether `runtime.durable` exists (AB-310).
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });

    const outcome = await bureau.eventHistory({ kind: 'run', id: 'run-1' });
    expect(outcome).toEqual({ outcome: 'unsupported-capability', reason: 'no-persistent-storage' });

    const report = await bureau.shutdown();
    expect(report.owners.map((owner) => owner.kind).sort()).toEqual([
      'audit-trail',
      'durable-engine',
    ]);
  });

  it('returns unsupported-capability from eventHistory for a fully ephemeral bureau (no storage at all)', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const outcome = await bureau.eventHistory({ kind: 'session', id: 'session-1' });
    expect(outcome).toEqual({ outcome: 'unsupported-capability', reason: 'no-persistent-storage' });

    await bureau.dispose();
  });

  it('composes and disposes a real event-history store, reporting an event-history owner, for a genuinely persistent SQLite bureau', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    const runtime = createManualRuntimeServices();

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
      });

      // Composed and functioning (not unsupported-capability) — an
      // ordinary empty page for an id nothing was ever recorded under:
      // `createDurableEventProducer` (AB-311) sinks the run/session/
      // schedule-fire families AB-87's matrix classifies as durable, but
      // only ever for owners something actually happened to — `'run-1'`
      // here was never a registered run.
      const outcome = await bureau.eventHistory({ kind: 'run', id: 'run-1' });
      expect(outcome).toEqual({ events: [], hasMore: false });

      const before = await runtime.deferred.drain();
      expect(before.outstanding).toEqual([]);

      const report = await bureau.shutdown();
      expect(report.owners.map((owner) => owner.kind).sort()).toEqual([
        'audit-trail',
        'durable-engine',
        'event-history',
      ]);
      const eventHistoryOwner = report.owners.find((owner) => owner.kind === 'event-history');
      expect(eventHistoryOwner?.outcome).toBe('completed');

      // AB-91's acceptance criterion 9 (ResourceScope/QuiescenceReport,
      // AB-256): `createDurableEventHistory` itself still creates no timer
      // and no listener of its own — `FleetEventFeed.subscribe()` (the
      // only place Weft's own feed schedules a live-poll timer or
      // registers a listener) is never called in THIS test, since nothing
      // here calls `bureau.subscribeEventHistory()` (see
      // `durable-event-history.test.ts`'s own `subscribeEventHistory()`
      // suite for that surface's disposal semantics). This test's own
      // bureau DOES compose `createDurableEventProducer` (AB-311) — a
      // `bureau`-level `'action'`/`'schedule.completed'`/`'schedule.failed'`
      // listener set, disposed before `eventHistoryInstance.dispose()`
      // above — so `RuntimeServices.deferred`'s zero-outstanding check
      // below is proof that subsystem drains cleanly too, not just that
      // this store itself never held anything. The restart tests in
      // `durable-event-history.test.ts` are the concrete proof that
      // `dispose()` genuinely releases the backend: reopening the SAME
      // SQLite/LMDB file immediately after `dispose()` succeeds, which
      // would deadlock (LMDB) or contend (SQLite) if a listener/timer/
      // handle were left live.
      const after = await runtime.deferred.drain();
      expect(after.outstanding).toEqual([]);
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('reports a webhook-notifier owner, awaited to completion, for a bureau configured with a webhook target', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      webhooks: {
        targets: [{ url: 'https://example.test/webhook' }],
        fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      },
    });
    expect(bureau.webhookNotifier).toBeDefined();

    const report = await bureau.shutdown();
    const webhookOwner = report.owners.find((owner) => owner.kind === 'webhook-notifier');
    expect(webhookOwner?.outcome).toBe('completed');
  });

  it("dispose() awaits shutdown({ policy: 'abort' }) to completion — the durable engine's teardown (the same finally block that closes raw storage) does not run before online-evals has settled its in-flight work", async () => {
    // A controllable ("gated") judge: `evaluate()` does not resolve until the
    // test calls `releaseJudge()`, so this deterministically proves ordering
    // instead of racing real timing.
    let releaseJudge!: () => void;
    const judgeGate = new Promise<void>((resolve) => {
      releaseJudge = resolve;
    });
    let evaluateCalls = 0;
    const generate = createMockGenerate('Done.');

    // Spy on the SHARED engine class prototype (the established pattern in
    // this file's durable-recovery describe blocks) so it observes whichever
    // instance `createBureau` builds internally. `[Symbol.asyncDispose]` and
    // `runtime.disposeStorage()` run in the SAME unconditional `finally`
    // block, strictly AFTER `Promise.allSettled(ownerDrains)` — so this spy
    // stands in for "the critical backend teardown has not run yet" without
    // needing to intercept `resolveStorage()`'s own internal instance
    // directly (which a `'memory'` backend does not expose reliably).
    const probe = await createRuntimeComposition({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      [Symbol.asyncDispose]: () => Promise<void>;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();

    let engineDisposed = false;
    const originalAsyncDispose = enginePrototype[Symbol.asyncDispose];
    const asyncDisposeSpy = spyOn(enginePrototype, Symbol.asyncDispose).mockImplementation(
      async function (this: unknown) {
        engineDisposed = true;
        return originalAsyncDispose.call(this as never);
      },
    );

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      onlineEvals: {
        judges: [
          {
            name: 'gated-judge',
            async evaluate() {
              evaluateCalls += 1;
              await judgeGate;
              return { pass: true, score: 1, message: 'ok' };
            },
          },
        ],
        sampleRate: 1,
        rng: () => 0,
      },
    });

    try {
      const run = await bureau.createRun({ message: 'Trigger a sampled evaluation' });
      await waitForRunCompletion(bureau, run.id);
      await waitForCondition(() => evaluateCalls > 0, 'online-eval judge was never invoked');

      let shutdownSettled = false;
      const shutdownPromise = bureau.shutdown().then((report) => {
        shutdownSettled = true;
        return report;
      });

      // The judge is still gated — the engine's teardown must not have run,
      // and shutdown() must not have resolved.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(engineDisposed).toBe(false);
      expect(shutdownSettled).toBe(false);

      releaseJudge();
      const report = await shutdownPromise;

      expect(shutdownSettled).toBe(true);
      expect(engineDisposed).toBe(true);
      const onlineEvalsOwner = report.owners.find((owner) => owner.kind === 'online-evals');
      expect(onlineEvalsOwner?.outcome).toBe('completed');
    } finally {
      asyncDisposeSpy.mockRestore();
    }
  });

  it("policy: 'drain' lets a caller-owned run reach its own natural terminal result while Bureau-owned background work (scheduler) is stopped exactly as under 'abort'", async () => {
    let releaseGenerate!: () => void;
    const generateGate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    const bureau = await createBureau({
      agents: {},
      generate: async () => {
        await generateGate;
        return { content: 'Drained to completion', toolCalls: [] };
      },
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Still running during drain' });
    await waitForCondition(
      () => bureau.getRun(run.id)?.status === 'running',
      'run never reached running before shutdown() was called',
    );

    let shutdownSettled = false;
    const shutdownPromise = bureau.shutdown({ policy: 'drain' }).then((report) => {
      shutdownSettled = true;
      return report;
    });

    // The run is still gated (not aborted — 'drain' does not touch
    // caller-owned runs) and shutdown() has not resolved yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(bureau.getRun(run.id)?.status).toBe('running');
    expect(shutdownSettled).toBe(false);

    releaseGenerate();
    const report = await shutdownPromise;

    expect(shutdownSettled).toBe(true);
    expect(report.policy).toBe('drain');
    await waitForCondition(
      () => bureau.getRun(run.id)?.status === 'completed',
      'drained run never reached its own natural terminal result',
    );
  });

  it('shutdown({ timeoutMilliseconds }) resolves within a bounded margin of N, reporting a still-unresolved owner "unresolved" and every other owner its real outcome — the underlying drain keeps running rather than being abandoned', async () => {
    // The gated owner here is the durable engine's `[Symbol.asyncDispose]`,
    // not an online-eval judge: `backgroundShutdownController.abort()` fires
    // before the owner drains even start (see `shutdown()`), and AB-206's
    // `raceAgainstAbort` makes a gated judge settle PROMPTLY once that
    // signal aborts regardless of whether the judge itself ever resolves —
    // so a judge gate cannot stay "still in flight" long enough to prove the
    // timeout-elapsed case. The engine's teardown has no such abort-race
    // shortcut, so gating it directly is what actually stays unresolved
    // across the elapsed timeout.
    let releaseEngineDispose!: () => void;
    const engineDisposeGate = new Promise<void>((resolve) => {
      releaseEngineDispose = resolve;
    });

    let capturedSignal: AbortSignal | undefined;
    let releaseSleep!: () => void;
    const sleep = (_milliseconds: number, signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<void>((resolve) => {
        releaseSleep = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    // See the ordering test above for why the durable engine's shared
    // prototype is spied on instead of `resolveStorage()`'s own internal
    // `'memory'` instance.
    const probe = await createRuntimeComposition({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      [Symbol.asyncDispose]: () => Promise<void>;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();

    let engineDisposeCalls = 0;
    let engineDisposed = false;
    const originalAsyncDispose = enginePrototype[Symbol.asyncDispose];
    const asyncDisposeSpy = spyOn(enginePrototype, Symbol.asyncDispose).mockImplementation(
      async function (this: unknown) {
        engineDisposeCalls += 1;
        await engineDisposeGate;
        engineDisposed = true;
        return originalAsyncDispose.call(this as never);
      },
    );

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      shutdownTimeoutSleep: sleep,
    });

    try {
      const shutdownPromise = bureau.shutdown({ timeoutMilliseconds: 50 });
      await waitForCondition(() => capturedSignal !== undefined, 'injected sleep was never called');
      await waitForCondition(
        () => engineDisposeCalls > 0,
        'the durable engine dispose was never invoked',
      );

      // Let every OTHER owner's already-fast drain (audit-trail has nothing
      // gating it) actually settle and record its outcome before the timer
      // elapses — otherwise the timeout branch could win the race before
      // those genuinely-quick drains have had a chance to run at all,
      // which would prove nothing about the timeout-elapsed case
      // specifically.
      for (let tick = 0; tick < 20; tick += 1) {
        await Promise.resolve();
      }

      // Elapse the injected timer WITHOUT releasing the gated engine
      // dispose — this is the deterministic stand-in for the real 50ms
      // passing.
      releaseSleep();
      const report = await shutdownPromise;

      expect(report.owners.find((owner) => owner.kind === 'durable-engine')?.outcome).toBe(
        'unresolved',
      );
      expect(report.owners.find((owner) => owner.kind === 'audit-trail')?.outcome).toBe(
        'completed',
      );
      expect(report.unresolved).toBe(1);
      // Never rejects, and the underlying drain is NOT abandoned — only the
      // wait for it was. Releasing the still-gated engine dispose lets the
      // real chain finish.
      expect(engineDisposed).toBe(false);
      releaseEngineDispose();
      await waitForCondition(() => engineDisposed, 'the real teardown chain never completed');
    } finally {
      asyncDisposeSpy.mockRestore();
    }
  });

  it('aborts the injected shutdownTimeoutSleep signal once the real teardown wins the race, so the timer does not outlive a fast shutdown()', async () => {
    let capturedSignal: AbortSignal | undefined;
    const sleep = (_milliseconds: number, signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<void>(() => {
        // Never resolves on its own — only `signal` aborting settles this
        // call's role in the race, proving the real chain wins and the
        // timer is told to stop.
      });
    };

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      shutdownTimeoutSleep: sleep,
    });

    await bureau.shutdown({ timeoutMilliseconds: 10_000 });
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('shutdown() (and dispose()) called a second time returns the SAME promise, regardless of the policy the second call requests', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const first = bureau.shutdown({ policy: 'abort' });
    const second = bureau.shutdown({ policy: 'drain' });
    expect(second).toBe(first);
    await first;
  });

  it('never rejects even when the injected shutdownTimeoutSleep rejects, resolving with a best-effort report instead (review finding, PR #442)', async () => {
    const sleep = (_milliseconds: number, _signal: AbortSignal) =>
      Promise.reject(new Error('injected shutdownTimeoutSleep failure'));

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      shutdownTimeoutSleep: sleep,
    });

    // `Promise.race([chain, shutdownTimeoutSleep(...).then(buildReport)])`
    // would otherwise propagate this rejection straight through `shutdown()`
    // — the fallback `.catch` fence must resolve with a best-effort report
    // instead of rejecting.
    const report = await bureau.shutdown({ timeoutMilliseconds: 10_000 });
    expect(report.admissionClosed).toBe(true);
  });

  it('uses the real default shutdownTimeoutSleep (a real setTimeout, cleared on abort) when no shutdownTimeoutSleep option is supplied', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    // No `shutdownTimeoutSleep` option — this exercises
    // `createDefaultShutdownTimeoutSleep()`'s real timer, generously bounded
    // so the real (fast) teardown always wins the race and the abort
    // listener fires, clearing the timer before it would otherwise elapse.
    const report = await bureau.shutdown({ timeoutMilliseconds: 60_000 });
    expect(report.admissionClosed).toBe(true);
  });

  it('prefers [Symbol.asyncDispose] over [Symbol.dispose] on the composed durable engine', async () => {
    // Spy on the SHARED engine class prototype (the established pattern in
    // this file — see the durable-recovery describe blocks above) so the
    // spy observes whichever instance `createBureau` builds internally.
    const probe = await createRuntimeComposition({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });
    const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
      [Symbol.asyncDispose]: () => Promise<void>;
      [Symbol.dispose]: () => void;
    };
    probe.durable!.engine[Symbol.dispose]?.();
    probe.disposeStorage?.();

    const asyncDisposeSpy = spyOn(enginePrototype, Symbol.asyncDispose).mockImplementation(
      async function (this: unknown) {
        return undefined;
      },
    );
    const syncDisposeSpy = spyOn(enginePrototype, Symbol.dispose).mockImplementation(function (
      this: unknown,
    ) {
      return undefined;
    });

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
      });
      await bureau.dispose();

      expect(asyncDisposeSpy).toHaveBeenCalledTimes(1);
      expect(syncDisposeSpy).not.toHaveBeenCalled();
    } finally {
      asyncDisposeSpy.mockRestore();
      syncDisposeSpy.mockRestore();
    }
  });
});

describe('createBureau durable event history producer + subscribeEventHistory (AB-311)', () => {
  it("sinks a completed run's terminal transition into the durable event history from the same emitter path the audit trail observes, in the same order", async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-durable-producer-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
      });

      const run = await bureau.createRun({ message: 'Complete once' });
      await waitForRunCompletion(bureau, run.id);
      await runtime.deferred.drain();

      const outcome = await bureau.eventHistory({ kind: 'run', id: run.id });
      if ('outcome' in outcome) throw new Error(`expected a page, got ${outcome.outcome}`);
      expect(outcome.events.map((event) => event.kind)).toEqual(['run.completed']);
      expect(outcome.events[0]?.owner).toEqual({ kind: 'run', id: run.id });

      // Same run, same terminal transition, through the audit trail's own
      // KV-based log (`createAuditTrail`'s `AUDIT_EVENT_TYPES` — the SAME
      // `'action'` emitter path this producer subscribes through) — proves
      // both are driven by the identical underlying transition, not two
      // independently-derived records that happen to agree.
      const auditRecords = await bureau.auditTrail!.query({ runId: run.id, type: 'run.completed' });
      expect(auditRecords).toHaveLength(1);
      expect(auditRecords[0]?.runId).toBe(run.id);

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('records a session-scoped action under its own owner, filtered from an unrelated session and an unrelated run', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-durable-producer-session-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
      });

      // `Store.recordAction` (operative's own supported synthetic-action
      // seam — see its doc comment) stamps a `session.*`-typed action onto
      // a REGISTERED run's action log, exactly the shape a real
      // `session.created`/`saved`/`loaded`/`deleted`/`fork`/`recover`
      // dispatch would produce once one of those event classes gains a
      // dispatch site (none does today — see `createDurableEventProducer`'s
      // own doc comment) — the supported way to exercise this producer's
      // `session.*` branch without waiting on that.
      const run = await bureau.createRun({ message: 'Carry a session action' });
      bureau.store.recordAction(run.id, 'session.created', { sessionId: 'sess-A', agentName: 'x' });
      bureau.store.recordAction(run.id, 'session.saved', { sessionId: 'sess-B', agentName: 'x' });
      await runtime.deferred.drain();

      const pageA = await bureau.eventHistory({ kind: 'session', id: 'sess-A' });
      if ('outcome' in pageA) throw new Error(`expected a page, got ${pageA.outcome}`);
      expect(pageA.events.map((event) => event.kind)).toEqual(['session.created']);
      expect(pageA.events[0]?.owner).toEqual({ kind: 'session', id: 'sess-A' });

      const pageB = await bureau.eventHistory({ kind: 'session', id: 'sess-B' });
      if ('outcome' in pageB) throw new Error(`expected a page, got ${pageB.outcome}`);
      expect(pageB.events.map((event) => event.kind)).toEqual(['session.saved']);

      await waitForRunCompletion(bureau, run.id);
      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('drops a session.* action with no string sessionId on its detail, rather than recording under a fabricated owner', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-durable-producer-no-session-id-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();
    const diagnostics: BureauDiagnostic[] = [];

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      const run = await bureau.createRun({ message: 'Carry a malformed session action' });
      bureau.store.recordAction(run.id, 'session.created', { agentName: 'x' }); // no sessionId
      await runtime.deferred.drain();

      const runPage = await bureau.eventHistory({ kind: 'run', id: run.id });
      if ('outcome' in runPage) throw new Error(`expected a page, got ${runPage.outcome}`);
      // The malformed action lands nowhere durable — only the run's own
      // eventual `run.completed` (once it settles below).
      expect(runPage.events.map((event) => event.kind)).not.toContain('session.created');
      expect(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.scope === 'durable-event-history' &&
            diagnostic.message.includes('no string sessionId'),
        ),
      ).toBe(true);

      await waitForRunCompletion(bureau, run.id);
      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('subscribeEventHistory replays a real recorded run.completed from bureau.createRun, then continues live', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-durable-subscribe-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
      });

      const run = await bureau.createRun({ message: 'Observed via subscribeEventHistory' });
      await waitForRunCompletion(bureau, run.id);
      await runtime.deferred.drain();

      const received: DurableEventEnvelope[] = [];
      const subscription = bureau.subscribeEventHistory({ kind: 'run', id: run.id }, (event) => {
        received.push(event);
      });

      await waitForCondition(
        () => received.length > 0,
        'subscribeEventHistory never replayed the recorded run.completed event',
      );
      expect(received.map((event) => event.kind)).toEqual(['run.completed']);
      expect(received[0]?.owner).toEqual({ kind: 'run', id: run.id });

      subscription.unsubscribe();
      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('never subscribes or records anything for an ephemeral bureau — eventHistory stays unsupported, subscribeEventHistory returns an already-closed subscription', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate('Done.'),
      toolbox: createEmptyToolbox(),
    });

    let delivered = false;
    const subscription = bureau.subscribeEventHistory({ kind: 'run', id: 'run-1' }, () => {
      delivered = true;
    });
    expect(subscription.closed).toBe(true);

    const run = await bureau.createRun({ message: 'No durable storage at all' });
    await waitForRunCompletion(bureau, run.id);

    expect(delivered).toBe(false);
    const outcome = await bureau.eventHistory({ kind: 'run', id: run.id });
    expect(outcome).toEqual({ outcome: 'unsupported-capability', reason: 'no-persistent-storage' });

    // The already-closed subscription's own `unsubscribe()` is still a
    // real, callable no-op (never throws, stays idempotent) — not just a
    // `closed: true` value nothing ever invokes.
    subscription.unsubscribe();
    subscription.unsubscribe();

    await bureau.dispose();
  });

  it('disposes the producer before the event-history store on shutdown, reporting one event-history owner', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-durable-producer-shutdown-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
      });

      const run = await bureau.createRun({ message: 'Shut down cleanly' });
      await waitForRunCompletion(bureau, run.id);

      const report = await bureau.shutdown();
      const eventHistoryOwner = report.owners.find((owner) => owner.kind === 'event-history');
      expect(eventHistoryOwner?.outcome).toBe('completed');
      // The producer's own writes (tracked under 'durable-event-record')
      // and the store's own subsystems are all drained — no leaked
      // in-flight work survives shutdown.
      const after = await runtime.deferred.drain();
      expect(after.outstanding).toEqual([]);
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });
});

describe('bureau.eventHistory authorization and deleted-aggregate (AB-313)', () => {
  it('returns not-found for a run owned by a different principal, indistinguishable from an unknown run', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-authz-run-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
      });

      const run = await bureau.createRun({ message: 'Attribute me to alice', principal: 'alice' });
      await waitForRunCompletion(bureau, run.id);
      await runtime.deferred.drain();

      const deniedOutcome = await bureau.eventHistory(
        { kind: 'run', id: run.id },
        { principal: 'mallory' },
      );
      expect(deniedOutcome).toEqual({ outcome: 'not-found' });

      // A genuinely never-existing run id also fails closed once a
      // principal is supplied (AB-313, copilot review PR #551: an absent
      // `runAttribution` entry cannot be told apart from a deleted or
      // recovered run's lost attribution, so it is never treated as
      // open) — indistinguishable from the denied-owner case above.
      const unknownOutcome = await bureau.eventHistory(
        { kind: 'run', id: 'no-such-run' },
        { principal: 'mallory' },
      );
      expect(unknownOutcome).toEqual({ outcome: 'not-found' });

      // Omitting `principal` entirely still reads the unknown run as an
      // ordinary empty page — the check is skipped, not failed, for a
      // trusted caller.
      const unknownTrusted = await bureau.eventHistory({ kind: 'run', id: 'no-such-run' });
      expect(unknownTrusted).toEqual({ events: [], hasMore: false });

      const allowedOutcome = await bureau.eventHistory(
        { kind: 'run', id: run.id },
        { principal: 'alice' },
      );
      if ('outcome' in allowedOutcome) throw new Error('expected a page');
      expect(allowedOutcome.events.map((event) => event.kind)).toEqual(['run.completed']);

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('fails closed (not-found) for a run with no recorded principal once a caller supplies one, but skips the check entirely when the caller omits one', async () => {
    // AB-313 (copilot review, PR #551): `runAttribution` is a best-effort,
    // in-memory-only map (AB-54) — an absent entry is indistinguishable
    // from "this run's ownership was lost" (deleted, or recovered across a
    // restart) versus "no principal was ever recorded." Treating an
    // absent entry as open would let ANY caller who merely supplies SOME
    // principal read a run's durable history once that entry is gone —
    // so a supplied principal against an unattributed run fails closed.
    // Omitting `principal` (an internal/trusted caller) still bypasses
    // the check entirely, same as every other owner kind.
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-authz-open-run-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
      });

      const run = await bureau.createRun({ message: 'No principal attribution' });
      await waitForRunCompletion(bureau, run.id);
      await runtime.deferred.drain();

      const withPrincipal = await bureau.eventHistory(
        { kind: 'run', id: run.id },
        { principal: 'anyone' },
      );
      expect(withPrincipal).toEqual({ outcome: 'not-found' });

      const withoutPrincipal = await bureau.eventHistory({ kind: 'run', id: run.id });
      if ('outcome' in withoutPrincipal) throw new Error('expected a page');
      expect(withoutPrincipal.events.map((event) => event.kind)).toEqual(['run.completed']);

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('fails closed (not-found) for a DELETED run once a caller supplies a principal — closes the bypass a missing runAttribution entry would otherwise open (copilot review, PR #551)', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-authz-deleted-run-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
      });

      const run = await bureau.createRun({
        message: 'Delete me then try to read',
        principal: 'alice',
      });
      await waitForRunCompletion(bureau, run.id);
      await runtime.deferred.drain();
      await bureau.deleteRun(run.id);
      await runtime.deferred.drain();

      // Even the ORIGINAL owning principal is denied once the run's
      // in-memory attribution is gone — this is the fail-closed trade-off
      // the fix makes deliberately: verification is impossible, so access
      // is denied rather than silently reopened for anyone (including the
      // real prior owner). The events remain reachable only for a caller
      // that omits `principal` entirely (an internal/trusted caller).
      const asOriginalOwner = await bureau.eventHistory(
        { kind: 'run', id: run.id },
        { principal: 'alice' },
      );
      expect(asOriginalOwner).toEqual({ outcome: 'not-found' });

      const asAnyoneElse = await bureau.eventHistory(
        { kind: 'run', id: run.id },
        { principal: 'mallory' },
      );
      expect(asAnyoneElse).toEqual({ outcome: 'not-found' });

      const trusted = await bureau.eventHistory({ kind: 'run', id: run.id });
      if (!('outcome' in trusted) || trusted.outcome !== 'deleted-aggregate') {
        throw new Error(`expected deleted-aggregate, got ${JSON.stringify(trusted)}`);
      }

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('returns not-found for a session an unauthorized principal queries, and admits the recorded authority', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-authz-session-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    try {
      const bureau = await createBureau({
        agents: {},
        generate: () => new Promise<never>(() => {}),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
      });

      const run = await bureau.createRun({ message: 'Wait for a signal', principal: 'alice' });
      await pollUntil(async () => {
        const session = await bureau.getSession(run.sessionId);
        return session?.metadata['lastRunStatus'] === 'running';
      });

      const deniedOutcome = await bureau.eventHistory(
        { kind: 'session', id: run.sessionId },
        { principal: 'mallory' },
      );
      expect(deniedOutcome).toEqual({ outcome: 'not-found' });

      const allowedOutcome = await bureau.eventHistory(
        { kind: 'session', id: run.sessionId },
        { principal: 'alice' },
      );
      expect('outcome' in allowedOutcome).toBe(false);

      await bureau.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('returns deleted-aggregate for a run whose Bureau record was removed, carrying the already-committed events', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-deleted-run-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
      });

      const run = await bureau.createRun({ message: 'Delete me after completion' });
      await waitForRunCompletion(bureau, run.id);
      await runtime.deferred.drain();
      await bureau.deleteRun(run.id);
      await runtime.deferred.drain();

      const outcome = await bureau.eventHistory({ kind: 'run', id: run.id });
      if (!('outcome' in outcome) || outcome.outcome !== 'deleted-aggregate') {
        throw new Error(`expected deleted-aggregate, got ${JSON.stringify(outcome)}`);
      }
      expect(outcome.owner).toEqual({ kind: 'run', id: run.id });
      expect(outcome.events.map((event) => event.kind)).toEqual(['run.completed', 'run.removed']);

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('returns deleted-aggregate for a session.deleted owner, carrying the already-committed events, distinguishable from an unrelated empty page', async () => {
    // `session.deleted` has no production dispatch site today (AB-87's own
    // declared gap: "session.deleted durable only via the generic action
    // stream, a gap" — no `emitter.dispatch(new SessionDeletedEvent(...))`
    // call exists anywhere in `deleteSession`). This synthesizes it the
    // same supported way the sibling "records a session-scoped action"
    // test above does (`Store.recordAction`), proving this issue's own
    // detection logic against the event shape a future dispatch site would
    // produce, without inventing a new production dispatch beyond this
    // issue's own delivery boundary.
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-deleted-session-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
      });

      const run = await bureau.createRun({ message: 'Carry a session-deleted action' });
      bureau.store.recordAction(run.id, 'session.deleted', { sessionId: 'sess-deleted' });
      await runtime.deferred.drain();
      await waitForRunCompletion(bureau, run.id);
      await runtime.deferred.drain();

      const deletedOutcome = await bureau.eventHistory({ kind: 'session', id: 'sess-deleted' });
      if (!('outcome' in deletedOutcome) || deletedOutcome.outcome !== 'deleted-aggregate') {
        throw new Error(`expected deleted-aggregate, got ${JSON.stringify(deletedOutcome)}`);
      }
      expect(deletedOutcome.owner).toEqual({ kind: 'session', id: 'sess-deleted' });
      expect(deletedOutcome.events.map((event) => event.kind)).toEqual(['session.deleted']);

      // A genuinely never-recorded id stays an ordinary empty page — the
      // detection is evidence-based (a `session.deleted` event inside the
      // page), never "the live record is merely absent."
      const freshOutcome = await bureau.eventHistory({ kind: 'session', id: 'never-existed' });
      expect(freshOutcome).toEqual({ events: [], hasMore: false });

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });
});

describe('deleteSession aborts every run it owns (AB-207)', () => {
  // The pending-approval flavor of "a run owned by the deleted session" is
  // already covered by the pre-existing "revokes pending approval on delete"
  // regression test above — that run reaches `action_required` and settles
  // as `'completed'` (parked for a human decision, not consuming a running
  // slot), so `persistedApprovalRunIds`'s existing revoke loop is untouched
  // by this fix. This test targets the actual gap: a session run that is
  // GENUINELY still `'running'` and has NO pending approval at all —
  // `persistedApprovalRunIds` would never see it, so the pre-fix
  // `deleteSession` called `abortRun` on nothing. Two such runs prove the
  // wider `getRunSessionIdentifier`-based set catches every one of them.
  it("calls abortRun for every session run still running, found via getRunSessionIdentifier, and its own promise does not resolve until each run's terminal event fires", async () => {
    let releaseFirstRun!: () => void;
    let releaseSecondRun!: () => void;
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    const secondRunGate = new Promise<void>((resolve) => {
      releaseSecondRun = resolve;
    });
    let generateCalls = 0;

    const bureau = await createBureau({
      agents: {},
      generate: async () => {
        generateCalls += 1;
        if (generateCalls === 1) {
          await firstRunGate;
          return { content: 'run 1 settled', toolCalls: [] };
        }
        await secondRunGate;
        return { content: 'run 2 settled', toolCalls: [] };
      },
      toolbox: createEmptyToolbox(),
      persistence: { store: { type: 'memory' } },
    });

    const firstRun = await bureau.createRun({ message: 'First session run' });
    await waitForCondition(
      () => bureau.getRun(firstRun.id)?.status === 'running',
      'first run never reached running before deleteSession() was called',
    );
    const secondRun = await bureau.createRun({
      message: 'Second session run',
      sessionId: firstRun.sessionId,
    });
    await waitForCondition(
      () => bureau.getRun(secondRun.id)?.status === 'running',
      'second run never reached running before deleteSession() was called',
    );

    // Neither run has any pending-approval bookkeeping at all — the
    // narrower `persistedApprovalRunIds` set is empty for this session.
    expect(bureau.getRun(firstRun.id)?.status).toBe('running');
    expect(bureau.getRun(secondRun.id)?.status).toBe('running');

    let deleteSessionSettled = false;
    const deletion = bureau.deleteSession(firstRun.sessionId).then(() => {
      deleteSessionSettled = true;
    });

    // Both generates are still gated — deleteSession() must not have
    // resolved yet, proving it awaited each run's terminal event rather
    // than merely requesting the abort.
    await Promise.resolve();
    await Promise.resolve();
    expect(deleteSessionSettled).toBe(false);

    releaseFirstRun();
    await Promise.resolve();
    await Promise.resolve();
    expect(deleteSessionSettled).toBe(false);

    releaseSecondRun();
    await deletion;
    expect(deleteSessionSettled).toBe(true);

    expect(bureau.getRun(firstRun.id)?.status).toBe('aborted');
    expect(bureau.getRun(secondRun.id)?.status).toBe('aborted');
    await bureau.dispose();
  });
});

describe('AB-260: BureauOptions.runtime composition', () => {
  it('produces a run envelope whose timestamps are derived from a manual clock pinned to a fixed origin', async () => {
    const origin = '2024-03-01T00:00:00.000Z';
    const runtime = createManualRuntimeServices({ origin });
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      runtime,
    });

    try {
      const envelopeTimestamps: number[] = [];
      const unsubscribe = bureau.subscribeLiveFrames((frame) => {
        if (frame.type === 'run-envelope') {
          envelopeTimestamps.push(frame.frame.timestamp);
        }
      });

      const summary = await bureau.createRun({ message: 'Hello, origin-derived clock' });
      await waitForRunCompletion(bureau, summary.id);
      unsubscribe();

      expect(envelopeTimestamps.length).toBeGreaterThan(0);
      // The manual clock never advances in this test, so every run-envelope
      // frame's timestamp is the SAME origin-derived value.
      for (const timestamp of envelopeTimestamps) {
        expect(timestamp).toBe(Date.parse(origin));
      }
    } finally {
      await bureau.dispose();
    }
  });

  it('gives two Bureaus with independent manual runtimes no shared clock, identifier sequence, or deferred ledger', async () => {
    const runtimeA = createManualRuntimeServices({ origin: '2024-01-01T00:00:00.000Z' });
    const runtimeB = createManualRuntimeServices({ origin: '2025-06-15T00:00:00.000Z' });

    const bureauA = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      runtime: runtimeA,
      scheduler: { enabled: true },
    });
    const bureauB = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      runtime: runtimeB,
      scheduler: { enabled: true },
    });

    try {
      // Distinct clocks.
      expect(runtimeA.clock.now()).not.toBe(runtimeB.clock.now());

      // Distinct identifier sequences: each Bureau mints its runId through
      // its own composed `RuntimeServices.identifiers` — two runs started
      // one on each Bureau both produce the SAME first-of-kind counter
      // value (`${identifierPrefix}-run-1`) rather than a shared,
      // monotonically-advancing sequence.
      const runA = await bureauA.createRun({ message: 'On bureau A' });
      const runB = await bureauB.createRun({ message: 'On bureau B' });
      // Each Bureau's `identifiers.next('run')` counter starts at 1
      // independently — a shared sequence would produce two counter values
      // under the SAME prefix instead of each restarting at 1 under its
      // own runtime's prefix.
      expect(runA.id).toBe(`${runtimeA.identifierPrefix}-run-1`);
      expect(runB.id).toBe(`${runtimeB.identifierPrefix}-run-1`);
      await waitForRunCompletion(bureauA, runA.id);
      await waitForRunCompletion(bureauB, runB.id);

      // Advancing one runtime's timers never fires the other's.
      let firedOnA = 0;
      let firedOnB = 0;
      runtimeA.timers.setTimeout(() => {
        firedOnA += 1;
      }, 1000);
      runtimeB.timers.setTimeout(() => {
        firedOnB += 1;
      }, 1000);
      await runtimeA.advance(1000);
      expect(firedOnA).toBe(1);
      expect(firedOnB).toBe(0);
      await runtimeB.advance(1000);
      expect(firedOnB).toBe(1);

      // Draining one runtime's deferred ledger reports only its own labels —
      // disposing Bureau A settles its own `scheduler-stop`/`audit-write`
      // tracking on `runtimeA`, never on `runtimeB`.
      await bureauA.dispose();
      const drainA = await runtimeA.deferred.drain();
      const drainB = await runtimeB.deferred.drain();
      expect(drainA.settled.length).toBeGreaterThan(0);
      expect(drainB.settled).toEqual([]);
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
    }
  });

  it('registers scheduler-stop, audit-write, webhook-delivery, and background-evaluation with the composed deferred ledger', async () => {
    const runtime = createManualRuntimeServices();
    let deliveredCount = 0;
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      runtime,
      persistence: { type: 'memory' },
      scheduler: { enabled: true },
      webhooks: {
        targets: [{ url: 'https://example.test/webhook' }],
        fetch: (async () => {
          deliveredCount += 1;
          return new Response(null, { status: 200 });
        }) as unknown as typeof fetch,
      },
      onlineEvals: {
        judges: [
          {
            name: 'always-breaches',
            async evaluate() {
              return { pass: false, score: 0, message: 'always fails' };
            },
          },
        ],
        sampleRate: 1,
        rng: () => 0,
      },
    });

    try {
      const summary = await bureau.createRun({ message: 'Trigger every deferred label' });
      await waitForRunCompletion(bureau, summary.id);
      await waitForCondition(
        () => deliveredCount > 0,
        'webhook delivery for the eval threshold breach was never attempted',
      );
      await bureau.webhookNotifier?.flush();
      await bureau.onlineEvalSampler?.flush();

      await bureau.dispose();

      const report = await runtime.deferred.drain();
      const labels = new Set(report.settled.map((entry) => entry.label));
      expect(labels.has('scheduler-stop')).toBe(true);
      expect(labels.has('audit-write')).toBe(true);
      expect(labels.has('webhook-delivery')).toBe(true);
      expect(labels.has('background-evaluation')).toBe(true);
      // No heartbeat subsystem exists on Bureau yet (see
      // `BureauShutdownOwnerReport.kind`'s own doc comment — `'heartbeat'`
      // is reserved for the day one is composed), so `'heartbeat-stop'` has
      // no call site to register and is deliberately absent here.
      expect(labels.has('heartbeat-stop')).toBe(false);
    } finally {
      await bureau.dispose();
    }
  });
});
