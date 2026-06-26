import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStorage, type TextValueStore, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createTool, createToolbox } from 'armorer';
import { createMockTool, createTestToolbox } from 'armorer/test';
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Conversation, getMessages } from 'conversationalist';
import { createMemory, type Memory } from 'memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from 'memory/test';
import type { GenerateFunction, GenerateResponse, Toolbox } from 'operative';
import { createSessionStore, stopWhen } from 'operative';
import { SCHEDULER_ORIGIN_TAG, startDurableRunResult } from 'operative/durable';
import { createStore } from 'operative/store';
import { createMockGenerate as createSequentialGenerate } from 'operative/test';
import { z } from 'zod';

import type { AuditRecord } from './audit-trail';
import * as auditTrailModule from './audit-trail';
import { BureauError, classifyRecoveredRun, createBureau } from './create-bureau';
import { createMemoryPersistHook, createRuntimeComposition } from './runtime-composition';
import { waitForCondition, waitForRunState } from './test';
import {
  type Bureau,
  type ConfigurationResponse,
  DEFAULT_MAXIMUM_STEPS,
  type ServerFrame,
} from './types';

let recoveryDatabaseCounter = 0;

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

    const flakyStore: TextValueStore = {
      async get(key) {
        return backingStore.get(key);
      },
      async set(key, value) {
        if (key.startsWith('agent-session:')) {
          sessionSaveCount += 1;
          if (sessionSaveCount === 2) {
            throw new Error('temporary persistence failure');
          }
        }

        await backingStore.set(key, value);
      },
      async delete(key) {
        await backingStore.delete(key);
      },
      async list(prefix) {
        return backingStore.list(prefix);
      },
      has(key) {
        return backingStore.has(key);
      },
      deletePrefix(prefix) {
        return backingStore.deletePrefix(prefix);
      },
      close() {
        return backingStore.close();
      },
    };

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
    // per-step toolbox:* actions were silent. The resolver now pre-allocates the
    // run's emitter+toolbox and the reattach adapter forwards toolbox events to it,
    // so a tool the resumed step executes is observable on bureau B's `action`
    // surface (same channel the live durable path uses).
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

    const flakyStore: TextValueStore = {
      async get(key) {
        return backingStore.get(key);
      },
      async set(key, value) {
        if (key.startsWith('agent-session:')) {
          sessionSaveCount += 1;
          if (sessionSaveCount === 2) {
            throw new Error('temporary persistence failure');
          }
        }

        await backingStore.set(key, value);
      },
      async delete(key) {
        await backingStore.delete(key);
      },
      async list(prefix) {
        return backingStore.list(prefix);
      },
      has(key) {
        return backingStore.has(key);
      },
      deletePrefix(prefix) {
        return backingStore.deletePrefix(prefix);
      },
      close() {
        return backingStore.close();
      },
    };

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
    const failingStore: TextValueStore = {
      async get(key) {
        return backingStore.get(key);
      },
      async set(key, value) {
        if (key.startsWith('agent-session:')) {
          throw new Error('persistence failed');
        }

        await backingStore.set(key, value);
      },
      async delete(key) {
        await backingStore.delete(key);
      },
      async list(prefix) {
        return backingStore.list(prefix);
      },
      has(key) {
        return backingStore.has(key);
      },
      deletePrefix(prefix) {
        return backingStore.deletePrefix(prefix);
      },
      close() {
        return backingStore.close();
      },
    };

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

  it('persists error session state once after the initial running save', async () => {
    const backingStore = textValueStore(new MemoryStorage());
    let sessionSaveCount = 0;

    const trackingStore: TextValueStore = {
      async get(key) {
        return backingStore.get(key);
      },
      async set(key, value) {
        if (key.startsWith('agent-session:')) {
          sessionSaveCount += 1;
        }

        await backingStore.set(key, value);
      },
      async delete(key) {
        await backingStore.delete(key);
      },
      async list(prefix) {
        return backingStore.list(prefix);
      },
      has(key) {
        return backingStore.has(key);
      },
      deletePrefix(prefix) {
        return backingStore.deletePrefix(prefix);
      },
      close() {
        return backingStore.close();
      },
    };

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

  it('throws CONFLICT when deleting a running run', async () => {
    const generate: GenerateFunction = () => new Promise(() => {});
    const bureau = await createBureau({ generate, toolbox: createEmptyToolbox() });

    const run = await bureau.createRun({ message: 'Hello' });
    expect(bureau.getRun(run.id)?.status).toBe('running');

    expect(() => bureau.deleteRun(run.id)).toThrow(BureauError);
  });

  it('throws NOT_IMPLEMENTED for session APIs when persistence is not configured', async () => {
    const bureau = await createBureau();

    const error = await bureau.listSessions().then(
      () => undefined,
      (rejection) => rejection,
    );

    expect(error).toMatchObject({
      code: 'NOT_IMPLEMENTED',
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

  it('createSchedule returns undefined (no-op) on a non-durable bureau', async () => {
    // Without a durable engine there is nothing to schedule; the method short-
    // circuits to undefined BEFORE the NOT_IMPLEMENTED guard, matching the other
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
    ownedSessionId: 'session-1' as string | undefined,
    metadataReadFailed: false,
    hasSessionStore: true,
    sessionLoad: { ok: true as const, session: { lastRunId: 'run-1', lastRunStatus: 'running' } },
  };

  it('reattaches an owned, in-flight run whose session confirms ownership', () => {
    expect(classifyRecoveredRun(base)).toBe('reattach');
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
