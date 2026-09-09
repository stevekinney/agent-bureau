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
import { createFleetEventFeed } from '@lostgradient/weft/server/handler';
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
  dedupeRecoveryPerRunFailures,
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
  resolvePersistedRunOwningPrincipal,
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

/**
 * AB-369: a `generate` that genuinely never resolves once invoked and never
 * checks its `AbortSignal` — unlike `() => new Promise(() => {})` used
 * elsewhere in this file (which never actually runs, because `abortRun` is
 * called before the run's queued microtask ever reaches step 0's `generate`
 * call, so the step's own `signal.aborted` guard short-circuits before
 * `generate` is invoked at all), this resolves `invoked` the instant
 * `generate` is actually called — a caller awaits `invoked` before calling
 * `abortRun`, guaranteeing `generate` is genuinely in flight and will never
 * settle, so `abortRun`'s cleanup continuation never runs either.
 */
function createTrulyHungGenerate(): { generate: GenerateFunction; invoked: Promise<void> } {
  let resolveInvoked: (() => void) | undefined;
  const invoked = new Promise<void>((resolve) => {
    resolveInvoked = resolve;
  });
  const generate: GenerateFunction = () => {
    resolveInvoked?.();
    return new Promise<never>(() => {});
  };
  return { generate, invoked };
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
        'session-recovery',
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
      sessionId: 'session-recovery',
    });

    expect(
      recoveredRequestContextFromMetadata(
        { lastRequestAuthorities: { 'other-run': {} } },
        'run-missing',
        'session-recovery',
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
        'session-recovery',
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
      sessionId: 'session-recovery',
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
        'session-recovery',
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
        'session-recovery',
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
        'session-recovery',
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

  it("createRun resolves only after weft's initial durable workflow record is committed (AB-361): a fresh process over the same SQLite store always sees it", async () => {
    // THE HONESTY PROOF: gate the SPECIFIC storage write `engine.start`
    // performs for THIS run (a `batch` call whose first operation is
    // `wf:<runId>` — confirmed by instrumenting a real run's storage calls;
    // bureau's own session save is a SEPARATE `conditionalBatch` against
    // `agent-session*` keys and is never touched by this gate) so the test
    // can prove `bureau.createRun()`'s OWN returned promise does not
    // resolve until that write commits — not merely that the write
    // eventually happens before some LATER unrelated await gives it enough
    // microtasks to sneak in first (the previous bug: `createRun` resolved
    // once the session's `lastRunStatus: 'running'` write landed, several
    // microtasks BEFORE `engine.start`'s own write — a race that a plain
    // "await createRun() then reopen and check" test cannot reliably catch,
    // since nothing here forces real I/O latency between the two writes).
    const databasePath = join(
      tmpdir(),
      `bureau-durably-started-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let bureauA: Awaited<ReturnType<typeof createBureau>> | undefined;
    let bureauB: Awaited<ReturnType<typeof createBureau>> | undefined;

    try {
      const realStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
      let gateArmed = true;
      // A Proxy, not an object-literal spread: `realStorage` is a real
      // class instance (`NodeSQLiteStorage`) whose methods live on its
      // prototype and read private fields via `this` — `{ ...realStorage }`
      // would silently drop every method, leaving only own enumerable
      // instance properties (there are none; the state is in `#private`
      // fields). The proxy forwards everything except `batch` unmodified,
      // bound to the real instance.
      const gatedStorage = new Proxy(realStorage, {
        get(target, property, receiver) {
          if (property === 'batch') {
            return async (operations: Parameters<typeof realStorage.batch>[0]) => {
              const isWorkflowStartWrite = operations.some(
                (operation) => operation.type === 'put' && operation.key.startsWith('wf:run-'),
              );
              if (isWorkflowStartWrite && gateArmed) {
                gateArmed = false; // only THIS run's initial write is gated
                await startGate;
              }
              return target.batch(operations);
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      bureauA = await createBureau({
        agents: {},
        // Never resolves — proves this run's very first step never even
        // begins before the assertions below run; the durable write this
        // test is about happens entirely BEFORE any step executes.
        generate: () => new Promise<never>(() => {}),
        toolbox: createEmptyToolbox(),
        storage: gatedStorage,
        durableExecution: true,
      });

      const runPromise = bureauA.createRun({ message: 'AB-361 durable write honesty' });
      let createRunSettled = false;
      void runPromise.then(
        () => {
          createRunSettled = true;
        },
        () => {
          createRunSettled = true;
        },
      );

      // Exhaust far more microtask turns than the pre-fix code needed to
      // resolve `createRun` (it only ever needed the session-save write,
      // already long committed by this point) — proves resolution is
      // genuinely gated on the STILL-PENDING workflow-record write, not
      // merely "hasn't happened yet by coincidence".
      for (let tick = 0; tick < 50; tick += 1) {
        await Promise.resolve();
      }
      expect(createRunSettled).toBe(false);

      releaseStart?.();
      const run = await runPromise;
      expect(createRunSettled).toBe(true);

      // Fresh process: a wholly separate bureau over the SAME SQLite file
      // (the in-process reopen pattern this issue's acceptance criterion
      // names), with no shared in-process state — bureau A's engine is a
      // different instance entirely.
      bureauB = await createBureau({
        agents: {},
        generate: () => new Promise<never>(() => {}),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      const state = await bureauB.getDurableRun(run.id);
      expect(state).not.toBeNull();
      expect(state).not.toBeUndefined();
      expect(state?.id).toBe(run.id);
    } finally {
      // In case an assertion above threw before `releaseStart` was called —
      // dispose() must not hang on a never-committed gate.
      releaseStart?.();
      await bureauB?.dispose();
      await bureauA?.dispose();
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('the in-memory branch resolves createRun without ever awaiting a durable write (AB-361 control)', async () => {
    // The SAME hung-generate shape as the durable proof above, but with NO
    // storage/durableExecution configured at all — `createRun` must still
    // resolve within a handful of microtasks, proving the in-memory
    // branch's timing is genuinely unaffected by AB-361: it has no
    // `durablyStarted` promise to await (see `ActiveRun.durablyStarted`'s
    // own doc comment), and `createRunFromRequest`'s new await is gated on
    // `runtime.durable`, which is absent here.
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
    });

    const runPromise = bureau.createRun({ message: 'in-memory, never durable' });
    let settled = false;
    void runPromise.then(() => {
      settled = true;
    });

    // A handful of ticks covers every await already on the pre-fix
    // in-memory path (session save, `store.register`). A real durable write
    // (opening storage, an engine round-trip) could never settle this fast
    // — so if this branch ever gained an awaited durable-write gate, it
    // would still be unsettled here.
    for (let tick = 0; tick < 10; tick += 1) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);

    const run = await runPromise;
    expect(run.id).toBeDefined();

    await bureau.dispose();
  });

  it('createRun rejects, unregisters the run, and persists an errored session when the durable workflow write itself fails (AB-361 review PRRT_kwDORvupsc6gWc39)', async () => {
    // Same gated-storage shape as the honesty proof above, but the
    // intercepted `batch` call REJECTS instead of blocking — modelling a
    // genuine persistence failure inside `context.engine.start`. Before the
    // review fix, this rejection propagated out of `driveDurableRun`
    // uncaught: `durablyStarted` rejected (correct), but `result` ALSO
    // rejected raw with no `RunCompletedEvent`/`run.completed` ever
    // dispatched — so `createRunFromRequest`'s catch block, which relies
    // entirely on that event to unregister the run and persist its
    // terminal session state, never got the chance to. This test proves
    // the run is genuinely cleaned up (a quick, quiescent dispose()) and
    // the session's `lastRunStatus` reflects the failure, not a permanent
    // `'running'`.
    const realStorage = await resolveStorage({ type: 'memory' });
    const startFailure = new Error('AB-361 review: durable write persistence failure');
    const gatedStorage = new Proxy(realStorage, {
      get(target, property, receiver) {
        if (property === 'batch') {
          return async (operations: Parameters<typeof realStorage.batch>[0]) => {
            const isWorkflowStartWrite = operations.some(
              (operation) => operation.type === 'put' && operation.key.startsWith('wf:'),
            );
            if (isWorkflowStartWrite) {
              throw startFailure;
            }
            return target.batch(operations);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: gatedStorage,
      durableExecution: true,
    });

    try {
      const sessionId = 'ab-361-review-start-rejects';
      const error = await bureau
        .createRun({ message: 'AB-361 review: engine.start rejects', sessionId })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('AB-361 review: durable write persistence failure');

      // The failed run's terminal `run.completed` listener (fired
      // synchronously inside `makeErrorResult`'s dispatch, before
      // `driveDurableRun`'s promise even settles) already unregistered the
      // run by the time `createRun`'s rejection reaches this line — but the
      // session WRITE `persistSessionUpdate` triggers from inside that same
      // listener is fire-and-forget (retried in the background, never
      // awaited by the listener itself — see `persistSessionUpdate`'s own
      // definition), so it can genuinely land a tick or two later.
      await waitForCondition(async () => {
        const session = await bureau.getSession(sessionId);
        return session?.metadata['lastRunStatus'] === 'error';
      }, 'errored session metadata was not persisted after the durable write failure');

      const session = await bureau.getSession(sessionId);
      expect(session?.metadata['lastRunStatus']).toBe('error');
      expect(session?.metadata['lastRunId']).toBeDefined();

      // A clean shutdown with nothing unresolved proves the run was
      // genuinely unregistered — a leaked `activeRuns`/`runToolboxes` entry
      // would show up as an unresolved/incomplete owner in this report
      // instead (see `BureauShutdownReport`).
      const report = await bureau.shutdown();
      expect(report.unresolved).toBe(0);
      expect(report.failed).toBe(0);
    } finally {
      await bureau.dispose().catch(() => {});
    }
  });

  it('keeps runAttribution for a run whose durable workflow write failed AFTER registration — its real owner is not locked out of its own event history (AB-361 review PRRT_kwDORvupsc6ga0TX)', async () => {
    // Same gated-storage failure shape as the sibling test above, but this
    // one supplies a `principal` on the request and asserts on the
    // AUTHORIZATION consequence, not just cleanup: before the review fix,
    // `createRunFromRequest`'s catch block applied the SAME
    // `runAttribution.delete(runId)` cleanup to this case as it does to a
    // run that never reached `store.register` at all — but this run DID
    // reach `store.register`, so it is already a terminal FAILED run
    // visible via `listRuns()`/`getRun()`. Wiping its attribution made
    // `resolveEventHistory()`'s fail-closed check indistinguishable from a
    // deleted or genuinely-unattributed run, so the run's REAL owner
    // (the exact principal that created it) got `not-found` for its own
    // failed run's event history — the fail-closed check meant to protect
    // against imposters, misapplied to lock out the legitimate owner.
    //
    // SQLite, not memory: `bureau.eventHistory()` only exists when
    // `persistentDurableStorage` is set, which gates on the storage
    // backend's own declared `capabilities().persistence !== 'ephemeral'`
    // — the in-memory backend the sibling test above uses is ephemeral, so
    // this test needs a genuinely persistent backend to exercise it.
    const databasePath = join(
      tmpdir(),
      `bureau-ab-361-review-attribution-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const realStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
    const startFailure = new Error('AB-361 review: durable write persistence failure');
    const gatedStorage = new Proxy(realStorage, {
      get(target, property, receiver) {
        if (property === 'batch') {
          return async (operations: Parameters<typeof realStorage.batch>[0]) => {
            const isWorkflowStartWrite = operations.some(
              (operation) => operation.type === 'put' && operation.key.startsWith('wf:'),
            );
            if (isWorkflowStartWrite) {
              throw startFailure;
            }
            return target.batch(operations);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createEmptyToolbox(),
      storage: gatedStorage,
      durableExecution: true,
    });

    try {
      const sessionId = 'ab-361-review-attribution-preserved';
      let runId: string | undefined;
      const error = await bureau
        .createRun({
          message: 'AB-361 review: engine.start rejects, principal must survive',
          sessionId,
          principal: 'the-real-owner',
        })
        .catch((caught: unknown) => {
          // `createRun` rejects before returning a `RunSummary`, so the
          // run's id is recovered from the errored session metadata below
          // instead of the (never-returned) resolved value.
          return caught;
        });
      expect(error).toBeInstanceOf(Error);

      await waitForCondition(async () => {
        const session = await bureau.getSession(sessionId);
        runId = session?.metadata['lastRunId'] as string | undefined;
        return session?.metadata['lastRunStatus'] === 'error' && runId !== undefined;
      }, 'errored session metadata was not persisted after the durable write failure');
      if (runId === undefined) throw new Error('expected lastRunId on the errored session');

      // The run's REAL owner, supplying the SAME principal the request
      // used, must NOT be locked out — this is the assertion that failed
      // before the review fix (it returned `{ outcome: 'not-found' }`).
      const ownedOutcome = await bureau.eventHistory(
        { kind: 'run', id: runId },
        { principal: 'the-real-owner' },
      );
      expect(ownedOutcome).not.toEqual({ outcome: 'not-found' });

      // An unrelated caller supplying a DIFFERENT principal is still
      // correctly denied — this fix restores attribution, it does not
      // disable the authorization check.
      const strangerOutcome = await bureau.eventHistory(
        { kind: 'run', id: runId },
        { principal: 'someone-else' },
      );
      expect(strangerOutcome).toEqual({ outcome: 'not-found' });

      const report = await bureau.shutdown();
      expect(report.unresolved).toBe(0);
      expect(report.failed).toBe(0);
    } finally {
      await bureau.dispose().catch(() => {});
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

  it('listAbortingRuns names a run whose abort was requested but whose cleanup never settles (AB-369)', async () => {
    const runtime = createManualRuntimeServices();
    const { generate, invoked } = createTrulyHungGenerate();
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
      runtime,
    });

    const run = await bureau.createRun({ message: 'Hello' });
    await invoked;

    expect(bureau.listAbortingRuns()).toEqual([]);

    const expectedSince = runtime.clock.now();
    const aborted = bureau.abortRun(run.id);
    expect(aborted.status).toBe('aborting');

    const abortingRuns = bureau.listAbortingRuns();
    expect(abortingRuns).toHaveLength(1);
    expect(abortingRuns[0]?.runId).toBe(run.id);
    expect(abortingRuns[0]?.since).toBe(expectedSince);

    // Cleanup genuinely never settles (`generate` never resolves and the run
    // never checks its abort signal): several microtask flushes later the
    // entry is still there, and the run's own store status never advances
    // past `'running'` either — this is a leak the pre-AB-369 baseline could
    // only prove via mutation testing, never observe from a public surface.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(bureau.listAbortingRuns().map((entry) => entry.runId)).toContain(run.id);
    expect(bureau.getRun(run.id)?.status).toBe('running');

    bureau.dispose();
  });

  it('a repeat abortRun call landing after status leaves running but before closed() settles does NOT clear abortingRunIds early (AB-369)', async () => {
    // `createBlockingGenerate` resolves on abort quickly, but the run's
    // store status (updated synchronously inside the `run.aborted` listener,
    // itself dispatched from deep inside the SAME `Promise.resolve().then()`
    // microtask that drives `executeLoop`) flips to a non-`'running'` value
    // several microtask ticks before `closed()` — chained through `result`'s
    // OWN `.then()`s — ever resolves. A repeat `abortRun` call that lands in
    // that window must NOT delete the `abortingRunIds` entry itself (review
    // finding, PR #583): doing so would let `listAbortingRuns()` — and
    // `BureauQuiescenceReport` — under-report a cleanup that has not
    // genuinely settled yet, exactly the invisible leak this issue exists to
    // close. Only the `closed()` continuation may clear the entry.
    const { generate } = createBlockingGenerate();
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    bureau.abortRun(run.id);

    let caughtWindow = false;
    for (let i = 0; i < 200; i++) {
      const status = bureau.getRun(run.id)?.status;
      const hasEntry = bureau.listAbortingRuns().some((entry) => entry.runId === run.id);
      if (status !== 'running' && hasEntry) {
        caughtWindow = true;
        break;
      }
      if (status !== 'running' && !hasEntry) break;
      await Promise.resolve();
    }
    expect(caughtWindow).toBe(true);
    expect(bureau.listAbortingRuns().map((entry) => entry.runId)).toContain(run.id);

    // The repeat call returns the run's current (already non-running)
    // summary, matching `abortRun`'s existing idempotency contract — but it
    // must leave the still-pending `abortingRunIds` entry alone.
    const repeat = bureau.abortRun(run.id);
    expect(repeat.status).not.toBe('aborting');
    expect(bureau.listAbortingRuns().map((entry) => entry.runId)).toContain(run.id);

    // It clears only once `closed()` genuinely settles.
    await pollUntil(() => !bureau.listAbortingRuns().some((entry) => entry.runId === run.id));
    expect(bureau.listAbortingRuns().map((entry) => entry.runId)).not.toContain(run.id);

    bureau.dispose();
  });

  it('abortRun clears abortingRunIds once the closed() continuation genuinely settles, with no repeat call (AB-369)', async () => {
    const { generate } = createBlockingGenerate();
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createEmptyToolbox(),
    });

    const run = await bureau.createRun({ message: 'Hello' });
    bureau.abortRun(run.id);
    expect(bureau.listAbortingRuns().map((entry) => entry.runId)).toContain(run.id);

    await pollUntil(() => !bureau.listAbortingRuns().some((entry) => entry.runId === run.id));
    expect(bureau.listAbortingRuns().map((entry) => entry.runId)).not.toContain(run.id);

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

  it('abortRun called twice synchronously while still running revokes a pending signed tool-approval review exactly once (AB-353)', async () => {
    // `abortRun`'s `abortingRunIds` admission set exists specifically to
    // guard against re-entering this block (and re-calling
    // `revokePendingApprovalsForRun`) on a same-run repeat call while still
    // `'running'` (see the doc comment above `abortingRunIds`'s
    // declaration). `ActiveRun.abort()` and `liveness.setStatus('aborting')`
    // are independently idempotent (AB-37: "repeat `abort()` no-ops"), so a
    // second call's redundant `abort()` is unobservable on its own — the
    // guard's actually load-bearing job is preventing a second, concurrent
    // `revokePendingApprovalsForRun` from reaching the SAME still-pending,
    // signed tool-approval review before the first call's own revoke has
    // recorded it as resolved, which would revoke the approval binding and
    // write its `review.tool-approval.canceled` audit record twice.
    let revokeCalls = 0;
    const toolbox = createEmptyToolbox();
    toolbox.revokeApproval = async () => {
      revokeCalls += 1;
      // Yield past both calls' synchronous prefixes before resolving, so a
      // removed guard's second, concurrent call genuinely races the first
      // rather than the test accidentally serializing them.
      await Promise.resolve();
    };

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox,
      storage: { type: 'memory' },
    });

    try {
      const { activeRun, emitter } = createParkedActiveRun();
      const runId = bureau.store.register(activeRun, 'run-abort-double-revoke');
      const approvalReviewId = `approval:${runId}:call-double-revoke`;

      emitter.dispatchEvent(
        new StepCompletedEvent({
          step: 0,
          conversation: new Conversation(),
          content: '',
          toolCalls: [],
          results: [
            {
              callId: 'call-double-revoke',
              outcome: 'action_required',
              content: 'needs approval',
              toolCallId: 'call-double-revoke',
              toolName: 'charge-card',
              result: undefined,
              action: { type: 'approval', message: 'Approve charge' },
              pendingApproval: {
                callId: 'call-double-revoke',
                toolName: 'charge-card',
                arguments: { cents: 500 },
                action: { type: 'approval', message: 'Approve charge' },
                approvalToken: 'signed-token',
                approvalBinding: {
                  version: 1,
                  principalId: 'principal-a',
                  tenantId: 'bureau',
                  ownerId: 'agent-a',
                  authorizationRevision: 'bureau:1',
                  capabilitiesRevision: '[]',
                  audience: 'operator',
                  agentId: 'agent-a',
                  runId,
                  toolboxRevision: 'rev-1',
                  toolDefinitionRevision: 'tool-rev-1',
                  policyRevision: 'policy-rev-1',
                  approvalRevision: 'approval-rev-1',
                  issuedAt: 0,
                  expiresAt: Number.MAX_SAFE_INTEGER,
                  nonce: 'nonce-double-revoke',
                  replayScope: `bureau:${runId}`,
                },
              },
            },
          ],
          final: true,
        }),
      );

      expect(bureau.listPendingReviews().map((review) => review.id)).toEqual([approvalReviewId]);

      // Synchronous back-to-back calls, matching the doc comment's own
      // "same-run repeat call while it is still `'running'`" scenario — no
      // `await` between them, so both reach `abortRun`'s guard before
      // either's detached `revokePendingApprovalsForRun` continuation has
      // resolved.
      bureau.abortRun(runId);
      bureau.abortRun(runId);

      await pollUntil(() => bureau.listPendingReviews().length === 0);

      expect(revokeCalls).toBe(1);

      const records = await bureau.auditTrail!.query({ runId });
      const canceledRecords = records.filter(
        (record) =>
          record.type === 'review.tool-approval.canceled' &&
          record.detail !== null &&
          typeof record.detail === 'object' &&
          (record.detail as { review?: { id?: string } }).review?.id === approvalReviewId,
      );
      expect(canceledRecords).toHaveLength(1);
    } finally {
      await bureau.dispose();
    }
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

describe('resolvePersistedRunOwningPrincipal (AB-359)', () => {
  it('returns undefined when the map is entirely absent — the exact shape an older, pre-AB-359 record decodes as', () => {
    expect(resolvePersistedRunOwningPrincipal({}, 'run-1')).toBeUndefined();
  });

  it('returns undefined when the map does not carry an entry for this runId', () => {
    expect(
      resolvePersistedRunOwningPrincipal(
        { lastRunOwningPrincipals: { 'run-other': 'alice' } },
        'run-1',
      ),
    ).toBeUndefined();
  });

  it('returns undefined when the map itself is malformed (not a plain object)', () => {
    expect(
      resolvePersistedRunOwningPrincipal({ lastRunOwningPrincipals: ['not-a-map'] }, 'run-1'),
    ).toBeUndefined();
    expect(
      resolvePersistedRunOwningPrincipal({ lastRunOwningPrincipals: 'not-a-map' }, 'run-1'),
    ).toBeUndefined();
  });

  it('returns undefined when the entry for this runId is present but not a string', () => {
    expect(
      resolvePersistedRunOwningPrincipal({ lastRunOwningPrincipals: { 'run-1': 42 } }, 'run-1'),
    ).toBeUndefined();
  });

  it('returns the persisted principal for a well-formed entry', () => {
    expect(
      resolvePersistedRunOwningPrincipal(
        { lastRunOwningPrincipals: { 'run-1': 'alice', 'run-2': 'bob' } },
        'run-1',
      ),
    ).toBe('alice');
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

  describe('waitForRecovery() resolves a typed BureauRecoveryReport (AB-349)', () => {
    it('resolves outcome: "clean" with an empty perRunFailures on a clean boot', async () => {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
      });
      try {
        // createBureau() resolving at all (rather than rejecting) is itself
        // part of what this proves — recovery failure is always diagnostic.
        const report = await bureau.waitForRecovery?.();
        expect(report).toEqual({ outcome: 'clean', perRunFailures: [] });
      } finally {
        await bureau.dispose();
      }
    });

    it('resolves outcome: "partial" with the corrupted run listed while its sibling recovers', async () => {
      const databasePath = join(
        tmpdir(),
        `bureau-recovery-partial-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
      );
      try {
        // A genuine crashed run (same cross-process proof as the recovery
        // test above), so this test proves the corrupted sibling does not
        // disturb the sibling that legitimately recovers.
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
        const run = await bureauA.createRun({ message: 'Recover me' });
        await pollUntil(() => bureauAReachedStep1);
        expect(bureauAReachedStep1).toBe(true);
        // bureauA is deliberately left un-disposed to simulate a crash — see
        // the recovery test above for the full rationale.

        const probe = await createRuntimeComposition({
          generate: createMockGenerate(),
          toolbox: createEmptyToolbox(),
          storage: { type: 'sqlite', path: databasePath },
          durableExecution: true,
        });
        const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
          recoverAll: (options: unknown) => Promise<unknown[]>;
        };
        const originalRecoverAll = enginePrototype.recoverAll;
        probe.durable!.engine[Symbol.dispose]?.();
        probe.disposeStorage?.();

        // Call through to the REAL recoverAll (so bureauA's genuine crashed
        // run still reattaches), then inject one corrupted handle alongside
        // it — an undefined-metadata handle classifies 'cancel'/'foreign-input'
        // regardless of any real recovered handle.
        const recoverAllSpy = spyOn(enginePrototype, 'recoverAll').mockImplementation(
          async function (this: unknown, options: unknown) {
            const handles = await originalRecoverAll.call(this, options);
            return [
              ...handles,
              { id: 'corrupted-sibling', getLaunchMetadata: async () => undefined },
            ];
          },
        );

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
          const report = await bureauB.waitForRecovery?.();
          expect(report?.outcome).toBe('partial');
          expect(report?.perRunFailures).toEqual([
            { runId: 'corrupted-sibling', reason: 'foreign-input' },
          ]);
          expect(report?.sweepFailure).toBeUndefined();
          expect(report?.batchFailure).toBeUndefined();

          // The genuinely crashed sibling still recovers to completion.
          await pollUntil(() => bSteps.includes(1));
          expect(bSteps).toEqual([1]);
          expect(bureauB.getRun(run.id)).toBeDefined();
        } finally {
          recoverAllSpy.mockRestore();
          await bureauB.dispose();
          await bureauA.dispose();
        }
      } finally {
        await rm(databasePath, { force: true });
        await rm(`${databasePath}-wal`, { force: true });
        await rm(`${databasePath}-shm`, { force: true });
      }
    });

    it('resolves outcome: "failed" with batchFailure.message when recoverAll() itself throws', async () => {
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

      try {
        // createBureau() itself resolving (never rejecting) even though the
        // whole recovery BATCH failed is exactly what this test proves.
        const bureau = await createBureau({
          agents: {},
          generate: createMockGenerate(),
          toolbox: createEmptyToolbox(),
          storage: { type: 'memory' },
          durableExecution: true,
        });
        try {
          const report = await bureau.waitForRecovery?.();
          expect(report?.outcome).toBe('failed');
          expect(report?.batchFailure?.message).toContain('boot recovery unavailable');
          expect(report?.perRunFailures).toEqual([]);
          expect(report?.sweepFailure).toBeUndefined();
        } finally {
          await bureau.dispose();
        }
      } finally {
        recoverAllSpy.mockRestore();
      }
    });

    it('does not drop a sweep failure that happened just before recoverAll() itself throws (code-review regression fixture)', async () => {
      const probe = await createRuntimeComposition({
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
      });
      const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
        list: (filter: unknown) => Promise<unknown>;
        recoverAll: () => Promise<unknown[]>;
      };
      probe.durable!.engine[Symbol.dispose]?.();
      probe.disposeStorage?.();
      const listSpy = spyOn(enginePrototype, 'list').mockRejectedValue(
        new Error('scheduler-residue sweep unavailable'),
      );
      const recoverAllSpy = spyOn(enginePrototype, 'recoverAll').mockRejectedValue(
        new Error('boot recovery unavailable'),
      );

      try {
        const bureau = await createBureau({
          agents: {},
          generate: createMockGenerate(),
          toolbox: createEmptyToolbox(),
          storage: { type: 'memory' },
          durableExecution: true,
        });
        try {
          const report = await bureau.waitForRecovery?.();
          expect(report?.outcome).toBe('failed');
          expect(report?.batchFailure?.message).toContain('boot recovery unavailable');
          // The sweep failure that happened BEFORE recoverAll() threw must
          // still surface on the resolved report, not be silently dropped
          // by the batch-failure path.
          expect(report?.sweepFailure?.message).toContain('scheduler-residue sweep unavailable');
          expect(report?.perRunFailures).toEqual([]);
        } finally {
          await bureau.dispose();
        }
      } finally {
        recoverAllSpy.mockRestore();
        listSpy.mockRestore();
      }
    });

    it('resolves outcome: "partial" with sweepFailure set and empty perRunFailures when every handle reattaches', async () => {
      const databasePath = join(
        tmpdir(),
        `bureau-recovery-sweep-failure-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
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
        });
        const run = await bureauA.createRun({ message: 'Recover me' });
        await pollUntil(() => bureauAReachedStep1);
        expect(bureauAReachedStep1).toBe(true);

        const probe = await createRuntimeComposition({
          generate: createMockGenerate(),
          toolbox: createEmptyToolbox(),
          storage: { type: 'sqlite', path: databasePath },
          durableExecution: true,
        });
        const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
          list: (filter: unknown) => Promise<unknown>;
        };
        probe.durable!.engine[Symbol.dispose]?.();
        probe.disposeStorage?.();

        // Fails the unconditional scheduler-residue sweep (`engine.list`)
        // without touching `recoverAll`, so the genuinely crashed run still
        // reattaches normally.
        const listSpy = spyOn(enginePrototype, 'list').mockRejectedValue(
          new Error('scheduler-residue sweep unavailable'),
        );

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
          const report = await bureauB.waitForRecovery?.();
          expect(report?.outcome).toBe('partial');
          expect(report?.sweepFailure?.message).toContain('scheduler-residue sweep unavailable');
          expect(report?.perRunFailures).toEqual([]);
          expect(report?.batchFailure).toBeUndefined();

          await pollUntil(() => bSteps.includes(1));
          expect(bSteps).toEqual([1]);
          expect(bureauB.getRun(run.id)).toBeDefined();
        } finally {
          listSpy.mockRestore();
          await bureauB.dispose();
          await bureauA.dispose();
        }
      } finally {
        await rm(databasePath, { force: true });
        await rm(`${databasePath}-wal`, { force: true });
        await rm(`${databasePath}-shm`, { force: true });
      }
    });

    it('deduplicates a handle classified "cancel" by both the awaited recovery hook and the post-recoverAll() pass (code-review regression fixture)', async () => {
      const probe = await createRuntimeComposition({
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
      });
      const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
        recoverAll: (options: {
          onRecoveredWorkflow: (info: unknown) => Promise<void>;
        }) => Promise<unknown[]>;
      };
      probe.durable!.engine[Symbol.dispose]?.();
      probe.disposeStorage?.();

      // A bureau-owned agentRun input whose session is absent: the awaited
      // hook (onRecoveredWorkflow) classifies it 'cancel'/'session-absent'
      // but — because 'cancel' never registers an ActiveRun — the SAME
      // handle is also present in recoverAll()'s returned array, so the
      // post-recoverAll() pass classifies it a second time with an
      // identical verdict.
      const duplicateInput = {
        runId: 'dup-run',
        sessionId: 'missing-session',
        agentName: 'bureau',
      };
      const recoverAllSpy = spyOn(enginePrototype, 'recoverAll').mockImplementation(
        async ({ onRecoveredWorkflow }) => {
          await onRecoveredWorkflow({ workflowId: 'dup-run', input: duplicateInput });
          return [{ id: 'dup-run', getLaunchMetadata: async () => ({ input: duplicateInput }) }];
        },
      );

      try {
        const bureau = await createBureau({
          agents: {},
          generate: createMockGenerate(),
          toolbox: createEmptyToolbox(),
          storage: { type: 'memory' },
          durableExecution: true,
        });
        try {
          const report = await bureau.waitForRecovery?.();
          expect(report?.outcome).toBe('partial');
          // Exactly ONE entry, not two, even though both classification
          // passes independently agree on 'cancel'/'session-absent'.
          expect(report?.perRunFailures).toEqual([{ runId: 'dup-run', reason: 'session-absent' }]);
        } finally {
          await bureau.dispose();
        }
      } finally {
        recoverAllSpy.mockRestore();
      }
    });

    it('reports outcome: "partial" via sweepFailure when a suspended scheduler run cannot be cancelled, even though the sweep itself never throws (code-review regression fixture)', async () => {
      const probe = await createRuntimeComposition({
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
      });
      const enginePrototype = Object.getPrototypeOf(probe.durable!.engine) as {
        list: (filter: unknown) => Promise<{ items: { id: string }[]; total: number }>;
        cancel: (runId: string) => Promise<void>;
        recoverAll: () => Promise<unknown[]>;
      };
      probe.durable!.engine[Symbol.dispose]?.();
      probe.disposeStorage?.();

      const listSpy = spyOn(enginePrototype, 'list').mockResolvedValue({
        items: [{ id: 'scheduler-run-stuck-1' }],
        total: 1,
      });
      const cancelSpy = spyOn(enginePrototype, 'cancel').mockRejectedValue(
        new Error('cancel unavailable'),
      );
      const recoverAllSpy = spyOn(enginePrototype, 'recoverAll').mockResolvedValue([]);

      try {
        const bureau = await createBureau({
          agents: {},
          generate: createMockGenerate(),
          toolbox: createEmptyToolbox(),
          storage: { type: 'memory' },
          durableExecution: true,
        });
        try {
          const report = await bureau.waitForRecovery?.();
          expect(report?.outcome).toBe('partial');
          expect(report?.sweepFailure?.message).toContain(
            '1 suspended scheduler run(s) could not be cancelled',
          );
          expect(report?.perRunFailures).toEqual([]);
          expect(report?.batchFailure).toBeUndefined();
        } finally {
          await bureau.dispose();
        }
      } finally {
        recoverAllSpy.mockRestore();
        cancelSpy.mockRestore();
        listSpy.mockRestore();
      }
    });
  });

  describe('dedupeRecoveryPerRunFailures (AB-349)', () => {
    it('returns an empty array for an empty input', () => {
      expect(dedupeRecoveryPerRunFailures([])).toEqual([]);
    });

    it('keeps every entry when runIds are distinct', () => {
      const input = [
        { runId: 'run-a', reason: 'foreign-input' },
        { runId: 'run-b', reason: 'session-absent' },
      ];
      expect(dedupeRecoveryPerRunFailures(input)).toEqual(input);
    });

    it('keeps only the FIRST entry for a repeated runId', () => {
      const input = [
        { runId: 'run-a', reason: 'foreign-input' },
        { runId: 'run-a', reason: 'foreign-input' },
        { runId: 'run-b', reason: 'session-absent' },
      ];
      expect(dedupeRecoveryPerRunFailures(input)).toEqual([
        { runId: 'run-a', reason: 'foreign-input' },
        { runId: 'run-b', reason: 'session-absent' },
      ]);
    });
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

/**
 * A plain-object snapshot of a `review.*` event's own fields — `type`,
 * `reviewId`, `runId`, `principal`, `kind`. Never `{ ...event }`: the real
 * DOM `Event` base class exposes `type` via a non-enumerable prototype
 * getter (and adds its own enumerable `isTrusted`), so a spread silently
 * drops `type` and picks up an unrelated DOM field — this reads exactly the
 * five fields the `review.*` family defines, nothing more, nothing less.
 */
function reviewEventSnapshot(event: {
  type: string;
  reviewId: string;
  runId: string;
  principal: string;
  kind: string;
}): { type: string; reviewId: string; runId: string; principal: string; kind: string } {
  return {
    type: event.type,
    reviewId: event.reviewId,
    runId: event.runId,
    principal: event.principal,
    kind: event.kind,
  };
}

describe('createBureau review lifecycle event family (AB-224)', () => {
  it('recordReviewDecision dispatches review.approved live, alongside the durable write, with only id/runId/principal/kind', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-approved-1', name: 'charge-card', arguments: { cents: 200 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('event-approved-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence: textValueStore(new MemoryStorage()),
    });

    try {
      const observed: unknown[] = [];
      bureau.addEventListener('review.approved', (event) =>
        observed.push(reviewEventSnapshot(event)),
      );

      const run = await bureau.createRun({ message: 'Charge the customer' });
      await waitForRunCompletion(bureau, run.id);
      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();

      await bureau.resolveReview({
        id: review!.id,
        decision: 'approve',
        principal: 'operator-approved',
      });

      // Exactly the five privileged fields — never the tool's own
      // arguments/result/approval detail (see `reviewEventSnapshot`).
      expect(observed).toEqual([
        {
          type: 'review.approved',
          reviewId: review!.id,
          runId: run.id,
          principal: 'operator-approved',
          kind: 'tool-approval',
        },
      ]);

      const records = await bureau.auditTrail!.query({ runId: run.id });
      expect(records.some((record) => record.type === 'review.tool-approval.approved')).toBe(true);
    } finally {
      bureau.dispose();
    }
  });

  it('recordReviewDecision dispatches review.denied for deny and review.rejected for reject — never the other one', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-denied-1', name: 'charge-card', arguments: { cents: 300 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('event-denied-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
    });
    try {
      const denied: unknown[] = [];
      const rejected: unknown[] = [];
      bureau.addEventListener('review.denied', (event) => denied.push(event.reviewId));
      bureau.addEventListener('review.rejected', (event) => rejected.push(event.reviewId));

      const run = await bureau.createRun({ message: 'Charge the customer' });
      await waitForRunCompletion(bureau, run.id);
      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();

      await bureau.resolveReview({ id: review!.id, decision: 'deny', principal: 'operator-x' });

      expect(denied).toEqual([review!.id]);
      expect(rejected).toEqual([]);
    } finally {
      bureau.dispose();
    }
  });

  it('recordReviewDecision dispatches review.rejected for reject — never review.denied', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-rejected-1', name: 'charge-card', arguments: { cents: 300 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('event-rejected-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
    });
    try {
      const denied: unknown[] = [];
      const rejected: unknown[] = [];
      bureau.addEventListener('review.denied', (event) => denied.push(event.reviewId));
      bureau.addEventListener('review.rejected', (event) => rejected.push(event.reviewId));

      const run = await bureau.createRun({ message: 'Charge the customer' });
      await waitForRunCompletion(bureau, run.id);
      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();

      await bureau.resolveReview({
        id: review!.id,
        decision: 'reject',
        principal: 'operator-y',
        reason: 'Suspicious amount',
      });

      expect(rejected).toEqual([review!.id]);
      expect(denied).toEqual([]);
    } finally {
      bureau.dispose();
    }
  });

  it('human-wait approve/deny/reject dispatch the matching live event', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });
    try {
      spyOn(bureau, 'signalSession').mockImplementation(async () => {});
      const approved: unknown[] = [];
      const denied: unknown[] = [];
      const rejected: unknown[] = [];
      bureau.addEventListener('review.approved', (event) => approved.push(event.reviewId));
      bureau.addEventListener('review.denied', (event) => denied.push(event.reviewId));
      bureau.addEventListener('review.rejected', (event) => rejected.push(event.reviewId));

      const approveRun = createParkedActiveRun();
      const approveRunId = bureau.store.register(approveRun.activeRun, 'run-hw-approve');
      approveRun.emitter.dispatchEvent(
        new HumanWaitParkedEvent('human-response', approveRunId, 'Approve?'),
      );
      const [approveReview] = bureau.listPendingReviews();
      await bureau.resolveReview({
        id: approveReview!.id,
        decision: 'approve',
        principal: 'operator-hw-a',
      });

      const denyRun = createParkedActiveRun();
      const denyRunId = bureau.store.register(denyRun.activeRun, 'run-hw-deny');
      denyRun.emitter.dispatchEvent(new HumanWaitParkedEvent('human-response', denyRunId, 'Deny?'));
      const [denyReview] = bureau.listPendingReviews();
      await bureau.resolveReview({
        id: denyReview!.id,
        decision: 'deny',
        principal: 'operator-hw-d',
      });

      const rejectRun = createParkedActiveRun();
      const rejectRunId = bureau.store.register(rejectRun.activeRun, 'run-hw-reject');
      rejectRun.emitter.dispatchEvent(
        new HumanWaitParkedEvent('human-response', rejectRunId, 'Reject?'),
      );
      const [rejectReview] = bureau.listPendingReviews();
      await bureau.resolveReview({
        id: rejectReview!.id,
        decision: 'reject',
        principal: 'operator-hw-r',
        reason: 'Not authorized',
      });

      expect(approved).toEqual([approveReview!.id]);
      expect(denied).toEqual([denyReview!.id]);
      expect(rejected).toEqual([rejectReview!.id]);
    } finally {
      bureau.dispose();
    }
  });

  it('sweepExpiredReviews dispatches review.expired live, attributed to system:expiry-sweep', async () => {
    const runtime = createManualRuntimeServices();
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [
            { id: 'call-expired-event-1', name: 'charge-card', arguments: { cents: 900 } },
          ],
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
          approvalSecret: 'expiry-event-secret',
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
      const expired: unknown[] = [];
      bureau.addEventListener('review.expired', (event) =>
        expired.push(reviewEventSnapshot(event)),
      );

      const run = await bureau.createRun({ message: 'Charge the customer' });
      await waitForRunCompletion(bureau, run.id);
      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();

      await runtime.advance(1500);
      const sweptCount = await bureau.sweepExpiredReviews();
      expect(sweptCount).toBe(1);

      expect(expired).toHaveLength(1);
      expect(expired[0]).toMatchObject({
        type: 'review.expired',
        reviewId: review!.id,
        runId: run.id,
        principal: 'system:expiry-sweep',
        kind: 'tool-approval',
      });
    } finally {
      bureau.dispose();
    }
  });

  it('deleteRun dispatches review.revoked attributed to system:run-deletion — never review.canceled', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-revoked-1', name: 'charge-card', arguments: { cents: 400 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('event-revoked-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence: textValueStore(new MemoryStorage()),
    });
    try {
      const revoked: unknown[] = [];
      const canceled: unknown[] = [];
      bureau.addEventListener('review.revoked', (event) =>
        revoked.push(reviewEventSnapshot(event)),
      );
      bureau.addEventListener('review.canceled', (event) => canceled.push(event.reviewId));

      const run = await bureau.createRun({ message: 'Charge the customer' });
      await waitForRunCompletion(bureau, run.id);
      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();

      await bureau.deleteRun(run.id);

      expect(revoked).toHaveLength(1);
      expect(revoked[0]).toMatchObject({
        type: 'review.revoked',
        reviewId: review!.id,
        runId: run.id,
        principal: 'system:run-deletion',
        kind: 'tool-approval',
      });
      expect(canceled).toEqual([]);

      // AB-228 — the LIVE `review.revoked` dispatch asserted above has a
      // durable counterpart (`recordReviewStatusTransition`'s `record()`
      // call, same as every other `ReviewStatus` transition) that this
      // suite had never independently queried for. Every other status
      // (approved/denied/rejected/expired/canceled/superseded) already has
      // this same durable-query assertion elsewhere in this file; this
      // closes the one gap AB-228 found.
      const revokedRecords = await bureau.auditTrail!.query({ runId: run.id });
      const revokedRecord = revokedRecords.find(
        (record) => record.type === 'review.tool-approval.revoked',
      );
      expect(revokedRecord).toBeDefined();
      expect(revokedRecord!.principal).toBe('system:run-deletion');
    } finally {
      bureau.dispose();
    }
  });

  it('deleteSession dispatches review.revoked attributed to system:session-deletion', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-revoked-2', name: 'charge-card', arguments: { cents: 450 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('event-revoked-session-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence: textValueStore(new MemoryStorage()),
    });
    try {
      const revoked: unknown[] = [];
      bureau.addEventListener('review.revoked', (event) =>
        revoked.push(reviewEventSnapshot(event)),
      );

      const run = await bureau.createRun({ message: 'Charge the customer' });
      await waitForRunCompletion(bureau, run.id);
      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();
      const session = await bureau.getSession(run.sessionId);
      expect(session?.metadata['lastRunId']).toBe(run.id);

      await bureau.deleteSession(run.sessionId);

      expect(revoked).toHaveLength(1);
      expect(revoked[0]).toMatchObject({
        type: 'review.revoked',
        reviewId: review!.id,
        runId: run.id,
        principal: 'system:session-deletion',
        kind: 'tool-approval',
      });
    } finally {
      await bureau.dispose();
    }
  });

  it('abortRun dispatches review.canceled attributed to system:run-abort for both kinds — never review.revoked', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
    });
    try {
      const canceled: unknown[] = [];
      const revoked: unknown[] = [];
      bureau.addEventListener('review.canceled', (event) =>
        canceled.push(reviewEventSnapshot(event)),
      );
      bureau.addEventListener('review.revoked', (event) => revoked.push(event.reviewId));

      const { activeRun, emitter } = createParkedActiveRun();
      const runId = bureau.store.register(activeRun, 'run-abort-events');
      emitter.dispatchEvent(
        new StepCompletedEvent({
          step: 0,
          conversation: new Conversation(),
          content: '',
          toolCalls: [],
          results: [
            {
              callId: 'call-abort-events-1',
              outcome: 'action_required',
              content: 'needs approval',
              toolCallId: 'call-abort-events-1',
              toolName: 'charge-card',
              result: undefined,
              action: { type: 'approval', message: 'Approve charge' },
              pendingApproval: {
                callId: 'call-abort-events-1',
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

      const approvalReviewId = `approval:${runId}:call-abort-events-1`;
      const humanWaitReviewId = `human-wait:${runId}:human-response`;

      bureau.abortRun(runId);
      await pollUntil(() => bureau.listPendingReviews().length === 0);

      expect(canceled.map((event) => (event as { reviewId: string }).reviewId).sort()).toEqual(
        [approvalReviewId, humanWaitReviewId].sort(),
      );
      expect(
        (canceled as { principal: string }[]).every(
          (event) => event.principal === 'system:run-abort',
        ),
      ).toBe(true);
      expect(revoked).toEqual([]);
    } finally {
      bureau.dispose();
    }
  });

  it("resolveReview approve's resumeApproval re-gate dispatches review.superseded, attributed to system:supersession, and writes the durable record", async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-superseded-1', name: 'charge-card', arguments: { cents: 900 } }],
        },
      ]),
      toolbox: createRegatingApprovalToolbox('event-superseded-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      storage: { type: 'memory' },
    });
    try {
      const superseded: unknown[] = [];
      bureau.addEventListener('review.superseded', (event) =>
        superseded.push(reviewEventSnapshot(event)),
      );

      const run = await bureau.createRun({ message: 'Charge the customer' });
      await waitForRunCompletion(bureau, run.id);
      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();

      const outcome = await bureau.resolveReview({
        id: review!.id,
        decision: 'approve',
        principal: 'operator-supersede',
      });
      expect(outcome.decision).toBe('approve');
      expect(charges).toEqual([]); // gated again, never executed

      // Still there, under the SAME id, now backed by the replacement approval.
      const stillPending = bureau.listPendingReviews();
      expect(stillPending).toHaveLength(1);
      expect(stillPending[0]!.id).toBe(review!.id);

      expect(superseded).toHaveLength(1);
      expect(superseded[0]).toMatchObject({
        type: 'review.superseded',
        reviewId: review!.id,
        runId: run.id,
        principal: 'system:supersession',
        kind: 'tool-approval',
      });

      const records = await bureau.auditTrail!.query({ runId: run.id });
      const supersededRecord = records.find(
        (record) => record.type === 'review.tool-approval.superseded',
      );
      expect(supersededRecord).toBeDefined();
      expect(supersededRecord!.principal).toBe('system:supersession');
      expect(
        (supersededRecord!.detail as { status?: string; review?: { status?: string } }).status,
      ).toBe('superseded');
    } finally {
      bureau.dispose();
    }
  });

  it('does not double-fire a review.* event when sweepExpiredReviews and deleteRun both observe a lingering post-regate override for the same review id (regression)', async () => {
    const runtime = createManualRuntimeServices();
    const charges: number[] = [];
    let evaluationCount = 0;
    const toolbox = createToolbox(
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
        approvalSecret: 'dup-guard-secret',
        approvalBindingTtlMs: 1000,
        runtime,
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
    );

    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-dup-1', name: 'charge-card', arguments: { cents: 400 } }],
        },
      ]),
      toolbox,
      stopWhen: stopWhen.toolOutcome('action_required'),
      persistence: textValueStore(new MemoryStorage()),
      runtime,
    });

    try {
      const canceled: string[] = [];
      const revoked: string[] = [];
      const expired: string[] = [];
      bureau.addEventListener('review.canceled', (event) => canceled.push(event.reviewId));
      bureau.addEventListener('review.revoked', (event) => revoked.push(event.reviewId));
      bureau.addEventListener('review.expired', (event) => expired.push(event.reviewId));

      const run = await bureau.createRun({ message: 'Charge the customer' });
      await waitForRunCompletion(bureau, run.id);
      const [review] = bureau.listPendingReviews();
      expect(review).toBeDefined();

      // Approve resumes the call; the policy gates it again on its SECOND
      // evaluation, producing a fresh `pendingApproval` for the SAME review
      // id and leaving `pendingApprovalOverrides` populated for it.
      const outcome = await bureau.resolveReview({
        id: review!.id,
        decision: 'approve',
        principal: 'operator-dup',
      });
      expect(outcome.decision).toBe('approve');
      expect(charges).toEqual([]);
      expect(bureau.listPendingReviews()).toHaveLength(1);
      expect(bureau.listPendingReviews()[0]!.id).toBe(review!.id);

      // Let the REPLACEMENT binding expire and sweep it — nothing clears
      // the lingering override on expiry.
      await runtime.advance(1500);
      const sweptCount = await bureau.sweepExpiredReviews();
      expect(sweptCount).toBe(1);
      expect(expired).toEqual([review!.id]);

      // Delete the run. Without the AB-224 fix, `revokePendingApprovalsForRun`'s
      // override loop would find the SAME lingering override, unconditionally
      // re-transition it, and fire a SECOND, duplicate `review.*` event for an
      // id that is already resolved — this issue's own named rollback trigger.
      await bureau.deleteRun(run.id);
      expect(revoked).toEqual([]);
      expect(canceled).toEqual([]);

      const resolved = await bureau.getReview(review!.id);
      expect(resolved?.status).toBe('expired');
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

  it("AB-241: a durable bureau.run() catalog dispatch records options.principal in the same runAttribution map eventHistory's principal gate consults, exactly as Bureau.createRun does", async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-authz-catalog-run-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      const bureau = await createBureau({
        agents: { echo: createAgent({ generate: createMockGenerate('Done.') }) },
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
      });

      const run = bureau.run('echo', 'Attribute me to alice', { principal: 'alice' });
      await run.result();
      const runId = run.snapshot().id;

      // A different caller's principal fails closed, matching createRun's
      // own run-kind authorization gate exactly.
      const deniedOutcome = await bureau.eventHistory(
        { kind: 'run', id: runId },
        { principal: 'mallory' },
      );
      expect(deniedOutcome).toEqual({ outcome: 'not-found' });

      // The attributed principal reads back successfully — never
      // 'not-found' — proving `runAttribution` (not merely
      // `LivenessSnapshot.owner`) carries this catalog run's principal the
      // same way it would for a `Bureau.createRun`-dispatched run. Unlike
      // `createRun`, a catalog run keeps no durable event of its own kind
      // recorded against it here (no bureau session backs this dispatch),
      // so an empty page is the expected shape — the AB-313 "never-recorded
      // id reads as an ordinary empty page" convention, not a failure.
      const allowedOutcome = await bureau.eventHistory(
        { kind: 'run', id: runId },
        { principal: 'alice' },
      );
      expect(allowedOutcome).toEqual({ events: [], hasMore: false });

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('AB-241: does not leave a phantom runAttribution entry when the durable branch records it and then a non-AgentContractError resolver failure means the run never actually dispatched', async () => {
    // Mirrors `createRunFromRequest`'s own cleanup for a run that "never
    // reached `store.register`" (create-bureau.ts's runAttribution.delete
    // at its own createRunRuntime-failure catch): `runAgent`'s durable
    // branch records `runAttribution` under its minted `runId` BEFORE
    // `OPERATIVE_RESOLVE_RUN_OPTIONS` resolves. A resolver rejection that
    // is NOT an `AgentContractError` (the one case with its own dedicated
    // fallback-and-delete) must still clean that entry up, or it becomes a
    // permanent phantom keyed to a run that never dispatched anything.
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-authz-catalog-run-failure-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    // A manual runtime gives a deterministic identifier sequence, so the
    // durable branch's minted runId is predictable WITHOUT ever going
    // through `listDurableRuns()` (which would never see this run — the
    // resolver fails before any durable workflow starts).
    const runtime = createManualRuntimeServices();

    const throwingAgent: RunnableAgent<never, false> & DefinitionResolvingAgent = {
      name: 'throwing',
      hasOutput: false,
      run: () => {
        throw new Error('the direct-dispatch run() must never be reached in this test');
      },
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: async () => {
        throw new Error('resolver exploded — not an AgentContractError');
      },
    };

    try {
      // Positive control, proving the `${identifierPrefix}-agent-run-1`
      // format assumption below against a REAL dispatch before relying on
      // it for a run that (by design) never reaches `listDurableRuns()` —
      // a fresh manual runtime's own independent identifier sequence, so
      // this draws no `agent-run` id the throwing bureau's sequence below
      // would ever produce.
      const controlRuntime = createManualRuntimeServices();
      const controlBureau = await createBureau({
        agents: { echo: createAgent({ generate: createMockGenerate('control') }) },
        storage: { type: 'memory' },
        durableExecution: true,
        runtime: controlRuntime,
      });
      const controlRun = controlBureau.run('echo', 'hi', { principal: 'alice' });
      await controlRun.result();
      expect(controlRun.snapshot().id).toBe(`${controlRuntime.identifierPrefix}-agent-run-1`);
      await controlBureau.dispose();

      const bureau = await createBureau({
        agents: { throwing: throwingAgent },
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        runtime,
      });

      const expectedRunId = `${runtime.identifierPrefix}-agent-run-1`;
      const run = bureau.run('throwing', 'hi', { principal: 'alice' });
      const result = await run.result();
      expect(result.error).toBeInstanceOf(Error);

      // The attribution this run recorded under `expectedRunId` before the
      // resolver rejected must be gone — a supplied principal reads it as
      // 'not-found', identical to a run that was never attributed at all.
      const outcome = await bureau.eventHistory(
        { kind: 'run', id: expectedRunId },
        { principal: 'alice' },
      );
      expect(outcome).toEqual({ outcome: 'not-found' });

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
    // AB-228 wired `deleteSession` (`create-bureau.ts`) to dispatch a real
    // `SessionDeletedEvent` on the BUREAU-level emitter, closing the durable
    // audit trail's own gap (`audit-trail.ts`'s dedicated
    // `sessionDeletedListener`) — but that dispatch never traverses the
    // `'action'` stream this module's `createDurableEventProducer` listens
    // through, so it still does not reach THIS store. This synthesizes it
    // the same supported way the sibling "records a session-scoped action"
    // test above does (`Store.recordAction`), proving this issue's own
    // detection logic against the event shape a real `'action'`-stream
    // dispatch site would produce; wiring one up here remains a follow-up,
    // out of AB-228's `AUDIT_EVENT_TYPES`-only boundary.
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

describe('bureau.eventHistory deleted-aggregate through a real session deletion (AB-372)', () => {
  it('returns deleted-aggregate for a session deleted through a real bureau.deleteSession call, with no synthetic record injected', async () => {
    // AB-313's own "returns deleted-aggregate for a session.deleted owner"
    // test above synthesizes the deletion marker via `bureau.store.recordAction`
    // because nothing wired a real `SessionDeletedEvent` dispatch into THIS
    // durable store — `durable-event-history.ts`'s `createDurableEventProducer`
    // had no listener for it (the audit trail, a separate durable layer, did).
    // AB-372 closes that gap; this proves the real production call site
    // (`Bureau.deleteSession`) reaches `bureau.eventHistory`'s deleted-aggregate
    // detection with no test-only synthesis anywhere in this test.
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-real-session-deletion-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
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

      const run = await bureau.createRun({ message: 'A session about to be really deleted' });
      await waitForRunCompletion(bureau, run.id);
      await runtime.deferred.drain();

      await bureau.deleteSession(run.sessionId);
      await runtime.deferred.drain();

      const outcome = await bureau.eventHistory({ kind: 'session', id: run.sessionId });
      if (!('outcome' in outcome) || outcome.outcome !== 'deleted-aggregate') {
        throw new Error(`expected deleted-aggregate, got ${JSON.stringify(outcome)}`);
      }
      expect(outcome.owner).toEqual({ kind: 'session', id: run.sessionId });
      expect(outcome.events.map((event) => event.kind)).toContain('session.deleted');

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it("coalesces two concurrent bureau.deleteSession calls on the same session into exactly one durable session.deleted record (mirrors the audit trail's own coalescing proof)", async () => {
    // `deleteSession`'s own single-process coalescing (`create-bureau.ts`)
    // means two concurrent calls for the same id dispatch `SessionDeletedEvent`
    // exactly once already (proved against the audit trail at
    // "dispatches session.deleted exactly once for two concurrent
    // deleteSession(id) calls" above) — this proves the SAME real call
    // pattern also reaches this durable store as exactly one record, not
    // merely the audit trail. The producer's own idempotency guard (proved
    // directly, with a genuinely duplicated dispatch, in
    // `durable-event-history.test.ts`) is a second, independent line of
    // defense for the documented cross-process race that coalescing cannot
    // cover.
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-real-session-deletion-dup-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
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

      const run = await bureau.createRun({ message: 'A session deleted concurrently' });
      await waitForRunCompletion(bureau, run.id);
      await runtime.deferred.drain();

      await Promise.all([
        bureau.deleteSession(run.sessionId),
        bureau.deleteSession(run.sessionId),
        bureau.deleteSession(run.sessionId),
      ]);
      await runtime.deferred.drain();

      const outcome = await bureau.eventHistory({ kind: 'session', id: run.sessionId });
      if (!('outcome' in outcome) || outcome.outcome !== 'deleted-aggregate') {
        throw new Error(`expected deleted-aggregate, got ${JSON.stringify(outcome)}`);
      }
      expect(outcome.events.filter((event) => event.kind === 'session.deleted')).toHaveLength(1);

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('a session id recreated after deletion reads back as an ordinary page, not deleted-aggregate, while it is live again (Codex P1 review finding, PR #580, "Ignore prior deletion markers while a reused session is live")', async () => {
    // The durable history a recreated session shares with its deleted
    // predecessor still carries the predecessor's own `'session.deleted'`
    // marker (this producer does not, and cannot without a per-incarnation
    // identity on `SessionDeletedEvent`, prune it) — `resolveEventHistory`
    // must not let that stale marker outrank the session's CURRENT live
    // record.
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-reused-session-live-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
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

      const originalRun = await bureau.createRun({ message: 'the first incarnation' });
      const sessionId = originalRun.sessionId;
      await waitForRunCompletion(bureau, originalRun.id);
      await runtime.deferred.drain();

      await bureau.deleteSession(sessionId);
      await runtime.deferred.drain();

      // Confirm the marker is really there before recreating — otherwise
      // this test would trivially pass for the wrong reason.
      const deletedOutcome = await bureau.eventHistory({ kind: 'session', id: sessionId });
      if (!('outcome' in deletedOutcome) || deletedOutcome.outcome !== 'deleted-aggregate') {
        throw new Error(`expected deleted-aggregate, got ${JSON.stringify(deletedOutcome)}`);
      }

      // Recreate the SAME id and complete a run against it.
      const recreatedRun = await bureau.createRun({ message: 'the second incarnation', sessionId });
      await waitForRunCompletion(bureau, recreatedRun.id);
      await runtime.deferred.drain();
      expect(await bureau.getSession(sessionId)).toBeDefined();

      const liveOutcome = await bureau.eventHistory({ kind: 'session', id: sessionId });
      expect('outcome' in liveOutcome).toBe(false);
      if ('outcome' in liveOutcome) throw new Error('unreachable');
      // The historical marker is still visible in the page — nothing is
      // erased, only the deleted-aggregate OUTCOME is suppressed.
      expect(liveOutcome.events.map((event) => event.kind)).toContain('session.deleted');

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('reauthorizes a recreated, live session against ITS OWN authority before returning its page — a principal unauthorized for the new incarnation is denied (Codex P1 review finding, PR #580, "Reauthorize the live session before returning its page")', async () => {
    // The up-front authorization check runs against whatever session record
    // existed BEFORE this function's owner-write wait and history replay —
    // for an id that was deleted (no live record at that point), it is a
    // no-op by the "no recorded authority is open" convention, which is
    // only correct for an id that STAYS deleted. If the id is recreated in
    // that window with a DIFFERENT recorded authority, the live-session
    // override this issue adds must reauthorize against THAT record before
    // returning its page — never fall through to treating the id as still
    // open just because it once had no live record.
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-reused-session-reauth-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
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

      const originalRun = await bureau.createRun({ message: 'the first incarnation' });
      const sessionId = originalRun.sessionId;
      await waitForRunCompletion(bureau, originalRun.id);
      await runtime.deferred.drain();

      await bureau.deleteSession(sessionId);
      await runtime.deferred.drain();

      // Recreate the SAME id, this time owned by a specific principal.
      const recreatedRun = await bureau.createRun({
        message: 'the second incarnation',
        sessionId,
        principal: 'alice',
      });
      await waitForRunCompletion(bureau, recreatedRun.id);
      await runtime.deferred.drain();
      expect(await bureau.getSession(sessionId)).toBeDefined();

      // A principal never authorized for either incarnation must be denied
      // the SAME not-found-shaped outcome every other unauthorized read
      // gets — not the recreated session's live history.
      const deniedOutcome = await bureau.eventHistory(
        { kind: 'session', id: sessionId },
        { principal: 'mallory' },
      );
      expect(deniedOutcome).toEqual({ outcome: 'not-found' });

      // The actual owner still reads the live page.
      const allowedOutcome = await bureau.eventHistory(
        { kind: 'session', id: sessionId },
        { principal: 'alice' },
      );
      expect('outcome' in allowedOutcome).toBe(false);

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('reauthorizes the POST-page session snapshot too, not just the up-front one (Codex P1 follow-up review finding, PR #580, "Reauthorize the post-page session snapshot")', async () => {
    // The up-front `liveSession` check runs BEFORE `history.page()`. This
    // simulates the exact race that motivates the post-page recheck: the
    // FIRST `sessionStore.load` call (the up-front check) observes no live
    // session — as it genuinely would for an id deleted, or recreated,
    // strictly AFTER that read but before `page()` resolves — while every
    // SUBSEQUENT call (the post-page recheck) sees the REAL, already-
    // recreated, unauthorized session. Mocking only the FIRST call
    // reproduces this deterministically, without depending on real
    // concurrency timing.
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-reused-session-post-page-reauth-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
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

      const originalRun = await bureau.createRun({ message: 'the first incarnation' });
      const sessionId = originalRun.sessionId;
      await waitForRunCompletion(bureau, originalRun.id);
      await runtime.deferred.drain();

      await bureau.deleteSession(sessionId);
      await runtime.deferred.drain();

      // Recreate the SAME id under a principal `mallory` is not authorized
      // for.
      const recreatedRun = await bureau.createRun({
        message: 'the second incarnation',
        sessionId,
        principal: 'alice',
      });
      await waitForRunCompletion(bureau, recreatedRun.id);
      await runtime.deferred.drain();

      const sessionStore = bureau.sessionStore;
      if (!sessionStore) throw new Error('expected a configured session store');
      const loadSpy = spyOn(sessionStore, 'load').mockImplementationOnce(async () => undefined);

      try {
        const deniedOutcome = await bureau.eventHistory(
          { kind: 'session', id: sessionId },
          { principal: 'mallory' },
        );
        expect(deniedOutcome).toEqual({ outcome: 'not-found' });
      } finally {
        loadSpy.mockRestore();
      }

      // The actual owner still reads the live page (a fresh call this
      // time, with no mocked read).
      const allowedOutcome = await bureau.eventHistory(
        { kind: 'session', id: sessionId },
        { principal: 'alice' },
      );
      expect('outcome' in allowedOutcome).toBe(false);

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('reauthorizes a recreated session even when the REQUESTED page omits its deletion marker entirely (Codex P1 follow-up review finding, PR #580, "Reauthorize when the requested page omits the marker")', async () => {
    // Authorization must not be nested inside "the requested page happens
    // to contain a session.deleted marker" — a `since` cursor positioned
    // after that marker (or a limit that pages around it) would otherwise
    // let an unauthorized caller read a recreated session's page simply by
    // asking for a page that doesn't include the historical marker.
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-reused-session-no-marker-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
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

      const originalRun = await bureau.createRun({ message: 'the first incarnation' });
      const sessionId = originalRun.sessionId;
      await waitForRunCompletion(bureau, originalRun.id);
      await runtime.deferred.drain();

      await bureau.deleteSession(sessionId);
      await runtime.deferred.drain();

      // Find the deletion marker's own cursor so the next read can be
      // positioned strictly AFTER it.
      const deletedOutcome = await bureau.eventHistory({ kind: 'session', id: sessionId });
      if (!('outcome' in deletedOutcome) || deletedOutcome.outcome !== 'deleted-aggregate') {
        throw new Error(`expected deleted-aggregate, got ${JSON.stringify(deletedOutcome)}`);
      }
      const markerCursor = deletedOutcome.events.find(
        (event) => event.kind === 'session.deleted',
      )?.cursor;
      if (markerCursor === undefined) throw new Error('expected a session.deleted cursor');

      const recreatedRun = await bureau.createRun({
        message: 'the second incarnation',
        sessionId,
        principal: 'alice',
      });
      await waitForRunCompletion(bureau, recreatedRun.id);
      await runtime.deferred.drain();

      // A page starting strictly AFTER the marker's own cursor never
      // includes it.
      const deniedNoMarker = await bureau.eventHistory(
        { kind: 'session', id: sessionId },
        { principal: 'mallory', since: markerCursor },
      );
      expect(deniedNoMarker).toEqual({ outcome: 'not-found' });

      const allowedNoMarker = await bureau.eventHistory(
        { kind: 'session', id: sessionId },
        { principal: 'alice', since: markerCursor },
      );
      expect('outcome' in allowedNoMarker).toBe(false);
      if ('outcome' in allowedNoMarker) throw new Error('unreachable');
      expect(allowedNoMarker.events.map((event) => event.kind)).not.toContain('session.deleted');

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('denies an unauthorized principal with not-found even when the durable read would otherwise report a retention gap (Codex P2 review finding, PR #580, "Authorize sessions before returning history gaps")', async () => {
    // Authorization must run BEFORE `history.page()` is even called, not
    // merely before its ORDINARY-page outcome is returned — otherwise an
    // unauthorized caller whose `since` cursor lands before the retention
    // floor gets back a `DurableEventGap` (with its own retention metadata)
    // instead of the documented not-found-shaped denial every other
    // authorization failure uses.
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-session-authz-gap-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
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

      const run = await bureau.createRun({ message: 'alice owns this', principal: 'alice' });
      await waitForRunCompletion(bureau, run.id);
      await runtime.deferred.drain();

      // A LIVE session accrues no durable event of its own from an
      // ordinary run today (`session.created`/`session.saved` are never
      // dispatched in production — see `durable-event-history.ts`'s own
      // doc comment) — synthesize one directly the same supported way
      // AB-313's own tests do, so this owner has at least one durable
      // event for the retention floor below to advance past.
      bureau.store.recordAction(run.id, 'session.saved', { sessionId: run.sessionId });
      await runtime.deferred.drain();

      const beforeGap = await bureau.eventHistory(
        { kind: 'session', id: run.sessionId },
        { principal: 'alice' },
      );
      if ('outcome' in beforeGap)
        throw new Error(`expected a page, got ${JSON.stringify(beforeGap)}`);
      const lastEvent = beforeGap.events.at(-1);
      if (!lastEvent) throw new Error('expected at least one durable event for this session');

      // Advance the retention floor past every one of this session's
      // durable events, via a second admin storage handle over the SAME
      // sqlite file (the identical pattern the AB-359 recovery tests use).
      const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
      const adminFeed = createFleetEventFeed(adminStorage);
      await adminFeed.retain({ beforeSequence: lastEvent.sequence + 1 });
      adminFeed.dispose();
      adminStorage[Symbol.dispose]();

      // An unauthorized principal is denied — never the gap.
      const deniedOutcome = await bureau.eventHistory(
        { kind: 'session', id: run.sessionId },
        { principal: 'mallory' },
      );
      expect(deniedOutcome).toEqual({ outcome: 'not-found' });

      // The actual owner still sees the real gap outcome.
      const ownerOutcome = await bureau.eventHistory(
        { kind: 'session', id: run.sessionId },
        { principal: 'alice' },
      );
      expect(ownerOutcome).toMatchObject({ outcome: 'gap' });

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('reauthorizes a fresh session snapshot before returning a post-wait gap too, not just the pre-page one (Codex P2 review finding, PR #580, "Reauthorize the session before returning a post-wait gap")', async () => {
    // The pre-page check above now runs BEFORE `waitForActiveWrites`, so its
    // read is stale by exactly the span of that wait — a session recreated
    // for a different, unauthorized principal DURING the wait would
    // otherwise ride the already-passed pre-page check straight through to
    // a raw `DurableEventGap`. Mocking only the FIRST `sessionStore.load`
    // call (the pre-page check) to see nothing reproduces that staleness
    // deterministically: every subsequent, unmocked call — including the
    // new gap-branch recheck this test targets — observes the REAL,
    // already-recreated, unauthorized session.
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-session-authz-post-wait-gap-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
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

      const run = await bureau.createRun({ message: 'alice owns this', principal: 'alice' });
      await waitForRunCompletion(bureau, run.id);
      await runtime.deferred.drain();

      bureau.store.recordAction(run.id, 'session.saved', { sessionId: run.sessionId });
      await runtime.deferred.drain();

      const beforeGap = await bureau.eventHistory(
        { kind: 'session', id: run.sessionId },
        { principal: 'alice' },
      );
      if ('outcome' in beforeGap)
        throw new Error(`expected a page, got ${JSON.stringify(beforeGap)}`);
      const lastEvent = beforeGap.events.at(-1);
      if (!lastEvent) throw new Error('expected at least one durable event for this session');

      const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
      const adminFeed = createFleetEventFeed(adminStorage);
      await adminFeed.retain({ beforeSequence: lastEvent.sequence + 1 });
      adminFeed.dispose();
      adminStorage[Symbol.dispose]();

      const sessionStore = bureau.sessionStore;
      if (!sessionStore) throw new Error('expected a configured session store');
      const loadSpy = spyOn(sessionStore, 'load').mockImplementationOnce(async () => undefined);

      try {
        // An unauthorized caller must be denied — never the gap — even
        // though the STALE pre-page snapshot (mocked away here) saw
        // nothing to deny against.
        const deniedOutcome = await bureau.eventHistory(
          { kind: 'session', id: run.sessionId },
          { principal: 'mallory' },
        );
        expect(deniedOutcome).toEqual({ outcome: 'not-found' });
      } finally {
        loadSpy.mockRestore();
      }

      // The actual owner still sees the real gap outcome (a fresh call
      // this time, with no mocked read).
      const ownerOutcome = await bureau.eventHistory(
        { kind: 'session', id: run.sessionId },
        { principal: 'alice' },
      );
      expect(ownerOutcome).toMatchObject({ outcome: 'gap' });

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });
});

describe('two Bureau processes racing deleteSession over one shared persistent store (AB-371)', () => {
  it('produces exactly one durable session.deleted record and one notification when both processes delete the same session concurrently', async () => {
    // The cross-process race AB-228's own process-local coalescing map and
    // the durable-event-history producer's own in-flight-by-owner map both
    // explicitly do NOT cover (see both modules' doc comments): two SEPARATE
    // Bureau instances, each with its own coalescing map and its own
    // producer, sharing one persistent SQLite backend the way two processes
    // would. Before AB-371, each process's own `sessionStore.load(id)` could
    // observe a truthy session before either had actually deleted it, so
    // both would unconditionally dispatch their own `SessionDeletedEvent` —
    // two durable records and two notifications for one real deletion.
    // `SessionStore.delete`'s new atomic `boolean` return closes this: only
    // the call that genuinely removed the live record dispatches.
    const databasePath = join(
      tmpdir(),
      `bureau-ab371-two-process-delete-race-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    const bureauA = await createBureau({
      agents: {},
      generate: createMockGenerate('Done.'),
      toolbox: createEmptyToolbox(),
      storage: { type: 'sqlite', path: databasePath },
    });
    const bureauB = await createBureau({
      agents: {},
      generate: createMockGenerate('Done.'),
      toolbox: createEmptyToolbox(),
      storage: { type: 'sqlite', path: databasePath },
    });

    try {
      const run = await bureauA.createRun({ message: 'A session deleted by two processes' });
      await waitForRunCompletion(bureauA, run.id);

      // Bureau B shares the same persistent store, so it sees the same
      // session record bureau A just created and persisted.
      await waitForCondition(
        async () => (await bureauB.getSession(run.sessionId)) !== undefined,
        'expected bureau B to observe the session bureau A persisted',
      );

      let notifications = 0;
      const onDeleted = (): void => {
        notifications += 1;
      };
      bureauA.addEventListener('session.deleted', onDeleted);
      bureauB.addEventListener('session.deleted', onDeleted);

      const [deletedByA, deletedByB] = await Promise.all([
        bureauA.deleteSession(run.sessionId),
        bureauB.deleteSession(run.sessionId),
      ]);
      void deletedByA;
      void deletedByB;

      bureauA.removeEventListener('session.deleted', onDeleted);
      bureauB.removeEventListener('session.deleted', onDeleted);

      // Exactly one of the two processes' own notification listeners fired —
      // each bureau only ever notifies for its own dispatch, so this counts
      // the total across both.
      expect(notifications).toBe(1);

      let deletedAggregatePage: Awaited<ReturnType<Bureau['eventHistory']>> | undefined;
      await waitForCondition(async () => {
        const page = await bureauA.eventHistory({ kind: 'session', id: run.sessionId });
        if ('outcome' in page && page.outcome === 'deleted-aggregate') {
          deletedAggregatePage = page;
          return true;
        }
        return false;
      }, 'expected the durable session history to reach deleted-aggregate');
      if (!deletedAggregatePage || !('events' in deletedAggregatePage)) {
        throw new Error('expected a deleted-aggregate page with events');
      }
      const deletionRecords = deletedAggregatePage.events.filter(
        (event) => event.kind === 'session.deleted',
      );
      expect(deletionRecords).toHaveLength(1);
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });
});

describe('bureau.eventHistory run ownership survives a process restart (AB-359)', () => {
  // The LMDB variant of this recovery scenario lives in its own file
  // (`event-history-run-ownership-recovery-lmdb.test.ts`) — it needs a real
  // per-iteration poll delay (LMDB completion-callback starvation, the same
  // root cause `src/test/harness-lmdb-isolation.test.ts` documents at
  // length), which a zero-delay-macrotask-only file like this one cannot
  // carry without pulling in a determinism-manifest exemption for the
  // whole file. Splitting it out scopes that exemption to only the one
  // real wait it needs, exactly as AB-332 already did for the identical
  // LMDB starvation symptom.

  /**
   * The cross-process proof, adapted from "recovers an in-flight durable
   * run across a process restart" above: bureau A dispatches a run WITH a
   * principal and crashes mid-run (never disposed — a genuinely
   * non-terminal Weft workflow is what `recoverAll()` needs to surface for
   * `reattachRecoveredRun` to run at all); bureau B reopens over the SAME
   * SQLite file, recovers and resumes the run to completion, and its
   * `eventHistory` must then be readable by the original principal and
   * denied to a stranger — proving `runAttribution` was rehydrated from the
   * session's persisted `lastRunOwningPrincipals`, not merely surviving in
   * memory (bureau A's own map is gone; it is a different `createBureau`
   * instance entirely).
   */
  it('a run dispatched with a principal, recovered over SQLite in a fresh process, is readable by that principal and denied to another', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-owner-recovery-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    let bureauAReachedStep1 = false;
    const bureauA = await createBureau({
      agents: {},
      generate: async ({ step }) => {
        if (step === 0) {
          return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        bureauAReachedStep1 = true; // step 0's saveCursor has committed
        return new Promise<never>(() => {}); // the "process" dies here
      },
      toolbox: createToolbox([createNextTool()]),
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const run = await bureauA.createRun({
        message: 'Attribute me to alice across a restart',
        principal: 'alice',
      });
      await pollUntil(() => bureauAReachedStep1);
      expect(bureauAReachedStep1).toBe(true);
      // AB-207: deliberately not disposing bureauA — see the sibling
      // recovery test's own comment for why this simulates a real crash.

      const bureauB = await createBureau({
        agents: {},
        generate: async ({ step }) => ({ content: `B recovered step ${step}`, toolCalls: [] }),
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        await waitForRunCompletion(bureauB, run.id);

        // The persistence layer itself, not just the end-to-end read: the
        // session's durable envelope carries the owning principal keyed by
        // this run's id.
        const recoveredSession = await bureauB.getSession(run.sessionId);
        expect(recoveredSession?.metadata['lastRunOwningPrincipals']).toEqual({
          [run.id]: 'alice',
        });

        const asOwner = await bureauB.eventHistory(
          { kind: 'run', id: run.id },
          { principal: 'alice' },
        );
        if ('outcome' in asOwner) {
          throw new Error(
            `expected a page for the owning principal, got ${JSON.stringify(asOwner)}`,
          );
        }
        expect(asOwner.events.map((event) => event.kind)).toContain('run.completed');

        const asStranger = await bureauB.eventHistory(
          { kind: 'run', id: run.id },
          { principal: 'mallory' },
        );
        expect(asStranger).toEqual({ outcome: 'not-found' });

        // A trusted caller that omits `principal` entirely still bypasses
        // the check, exactly as it does for a never-restarted run.
        const trusted = await bureauB.eventHistory({ kind: 'run', id: run.id });
        if ('outcome' in trusted) {
          throw new Error(`expected a page for a trusted caller, got ${JSON.stringify(trusted)}`);
        }
        expect(trusted.events.map((event) => event.kind)).toContain('run.completed');
      } finally {
        bureauB.dispose();
      }
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('a run already TERMINAL before the crash — never reattached, since recoverAll() only surfaces in-flight workflows — is still readable by its owner after restart (chatgpt-codex-connector review, PR #564, P1)', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-owner-recovery-terminal-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      const bureauA = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
      });

      const run = await bureauA.createRun({
        message: 'Complete me, THEN restart',
        principal: 'alice',
      });
      await waitForRunCompletion(bureauA, run.id);
      // A clean shutdown, not a crash — the run is genuinely, fully
      // terminal in the durable engine before bureau B ever boots, so
      // `recoverAll()` has nothing in-flight to surface for this run and
      // `reattachRecoveredRun` never runs for it.
      await bureauA.dispose();

      const bureauB = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
      });

      try {
        // Never reattached: getRun confirms bureau B has no live handle for
        // it at all, proving this read does not ride reattachRecoveredRun.
        expect(bureauB.getRun(run.id)).toBeUndefined();

        const asOwner = await bureauB.eventHistory(
          { kind: 'run', id: run.id },
          { principal: 'alice' },
        );
        if ('outcome' in asOwner) {
          throw new Error(
            `expected a page for the owning principal, got ${JSON.stringify(asOwner)}`,
          );
        }
        expect(asOwner.events.map((event) => event.kind)).toContain('run.completed');

        const asStranger = await bureauB.eventHistory(
          { kind: 'run', id: run.id },
          { principal: 'mallory' },
        );
        expect(asStranger).toEqual({ outcome: 'not-found' });
      } finally {
        await bureauB.shutdown();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('a run dispatched WITHOUT a principal stays denied to any principal after recovery, and readable to a trusted caller that omits one', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-owner-recovery-open-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

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

    try {
      // No `principal` — matches AB-313's "genuinely unattributed" case.
      const run = await bureauA.createRun({ message: 'No principal, then restart' });
      await pollUntil(() => bureauAReachedStep1);
      expect(bureauAReachedStep1).toBe(true);

      const bureauB = await createBureau({
        agents: {},
        generate: async ({ step }) => ({ content: `B recovered step ${step}`, toolCalls: [] }),
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        await waitForRunCompletion(bureauB, run.id);

        // No entry is written at all for an unattributed run — never a
        // present-but-empty/undefined value — matching `runAttribution.set`'s
        // own conditional-write behavior at dispatch time.
        const recoveredSession = await bureauB.getSession(run.sessionId);
        expect(recoveredSession?.metadata['lastRunOwningPrincipals']).toBeUndefined();

        const withPrincipal = await bureauB.eventHistory(
          { kind: 'run', id: run.id },
          { principal: 'anyone' },
        );
        expect(withPrincipal).toEqual({ outcome: 'not-found' });

        const trusted = await bureauB.eventHistory({ kind: 'run', id: run.id });
        if ('outcome' in trusted) {
          throw new Error(`expected a page for a trusted caller, got ${JSON.stringify(trusted)}`);
        }
        expect(trusted.events.map((event) => event.kind)).toContain('run.completed');
      } finally {
        bureauB.dispose();
      }
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('records TWO concurrent runs on the same session as separate entries, keyed by their own runId, without either clobbering the other (AB-285-style union-merge)', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-owner-recovery-union-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
      });

      const sessionId = 'shared-session';
      const runOne = await bureau.createRun({
        message: 'First, as alice',
        sessionId,
        principal: 'alice',
      });
      await waitForRunCompletion(bureau, runOne.id);

      const runTwo = await bureau.createRun({
        message: 'Second, as bob',
        sessionId,
        principal: 'bob',
      });
      await waitForRunCompletion(bureau, runTwo.id);

      const session = await bureau.getSession(sessionId);
      expect(session?.metadata['lastRunOwningPrincipals']).toEqual({
        [runOne.id]: 'alice',
        [runTwo.id]: 'bob',
      });

      const asAliceOnRunOne = await bureau.eventHistory(
        { kind: 'run', id: runOne.id },
        { principal: 'alice' },
      );
      if ('outcome' in asAliceOnRunOne) throw new Error('expected a page for alice on run one');
      const asBobOnRunTwo = await bureau.eventHistory(
        { kind: 'run', id: runTwo.id },
        { principal: 'bob' },
      );
      if ('outcome' in asBobOnRunTwo) throw new Error('expected a page for bob on run two');

      // Neither principal is authorized against the OTHER run.
      const asAliceOnRunTwo = await bureau.eventHistory(
        { kind: 'run', id: runTwo.id },
        { principal: 'alice' },
      );
      expect(asAliceOnRunTwo).toEqual({ outcome: 'not-found' });
      const asBobOnRunOne = await bureau.eventHistory(
        { kind: 'run', id: runOne.id },
        { principal: 'bob' },
      );
      expect(asBobOnRunOne).toEqual({ outcome: 'not-found' });

      await bureau.shutdown();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });
});

describe('bureau.runDurableMaintenance prunes stale run ownership (AB-363)', () => {
  it("drops a session's lastRunOwningPrincipals entry once its run's entire durable history — including a later deleteRun()'s own run.removed — is below the retention floor, leaves a still-retained run's entry alone, and the pruned run's history now reads back as a gap", async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-run-ownership-prune-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
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

      try {
        const runA = await bureau.createRun({ message: 'A', principal: 'alice' });
        await waitForRunCompletion(bureau, runA.id);

        const beforeA = await bureau.getSession(runA.sessionId);
        expect(beforeA?.metadata['lastRunOwningPrincipals']).toEqual({ [runA.id]: 'alice' });

        // Delete run A — the run store no longer holds it once this
        // resolves, closing the window a still-in-store completed run
        // would otherwise leave open (Codex review, PR #568, "Preserve
        // ownership for a later run removal event"): `deleteRun()` can
        // always be called on ANY run still present in the store, and it
        // records a brand-new, retained `run.removed` durable event under
        // that SAME owner. `runtime.deferred.drain()` settles the
        // fire-and-forget `history.record()` write `run.removed` starts
        // synchronously off `deleteRun()`'s own dispatch, so run A's own
        // durable history is fully landed — this event included — before
        // anything below advances the floor past it.
        await bureau.deleteRun(runA.id);
        await runtime.deferred.drain();

        // Run B is created and completed AFTER run A's deletion has fully
        // landed, so every one of run B's durable events sorts at a
        // strictly higher sequence than run A's last one (`run.removed`) —
        // the retention floor computed below from run A's own history can
        // then advance past all of run A without touching any of run B's.
        const runB = await bureau.createRun({ message: 'B', principal: 'bob' });
        await waitForRunCompletion(bureau, runB.id);

        const beforeB = await bureau.getSession(runB.sessionId);
        expect(beforeB?.metadata['lastRunOwningPrincipals']).toEqual({ [runB.id]: 'bob' });

        // Advance the retention floor past every one of run A's durable
        // events (there may be more than one durable owner row for run A —
        // e.g. its owning session's own durable lifecycle rows land at
        // lower sequences too, and its deletion added `run.removed` on
        // top — so the floor is derived from run A's own highest recorded
        // sequence, not assumed) but strictly before any of run B's. A
        // second storage handle opened over the SAME sqlite file while
        // bureau's own handle stays open — the identical multi-consumer
        // pattern the AB-359 recovery tests already rely on for two
        // independently constructed bureaus sharing one path. Omitting
        // `principal` reads the deleted-aggregate outcome as the internal/
        // trusted caller this maintenance-adjacent assertion is — the
        // in-memory `runAttribution` entry `deleteRun()` clears would fail
        // an authenticated `alice` lookup closed instead (AB-313).
        const runADeletedOutcome = await bureau.eventHistory({ kind: 'run', id: runA.id });
        if (
          !('outcome' in runADeletedOutcome) ||
          runADeletedOutcome.outcome !== 'deleted-aggregate'
        ) {
          throw new Error(
            `expected a deleted-aggregate outcome for run A, got ${JSON.stringify(runADeletedOutcome)}`,
          );
        }
        const lastEventForA = runADeletedOutcome.events.at(-1);
        if (!lastEventForA) throw new Error('expected at least one durable event for run A');
        expect(lastEventForA.kind).toBe('run.removed');

        const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
        const adminFeed = createFleetEventFeed(adminStorage);
        await adminFeed.retain({ beforeSequence: lastEventForA.sequence + 1 });
        adminFeed.dispose();
        adminStorage[Symbol.dispose]();

        await bureau.runDurableMaintenance();

        const afterA = await bureau.getSession(runA.sessionId);
        const afterB = await bureau.getSession(runB.sessionId);
        // No key at all — not a present-but-empty map — matching the
        // "never attributed" shape AB-359's own tests assert on.
        expect(afterA?.metadata['lastRunOwningPrincipals']).toBeUndefined();
        expect(afterB?.metadata['lastRunOwningPrincipals']).toEqual({ [runB.id]: 'bob' });

        // A cursorless read always reports a gap once the floor has
        // advanced past the beginning at all — true for EVERY owner, not
        // only a pruned one (see `page() retention-floor gap` in
        // `durable-event-history.test.ts`) — so this only confirms run A
        // is no more readable than before; it is not, by itself, proof
        // that pruning was scoped correctly. `afterA`/`afterB` above are.
        const runAHistory = await bureau.eventHistory({ kind: 'run', id: runA.id });
        expect(runAHistory).toMatchObject({ outcome: 'gap' });

        // Run B is unaffected: still owner-authorized, and its own event —
        // genuinely retained, just past the floor boundary — is readable
        // from a cursor at that boundary (`lastEventForA.cursor`, exactly
        // where the retained window now starts).
        const asBob = await bureau.eventHistory(
          { kind: 'run', id: runB.id },
          { principal: 'bob', since: lastEventForA.cursor },
        );
        if ('outcome' in asBob) throw new Error('expected a page for bob on run B');
        expect(asBob.events.map((event) => event.kind)).toContain('run.completed');
      } finally {
        await bureau.shutdown();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it("never prunes a still-running run's ownership entry, even when the fleet feed has no retained event for it yet (the dispatch-vs-event-production race)", async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-run-ownership-prune-parked-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    let parkedRunReachedStep1 = false;
    let generateCalls = 0;
    const bureau = await createBureau({
      agents: {},
      // The FIRST dispatched run (`completedRun` below) completes in one
      // step (no tool calls, so `stopWhen.noToolCalls()` stops it there).
      // Every run dispatched after that (`parkedRun`) takes a tool call on
      // step 0 to keep going, then parks forever on step 1 — the same
      // "reaches step 1, then a never-resolving promise" pattern the
      // AB-359 crash-simulation tests use, never a real sleep.
      generate: async ({ step }) => {
        if (step === 0) {
          generateCalls += 1;
          if (generateCalls === 1) return { content: 'Completed', toolCalls: [] };
          return { content: 'parked step 0', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        parkedRunReachedStep1 = true;
        return new Promise<never>(() => {}); // parks forever — never a real sleep
      },
      toolbox: createToolbox([createNextTool()]),
      storage: { type: 'sqlite', path: databasePath },
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      // A completed run whose durable event(s) will be retired, to give
      // `retainedRunOwnerIds()` a floor above 0.
      const completedRun = await bureau.createRun({ message: 'Completed', principal: 'alice' });
      await waitForRunCompletion(bureau, completedRun.id);

      const completedPage = await bureau.eventHistory({ kind: 'run', id: completedRun.id });
      if ('outcome' in completedPage) throw new Error('expected a page for the completed run');
      const lastSequenceForCompleted = Math.max(
        ...completedPage.events.map((event) => event.sequence),
      );

      // A run still in flight — its ownership entry is written at
      // dispatch time, but it has produced no durable event yet.
      const parkedRun = await bureau.createRun({
        message: 'Still running',
        principal: 'carol',
      });
      await pollUntil(() => parkedRunReachedStep1);
      expect(parkedRunReachedStep1).toBe(true);

      const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
      const adminFeed = createFleetEventFeed(adminStorage);
      await adminFeed.retain({ beforeSequence: lastSequenceForCompleted + 1 });
      adminFeed.dispose();
      adminStorage[Symbol.dispose]();

      await bureau.runDurableMaintenance();

      const parkedSession = await bureau.getSession(parkedRun.sessionId);
      expect(parkedSession?.metadata['lastRunOwningPrincipals']).toEqual({
        [parkedRun.id]: 'carol',
      });

      // `completedRun` is below the floor and has no live authority or
      // active write — every OTHER exclusion signal has already fallen
      // away — but it was never deleted, so it is STILL present in the
      // run store, and `deleteRun()` therefore remains callable on it at
      // any future point (Codex review, PR #568, "Preserve ownership for
      // a later run removal event"). Its entry survives on that signal
      // alone.
      const completedSession = await bureau.getSession(completedRun.sessionId);
      expect(completedSession?.metadata['lastRunOwningPrincipals']).toEqual({
        [completedRun.id]: 'alice',
      });
    } finally {
      // `dispose()` uses the 'abort' shutdown policy (unlike a graceful
      // `shutdown()`, which would wait forever for the parked run to
      // settle on its own) — same cleanup shape the AB-359
      // crash-simulation tests use once their own scenario is done, so no
      // background maintenance timer outlives this test and later trips
      // over the sqlite file this `finally` is about to delete.
      await bureau.dispose();
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('is a no-op over ephemeral storage, where no durable event history store is composed at all', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate('Done.'),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });

    try {
      const run = await bureau.createRun({ message: 'Ephemeral', principal: 'alice' });
      await waitForRunCompletion(bureau, run.id);

      const result = await bureau.runDurableMaintenance();
      expect(result).toBe(true);

      const session = await bureau.getSession(run.sessionId);
      expect(session?.metadata['lastRunOwningPrincipals']).toEqual({ [run.id]: 'alice' });
    } finally {
      await bureau.shutdown();
    }
  });

  it('excludes a run still named in lastRequestAuthorities from pruning — live or awaiting a pending-approval decision, either way a future durable write can still arrive (Codex review, PR #568)', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-run-ownership-prune-live-authority-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
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

      try {
        const completedRun = await bureau.createRun({ message: 'Completed', principal: 'alice' });
        await waitForRunCompletion(bureau, completedRun.id);

        // Delete `completedRun` — otherwise it would survive pruning
        // itself purely by still being present in the run store (the
        // "Preserve ownership for a later run removal event" exclusion,
        // Codex review PR #568), which would leave this test unable to
        // distinguish that from the `lastRequestAuthorities` exclusion it
        // actually means to cover. `runtime.deferred.drain()` settles the
        // `run.removed` write `deleteRun()` starts synchronously.
        await bureau.deleteRun(completedRun.id);
        await runtime.deferred.drain();

        const completedOutcome = await bureau.eventHistory({ kind: 'run', id: completedRun.id });
        if (!('outcome' in completedOutcome) || completedOutcome.outcome !== 'deleted-aggregate') {
          throw new Error(
            `expected a deleted-aggregate outcome for the completed run, got ${JSON.stringify(completedOutcome)}`,
          );
        }
        const lastEvent = completedOutcome.events.at(-1);
        if (!lastEvent) throw new Error('expected at least one durable event');
        expect(lastEvent.kind).toBe('run.removed');

        // Fabricate a SECOND run's entries on the SAME session: an
        // ownership entry (a candidate once retention advances) whose
        // `lastRequestAuthorities` entry is still present — a shape only a
        // still-live run or a terminal-but-pending-approval run can have.
        // Sharing `completedRun`'s session puts both entries through the
        // same pruning pass.
        const sessionStore = bureau.sessionStore;
        if (!sessionStore) throw new Error('expected a configured session store');
        await sessionStore.update(completedRun.sessionId, (session) => {
          if (!session) return undefined;
          const currentOwners = session.metadata['lastRunOwningPrincipals'];
          const currentAuthorities = session.metadata['lastRequestAuthorities'];
          return {
            ...session,
            metadata: {
              ...session.metadata,
              lastRunOwningPrincipals: {
                ...(currentOwners as Record<string, string> | undefined),
                'pending-run-id': 'mallory',
              },
              lastRequestAuthorities: {
                ...(currentAuthorities as Record<string, unknown> | undefined),
                'pending-run-id': { agentId: 'bureau', principalId: 'mallory' },
              },
            },
          };
        });

        const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
        const adminFeed = createFleetEventFeed(adminStorage);
        await adminFeed.retain({ beforeSequence: lastEvent.sequence + 1 });
        adminFeed.dispose();
        adminStorage[Symbol.dispose]();

        await bureau.runDurableMaintenance();

        const session = await bureau.getSession(completedRun.sessionId);
        // `completedRun`'s own entry is gone (its own terminal transition
        // already removed it from `lastRequestAuthorities`, it is deleted
        // — so no future `deleteRun()` can protect it via the run store —
        // and its full history, `run.removed` included, fell below the
        // floor) — but the fabricated one survives: still named in
        // `lastRequestAuthorities`, so it is excluded from pruning
        // regardless of the retained-owner set.
        expect(session?.metadata['lastRunOwningPrincipals']).toEqual({
          'pending-run-id': 'mallory',
        });
      } finally {
        await bureau.shutdown();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('skips pruning an entire session, not just one run, when its lastRequestAuthorities value is present but malformed (Codex review, PR #568, "Preserve owners when the authority map is malformed")', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-run-ownership-prune-malformed-authorities-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
      });

      try {
        const completedRun = await bureau.createRun({ message: 'Completed', principal: 'alice' });
        await waitForRunCompletion(bureau, completedRun.id);

        const completedPage = await bureau.eventHistory({ kind: 'run', id: completedRun.id });
        if ('outcome' in completedPage) throw new Error('expected a page for the completed run');
        const lastEvent = completedPage.events.at(-1);
        if (!lastEvent) throw new Error('expected at least one durable event');

        // Corrupt `lastRequestAuthorities` into a non-record shape — a
        // scalar, exactly the "present but malformed" shape
        // `lookupSessionAuthority` already distinguishes from absence
        // elsewhere in this module — while the run's own ownership entry
        // is still a normal candidate once retention advances.
        const sessionStore = bureau.sessionStore;
        if (!sessionStore) throw new Error('expected a configured session store');
        await sessionStore.update(completedRun.sessionId, (session) => {
          if (!session) return undefined;
          return {
            ...session,
            metadata: {
              ...session.metadata,
              lastRequestAuthorities: 'not-a-record',
            },
          };
        });

        const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
        const adminFeed = createFleetEventFeed(adminStorage);
        await adminFeed.retain({ beforeSequence: lastEvent.sequence + 1 });
        adminFeed.dispose();
        adminStorage[Symbol.dispose]();

        await bureau.runDurableMaintenance();

        const session = await bureau.getSession(completedRun.sessionId);
        // The malformed map fails the WHOLE session closed: the
        // otherwise-prunable ownership entry survives rather than being
        // deleted on the strength of a corrupted authority record.
        expect(session?.metadata['lastRunOwningPrincipals']).toEqual({
          [completedRun.id]: 'alice',
        });
      } finally {
        await bureau.shutdown();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('revalidates the retained-owner set immediately before deleting, not against the whole pass\'s initial snapshot (Codex review, PR #568, "Revalidate retained owners before pruning")', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-run-ownership-prune-revalidate-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
      });

      try {
        const run = await bureau.createRun({ message: 'A', principal: 'alice' });
        await waitForRunCompletion(bureau, run.id);

        const page = await bureau.eventHistory({ kind: 'run', id: run.id });
        if ('outcome' in page) throw new Error('expected a page for the run');
        const lastEvent = page.events.at(-1);
        if (!lastEvent) throw new Error('expected at least one durable event');

        // Retire the run's only durable event — a stale candidate per
        // whatever snapshot the maintenance pass takes BEFORE this point.
        const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
        const adminFeed = createFleetEventFeed(adminStorage);
        await adminFeed.retain({ beforeSequence: lastEvent.sequence + 1 });

        const sessionStore = bureau.sessionStore;
        if (!sessionStore) throw new Error('expected a configured session store');
        const originalUpdate = sessionStore.update.bind(sessionStore);
        // Simulates "a new durable event for this SAME run lands in the
        // feed after the pass's initial `retainedRunOwnerIds()` snapshot,
        // but before this session's write" — the exact staleness window
        // the review comment names — by appending directly to the shared
        // fleet feed the instant before the maintenance pass's own write
        // for this session executes.
        const updateSpy = spyOn(sessionStore, 'update').mockImplementationOnce(
          async (id: string, updater: Parameters<typeof originalUpdate>[1]) => {
            await adminFeed.append({
              kind: 'review.approved',
              workflowId: `run:${run.id}`,
              emittedAtMs: 0,
              payload: {},
            });
            return originalUpdate(id, updater);
          },
        );

        try {
          await bureau.runDurableMaintenance();
        } finally {
          updateSpy.mockRestore();
          adminFeed.dispose();
          adminStorage[Symbol.dispose]();
        }

        const session = await bureau.getSession(run.sessionId);
        // The run was a candidate per whatever snapshot the pass started
        // with — but a FRESH recheck immediately before the write sees the
        // newly-landed event and correctly treats the run as still
        // retained, so its ownership entry survives.
        expect(session?.metadata['lastRunOwningPrincipals']).toEqual({ [run.id]: 'alice' });
      } finally {
        await bureau.shutdown();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('preserves every ownership entry on a session whose lastRequestAuthorities is present but malformed, rather than treating it as absent (Codex/Copilot review, PR #568, "Preserve owners when the authority map is malformed")', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-run-ownership-prune-malformed-authorities-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
      });

      try {
        const run = await bureau.createRun({ message: 'A', principal: 'alice' });
        await waitForRunCompletion(bureau, run.id);

        const page = await bureau.eventHistory({ kind: 'run', id: run.id });
        if ('outcome' in page) throw new Error('expected a page for the run');
        const lastEvent = page.events.at(-1);
        if (!lastEvent) throw new Error('expected at least one durable event');

        // Corrupt `lastRequestAuthorities` to a non-record shape (a bare
        // string) — present, not absent, the same "recorded but corrupted"
        // shape `lookupSessionAuthority` fails closed on elsewhere in this
        // file. The run's own `lastRequestAuthorities` entry was already
        // cleared by its terminal transition, so nothing here recreates it
        // — this replaces the WHOLE map with a malformed value.
        const sessionStore = bureau.sessionStore;
        if (!sessionStore) throw new Error('expected a configured session store');
        await sessionStore.update(run.sessionId, (session) => {
          if (!session) return undefined;
          return {
            ...session,
            metadata: {
              ...session.metadata,
              lastRequestAuthorities: 'corrupt',
            },
          };
        });

        const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
        const adminFeed = createFleetEventFeed(adminStorage);
        await adminFeed.retain({ beforeSequence: lastEvent.sequence + 1 });
        adminFeed.dispose();
        adminStorage[Symbol.dispose]();

        await bureau.runDurableMaintenance();

        const session = await bureau.getSession(run.sessionId);
        // The run's history is below the floor and it has no active write —
        // by every OTHER signal it is a pruning candidate. A malformed
        // `lastRequestAuthorities` must still block the write for this
        // whole session, not just fail to protect this one run: the
        // ownership entry survives.
        expect(session?.metadata['lastRunOwningPrincipals']).toEqual({ [run.id]: 'alice' });
        expect(session?.metadata['lastRequestAuthorities']).toBe('corrupt');
      } finally {
        await bureau.shutdown();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('never refreshes a pruned session\'s updatedAt — a maintenance write is not activity (Codex review, PR #568, "Avoid refreshing session activity during retention pruning")', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-run-ownership-prune-no-activity-refresh-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
      });

      try {
        const run = await bureau.createRun({ message: 'A', principal: 'alice' });
        await waitForRunCompletion(bureau, run.id);

        const page = await bureau.eventHistory({ kind: 'run', id: run.id });
        if ('outcome' in page) throw new Error('expected a page for the run');
        const lastEvent = page.events.at(-1);
        if (!lastEvent) throw new Error('expected at least one durable event');

        // `store.getRun(runId) !== undefined` excludes a still-present run
        // from pruning (Codex review, "Preserve ownership for a later run
        // removal event") — delete it first so the ONLY remaining question
        // is whether the write that follows stamps a fresh `updatedAt`.
        await bureau.deleteRun(run.id);
        const deletedOutcome = await bureau.eventHistory(
          { kind: 'run', id: run.id },
          { since: lastEvent.cursor },
        );
        if (!('outcome' in deletedOutcome) || deletedOutcome.outcome !== 'deleted-aggregate') {
          throw new Error(
            `expected a deleted-aggregate outcome after deletion, got ${JSON.stringify(deletedOutcome)}`,
          );
        }
        const removalEvent = deletedOutcome.events.at(-1);
        if (!removalEvent) throw new Error('expected a run.removed durable event');

        const beforeMaintenance = await bureau.getSession(run.sessionId);
        const updatedAtBeforeMaintenance = beforeMaintenance?.updatedAt;
        if (!updatedAtBeforeMaintenance) throw new Error('expected a session with updatedAt');

        const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
        const adminFeed = createFleetEventFeed(adminStorage);
        await adminFeed.retain({ beforeSequence: removalEvent.sequence + 1 });
        adminFeed.dispose();
        adminStorage[Symbol.dispose]();

        await bureau.runDurableMaintenance();

        const afterMaintenance = await bureau.getSession(run.sessionId);
        // The ownership entry was actually pruned (same assertion the
        // main pruning test makes) — so this proves the write happened
        // AND did not stamp a fresh updatedAt, not merely that nothing
        // was written at all.
        expect(afterMaintenance?.metadata['lastRunOwningPrincipals']).toBeUndefined();
        expect(afterMaintenance?.updatedAt).toBe(updatedAtBeforeMaintenance);
      } finally {
        await bureau.shutdown();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('excludes a run still present in the in-memory run store from pruning — deleteRun() remains callable on it at any point, and would record a brand-new run.removed durable event with no owner left to protect it (Codex review, PR #568, "Preserve ownership for a later run removal event")', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-run-ownership-prune-still-in-store-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
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

      try {
        const run = await bureau.createRun({ message: 'A', principal: 'alice' });
        await waitForRunCompletion(bureau, run.id);

        const page = await bureau.eventHistory({ kind: 'run', id: run.id });
        if ('outcome' in page) throw new Error('expected a page for the run');
        const lastEventBeforeDeletion = page.events.at(-1);
        if (!lastEventBeforeDeletion) throw new Error('expected at least one durable event');

        const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
        const adminFeed = createFleetEventFeed(adminStorage);
        try {
          // First cycle: advance the floor past the run's own terminal
          // transition WITHOUT deleting it. Every other exclusion signal
          // is already gone (no live authority, no write in flight) — the
          // run store is the only thing standing between this run and
          // being pruned while `deleteRun()` remains callable on it.
          await adminFeed.retain({ beforeSequence: lastEventBeforeDeletion.sequence + 1 });
          await bureau.runDurableMaintenance();

          const stillInStore = await bureau.getSession(run.sessionId);
          expect(stillInStore?.metadata['lastRunOwningPrincipals']).toEqual({ [run.id]: 'alice' });

          // Delete the run — the run store no longer holds it, and the
          // deletion's own `run.removed` durable event lands (settled via
          // `runtime.deferred.drain()`, the fire-and-forget write
          // `deleteRun()`'s dispatch starts synchronously).
          await bureau.deleteRun(run.id);
          await runtime.deferred.drain();

          // A cursorless read always reports a gap once ANY retention has
          // ever happened, for every owner, not only a pruned one (see
          // the equivalent note earlier in this describe block) — reading
          // `since` the run's own last pre-deletion cursor instead scopes
          // this to exactly the one new event deletion added.
          const deletedOutcome = await bureau.eventHistory(
            { kind: 'run', id: run.id },
            { since: lastEventBeforeDeletion.cursor },
          );
          if (!('outcome' in deletedOutcome) || deletedOutcome.outcome !== 'deleted-aggregate') {
            throw new Error(
              `expected a deleted-aggregate outcome after deletion, got ${JSON.stringify(deletedOutcome)}`,
            );
          }
          const lastEventAfterDeletion = deletedOutcome.events.at(-1);
          if (!lastEventAfterDeletion) throw new Error('expected at least one durable event');
          expect(lastEventAfterDeletion.kind).toBe('run.removed');

          // Second cycle: advance the floor past `run.removed` too — now
          // the run's ENTIRE durable history, deletion included, is
          // unreadable, and it can never be deleted again (`deleteRun()`
          // throws NOT_FOUND once a run is gone from the store), so no
          // further durable write for it is possible. The entry is
          // finally prunable.
          await adminFeed.retain({ beforeSequence: lastEventAfterDeletion.sequence + 1 });
          await bureau.runDurableMaintenance();
        } finally {
          adminFeed.dispose();
          adminStorage[Symbol.dispose]();
        }

        const afterDeletionAndRetention = await bureau.getSession(run.sessionId);
        expect(afterDeletionAndRetention?.metadata['lastRunOwningPrincipals']).toBeUndefined();
      } finally {
        await bureau.shutdown();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('prunes stale run ownership on its own, on a timer, under the default automatic maintenance profile — never requiring an explicit runDurableMaintenance() call (Codex review, PR #568, "Run ownership pruning in the automatic maintenance profile")', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-run-ownership-prune-automatic-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
        // `durableBackgroundTasks` deliberately omitted — the default
        // 'automatic' profile is exactly what this test proves prunes on
        // its own.
      });

      try {
        const run = await bureau.createRun({ message: 'A', principal: 'alice' });
        await waitForRunCompletion(bureau, run.id);
        await runtime.deferred.drain();

        // `store.getRun(runId) !== undefined` excludes a still-present run
        // from pruning (Codex review, "Preserve ownership for a later run
        // removal event") — delete it first so this test isolates the
        // automatic timer, not that separate exclusion signal.
        const page = await bureau.eventHistory({ kind: 'run', id: run.id });
        if ('outcome' in page) throw new Error('expected a page for the run');
        const lastEventBeforeDeletion = page.events.at(-1);
        if (!lastEventBeforeDeletion) throw new Error('expected at least one durable event');
        await bureau.deleteRun(run.id);
        const deletedOutcome = await bureau.eventHistory(
          { kind: 'run', id: run.id },
          { since: lastEventBeforeDeletion.cursor },
        );
        if (!('outcome' in deletedOutcome) || deletedOutcome.outcome !== 'deleted-aggregate') {
          throw new Error(
            `expected a deleted-aggregate outcome after deletion, got ${JSON.stringify(deletedOutcome)}`,
          );
        }
        const lastEvent = deletedOutcome.events.at(-1);
        if (!lastEvent) throw new Error('expected a run.removed durable event');

        const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
        const adminFeed = createFleetEventFeed(adminStorage);
        await adminFeed.retain({ beforeSequence: lastEvent.sequence + 1 });
        adminFeed.dispose();
        adminStorage[Symbol.dispose]();

        const sessionBeforeAdvance = await bureau.getSession(run.sessionId);
        expect(sessionBeforeAdvance?.metadata['lastRunOwningPrincipals']).toEqual({
          [run.id]: 'alice',
        });

        // Advance past the automatic pruning timer's own interval —
        // `Bureau.runDurableMaintenance()` is never called anywhere in
        // this test. `runtime.advance()` only synchronously fires the due
        // timer callback and awaits one microtask tick per fired callback
        // — nowhere near enough for the pruning pass's own chained,
        // multi-step async storage work (list, then a read-modify-write
        // `sessionStore.update()`, then a fleet-feed replay), and
        // `runtime.deferred.drain()`'s bounded microtask-quiescence budget
        // gives up after one round with no progress rather than blocking
        // forever — so this polls with real (bounded, macrotask-yielding)
        // waits for the write to actually land, exactly like every other
        // async-background-work assertion in this file (`waitForCondition`).
        await runtime.advance(300_000);
        await waitForCondition(async () => {
          const session = await bureau.getSession(run.sessionId);
          return session?.metadata['lastRunOwningPrincipals'] === undefined;
        }, 'expected the automatic pruning timer to drop the ownership entry');

        const session = await bureau.getSession(run.sessionId);
        expect(session?.metadata['lastRunOwningPrincipals']).toBeUndefined();
      } finally {
        await bureau.shutdown();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('diagnoses, rather than throwing out of, a failed automatic pruning pass — a rejected sessionStore.list() must not crash the interval or the process', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-run-ownership-prune-automatic-failure-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();
    const diagnostics: string[] = [];

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      });

      try {
        const run = await bureau.createRun({ message: 'A', principal: 'alice' });
        await waitForRunCompletion(bureau, run.id);
        await runtime.deferred.drain();

        // The retention floor must be above 0, or `pruneStaleRunOwnership`
        // returns before ever calling `sessionStore.list()` — this test
        // needs that call reached, so it can inject the failure there.
        const page = await bureau.eventHistory({ kind: 'run', id: run.id });
        if ('outcome' in page) throw new Error('expected a page for the run');
        const lastEvent = page.events.at(-1);
        if (!lastEvent) throw new Error('expected at least one durable event');
        const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
        const adminFeed = createFleetEventFeed(adminStorage);
        await adminFeed.retain({ beforeSequence: lastEvent.sequence + 1 });
        adminFeed.dispose();
        adminStorage[Symbol.dispose]();

        const sessionStore = bureau.sessionStore;
        if (!sessionStore) throw new Error('expected a configured session store');
        const listSpy = spyOn(sessionStore, 'list').mockImplementationOnce(() => {
          throw new Error('injected sessionStore.list failure');
        });

        await runtime.advance(300_000);
        await waitForCondition(
          () =>
            diagnostics.some((message) =>
              message.includes('Automatic run-ownership pruning pass failed'),
            ),
          'expected a diagnostic for the failed automatic pruning pass',
        );

        listSpy.mockRestore();
        // The bureau itself is unaffected — a later run still dispatches
        // and completes normally, proving the failed pass was isolated
        // rather than having crashed anything shared.
        const laterRun = await bureau.createRun({ message: 'B', principal: 'bob' });
        await waitForRunCompletion(bureau, laterRun.id);
      } finally {
        await bureau.shutdown();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('skips a new automatic pruning pass while the prior one is still in flight, instead of overlapping them (Copilot review, PR #579)', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-run-ownership-prune-automatic-overlap-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
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

      try {
        const run = await bureau.createRun({ message: 'A', principal: 'alice' });
        await waitForRunCompletion(bureau, run.id);
        await runtime.deferred.drain();

        // `store.getRun(runId) !== undefined` excludes a still-present run
        // from pruning — delete it first so the released first pass
        // actually has something prunable to prove it completed.
        const page = await bureau.eventHistory({ kind: 'run', id: run.id });
        if ('outcome' in page) throw new Error('expected a page for the run');
        const lastEventBeforeDeletion = page.events.at(-1);
        if (!lastEventBeforeDeletion) throw new Error('expected at least one durable event');
        await bureau.deleteRun(run.id);
        const deletedOutcome = await bureau.eventHistory(
          { kind: 'run', id: run.id },
          { since: lastEventBeforeDeletion.cursor },
        );
        if (!('outcome' in deletedOutcome) || deletedOutcome.outcome !== 'deleted-aggregate') {
          throw new Error(
            `expected a deleted-aggregate outcome after deletion, got ${JSON.stringify(deletedOutcome)}`,
          );
        }
        const lastEvent = deletedOutcome.events.at(-1);
        if (!lastEvent) throw new Error('expected a run.removed durable event');

        const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
        const adminFeed = createFleetEventFeed(adminStorage);
        await adminFeed.retain({ beforeSequence: lastEvent.sequence + 1 });
        adminFeed.dispose();
        adminStorage[Symbol.dispose]();

        // Blocks the FIRST pruning pass's `sessionStore.list()` call
        // indefinitely — it never resolves until `releaseFirstPass()` is
        // called — so the pass stays "in flight" across a second timer
        // tick, without a real sleep.
        let releaseFirstPass!: () => void;
        const firstPassGate = new Promise<void>((resolve) => {
          releaseFirstPass = resolve;
        });
        const sessionStore = bureau.sessionStore;
        if (!sessionStore) throw new Error('expected a configured session store');
        const originalList = sessionStore.list.bind(sessionStore);
        let listCallCount = 0;
        const listSpy = spyOn(sessionStore, 'list').mockImplementation(async (...args) => {
          listCallCount += 1;
          if (listCallCount === 1) await firstPassGate;
          return originalList(...args);
        });

        // First tick starts a pass that blocks on `list()`.
        await runtime.advance(300_000);
        await waitForCondition(() => listCallCount >= 1, 'expected the first pass to call list()');

        // Second tick fires while the first pass is still in flight — the
        // in-flight guard must skip starting a second pass entirely,
        // so `list()` is not called again yet.
        await runtime.advance(300_000);
        expect(listCallCount).toBe(1);

        // Release the first pass; it completes normally.
        releaseFirstPass();
        await waitForCondition(async () => {
          const session = await bureau.getSession(run.sessionId);
          return session?.metadata['lastRunOwningPrincipals'] === undefined;
        }, 'expected the first pass to finish pruning once released');

        // A THIRD tick, now that no pass is in flight, calls list() again —
        // proving the guard skips only while genuinely overlapping, not
        // forever.
        await runtime.advance(300_000);
        await waitForCondition(
          () => listCallCount >= 2,
          'expected a later tick, once the guard clears, to call list() again',
        );

        listSpy.mockRestore();
      } finally {
        await bureau.shutdown();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('waits for an in-flight automatic pruning pass to finish before shutdown disposes the event history and storage (Codex review, PR #579, "Await running pruning passes before backend teardown")', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-run-ownership-prune-automatic-shutdown-race-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate('Done.'),
      toolbox: createEmptyToolbox(),
      storage: { type: 'sqlite', path: databasePath },
      runtime,
    });

    try {
      const run = await bureau.createRun({ message: 'A', principal: 'alice' });
      await waitForRunCompletion(bureau, run.id);
      await runtime.deferred.drain();

      const page = await bureau.eventHistory({ kind: 'run', id: run.id });
      if ('outcome' in page) throw new Error('expected a page for the run');
      const lastEventBeforeDeletion = page.events.at(-1);
      if (!lastEventBeforeDeletion) throw new Error('expected at least one durable event');
      await bureau.deleteRun(run.id);
      const deletedOutcome = await bureau.eventHistory(
        { kind: 'run', id: run.id },
        { since: lastEventBeforeDeletion.cursor },
      );
      if (!('outcome' in deletedOutcome) || deletedOutcome.outcome !== 'deleted-aggregate') {
        throw new Error(
          `expected a deleted-aggregate outcome after deletion, got ${JSON.stringify(deletedOutcome)}`,
        );
      }
      const lastEvent = deletedOutcome.events.at(-1);
      if (!lastEvent) throw new Error('expected a run.removed durable event');

      const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
      const adminFeed = createFleetEventFeed(adminStorage);
      await adminFeed.retain({ beforeSequence: lastEvent.sequence + 1 });
      adminFeed.dispose();
      adminStorage[Symbol.dispose]();

      // Blocks the pruning pass mid-flight, inside its own
      // `sessionStore.update()` callback — deliberately AFTER the
      // candidate check but before the write actually lands — so
      // `bureau.shutdown()` is called while a real write is genuinely
      // still in progress, not merely queued.
      let releasePass!: () => void;
      const passGate = new Promise<void>((resolve) => {
        releasePass = resolve;
      });
      const sessionStore = bureau.sessionStore;
      if (!sessionStore) throw new Error('expected a configured session store');
      const originalUpdate = sessionStore.update.bind(sessionStore);
      const updateSpy = spyOn(sessionStore, 'update').mockImplementationOnce(
        async (id: string, updater: Parameters<typeof originalUpdate>[1], opts) => {
          await passGate;
          return originalUpdate(id, updater, opts);
        },
      );

      await runtime.advance(300_000);
      await waitForCondition(
        () => updateSpy.mock.calls.length >= 1,
        'expected the pass to reach sessionStore.update()',
      );

      // Start shutdown WHILE the pass is blocked inside `update()`, then
      // release the pass a macrotask later — if shutdown disposed
      // `eventHistoryInstance`/storage before awaiting this pass, the
      // pass's own write (or the shutdown's later teardown) would throw
      // once released, and `shutdownPromise` would reject instead of
      // resolving cleanly.
      const shutdownPromise = bureau.shutdown();
      let shutdownSettled = false;
      void shutdownPromise.then(() => {
        shutdownSettled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);

      releasePass();
      updateSpy.mockRestore();
      await shutdownPromise;

      // Read back through a FRESH store instance (bureau's own storage is
      // disposed post-shutdown) — the write the pass was blocked inside of
      // actually completed, proving shutdown genuinely waited for it
      // rather than disposing around it.
      const verifyStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
      const verifySessionStore = createSessionStore(
        textValueStore(verifyStorage, { disposeUnderlyingStorage: false }),
      );
      const session = await verifySessionStore.load(run.sessionId);
      expect(session?.metadata['lastRunOwningPrincipals']).toBeUndefined();
      verifyStorage[Symbol.dispose]();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('never starts the automatic pruning timer under durableBackgroundTasks: "manual" — a manual host drives pruning only through its own runDurableMaintenance() calls', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-run-ownership-prune-manual-profile-${process.pid}-${recoveryDatabaseCounter++}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    try {
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate('Done.'),
        toolbox: createEmptyToolbox(),
        storage: { type: 'sqlite', path: databasePath },
        runtime,
        durableBackgroundTasks: 'manual',
      });

      try {
        const run = await bureau.createRun({ message: 'A', principal: 'alice' });
        await waitForRunCompletion(bureau, run.id);
        await runtime.deferred.drain();

        // `store.getRun(runId) !== undefined` excludes a still-present run
        // from pruning (Codex review, "Preserve ownership for a later run
        // removal event") — delete it first so this test's later explicit
        // `runDurableMaintenance()` call can actually prune it.
        const page = await bureau.eventHistory({ kind: 'run', id: run.id });
        if ('outcome' in page) throw new Error('expected a page for the run');
        const lastEventBeforeDeletion = page.events.at(-1);
        if (!lastEventBeforeDeletion) throw new Error('expected at least one durable event');
        await bureau.deleteRun(run.id);
        const deletedOutcome = await bureau.eventHistory(
          { kind: 'run', id: run.id },
          { since: lastEventBeforeDeletion.cursor },
        );
        if (!('outcome' in deletedOutcome) || deletedOutcome.outcome !== 'deleted-aggregate') {
          throw new Error(
            `expected a deleted-aggregate outcome after deletion, got ${JSON.stringify(deletedOutcome)}`,
          );
        }
        const lastEvent = deletedOutcome.events.at(-1);
        if (!lastEvent) throw new Error('expected a run.removed durable event');

        const adminStorage = await resolveStorage({ type: 'sqlite', path: databasePath });
        const adminFeed = createFleetEventFeed(adminStorage);
        await adminFeed.retain({ beforeSequence: lastEvent.sequence + 1 });
        adminFeed.dispose();
        adminStorage[Symbol.dispose]();

        // Advance far past the automatic profile's own interval — a manual
        // profile started no such timer at all, so this must not prune.
        await runtime.advance(600_000);
        await runtime.deferred.drain();

        const session = await bureau.getSession(run.sessionId);
        expect(session?.metadata['lastRunOwningPrincipals']).toEqual({ [run.id]: 'alice' });

        // The manual host's own explicit call still prunes, proving the
        // ownership entry really was prunable — the timer's absence, not
        // an unrelated reason, is why it survived above.
        await bureau.runDurableMaintenance();
        const sessionAfterExplicitMaintenance = await bureau.getSession(run.sessionId);
        expect(
          sessionAfterExplicitMaintenance?.metadata['lastRunOwningPrincipals'],
        ).toBeUndefined();
      } finally {
        await bureau.shutdown();
      }
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

describe('Bureau.issueGrant / revokeGrant / listGrants (AB-46, AB-346)', () => {
  it('issueGrant delegates to the base toolbox and returns a signed grant', async () => {
    const toolbox = createToolbox([], { approvalSecret: 'grant-secret' });
    const bureau = await createBureau({ agents: {}, toolbox });

    try {
      const grant = await bureau.issueGrant({
        principalId: 'principal-1',
        tenantId: 'tenant-1',
        ownerId: 'owner-1',
        agentId: 'agent-1',
        toolName: 'read-file',
        scope: 'session',
        sessionId: 'session-1',
        expiresAt: Number.MAX_SAFE_INTEGER,
        maxUses: 3,
        delegationBehavior: 'does-not-propagate',
      });

      expect(grant.id).toMatch(/^grant:/);
      expect(grant.usesRemaining).toBe(3);
      expect(await toolbox.listGrants()).toEqual([grant]);
    } finally {
      await bureau.dispose();
    }
  });

  it('revokeGrant delegates to the base toolbox and is idempotent', async () => {
    const toolbox = createToolbox([], { approvalSecret: 'grant-secret' });
    const bureau = await createBureau({ agents: {}, toolbox });

    try {
      const grant = await bureau.issueGrant({
        principalId: 'principal-1',
        tenantId: 'tenant-1',
        ownerId: 'owner-1',
        agentId: 'agent-1',
        toolName: 'read-file',
        scope: 'session',
        sessionId: 'session-1',
        expiresAt: Number.MAX_SAFE_INTEGER,
        maxUses: 1,
        delegationBehavior: 'does-not-propagate',
      });

      await bureau.revokeGrant(grant.id);
      await bureau.revokeGrant(grant.id);
      await bureau.revokeGrant('unknown-grant-id');

      const [stored] = await toolbox.listGrants();
      expect(stored?.revoked).toBe(true);
    } finally {
      await bureau.dispose();
    }
  });

  it('listGrants delegates to the base toolbox with an optional filter', async () => {
    const toolbox = createToolbox([], { approvalSecret: 'grant-secret' });
    const bureau = await createBureau({ agents: {}, toolbox });

    try {
      const matching = await bureau.issueGrant({
        principalId: 'principal-a',
        tenantId: 'tenant-1',
        ownerId: 'owner-1',
        agentId: 'agent-1',
        toolName: 'read-file',
        scope: 'session',
        sessionId: 'session-1',
        expiresAt: Number.MAX_SAFE_INTEGER,
        maxUses: 1,
        delegationBehavior: 'does-not-propagate',
      });
      await bureau.issueGrant({
        principalId: 'principal-b',
        tenantId: 'tenant-1',
        ownerId: 'owner-1',
        agentId: 'agent-1',
        toolName: 'read-file',
        scope: 'session',
        sessionId: 'session-1',
        expiresAt: Number.MAX_SAFE_INTEGER,
        maxUses: 1,
        delegationBehavior: 'does-not-propagate',
      });

      expect(await bureau.listGrants({ principalId: 'principal-a' })).toEqual([matching]);
      expect(await bureau.listGrants()).toHaveLength(2);
    } finally {
      await bureau.dispose();
    }
  });

  it('propagates the toolbox error when no approvalSecret is configured', async () => {
    const toolbox = createToolbox([]);
    const bureau = await createBureau({ agents: {}, toolbox });

    try {
      expect(
        bureau.issueGrant({
          principalId: 'principal-1',
          tenantId: 'tenant-1',
          ownerId: 'owner-1',
          agentId: 'agent-1',
          toolName: 'read-file',
          scope: 'session',
          expiresAt: Number.MAX_SAFE_INTEGER,
          maxUses: 1,
          delegationBehavior: 'does-not-propagate',
        }),
      ).rejects.toThrow('approvalSecret is required');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('createBureau durable audit trail — AB-228 parity gaps (toolbox loop-detection, schedule-definition lifecycle, and session deletion)', () => {
  it('durably records a real toolbox loop-warning/loop-blocked through the SAME production wiring a run uses, under the toolbox-prefixed type', async () => {
    // Mirrors `packages/operative/test/event-forwarding.test.ts`'s own
    // loop-detection scenario (identical thresholds, identical repeated
    // no-argument tool call) — but exercised through a REAL `createBureau`
    // with persistence configured, so this proves the full production path
    // (armorer's toolbox -> `forwardEvents`'s `toolbox.` prefix -> the
    // operative store's Action log -> the bureau's `'action'` stream ->
    // `createAuditTrail`'s listener) actually reaches
    // `bureau.auditTrail.query()`, not just a unit-level stub dispatch.
    const nextTool = createTool({
      name: 'next',
      description: 'continue',
      input: z.object({}),
      execute: async () => 'ok',
    });
    const toolbox = createToolbox([nextTool], {
      loopDetection: { warningThreshold: 2, blockThreshold: 4, maxWindowSize: 30 },
    });

    const LOOPING_STEPS = 6;
    const bureau = await createBureau({
      agents: {},
      // Step-counting, not a canned response list (matches the pattern this
      // file already uses for tool-driving generate functions) — calls the
      // same no-argument `next` tool repeatedly, tripping the loop detector's
      // warning threshold (2) and then its block threshold (4), before
      // finishing with a plain text response.
      generate: async ({ step }: { step: number }) =>
        step < LOOPING_STEPS
          ? { content: '', toolCalls: [{ name: 'next', arguments: {} }] }
          : { content: 'Done.', toolCalls: [] },
      toolbox,
      stopWhen: stopWhen.noToolCalls(),
      persistence: textValueStore(new MemoryStorage()),
    });

    try {
      const run = await bureau.createRun({ message: 'Loop the tool' });
      await waitForRunCompletion(bureau, run.id);

      const warningRecords = await bureau.auditTrail!.query({
        runId: run.id,
        type: 'toolbox.loop-warning',
      });
      expect(warningRecords.length).toBeGreaterThan(0);
      // Pins the store's `originalEvent` flattening (`store.ts`'s
      // `register()`): a nested Event's own OBJECT properties (`tool`,
      // `call` — the full `Tool`/`ToolCall`, potentially carrying tool
      // arguments) are dropped, only its primitive properties survive. This
      // is the exact mechanism AB-228's own rollback trigger names ("a
      // newly durable event type is found to write unredacted privileged
      // content") — if a future change to that flattening ever let `tool`/
      // `call` through, this assertion is what catches it.
      const warningDetail = warningRecords[0]?.detail as {
        originalEvent?: Record<string, unknown>;
      };
      expect(warningDetail.originalEvent).toMatchObject({
        type: 'loop-warning',
        detector: 'simple-repeat',
        count: expect.any(Number),
        message: expect.any(String),
      });
      expect(warningDetail.originalEvent).not.toHaveProperty('tool');
      expect(warningDetail.originalEvent).not.toHaveProperty('call');

      const blockedRecords = await bureau.auditTrail!.query({
        runId: run.id,
        type: 'toolbox.loop-blocked',
      });
      expect(blockedRecords.length).toBeGreaterThan(0);
      const blockedDetail = blockedRecords[0]?.detail as {
        originalEvent?: Record<string, unknown>;
      };
      expect(blockedDetail.originalEvent).toMatchObject({
        type: 'loop-blocked',
        detector: 'simple-repeat',
        count: expect.any(Number),
        message: expect.any(String),
      });
      expect(blockedDetail.originalEvent).not.toHaveProperty('tool');
      expect(blockedDetail.originalEvent).not.toHaveProperty('call');

      // Confirm the bare, un-prefixed armorer name never appears — proves
      // the trail is keyed on the ACTUAL wire string, not the name AB-87's
      // prose used.
      expect(await bureau.auditTrail!.query({ runId: run.id, type: 'loop-warning' })).toEqual([]);
      expect(await bureau.auditTrail!.query({ runId: run.id, type: 'loop-blocked' })).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it('durably records a real toolbox.budget-exceeded through the SAME production wiring a run uses, under the toolbox-prefixed type (Codex P2 review finding, PR #566)', async () => {
    // The bare `budget.exceeded` entry only covers the orphaned
    // `BudgetExceededEvent` class (see `audit-trail.ts`'s own doc comment):
    // it never matches this REAL production path, where the toolbox's own
    // `checkBudget` rejection emits `'budget-exceeded'`, forwarded with the
    // `toolbox.` prefix the same way `loop-warning`/`loop-blocked` are.
    // Mirrors `packages/operative/test/event-forwarding.test.ts`'s own
    // `budget: { maxCalls: 1 }` scenario, but through a real `createBureau`.
    const weatherTool = createTool({
      name: 'weather',
      description: 'look up the weather',
      input: z.object({ city: z.string() }),
      execute: async () => 'sunny',
    });
    const toolbox = createToolbox([weatherTool], { budget: { maxCalls: 1 } });

    const bureau = await createBureau({
      agents: {},
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-budget-1', name: 'weather', arguments: { city: 'Denver' } }],
        },
        {
          content: '',
          toolCalls: [{ id: 'call-budget-2', name: 'weather', arguments: { city: 'Boulder' } }],
        },
        { content: 'Done.', toolCalls: [] },
      ]),
      toolbox,
      stopWhen: stopWhen.noToolCalls(),
      persistence: textValueStore(new MemoryStorage()),
    });

    try {
      const run = await bureau.createRun({ message: 'Check the weather twice' });
      await waitForRunCompletion(bureau, run.id);

      const exceededRecords = await bureau.auditTrail!.query({
        runId: run.id,
        type: 'toolbox.budget-exceeded',
      });
      expect(exceededRecords.length).toBeGreaterThan(0);

      // Confirm the bare, un-prefixed `budget.exceeded` never matches this
      // real emission — proves the trail is keyed on the ACTUAL wire
      // string, not the class name that never dispatches in production.
      expect(await bureau.auditTrail!.query({ runId: run.id, type: 'budget.exceeded' })).toEqual(
        [],
      );
    } finally {
      await bureau.dispose();
    }
  });

  it('durably records schedule.created/paused/resumed/cancelled through a real bureau, under a schedule-scoped owner id', async () => {
    // Mirrors `schedule-fire.test.ts`'s own
    // "dispatches SchedulePausedEvent/ScheduleResumedEvent/ScheduleCancelledEvent"
    // setup (same `storage`/`durableExecution` config, same
    // `createSchedule`/`pauseSchedule`/`resumeSchedule`/`cancelSchedule`
    // calls) — proving the durable audit write and the live event this
    // suite already covers come from the identical production call sites.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate('Done.'),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
    });

    try {
      const summary = await bureau.createSchedule({
        agentName: 'researcher',
        input: 'paused forever',
        spec: '1h',
      });
      expect(summary).toBeDefined();

      await bureau.pauseSchedule(summary!.id);
      await bureau.resumeSchedule(summary!.id);
      await bureau.cancelSchedule(summary!.id);

      const owner = `schedule:${summary!.id}`;
      const createdRecords = await bureau.auditTrail!.query({
        runId: owner,
        type: 'schedule.created',
      });
      expect(createdRecords).toHaveLength(1);
      const pausedRecords = await bureau.auditTrail!.query({
        runId: owner,
        type: 'schedule.paused',
      });
      expect(pausedRecords).toHaveLength(1);
      const resumedRecords = await bureau.auditTrail!.query({
        runId: owner,
        type: 'schedule.resumed',
      });
      expect(resumedRecords).toHaveLength(1);
      const cancelledRecords = await bureau.auditTrail!.query({
        runId: owner,
        type: 'schedule.cancelled',
      });
      expect(cancelledRecords).toHaveLength(1);
    } finally {
      await bureau.dispose();
    }
  });

  it('durably records session.deleted through a real bureau.deleteSession call, under a session-scoped owner id (Codex P1 review finding, PR #566)', async () => {
    // Before this fix, `deleteSession` deleted the session without ever
    // dispatching a `session.deleted` fact of any kind — a repo-wide
    // production search found no emission point at all, so this new
    // allowlist entry only handled synthetic/manual actions like
    // `audit-trail.test.ts`'s unit-level stub dispatch. This proves the
    // real production call site (`Bureau.deleteSession`) reaches
    // `bureau.auditTrail.query()`, not just that string sitting in
    // `AUDIT_EVENT_TYPES`.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate('Done.'),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });

    try {
      const run = await bureau.createRun({ message: 'A session about to be deleted' });
      await waitForRunCompletion(bureau, run.id);
      const session = await bureau.getSession(run.sessionId);
      expect(session).toBeDefined();

      await bureau.deleteSession(run.sessionId);

      const owner = `session:${run.sessionId}`;
      const deletedRecords = await bureau.auditTrail!.query({
        runId: owner,
        type: 'session.deleted',
      });
      expect(deletedRecords).toHaveLength(1);
      expect(deletedRecords[0]?.detail).toEqual({ sessionId: run.sessionId });

      // Deleting an id that was never a live session dispatches nothing —
      // there is no genuine deletion fact to record.
      await bureau.deleteSession('never-existed-session');
      const nonExistentRecords = await bureau.auditTrail!.query({
        runId: 'session:never-existed-session',
        type: 'session.deleted',
      });
      expect(nonExistentRecords).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it('dispatches session.deleted exactly once for two concurrent deleteSession(id) calls on the same session (Codex P2 review finding, PR #566)', async () => {
    // Both callers' own `sessionStore.load(id)` can resolve truthy before
    // either has actually deleted the record — `SessionStore.delete` is an
    // idempotent no-op for an already-removed id, not a "did I win"
    // signal — so an unguarded dispatch would fire twice for one real
    // deletion. `deleteSession` coalesces concurrent calls for the same id
    // onto a single in-flight `performDeleteSession` run.
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate('Done.'),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });

    try {
      const run = await bureau.createRun({ message: 'A session deleted concurrently' });
      await waitForRunCompletion(bureau, run.id);

      const deleted: string[] = [];
      bureau.addEventListener('session.deleted', (event) => deleted.push(event.sessionId));

      await Promise.all([
        bureau.deleteSession(run.sessionId),
        bureau.deleteSession(run.sessionId),
        bureau.deleteSession(run.sessionId),
      ]);

      expect(deleted).toEqual([run.sessionId]);

      const owner = `session:${run.sessionId}`;
      const deletedRecords = await bureau.auditTrail!.query({
        runId: owner,
        type: 'session.deleted',
      });
      expect(deletedRecords).toHaveLength(1);
    } finally {
      await bureau.dispose();
    }
  });

  it('does not coalesce a deleteSession call for a session RECREATED with the same id while the original deletion is still finishing its post-commit cleanup (Codex follow-up review finding, PR #566)', async () => {
    // The coalescing map above is released as soon as `sessionStore.delete`
    // itself commits, not when the whole function (including awaiting a
    // released paused run's own terminal event) finally resolves. Before
    // that fix, a `deleteSession(id)` call arriving during that tail would
    // silently resolve against the OLD, already-settled deletion's promise
    // without ever touching the NEW session — this proves it actually
    // deletes the new one.
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
      persistence: textValueStore(new MemoryStorage()),
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const originalRun = await bureau.createRun({ message: 'go', principal: 'alice' });
      const sessionId = originalRun.sessionId;
      await pollUntil(() => generate.callCount === 1);

      const pause = await bureau.submitSteeringCommand(sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(pause.outcome).toBe('accepted');

      // Deletes the ORIGINAL session — `sessionStore.delete` commits
      // quickly (nothing here waits on the gated tool), but the returned
      // promise stays pending, awaiting the just-released paused run's own
      // terminal event, which the still-held tool gate blocks.
      const originalDeletion = bureau.deleteSession(sessionId);
      await pollUntil(async () => (await bureau.getSession(sessionId)) === undefined);

      // A NEW session, reusing the SAME id, created and completed WHILE
      // `originalDeletion` is still pending.
      const recreatedRun = await bureau.createRun({
        message: 'a fresh session reusing the same id',
        sessionId,
      });
      await waitForRunCompletion(bureau, recreatedRun.id);
      expect(await bureau.getSession(sessionId)).toBeDefined();

      // This must genuinely delete the RECREATED session, not silently
      // resolve against `originalDeletion`'s stale promise.
      const recreatedDeletion = bureau.deleteSession(sessionId);

      releaseTool!();
      await Promise.all([originalDeletion, recreatedDeletion]);
      await waitForRunCompletion(bureau, originalRun.id);

      expect(await bureau.getSession(sessionId)).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });

  it('dispatches session.deleted immediately, so it durably sorts BEFORE a released run\'s own later terminal action rather than after it (Codex P1 review finding, PR #566, "Persist deletion before waiting for run terminals")', async () => {
    // A prior round dispatched `session.deleted` only after every run this
    // deletion released or aborted had actually settled, specifically so a
    // released-paused-run's own terminal action — landing in the same
    // millisecond under a fixed/injected clock — would sort after (not
    // before) the deletion that caused it. That ordering bought
    // same-millisecond correctness for exactly that one case at the cost
    // of gating a durable fact behind an UNBOUNDED wait: a run whose tool
    // ignores its abort signal can leave that wait pending forever, and a
    // crash during that window permanently loses the `session.deleted`
    // audit fact, with no recovery-time producer able to reconstruct it.
    // Durability now wins: the dispatch moved to immediately after
    // `sessionStore.delete` commits, well before `settleForDeletion`
    // releases this paused run, let alone before it resumes its step loop
    // and eventually reaches its own `run.completed`.
    //
    // Verified empirically (not assumed): releasing a paused run and
    // letting it resume through a further tool call and generate step
    // takes real, measurable time even with everything in-process and no
    // real I/O — comfortably enough to cross a millisecond boundary on
    // this machine. `AuditRecord`'s primary sort key is timestamp
    // (`encodeKey`), so the deletion's genuinely earlier timestamp sorts
    // it before the run's later terminal action; `writeOutOfBandRecord`'s
    // huge manual sequence only matters as a SAME-millisecond tie-break,
    // and doesn't apply here since these two do not tie. This actually
    // recovers a MORE truthful chronology than the prior round's, not a
    // less truthful one: the session record really was deleted before
    // this run went on to finish.
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
      persistence: textValueStore(new MemoryStorage()),
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const run = await bureau.createRun({ message: 'go', principal: 'alice' });
      const sessionId = run.sessionId;
      await pollUntil(() => generate.callCount === 1);

      const pause = await bureau.submitSteeringCommand(sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(pause.outcome).toBe('accepted');
      releaseTool!();

      await bureau.deleteSession(sessionId);
      await waitForRunCompletion(bureau, run.id);

      const allRecords = await bureau.auditTrail!.query({ limit: 1000 });
      const runTerminalIndex = allRecords.findIndex(
        (record) => record.runId === run.id && record.type === 'run.completed',
      );
      const sessionDeletedIndex = allRecords.findIndex(
        (record) => record.runId === `session:${sessionId}` && record.type === 'session.deleted',
      );
      expect(runTerminalIndex).toBeGreaterThanOrEqual(0);
      expect(sessionDeletedIndex).toBeGreaterThanOrEqual(0);
      expect(sessionDeletedIndex).toBeLessThan(runTerminalIndex);
    } finally {
      await bureau.dispose();
    }
  });

  it("AB-370: orders session.deleted before a released run's own later terminal action by sequence when both land in the exact same manual-clock millisecond", async () => {
    // The test just above proves timestamp ordering when the two records
    // genuinely land in different milliseconds (real elapsed wall-clock
    // time between the dispatch and the released run's eventual terminal
    // action). This test forces the SAME-millisecond collision the prior
    // AB-228 comment in `create-bureau.ts` named as a residual, deliberately
    // accepted risk: a manual clock never advances on its own, so every
    // `Action.timestamp` (the operative store draws it from this same
    // injected `runtime.clock.now()`) and every out-of-band audit write
    // (`writeOutOfBandRecord` draws `timestampMs` from the identical clock)
    // share the exact same value for the whole test, with no real elapsed
    // time to fall back on.
    //
    // Before AB-370, `writeOutOfBandRecord`'s `manualSequence` started near
    // `Number.MAX_SAFE_INTEGER` — always larger than any real
    // `action.sequence` — so `session.deleted` was FORCED to sort AFTER the
    // run's terminal action in exactly this collision, regardless of which
    // one was actually dispatched first. That was a fixed bias, not a
    // measurement: `create-bureau.ts` dispatches `SessionDeletedEvent`
    // immediately after `sessionStore.delete()` commits, then releases this
    // paused run via `settleForDeletion()`, and only THEN does the released
    // run resume its step loop toward its own `run.completed` — so the
    // deletion is genuinely dispatched first. AB-370's shared, per-bureau
    // `sequence` counter (allocated at each write's dispatch time, before
    // either write's asynchronous `kv.set` even starts) now reflects that
    // true call order instead of the old fixed bias.
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

    const runtime = createManualRuntimeServices();
    // `createBureau`'s own `createStore()` call (`create-bureau.ts`) always
    // builds the operative store with ITS OWN default (real) runtime unless
    // a pre-built store is supplied — the bureau-level `runtime` option
    // alone does not reach `Action.timestamp`. Passing `store` here,
    // pre-built against the SAME manual `runtime`, is what makes the run's
    // own action timestamps deterministic and pinned alongside the audit
    // trail's out-of-band writes below.
    const store = createStore({ runtime });
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createToolbox([nextTool]),
      persistence: textValueStore(new MemoryStorage()),
      stopWhen: stopWhen.noToolCalls(),
      runtime,
      store,
    });

    try {
      const run = await bureau.createRun({ message: 'go', principal: 'alice' });
      const sessionId = run.sessionId;
      await pollUntil(() => generate.callCount === 1);

      const pause = await bureau.submitSteeringCommand(sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(pause.outcome).toBe('accepted');
      releaseTool!();

      // Deliberately never call `runtime.advance(...)` — the clock the
      // operative store and the audit trail both read stays pinned at the
      // exact same value from `createRun` through the released run's own
      // eventual terminal action.
      await bureau.deleteSession(sessionId);
      await waitForRunCompletion(bureau, run.id);

      const allRecords = await bureau.auditTrail!.query({ limit: 1000 });
      const runTerminal = allRecords.find(
        (record) => record.runId === run.id && record.type === 'run.completed',
      );
      const sessionDeleted = allRecords.find(
        (record) => record.runId === `session:${sessionId}` && record.type === 'session.deleted',
      );
      if (!runTerminal || !sessionDeleted) {
        throw new Error('expected both a run.completed and a session.deleted audit record');
      }
      // Both records genuinely share a timestamp — otherwise this test
      // isn't exercising the same-millisecond collision at all, and the
      // primary-timestamp sort (unaffected by this fix) would decide it.
      expect(sessionDeleted.timestampMs).toBe(runTerminal.timestampMs);
      expect(sessionDeleted.sequence).toBeDefined();
      expect(runTerminal.sequence).toBeDefined();
      // True call order: the deletion was dispatched before the released
      // run resumed and reached its own terminal action.
      expect(sessionDeleted.sequence!).toBeLessThan(runTerminal.sequence!);

      const allIndexes = await bureau.auditTrail!.query({ limit: 1000 });
      const sessionDeletedIndex = allIndexes.findIndex(
        (record) => record.runId === `session:${sessionId}` && record.type === 'session.deleted',
      );
      const runTerminalIndex = allIndexes.findIndex(
        (record) => record.runId === run.id && record.type === 'run.completed',
      );
      // `query()`'s own sort must reflect the same call order, not just the
      // raw `sequence` field values compared directly above.
      expect(sessionDeletedIndex).toBeLessThan(runTerminalIndex);
    } finally {
      await bureau.dispose();
    }
  });

  it('durably records session.deleted before waiting on any run cleanup, so a genuinely stuck run cannot block the durable audit fact (Codex P1 review finding, PR #566)', async () => {
    // Before this fix, `session.deleted` was dispatched only after
    // `Promise.allSettled(runTerminals)` resolved — an UNBOUNDED wait for
    // every run this deletion released or aborted to actually terminate.
    // A PAUSED run's cleanup path is exactly this shape: `deleteSession`
    // never aborts it, only releases its steering gate
    // (`settleForDeletion`) so it can resume running to a real terminal —
    // if the tool it resumes into never settles (ignores its abort signal,
    // or simply hangs), that wait can hold open indefinitely even though
    // the session record itself is already gone, permanently losing the
    // `session.deleted` audit fact if the process crashes in that window.
    // (Aborting a NON-paused run instead settles its `ActiveRun` on
    // `run.aborted` promptly regardless of the tool's own state, so that
    // shape would not actually exercise the unbounded wait this test
    // targets — the paused path is the one that genuinely can hang.) This
    // proves the durable record now lands, and is observable via
    // `query()`, WHILE `deleteSession`'s own returned promise is still
    // pending behind exactly such a stuck, released run.
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const stuckTool = createTool({
      name: 'stuck',
      description: 'never resolves until released',
      input: z.object({}),
      execute: async () => {
        await toolGate;
        return 'ok';
      },
    });
    const generate = createSequentialGenerate([
      { content: 'step 0', toolCalls: [{ name: 'stuck', arguments: {} }] },
      { content: 'done', toolCalls: [] },
    ]);

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createToolbox([stuckTool]),
      persistence: textValueStore(new MemoryStorage()),
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const run = await bureau.createRun({ message: 'go', principal: 'alice' });
      const sessionId = run.sessionId;
      await pollUntil(() => generate.callCount === 1);

      const pause = await bureau.submitSteeringCommand(sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(pause.outcome).toBe('accepted');

      let deletionSettled = false;
      const deletionPromise = bureau.deleteSession(sessionId).then(() => {
        deletionSettled = true;
      });

      const observedDeletion = await new Promise<{ sessionId: string }>((resolve) => {
        bureau.addEventListener('session.deleted', (event) => resolve(event), { once: true });
      });
      expect(observedDeletion.sessionId).toBe(sessionId);
      // The released-but-stuck tool keeps the run's terminal event — and
      // thus `deleteSession`'s own returned promise — pending at this
      // point.
      expect(deletionSettled).toBe(false);

      const records = await bureau.auditTrail!.query({
        runId: `session:${sessionId}`,
        type: 'session.deleted',
      });
      expect(records).toHaveLength(1);
      // Still pending: the durable write above resolved without needing
      // the stuck run's cleanup to finish first.
      expect(deletionSettled).toBe(false);

      releaseTool!();
      await deletionPromise;
      await waitForRunCompletion(bureau, run.id);
    } finally {
      await bureau.dispose();
    }
  });
});
