import type { GenerateFunction } from '@lostgradient/operative';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { waitForCondition } from '@lostgradient/operative/test';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createProcessLocalApprovalStateStore, createTool, createToolbox } from 'armorer';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { ManualRuntimeServices } from 'lifecycle';
import { createManualRuntimeServices } from 'lifecycle';
import { z } from 'zod';

import type { Bureau, RunSummary } from '../types';
import {
  BureauHarnessUnsupportedError,
  type BureauTestHarness,
  createBureauTestHarness,
} from './harness';
import {
  type BureauStorageFixture,
  createLmdbStorageFixture,
  createMemoryStorageFixture,
  createSqliteStorageFixture,
} from './storage-fixtures';

function mockGenerate(content = 'Done.'): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

/**
 * Same drain pattern `create-bureau.test.ts` uses for the durable
 * inline-launch queue, plus a real-delay poll for the terminal-status wait
 * itself (`waitForCondition`'s own default, a zero-delay `MessageChannel`
 * macrotask loop, is NOT enough here — root-caused directly, not a blind
 * workaround: with the `lmdb` backend, spinning that macrotask loop
 * measurably STARVES the native library's own async completion — a
 * 5,000-iteration zero-delay spin (~600ms of real time) left two
 * concurrent LMDB-backed runs still `'running'`, while the identical
 * scenario polled with real `setTimeout(5)` between checks completed both
 * well within a couple hundred milliseconds. `MessageChannel` macrotasks
 * evidently get scheduled ahead of `lmdb`'s own completion callbacks when
 * nothing yields real time between posts, so a tight macrotask-only loop
 * can spin forever without ever letting the pending write land. A tiny
 * real per-iteration delay breaks that starvation while remaining a
 * bounded, condition-checked POLL — this still asserts the observed
 * status each iteration and fails loudly past the cap, never a blind
 * "sleep N then assume it's done."
 */
async function waitForRunCompletion(bureau: Bureau, runId: string): Promise<void> {
  const maximumAttempts = 400;
  let status: string | undefined;
  let reachedTerminalStatus = false;
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    status = bureau.getRun(runId)?.status;
    // `undefined` (the run id is not yet, or never, known to this bureau) is
    // NOT a terminal status — keep polling for it exactly like `'running'`,
    // rather than treating "not found yet" as "already done" (a false
    // positive `undefined !== 'running'` would produce).
    if (status !== undefined && status !== 'running') {
      reachedTerminalStatus = true;
      break;
    }
    if (attempt < maximumAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (!reachedTerminalStatus) {
    throw new Error(
      status === undefined
        ? `Run ${runId} was never observed by bureau.getRun`
        : `Run ${runId} did not reach a terminal status`,
    );
  }
  for (let i = 0; i < 10; i++) {
    await yieldToPortableEventLoop();
  }
}

const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (disposals.length > 0) {
    const dispose = disposals.pop()!;
    await dispose();
  }
});

async function harnessWithMemoryStorage(
  overrides: Partial<Parameters<typeof createBureauTestHarness>[0]> = {},
): Promise<BureauTestHarness> {
  const storage = createMemoryStorageFixture();
  const harness = await createBureauTestHarness({
    agents: {
      worker: createAgent({ name: 'worker', generate: mockGenerate('worker done') }),
    },
    generate: mockGenerate(),
    toolbox: createToolbox([]),
    storage,
    ...overrides,
  });
  disposals.push(async () => {
    await harness.bureau.dispose();
    await storage.dispose();
  });
  return harness;
}

describe('createBureauTestHarness', () => {
  it('resolves only after bureau.ready is true and boot recovery has completed', async () => {
    const harness = await harnessWithMemoryStorage();

    expect(harness.bureau.ready).toBe(true);
  });

  it('composes the bureau over the injected runtime and storage fixture', async () => {
    const runtime = createManualRuntimeServices({ origin: '2030-01-01T00:00:00.000Z' });
    const storage = createMemoryStorageFixture();
    const harness = await createBureauTestHarness({
      agents: {},
      generate: mockGenerate(),
      toolbox: createToolbox([]),
      runtime,
      storage,
    });
    disposals.push(async () => {
      await harness.bureau.dispose();
      await storage.dispose();
    });

    expect(harness.runtime).toBe(runtime);
    expect(harness.storage).toBe(storage);
    expect(harness.runtime.clock.now()).toBe(Date.parse('2030-01-01T00:00:00.000Z'));
  });

  it('disposes the storage fixture (and any constructed Bureau) when construction fails, rather than leaking it', async () => {
    const storage = createMemoryStorageFixture();
    let disposeCalls = 0;
    const originalDispose = storage.dispose.bind(storage);
    storage.dispose = async () => {
      disposeCalls += 1;
      await originalDispose();
    };

    // `sessionInput.sessionBacklogLimit: 0` is rejected synchronously by
    // createBureau's own construction-time validation (BAD_REQUEST) — the
    // same invalid-input fixture create-bureau.test.ts's own
    // "rejects a non-positive-integer sessionBacklogLimit" case uses.
    // Awaited via an explicit catch (rather than `expect(...).rejects`) so
    // the disposeCalls assertion below is guaranteed to run only after this
    // rejection — and this test's own cleanup — have actually settled.
    const error: unknown = await createBureauTestHarness({
      agents: {},
      generate: mockGenerate(),
      toolbox: createToolbox([]),
      storage,
      sessionInput: { sessionBacklogLimit: 0 },
    }).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(Error);
    expect(disposeCalls).toBe(1);
  });

  it('defaults runtime to a freshly constructed ManualRuntimeServices when omitted', async () => {
    const storage = createMemoryStorageFixture();
    const harness = await createBureauTestHarness({
      agents: {},
      generate: mockGenerate(),
      toolbox: createToolbox([]),
      storage,
    });
    disposals.push(async () => {
      await harness.bureau.dispose();
      await storage.dispose();
    });

    expect(typeof harness.runtime.advance).toBe('function');
    expect(typeof harness.runtime.pendingTimers).toBe('function');
  });

  describe('startRun', () => {
    it('dispatches a catalog agent and returns its AgentRun handle', async () => {
      const harness = await harnessWithMemoryStorage();

      const run = harness.startRun('worker', 'hello');

      expect(await run.unwrap()).toBe('worker done');
    });
  });

  describe('startSession', () => {
    it('is a thin wrapper over Bureau.createRun', async () => {
      const harness = await harnessWithMemoryStorage();

      const summary = await harness.startSession({ message: 'hello session' });
      await waitForRunCompletion(harness.bureau, summary.id);

      expect(summary.sessionId).toBeDefined();
      expect(harness.bureau.getRun(summary.id)?.status).toBe('completed');
    });
  });

  describe('startChild', () => {
    it('dispatches a child run correlated to the given parent run id', async () => {
      const harness = await harnessWithMemoryStorage({
        agents: {
          worker: createAgent({ name: 'worker', generate: mockGenerate('worker done') }),
          helper: createAgent({ name: 'helper', generate: mockGenerate('helper done') }),
        },
      });

      const parent = await harness.startSession({ message: 'parent' });
      const child = harness.startChild(parent.id, 'helper', 'child input');

      expect(child.parentRunId).toBe(parent.id);
      expect(child.agentName).toBe('helper');
      const result = await child.result();
      expect(result.content).toBe('helper done');
    });

    it('throws synchronously for an unknown agent name', async () => {
      const harness = await harnessWithMemoryStorage();

      expect(() => harness.startChild('run-1', 'no-such-agent', 'input')).toThrow(/unknown agent/i);
    });
  });

  describe('submitSchedulerTask', () => {
    it('is a thin wrapper over Bureau.submitSchedulerTask', async () => {
      const harness = await harnessWithMemoryStorage({
        agents: {},
        scheduler: { enabled: true, idleDelay: 1 },
      });

      const response = await harness.submitSchedulerTask({
        message: 'scheduled task',
        priority: 'background',
      });

      expect(response.status).toBe('queued');
      await waitForCondition(
        () => harness.bureau.scheduler?.getState().completedCount === 1,
        'scheduled task did not complete',
      );
    });
  });

  describe('reattachDurable', () => {
    it('is a thin wrapper over Bureau.getDurableRun, returning undefined without a durable engine', async () => {
      const harness = await harnessWithMemoryStorage();

      const summary = await harness.startSession({ message: 'no durable engine here' });
      await waitForRunCompletion(harness.bureau, summary.id);

      expect(harness.reattachDurable(summary.id)).resolves.toBeUndefined();
    });
  });

  describe('deliverSignal', () => {
    it('is a thin wrapper over Bureau.signalSession, propagating its NOT_CONFIGURED error without a durable engine', async () => {
      const harness = await harnessWithMemoryStorage();

      const summary = await harness.startSession({ message: 'no durable engine here' });
      await waitForRunCompletion(harness.bureau, summary.id);

      expect(harness.deliverSignal(summary.sessionId, 'wake', {})).rejects.toThrow(/durable/i);
    });
  });

  describe('resolveReview', () => {
    it('is a thin wrapper over Bureau.resolveReview', async () => {
      const approvalStateStore = createProcessLocalApprovalStateStore();
      const harness = await harnessWithMemoryStorage({
        agents: {},
        generate: async () => ({
          content: '',
          toolCalls: [{ id: 'call-1', name: 'sensitive-tool', arguments: {} }],
        }),
        toolbox: createToolbox(
          [
            createTool({
              name: 'sensitive-tool',
              version: '1.0.0',
              description: 'Requires approval',
              input: z.object({}),
              async execute() {
                return 'unexpected';
              },
            }),
          ],
          {
            approvalSecret: 'harness-test-secret',
            approvalStateStore,
            policy: {
              beforeExecute: () => ({
                allow: false,
                status: 'needs_approval',
                reason: 'Operator approval required',
                action: { message: 'Approve harness test' },
              }),
            },
          },
        ),
        stopWhen: stopWhen.toolOutcome('action_required'),
      });

      const summary = await harness.startSession({ message: 'trigger approval' });
      await waitForRunCompletion(harness.bureau, summary.id);

      const reviews = harness.bureau.listPendingReviews();
      expect(reviews).toHaveLength(1);

      const outcome = await harness.resolveReview({
        id: reviews[0]!.id,
        decision: 'deny',
        principal: 'harness-test',
      });

      expect(outcome.decision).toBe('deny');
      expect(harness.bureau.listPendingReviews()).toHaveLength(0);
    });
  });

  describe('waitForRunCompletion (this file’s own test helper)', () => {
    it('keeps polling — never treats "not found yet" as done — and fails with a distinct message when a run id is never observed', async () => {
      const harness = await harnessWithMemoryStorage();

      expect(waitForRunCompletion(harness.bureau, 'no-such-run')).rejects.toThrow(
        /never observed/i,
      );
    });
  });

  describe('supports and the unsupported-capability drivers', () => {
    it('reports false for managed-goal and scheduler-task-result', async () => {
      const harness = await harnessWithMemoryStorage();

      expect(harness.supports('managed-goal')).toBe(false);
      expect(harness.supports('scheduler-task-result')).toBe(false);
    });

    it('startManagedGoal throws a typed BureauHarnessUnsupportedError naming AB-101 and AB-102', async () => {
      const harness = await harnessWithMemoryStorage();

      expect(() => harness.startManagedGoal()).toThrow(BureauHarnessUnsupportedError);
      try {
        harness.startManagedGoal();
      } catch (error) {
        expect(error).toBeInstanceOf(BureauHarnessUnsupportedError);
        expect((error as BureauHarnessUnsupportedError).capability).toBe('managed-goal');
        expect((error as BureauHarnessUnsupportedError).owningIssues).toEqual(['AB-101', 'AB-102']);
      }
    });

    it('getSchedulerTaskResult throws a typed BureauHarnessUnsupportedError naming AB-180', async () => {
      const harness = await harnessWithMemoryStorage();

      try {
        harness.getSchedulerTaskResult('task-1');
        throw new Error('expected getSchedulerTaskResult to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(BureauHarnessUnsupportedError);
        expect((error as BureauHarnessUnsupportedError).capability).toBe('scheduler-task-result');
        expect((error as BureauHarnessUnsupportedError).owningIssues).toEqual(['AB-180']);
      }
    });
  });
});

describe('createBureauTestHarness — durable backend (sqlite)', () => {
  it('createRecurringSchedule and reattachDurable observe the same live durable engine', async () => {
    const runtime = createManualRuntimeServices();
    const storage = createSqliteStorageFixture({ runtime });
    const harness = await createBureauTestHarness({
      agents: {},
      generate: mockGenerate(),
      toolbox: createToolbox([]),
      runtime,
      storage,
      durableExecution: true,
    });

    try {
      const schedule = await harness.createRecurringSchedule({
        agentName: 'worker',
        input: 'fire',
        spec: '1h',
      });
      expect(schedule).toBeDefined();
      expect(schedule?.id).toBeDefined();
      expect(schedule?.status).toBe('active');

      const summary = await harness.startSession({ message: 'durable run' });
      await waitForRunCompletion(harness.bureau, summary.id);

      const durableRun = await harness.reattachDurable(summary.id);
      expect(durableRun).toBeDefined();
      expect(durableRun?.status).toBe('completed');
    } finally {
      await harness.bureau.dispose();
      await storage.dispose();
    }
  });
});

describe('two concurrent harnesses are fully isolated', () => {
  /**
   * AB-306: root-caused directly before restructuring anything. Timing the
   * two storage-fixture creations, the two `createBureauTestHarness` calls,
   * and the `waitForRunCompletion` polls separately under artificial load
   * (six concurrent `bun test` runs of another package) showed fixture
   * creation and Bureau construction together cost well under 200ms even
   * loaded — not construction cost, as initially suspected. The real cost
   * living inside the old single `it.each` body was three sequential
   * `waitForRunCompletion` calls: each one polls with a REAL
   * `setTimeout(5)` between checks (a documented, intentional fix for LMDB
   * completion-callback starvation under a zero-delay macrotask loop — see
   * that helper's own comment), and real timer delivery is exactly what
   * degrades under host CPU contention, sometimes taking 100s of ms per
   * 5ms-nominal tick. Stacking three such polls inside ONE test's 5000ms
   * Bun default timeout is what actually timed out under load, not the
   * fixture/construction cost.
   *
   * The fix moves every real-time-consuming step (fixture creation, Bureau
   * construction, and — critically — each `waitForRunCompletion` poll) into
   * its own `beforeAll` hook. Bun (confirmed empirically) gives each
   * `beforeAll` call in a describe block its OWN default timeout budget
   * rather than sharing one budget across the whole sequence, so splitting
   * the three real waits into three separate hooks roughly triples the
   * real-time headroom available before any single step could time out —
   * without raising any timeout, retry, or resource cap. Every `it` body
   * below is now a synchronous (or synthetic-clock-only) assertion with no
   * real wall-clock dependency, so per-test budget pressure from load is
   * gone. The isolation assertions themselves (paths differ, timers
   * independent, identifiers independent, events not shared) are
   * unchanged in meaning — only when the underlying work happens moved.
   */
  describe.each([
    ['memory', () => createMemoryStorageFixture()],
    ['sqlite', () => createSqliteStorageFixture({ runtime: createManualRuntimeServices() })],
    ['lmdb', () => createLmdbStorageFixture({ runtime: createManualRuntimeServices() })],
  ] as const)(
    '%s: independent storage paths, timers, identifiers, and events',
    (_label, makeStorage) => {
      let runtimeA: ManualRuntimeServices;
      let runtimeB: ManualRuntimeServices;
      let storageA: BureauStorageFixture;
      let storageB: BureauStorageFixture;
      let harnessA: BureauTestHarness;
      let harnessB: BureauTestHarness;
      let runA: RunSummary;
      let runB: RunSummary;
      let eventsSeenByA: string[];

      beforeAll(async () => {
        runtimeA = createManualRuntimeServices({ origin: '2024-01-01T00:00:00.000Z' });
        runtimeB = createManualRuntimeServices({ origin: '2025-06-15T00:00:00.000Z' });
        storageA = makeStorage();
        storageB = makeStorage();

        harnessA = await createBureauTestHarness({
          agents: {},
          generate: mockGenerate('A'),
          toolbox: createToolbox([]),
          runtime: runtimeA,
          storage: storageA,
        });
        harnessB = await createBureauTestHarness({
          agents: {},
          generate: mockGenerate('B'),
          toolbox: createToolbox([]),
          runtime: runtimeB,
          storage: storageB,
        });
      });

      // Distinct identifier sequences: each harness's Bureau mints its runId
      // through its OWN composed runtime — both produce the same
      // first-of-kind counter value independently. Draining runA to
      // completion here (its own hook, its own timeout budget) matters
      // beyond the identifier check itself: it keeps runA's own completion
      // frame from firing later, during the event-isolation hook's
      // subscription window, and being mistaken for cross-harness leakage.
      beforeAll(async () => {
        runA = await harnessA.startSession({ message: 'on A' });
        runB = await harnessB.startSession({ message: 'on B' });
        await waitForRunCompletion(harnessA.bureau, runA.id);
      });

      // Drained in its own hook (rather than alongside runA's wait above) so
      // this real LMDB completion poll gets its own fresh timeout budget too.
      beforeAll(async () => {
        await waitForRunCompletion(harnessB.bureau, runB.id);
      });

      // Neither harness observes the other's events. Subscribing and
      // draining the B-only run happen here — its own hook, its own budget —
      // rather than inside the `it` below, for the same reason as the two
      // hooks above.
      beforeAll(async () => {
        eventsSeenByA = [];
        const unsubscribeA = harnessA.bureau.subscribeLiveFrames((frame) => {
          eventsSeenByA.push(frame.type);
        });
        // try/finally: if startSession or waitForRunCompletion throws, this
        // still unsubscribes rather than leaking a live subscription on
        // harnessA into afterAll's teardown, which could mask the real
        // failure behind an unrelated dispose-time symptom.
        try {
          const runOnBOnly = await harnessB.startSession({ message: 'B-only run' });
          await waitForRunCompletion(harnessB.bureau, runOnBOnly.id);
        } finally {
          unsubscribeA();
        }
      });

      afterAll(async () => {
        await harnessA.bureau.dispose();
        await harnessB.bureau.dispose();
        // Fixture dispose() already deletes only paths IT allocated
        // (`owned: true`) and leaves a caller-supplied path untouched — a
        // second, unconditional `rm` here would duplicate that ownership
        // check and could delete a real caller-supplied path if this test
        // ever passed one explicitly. Rely on the fixtures' own dispose().
        await storageA.dispose();
        await storageB.dispose();
      });

      it('has distinct storage paths (when persistent) and distinct clocks', () => {
        // Memory fixtures have no path — this assertion is vacuously
        // satisfied by both being `undefined` only when paths genuinely
        // can't collide; sqlite/lmdb always assert a concrete inequality.
        if (storageA.path !== undefined || storageB.path !== undefined) {
          expect(storageA.path).not.toBe(storageB.path);
        }
        expect(runtimeA.clock.now()).not.toBe(runtimeB.clock.now());
      });

      it('mints identifiers independently', () => {
        expect(runA.id).toBe('run-1');
        expect(runB.id).toBe('run-1');
      });

      it('never fires the other runtime when advancing timers', async () => {
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
      });

      it('never lets A observe B-only events', () => {
        expect(eventsSeenByA).toEqual([]);
      });
    },
  );
});
