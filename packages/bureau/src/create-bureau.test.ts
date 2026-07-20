import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encode } from '@lostgradient/weft';
import { KEYS, MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import type { ConditionalTextValueStore } from '@lostgradient/weft/storage/text-value-store';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createTool, createToolbox } from 'armorer';
import { createMockTool, createTestToolbox } from 'armorer/test';
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Conversation, createConversationHistory, getMessages } from 'conversationalist';
import { CompletableEventTarget } from 'lifecycle';
import { createMemory, type Memory } from 'memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from 'memory/test';
import type {
  ActiveRun,
  CombinedOperativeEventMap,
  GenerateFunction,
  GenerateResponse,
  Toolbox,
} from 'operative';
import {
  createSessionStore,
  HumanWaitParkedEvent,
  RunAbortedEvent,
  StepCompletedEvent,
  stopWhen,
  TaskDispatchedEvent,
} from 'operative';
import {
  type DurableRunDeps,
  SCHEDULER_ORIGIN_TAG,
  startDurableRunResult,
} from 'operative/durable';
import { createStore } from 'operative/store';
import { createMockGenerate as createSequentialGenerate } from 'operative/test';
import { z } from 'zod';

import type { AuditRecord } from './audit-trail';
import * as auditTrailModule from './audit-trail';
import {
  BureauError,
  classifyRecoveredRun,
  createBureau,
  isRecoverableScheduledFireInput,
  monitorRecoveredScheduledFire,
} from './create-bureau';
import { createMemoryPersistHook, createRuntimeComposition } from './runtime-composition';
import { waitForCondition, waitForRunState } from './test';
import {
  type Bureau,
  type ConfigurationResponse,
  DEFAULT_MAXIMUM_STEPS,
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
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return check();
}

// Drain Weft's deferred inline-launch queue between tests — a pending setTimeout(0)
// inline-launch left by one durable run can starve a later one under full
// `bun test` concurrency (CI). 0.3.0's dispose-drain does not replace this flush.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('createBureau', () => {
  it('is not ready when no generate function is configured', async () => {
    const bureau = await createBureau();
    expect(bureau.ready).toBe(false);
  });

  it('is ready when a generate function is configured', async () => {
    const bureau = await createBureau({ generate: createMockGenerate() });
    expect(bureau.ready).toBe(true);
  });

  it('uses a provided store when one is supplied', async () => {
    const store = createStore();
    const bureau = await createBureau({ store });
    expect(bureau.store).toBe(store);
  });

  it('throws NOT_CONFIGURED when createRun is called without a generate function', async () => {
    const bureau = await createBureau();

    const error = await bureau.createRun({ message: 'Hello' }).then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  it('throws BAD_REQUEST when createRun is called with an empty message', async () => {
    const bureau = await createBureau({ generate: createMockGenerate() });

    const error = await bureau.createRun({ message: '' }).then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('throws BAD_REQUEST when createRun is called with a blank session identifier', async () => {
    const bureau = await createBureau({ generate: createMockGenerate() });

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
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const summary = await bureau.createRun({ message: 'Hello' });

    expect(summary.id).toBeString();
    expect(summary.sessionId).toBeString();
    expect(summary.status).toBe('running');
    expect(bureau.store.getRun(summary.id)).toBeDefined();
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
      generate: async ({ step }) =>
        step === 0
          ? { content: 'calling', toolCalls: [{ name: 'next', arguments: {} }] }
          : { content: 'done', toolCalls: [] },
      toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
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
      generate: async ({ step }) =>
        step === 0
          ? { content: 'calling', toolCalls: [{ name: 'next', arguments: {} }] }
          : { content: 'done', toolCalls: [] },
      toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
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
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });

    const run = await bureau.createRun({ message: 'Named dispatch', agentName: 'researcher' });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.agentName).toBe('researcher');
  });

  it('stamps the session with the default bureau agent when no agentName is dispatched', async () => {
    const bureau = await createBureau({
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const bureau = await createBureau({
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
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
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
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      persistence: flakyStore,
      sessionPersistenceSleep: async () => {},
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
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true; // step 0's saveCursor has committed
          // Hang forever — the "process" dies here.
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const run = await bureauA.createRun({ message: 'Recover me' });
      // Crash once step 1's generate is entered — i.e. step 0 is durably
      // checkpointed (see the anchor rationale above).
      await pollUntil(() => bureauAReachedStep1);
      expect(bureauAReachedStep1).toBe(true);
      bureauA.dispose();

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
        generate: async ({ step }) => {
          bSteps.push(step);
          return { content: `B recovered step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
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
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
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
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
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
      bureauA.dispose();

      const bSteps: number[] = [];
      const runSeqsFromB: number[] = [];
      const bureauB = await createBureau({
        generate: async ({ step }) => {
          bSteps.push(step);
          return { content: `B recovered step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
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
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
        workflowVersion: 'v1',
      });

      const run = await bureauA.createRun({ message: 'Recover me under a new version' });
      await pollUntil(() => bureauAReachedStep1);
      expect(bureauAReachedStep1).toBe(true);
      bureauA.dispose();

      const warnSpy = spyOn(console, 'warn');
      const bSteps: number[] = [];
      const bureauB = await createBureau({
        generate: async ({ step }) => {
          bSteps.push(step);
          return { content: `B recovered step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
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
            toolbox: toolbox as never,
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
            toolbox: toolbox as never,
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
        // Weft 0.10+ native marker shape: an object, not a bare string.
        await firstRuntime.durable!.engine.storage.put(
          KEYS.scheduleRun(runId),
          encode({ id: scheduleId, occurrence: Date.now() }),
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
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const run = await bureauA.createRun({ message: 'Recover into the audit trail' });
      await pollUntil(() => bureauAReachedStep1);
      bureauA.dispose();

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
          generate: async ({ step }) => ({ content: `B recovered step ${step}`, toolCalls: [] }),
          toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
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
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          reachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });
      const run = await bureauA.createRun({ message: 'Recover with a tool' });
      await pollUntil(() => reachedStep1);
      bureauA.dispose();

      // Bureau B: resumes at step 1, which calls the `next` tool again before
      // settling — so a toolbox action fires on the RECOVERED run's surface.
      const actions: string[] = [];
      const bureauB = await createBureau({
        generate: async ({ step }) => {
          if (step === 1) {
            return { content: 'B resume step 1', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          return { content: `B step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
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
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const run = await bureauA.createRun({ message: 'Recover with envelope frames' });
      await pollUntil(() => bureauAReachedStep1);
      bureauA.dispose();

      // Bureau B: resumes at step 1, which calls the `next` tool again before
      // settling — so step/tool-pre/tool-post frames should surface on the
      // recovered run's run-envelope stream, not just the terminal one.
      const bureauB = await createBureau({
        generate: async ({ step }) => {
          if (step === 1) {
            return { content: 'B resume step 1', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          return { content: `B step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
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
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const run = await bureauA.createRun({
        message: 'C3 recovery stamp test',
        agentName: 'recovery-agent',
      });
      await pollUntil(() => bureauAReachedStep1);
      bureauA.dispose();

      // Bureau B: resumes at step 1, which calls the `next` tool. After recovery
      // the resolver now wires the C3 block so the tool.started event emitted
      // during resume carries {agentName:'recovery-agent', runId}.
      const capturedStamps: Array<{ agentName: string; runId: string }> = [];
      const bureauB = await createBureau({
        generate: async ({ step }) => {
          if (step === 1) {
            return { content: 'B resume', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          return { content: `B step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
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
        generate: async ({ step }) => {
          if (step === 0) {
            return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          bureauAReachedStep1 = true;
          return new Promise<never>(() => {}); // hang — the "process" dies here
        },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        stopWhen: stopWhen.noToolCalls(),
      });

      const run = await bureauA.createRun({ message: 'Recover me' });
      await pollUntil(() => bureauAReachedStep1);
      expect(bureauAReachedStep1).toBe(true);
      bureauA.dispose();

      // === Bureau B: same file, durable forced on, but NO generate and NO
      // provider — so reconstructing the run's deps throws on this process. ===
      const bureauB = await createBureau({
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
        // Step 0 commits a tool call (so toolbox events must fire on the durable
        // path); step 1 has no tool call, so `noToolCalls()` stops the run.
        generate: async ({ step }) =>
          step === 0
            ? { content: 'calling tool', toolCalls: [{ name: 'next', arguments: {} }] }
            : { content: 'done', toolCalls: [] },
        toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
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
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        persistence: flakyStore,
        sessionPersistenceSleep: async () => {
          retrySleepCount += 1;
          throw new Error('retry sleep aborted');
        },
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
      generate,
      toolbox: createEmptyToolbox(),
      persistence: textValueStore(new MemoryStorage()),
    });

    const run = await bureau.createRun({ message: 'Explode' });
    await waitForRunCompletion(bureau, run.id);

    const session = await bureau.getSession(run.sessionId);
    expect(session?.metadata['lastRunId']).toBe(run.id);
    expect(session?.metadata['lastRunStatus']).toBe('error');
    expect(session?.metadata['lastError']).toBe('Explode');
  });

  it('persists a guardrail tripwire halt as lastRunStatus: error with lastError set (regression PRRT_kwDORvupsc6PxCXP)', async () => {
    // Before the fix, the run.completed listener only mapped
    // `finishReason === 'error'` to `lastRunStatus: 'error'` — a tripwire halt
    // (`finishReason: 'tripwire'`) fell into the `'completed'` branch and never
    // wrote `lastError`, so a malicious/flagged prompt that hard-halted the run
    // was persisted to session metadata as an ordinary successful completion.
    const generate: GenerateFunction = async () => ({ content: 'ok', toolCalls: [] });

    const bureau = await createBureau({
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

    const bureau = await createBureau({ generate });

    const run = await bureau.createRun({ message: 'Need a tool' });
    await waitForRunCompletion(bureau, run.id);

    const detail = bureau.getRun(run.id);
    expect(detail?.status).toBe('error');
    expect(detail?.error).toContain('No toolbox configured but tool calls were received');
  });

  it('lists runs and filters them by status', async () => {
    const bureau = await createBureau({
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

  it('aborts a running run', async () => {
    const generate: GenerateFunction = () => new Promise(() => {});
    const bureau = await createBureau({ generate, toolbox: createEmptyToolbox() });

    const run = await bureau.createRun({ message: 'Hello' });

    const aborted = bureau.abortRun(run.id);
    expect(aborted.status).toBe('aborted');
  });

  it('persists both lastRunStatus and lastFinishReason when a run is aborted', async () => {
    // An aborted session's metadata must be internally consistent: status AND
    // finishReason both `aborted`, so a prior run's stale `lastFinishReason` on
    // the same session cannot linger. Boot recovery relies on this too — a
    // recovered run that aborts settles through this same listener.
    const generate: GenerateFunction = () => new Promise(() => {});
    const bureau = await createBureau({
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
      toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
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
    const bureau = await createBureau({ generate, toolbox: createEmptyToolbox() });

    const run = await bureau.createRun({ message: 'Hello' });
    expect(bureau.getRun(run.id)?.status).toBe('running');

    expect(() => bureau.deleteRun(run.id)).toThrow(BureauError);
  });

  it('throws NOT_CONFIGURED for session APIs when persistence is not configured', async () => {
    const bureau = await createBureau();

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

    await bureau.deleteSession(run.sessionId);
    const deleted = await bureau.getSession(run.sessionId);
    expect(deleted).toBeUndefined();
  });

  it('returns configuration data with provider and tool summaries', async () => {
    const bureau = await createBureau({
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

  it('configures a scheduler for routed multi-provider runtimes', async () => {
    const bureau = await createBureau({
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
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    expect(bureau.getTools()).toEqual([]);
  });

  it('does not abort run setup when a subscribeLiveFrames listener throws (regression PRRT_kwDORvupsc6PxP_w)', async () => {
    // AB-96 codex review: `emitLiveFrame` fired listeners with no isolation. The
    // 'run-started' run-envelope frame is emitted BEFORE `store.register` +
    // the terminal listeners are installed, so a throwing subscriber there
    // used to propagate out of `createRun`, leaving the session persisted as
    // `running` and the ActiveRun launched but never registered — `getRun`
    // would return `undefined` forever for a run that is actually executing.
    const bureau = await createBureau({
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

  it('emits one scheduler preempted frame with current state', async () => {
    const { generate: slowGenerate, resolve } = createBlockingGenerate();
    const schedulerFrames: Extract<
      ServerFrame,
      { type: 'scheduler.state' | 'scheduler.task.preempted' }
    >[] = [];

    const bureau = await createBureau({
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
    const bureau = await createBureau();
    bureau.dispose();
    bureau.dispose();
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
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
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
    } finally {
      bureau.dispose();
    }
  });

  it('createSchedule registers a fixed-interval schedule for a weft duration spec', async () => {
    // A weft duration grammar string (e.g. '6h', '5 minutes') is a fixed interval,
    // not cron — toScheduleSpec wraps it as { every } so weft parses it as an
    // interval. ISO-8601 (`PT6H`) is NOT weft duration grammar and stays cron.
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
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
    } finally {
      bureau.dispose();
    }
  });

  it('createSchedule returns undefined (no-op) on a non-durable bureau', async () => {
    // Without a durable engine there is nothing to schedule; the method short-
    // circuits to undefined before any registration, matching the other
    // durable-only accessors.
    const bureau = await createBureau({
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
});

describe('createBureau durable inspection surface', () => {
  it('getDurableRun and listDurableRuns return undefined when no durable engine is composed', async () => {
    // A memory-backed bureau with no durableExecution flag has no engine, so the
    // durable read accessors report "no durable surface" via undefined.
    const bureau = await createBureau({
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
        toolbox: createToolbox([]) as unknown as Toolbox,
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
            toolbox: createToolbox([]) as unknown as Toolbox,
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
            toolbox: createToolbox([]) as unknown as Toolbox,
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
});

describe('createBureau session signal/update/query without durable engine', () => {
  // Regression for findings PRRT_kwDORvupsc6MXEmd and PRRT_kwDORvupsc6MXEmm:
  // signalSession / updateSession / querySession must throw BureauError('NOT_CONFIGURED')
  // when no durable engine is composed, not return undefined. Returning undefined was
  // indistinguishable from a void signal result or a handler that returns undefined,
  // causing the gateway route to respond 501 even on successful signal delivery.

  it('signalSession throws NOT_CONFIGURED when no durable engine is composed', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const error = await bureau
      .signalSession('any-session', 'any-signal')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_CONFIGURED');
  });

  it('updateSession throws NOT_CONFIGURED when no durable engine is composed', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const error = await bureau
      .updateSession('any-session', 'any-update')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_CONFIGURED');
  });

  it('querySession throws NOT_CONFIGURED when no durable engine is composed', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const error = await bureau
      .querySession('any-session', 'any-query')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_CONFIGURED');
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
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
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
    addEventListener: emitter.addEventListener.bind(emitter) as ActiveRun['addEventListener'],
    removeEventListener: emitter.removeEventListener.bind(
      emitter,
    ) as ActiveRun['removeEventListener'],
    on: emitter.on.bind(emitter) as ActiveRun['on'],
    once: emitter.once.bind(emitter) as ActiveRun['once'],
    subscribe: emitter.subscribe.bind(emitter) as ActiveRun['subscribe'],
    events: emitter.events.bind(emitter) as ActiveRun['events'],
    toObservable: emitter.toObservable.bind(emitter),
    complete: emitter.complete.bind(emitter),
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

describe('createBureau review queue (AB-20)', () => {
  it('listPendingReviews surfaces a tool call parked on needs_approval', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('test-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
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
    expect(review!.ageMilliseconds).toBeGreaterThanOrEqual(0);
    expect(charges).toEqual([]); // not yet executed

    bureau.dispose();
  });

  it('listPendingReviews surfaces a run parked on a human-wait signal', async () => {
    const bureau = await createBureau({
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
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const { activeRun, emitter } = createParkedActiveRun();
    const runId = bureau.store.register(activeRun, 'run-resumed-human-wait');
    emitter.dispatchEvent(new HumanWaitParkedEvent('human-response', runId));
    // Resuming a `ctx.waitForSignal` park runs the durable workflow straight
    // through to completion (it does not start a new step) — the run's
    // status leaving `'running'` is what marks it no longer parked.
    emitter.dispatchEvent(new RunAbortedEvent(1, new Conversation(), 'resumed'));

    expect(bureau.listPendingReviews()).toHaveLength(0);

    bureau.dispose();
  });

  it('resolveReview approve resumes a tool-approval and executes the tool for real', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-2', name: 'charge-card', arguments: { cents: 750 } }],
        },
      ]),
      toolbox: createNeedsApprovalToolbox('test-secret-2', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
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

    // Resolved reviews disappear from the queue.
    expect(bureau.listPendingReviews()).toHaveLength(0);

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
      generate: createSequentialGenerate([
        {
          content: '',
          toolCalls: [{ id: 'call-3', name: 'charge-card', arguments: { cents: 900 } }],
        },
      ]),
      toolbox: createRegatingApprovalToolbox('test-secret-3', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
    });

    const run = await bureau.createRun({ message: 'Charge the customer' });
    await waitForRunCompletion(bureau, run.id);

    const [review] = bureau.listPendingReviews();
    expect(review).toBeDefined();

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

    bureau.dispose();
  });

  it('resolveReview approve on a human-wait review signals the parked session', async () => {
    const bureau = await createBureau({
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

    bureau.dispose();
  });

  it('resolveReview throws NOT_FOUND for an unknown or already-resolved review id', async () => {
    const bureau = await createBureau({
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
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

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
    expect(bureau.listPendingReviews()).toHaveLength(0);

    // Terminate and delete the run — deleteRun refuses a still-`running` run.
    first.emitter.dispatchEvent(new RunAbortedEvent(0, new Conversation(), 'test-cleanup'));
    bureau.deleteRun(runId);

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
    ]);

    const bureau = await createBureau({
      generate,
      toolbox: createEmptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      stopWhen: stopWhen.toolCalled('requestHumanInput'),
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
});
