import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GenerateFunction } from '@lostgradient/operative';
import { createAgent } from '@lostgradient/operative';
import { createFaultEngine, type FaultPlan, waitForCondition } from '@lostgradient/operative/test';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { createTool, createToolbox } from 'armorer';
import { file } from 'bun';
import { afterEach, describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';
import { z } from 'zod';

import {
  type BureauTestHarness,
  type BureauTestHarnessOptions,
  createBureauTestHarness,
} from './harness';
import {
  assertBureauQuiescent,
  BureauQuiescenceError,
  type BureauQuiescenceReport,
} from './quiescence';
import { createMemoryStorageFixture, createSqliteStorageFixture } from './storage-fixtures';

function mockGenerate(content = 'Done.'): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

/** Never resolves and never checks its `AbortSignal` — a deliberately-hung provider call. */
function hungGenerate(): GenerateFunction {
  return () => new Promise<never>(() => {});
}

/**
 * Blocks forever unless the run's `AbortSignal` fires, matching a
 * well-behaved provider — `lifecycle-contract/support.ts`'s
 * `createBlockingGenerate` (not exported from a shared package this suite
 * can import, so reimplemented here). Used to reproduce AB-339's exact
 * repro shape: `run.abort()` called synchronously, before the deferred
 * durable workflow has even started driving.
 */
function blockingGenerate(): GenerateFunction {
  return (context) =>
    new Promise((resolve) => {
      if (context.signal?.aborted) {
        resolve({ content: 'aborted', toolCalls: [] });
        return;
      }
      context.signal?.addEventListener(
        'abort',
        () => resolve({ content: 'aborted', toolCalls: [] }),
        { once: true },
      );
    });
}

/**
 * A toolbox whose one tool never resolves, plus a `generate` that calls it
 * exactly once. A durable run built on these commits its first STEP (the
 * tool-call step) — persisting real durable state — before hanging inside
 * the tool's `execute()`, unlike `hungGenerate()` alone, which hangs on the
 * very first model call and never persists anything durably at all.
 */
function hangingDurableFixture() {
  let called = false;
  const generate: GenerateFunction = async () => {
    if (called) return { content: '', toolCalls: [] };
    called = true;
    return { content: '', toolCalls: [{ id: 'call-1', name: 'hang', arguments: {} }] };
  };
  const toolbox = createToolbox([
    createTool({
      name: 'hang',
      version: '1.0.0',
      description:
        'Never resolves on its own, but honors an abort so toolbox.shutdown() can settle.',
      input: z.object({}),
      execute: (_input, context) =>
        new Promise<never>((_resolve, reject) => {
          const signal = context.signal;
          if (signal && 'addEventListener' in signal) {
            signal.addEventListener('abort', () => reject(new Error('hang tool aborted')), {
              once: true,
            });
          }
        }),
    }),
  ]);
  return { generate, toolbox };
}

const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (disposals.length > 0) {
    const dispose = disposals.pop()!;
    await dispose();
  }
});

async function harnessWithMemoryStorage(
  overrides: Partial<BureauTestHarnessOptions> = {},
): Promise<BureauTestHarness> {
  const storage = createMemoryStorageFixture();
  const harness = await createBureauTestHarness({
    agents: {
      worker: createAgent({ name: 'worker', generate: mockGenerate('worker done') }),
    },
    generate: mockGenerate(),
    ...overrides,
    storage,
  });
  disposals.push(async () => {
    await harness.bureau.dispose();
    await storage.dispose();
  });
  return harness;
}

describe('assertBureauQuiescent / BureauTestHarness.close()', () => {
  it("imports nothing outside bureau's own internals plus the documented public packages", async () => {
    const source = await file(new URL('./quiescence.ts', import.meta.url)).text();
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
    const allowedPackages = new Set(['@lostgradient/operative/test']);

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      const allowed = specifier.startsWith('.') || allowedPackages.has(specifier);
      expect(allowed).toBe(true);
    }
  });

  it('resolves quiescent, with every row empty, once a run has completed and nothing else is outstanding', async () => {
    const harness = await harnessWithMemoryStorage();

    const run = harness.startRun('worker', 'hello');
    await run.result();

    const report = await harness.close();

    expect(report.quiescent).toBe(true);
    expect(report.leaked).toEqual([]);
    expect(report.activeRoots).toEqual([]);
    expect(report.activeDescendants).toEqual([]);
    expect(report.pendingWebhookDeliveries).toEqual([]);
    expect(report.durableAttempts).toEqual([]);
    expect(report.runningScheduleFires).toEqual([]);
    expect(report.parkedWaits).toEqual([]);
    expect(report.pendingHookEffects).toEqual([]);
    expect(report.pendingAuditWrites).toEqual([]);
    expect(report.activeEvaluations).toEqual([]);
    expect(report.openStorageResources).toEqual([]);
    expect(report.incomplete).toEqual([]);
    expect(report.detached).toEqual([]);
  });

  it('close() is idempotent: a second call returns the exact same report without shutting down twice', async () => {
    const harness = await harnessWithMemoryStorage();
    const run = harness.startRun('worker', 'hello');
    await run.result();

    const first = await harness.close();
    const second = await harness.close();

    expect(second).toBe(first);
    expect(harness.bureau.completed).toBe(true);
  });

  it('close() never calls bureau.dispose() as a substitute for shutdown() — the shutdown report is what resolves the promise', async () => {
    const harness = await harnessWithMemoryStorage();
    const run = harness.startRun('worker', 'hello');
    await run.result();

    const report = await harness.close();

    expect(report.shutdownReport.admissionClosed).toBe(true);
    expect(report.shutdownReport.policy).toBe('abort');
  });

  describe('the five negative leak kinds', () => {
    it('names a child run left non-terminal (kind "child", discovered via ChildRunRegistry)', async () => {
      const harness = await harnessWithMemoryStorage({
        agents: {
          worker: createAgent({ name: 'worker', generate: mockGenerate() }),
          stuck: createAgent({ name: 'stuck', generate: hungGenerate() }),
        },
      });

      const parent = harness.startRun('worker', 'parent');
      const child = harness.startChild(parent.snapshot().id, 'stuck', 'child input');

      try {
        await harness.close();
        throw new Error('expected close() to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(BureauQuiescenceError);
        const report = (error as BureauQuiescenceError).report;
        expect(report.quiescent).toBe(false);
        expect(report.activeDescendants).toHaveLength(1);
        expect(report.activeDescendants[0]?.kind).toBe('child');
        expect(report.activeDescendants[0]?.identifier).toBe(child.childRunId);
        expect(report.activeDescendants[0]?.discoveredVia).toBe('public-child-discovery');
        expect(report.leaked).toContainEqual(report.activeDescendants[0]!);
      }
    });

    it('names a timer never cleared (kind "timer", discovered via runtime-services-timers)', async () => {
      const harness = await harnessWithMemoryStorage();

      const handle = harness.runtime.timers.setTimeout(() => {}, 999_999);
      harness.scope.register({ kind: 'timer', identifier: 'leftover-timer', handle });

      try {
        await harness.close();
        throw new Error('expected close() to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(BureauQuiescenceError);
        const report = (error as BureauQuiescenceError).report;
        const leak = report.leaked.find((entry) => entry.kind === 'timer');
        expect(leak?.identifier).toBe('leftover-timer');
        expect(leak?.discoveredVia).toBe('runtime-services-timers');
      } finally {
        harness.runtime.timers.clearTimeout(handle);
      }
    });

    it('names an event subscription never disposed (kind "listener", discovered via public-child-discovery)', async () => {
      const harness = await harnessWithMemoryStorage();

      // A raw `Subscription` a test never unsubscribed — deliberately NOT
      // `harness.bureau.subscribe(...)`: `bureau.shutdown()`'s own teardown
      // completes its event target (`emitter.complete()`), which closes
      // every subscription against it as a SIDE EFFECT of shutting down
      // cleanly — exactly the outcome this test must NOT get for free, so
      // it leaks a subscription against something shutdown does not touch.
      const subscription = { closed: false, unsubscribe() {} };
      harness.scope.register({ kind: 'listener', identifier: 'leftover-listener', subscription });

      try {
        await harness.close();
        throw new Error('expected close() to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(BureauQuiescenceError);
        const report = (error as BureauQuiescenceError).report;
        const leak = report.leaked.find((entry) => entry.kind === 'listener');
        expect(leak?.identifier).toBe('leftover-listener');
      } finally {
        subscription.unsubscribe();
      }
    });

    it('names a queue item still resident — a webhook delivery left "pending" — (kind "queue-item", discovered via public-snapshot)', async () => {
      const harness = await harnessWithMemoryStorage({
        webhooks: {
          targets: [{ url: 'https://example.test/webhook' }],
          fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
        },
      });
      expect(harness.bureau.webhookNotifier).toBeDefined();
      expect(harness.bureau.kv).toBeDefined();

      // A delivery record left `pending` in the durable KV store with no
      // live in-memory tracked delivery behind it — exactly the "restart
      // resumption is out of scope for v1" gap `webhook-notifier.ts`'s own
      // module doc names: a record this harness's live notifier never
      // claimed, so its `dispose()` drain (which only awaits deliveries it
      // is actively tracking) never touches it. Written through the same
      // PUBLIC `bureau.kv` surface `webhookNotifier.listDeliveries()` itself
      // reads back from — never a private Map.
      await harness.bureau.kv!.set(
        'webhook-delivery:v1:leaked-delivery-1',
        JSON.stringify({
          id: 'leaked-delivery-1',
          triggerType: 'approval-pending',
          targetUrl: 'https://example.test/webhook',
          runId: 'run-nonexistent',
          status: 'pending',
          attempts: 1,
          createdAt: 0,
          updatedAt: 0,
        }),
      );

      try {
        await harness.close();
        throw new Error('expected close() to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(BureauQuiescenceError);
        const report = (error as BureauQuiescenceError).report;
        expect(report.pendingWebhookDeliveries).toHaveLength(1);
        expect(report.pendingWebhookDeliveries[0]?.identifier).toBe('leaked-delivery-1');
        expect(report.pendingWebhookDeliveries[0]?.discoveredVia).toBe('public-snapshot');
        expect(report.leaked).toContainEqual(report.pendingWebhookDeliveries[0]!);
      }
    });

    it('names a durable owner with no live process-local owner and no recorded detachment (kind "durable-owner", discovered via public-snapshot)', async () => {
      const { generate, toolbox } = hangingDurableFixture();
      const harness = await harnessWithMemoryStorage({
        agents: {},
        generate,
        toolbox,
        durableExecution: true,
      });

      const summary = await harness.startSession({ message: 'durable run that never finishes' });
      // Waits for the DURABLE engine's own persisted state (not just
      // Bureau's in-memory `getRun` status, which flips to "running" before
      // the engine commits a first checkpoint) to actually exist and read
      // non-terminal — the fact this negative test is asserting.
      await waitForCondition(async () => {
        const state = await harness.bureau.getDurableRun(summary.id);
        return state !== null && state !== undefined && state.status === 'running';
      }, 'durable run never reached a persisted "running" state');
      // Registered by runId only — the process-local `AgentRun`/`ActiveRun`
      // handle for this run was never captured by `harness.scope`, matching
      // the negative test's "no live process-local owner" framing.
      harness.registerDurableRun(summary.id);

      try {
        await harness.close();
        throw new Error('expected close() to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(BureauQuiescenceError);
        const report = (error as BureauQuiescenceError).report;
        expect(report.durableAttempts).toHaveLength(1);
        expect(report.durableAttempts[0]?.identifier).toBe(summary.id);
        expect(report.durableAttempts[0]?.discoveredVia).toBe('public-snapshot');
        expect(report.leaked).toContainEqual(report.durableAttempts[0]!);
        expect(report.detached).toEqual([]);
      }
    });
  });

  it('a deliberately detached durable run appears under "detached", never under a leak row, and stays discoverable through bureau.getDurableRun after the harness closed', async () => {
    // `bureau.shutdown()`'s own teardown disposes the durable engine
    // instance, so re-querying that SAME (now-disposed) engine after
    // `close()` proves nothing about durability — a disposed in-process
    // engine object legitimately answers `null` regardless of whether the
    // underlying data survived. Proving "detachment is a real, recorded
    // outcome" (the AC's own framing) means proving the DATA survived —
    // reattaching through a SECOND, independently-constructed harness over
    // the SAME on-disk SQLite file after the first harness closed. A
    // caller-supplied (`owned: false`) path, per storage-fixtures.ts's own
    // contract, is never deleted by either fixture's `dispose()`.
    const runtime1 = createManualRuntimeServices();
    const path = join(
      tmpdir(),
      `ab-262-detachment-${runtime1.identifiers.next('detachment-test-fixture')}.sqlite`,
    );
    try {
      const { generate, toolbox } = hangingDurableFixture();
      const storage1 = createSqliteStorageFixture({ runtime: runtime1, path });
      const harness = await createBureauTestHarness({
        agents: {},
        generate,
        toolbox,
        runtime: runtime1,
        storage: storage1,
        durableExecution: true,
      });

      const summary = await harness.startSession({ message: 'deliberately detached durable run' });
      await waitForCondition(async () => {
        const state = await harness.bureau.getDurableRun(summary.id);
        return state !== null && state !== undefined && state.status === 'running';
      }, 'durable run never reached a persisted "running" state');
      harness.registerDurableRun(summary.id, { detached: true });

      const report = await harness.close();

      expect(report.quiescent).toBe(true);
      expect(report.durableAttempts).toEqual([]);
      expect(report.detached).toContainEqual({ kind: 'durable-owner', id: summary.id });

      const runtime2 = createManualRuntimeServices();
      const storage2 = createSqliteStorageFixture({ runtime: runtime2, path });
      const secondHarness = await createBureauTestHarness({
        agents: {},
        generate: mockGenerate(),
        toolbox: createToolbox([]),
        runtime: runtime2,
        storage: storage2,
        durableExecution: true,
      });
      try {
        const state = await secondHarness.reattachDurable(summary.id);
        expect(state).toBeDefined();
        expect(state?.id).toBe(summary.id);
      } finally {
        await secondHarness.bureau.dispose();
        await storage2.dispose();
      }
    } finally {
      await rm(path, { force: true });
      await rm(`${path}-wal`, { force: true });
      await rm(`${path}-shm`, { force: true });
    }
  });

  it('AB-339: a directly aborted durable run reports quiescent even when the harness closes without the caller awaiting closed() first', async () => {
    // Real SQLite storage, matching the original reproduction
    // (`adapters/bureau-durable.ts`) — this bug does not reproduce against
    // the in-memory storage fixture, whose "disposed" backend still serves
    // reads, masking the race a real closed SQLite connection exposes.
    const runtime = createManualRuntimeServices();
    const path = join(
      tmpdir(),
      `ab-339-direct-abort-${runtime.identifiers.next('ab-339-fixture')}.sqlite`,
    );
    try {
      const generate = blockingGenerate();
      const storage = createSqliteStorageFixture({ runtime, path });
      const harness = await createBureauTestHarness({
        agents: { worker: createAgent({ name: 'worker', generate }) },
        generate,
        toolbox: createToolbox([]),
        runtime,
        storage,
        durableExecution: true,
      });

      // Abort called synchronously, right after `startRun` — matching
      // `driveDurableSequential`'s `targetedAbort` shape exactly: the
      // durable workflow has not even started driving yet
      // (`driveStarted` is still false inside the adapter), so `abort()`
      // fires the `AbortController` but does NOT yet call `engine.cancel()`
      // — that call is deferred to whenever `closed()` first runs its
      // `resolveDurableOutcome()`.
      const run = harness.startRun('worker', 'go');
      run.abort(
        'AB-339 regression: direct abort, harness closes without an explicit closed() await',
      );
      await run.result();
      // Deliberately NOT awaiting `run.closed()` here — AB-256's contract is
      // that `ResourceScope.close()` (via `harness.close()`) aborts every
      // registered run and awaits each `closed()` itself, so the caller
      // should never need this extra call for the harness to report
      // quiescent.

      const report = await harness.close();

      expect(report.quiescent).toBe(true);
      expect(report.leaked).toEqual([]);
      expect(report.activeRoots).toEqual([]);
    } finally {
      await rm(path, { force: true });
      await rm(`${path}-wal`, { force: true });
      await rm(`${path}-shm`, { force: true });
    }
  });

  it('distinguishes "incomplete" (a bounded shutdown wait elapsed) from "leaked" — an unresolved owner is reported under incomplete, never leaked, and quiescent stays true', async () => {
    let capturedSignal: AbortSignal | undefined;
    let releaseSleep!: () => void;
    const sleep = (_milliseconds: number, signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<void>((resolve) => {
        releaseSleep = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    const storage = createMemoryStorageFixture();
    const harness = await createBureauTestHarness({
      agents: {},
      generate: hungGenerate(),
      storage,
      scheduler: { enabled: true, idleDelay: 1 },
      shutdownTimeoutSleep: sleep,
    });
    disposals.push(async () => {
      await harness.bureau.dispose();
      await storage.dispose();
    });

    await harness.submitSchedulerTask({ priority: 'background', message: 'never finishes' });
    await waitForCondition(
      () => harness.bureau.scheduler?.getState().activeTask !== undefined,
      'scheduler task never started running',
    );

    const reportPromise = assertBureauQuiescent(harness, { timeoutMilliseconds: 50 });
    await waitForCondition(() => capturedSignal !== undefined, 'injected sleep was never called');
    releaseSleep();

    const report = await reportPromise;

    const schedulerIncomplete = report.incomplete.find((entry) => entry.kind === 'scheduler');
    expect(schedulerIncomplete?.reason).toBe('unresolved');
    expect(report.leaked.some((leak) => leak.kind === 'queue-item')).toBe(false);
    expect(report.quiescent).toBe(true);
  });

  it('AB-338: BureauTestHarness.close() with a bounded drain resolves a hung run as incomplete under the manual runtime, with no wall-clock wait and no manual clock advance in the test body', async () => {
    // Deliberately the REAL default `shutdownTimeoutSleep`
    // (`createDefaultShutdownTimeoutSleep`, driven by `runtime.timers` —
    // AB-260's deterministic contract), not an injected fake as the
    // preceding test uses: this test's whole point is that
    // `BureauTestHarness.close()` itself, not the test body, is what
    // advances a `ManualRuntimeServices` far enough for that real sleep to
    // ever resolve. Before AB-338, this `close()` call hung forever —
    // nothing in the harness or this test advanced the clock, so the
    // default sleep's timer never fired.
    const storage = createMemoryStorageFixture();
    const harness = await createBureauTestHarness({
      agents: {},
      generate: hungGenerate(),
      storage,
      scheduler: { enabled: true, idleDelay: 1 },
    });
    disposals.push(async () => {
      await harness.bureau.dispose();
      await storage.dispose();
    });

    // The hung run: a scheduler-dispatched background task whose generate
    // call never resolves and is never aborted under a 'drain' policy —
    // `scheduler.stop()` awaits it directly, so it is what makes the
    // 'scheduler' owner unresolved when the bounded wait elapses.
    await harness.submitSchedulerTask({ priority: 'background', message: 'never finishes' });
    await waitForCondition(
      () => harness.bureau.scheduler?.getState().activeTask !== undefined,
      'scheduler task never started running',
    );

    const report = await harness.close({ policy: 'drain', timeoutMilliseconds: 50 });

    const schedulerIncomplete = report.incomplete.find((entry) => entry.kind === 'scheduler');
    expect(schedulerIncomplete?.reason).toBe('unresolved');
    expect(report.quiescent).toBe(true);
  });

  it('AB-338: BureauTestHarness.close() with a bounded timeout against an already-quiescent bureau resolves cleanly, without waiting on a shutdown timer that was cleared before it ever appeared', async () => {
    // The counterpart to the preceding test: nothing here hangs, so
    // `bureau.shutdown()`'s own `chain` wins its race against the
    // timeout sleep and clears that sleep's timer before `close()`'s
    // internal poll loop ever has a chance to see it armed. `close()`
    // must recognize the report already settled and skip the advance
    // entirely, rather than waiting out `waitForCondition`'s full budget
    // for a timer that will never appear.
    const harness = await harnessWithMemoryStorage();
    const run = harness.startRun('worker', 'hello');
    await run.result();

    const report = await harness.close({ timeoutMilliseconds: 50 });

    expect(report.quiescent).toBe(true);
    expect(report.incomplete).toEqual([]);
    expect(report.shutdownReport.unresolved).toBe(0);
  });

  it('AB-338: BureauTestHarness.close() with a negative timeoutMilliseconds still finds the timer it armed (clamped to "now", matching ManualRuntimeServices\' own clamp)', async () => {
    // A negative `timeoutMilliseconds` is a degenerate caller input, but
    // `ManualRuntimeServices.timers.setTimeout`/`.advance()` both clamp a
    // negative delay to `0` rather than rejecting it — so the timer
    // `bureau.shutdown()` actually arms lands at `now + 0`, never at
    // `now + (a negative number)`. `close()` must compute the SAME
    // clamped deadline it is waiting for, or it would report a false
    // "timeout was never armed" against a timer that, in fact, armed and
    // fired exactly as expected (review finding, PR #533).
    const storage = createMemoryStorageFixture();
    const harness = await createBureauTestHarness({
      agents: {},
      generate: hungGenerate(),
      storage,
      scheduler: { enabled: true, idleDelay: 1 },
    });
    disposals.push(async () => {
      await harness.bureau.dispose();
      await storage.dispose();
    });

    await harness.submitSchedulerTask({ priority: 'background', message: 'never finishes' });
    await waitForCondition(
      () => harness.bureau.scheduler?.getState().activeTask !== undefined,
      'scheduler task never started running',
    );

    const report = await harness.close({ policy: 'drain', timeoutMilliseconds: -50 });

    const schedulerIncomplete = report.incomplete.find((entry) => entry.kind === 'scheduler');
    expect(schedulerIncomplete?.reason).toBe('unresolved');
    expect(report.quiescent).toBe(true);
  });

  it('BureauQuiescenceError renders the incomplete and detached rows too, when a report carries both alongside a real leak', () => {
    const report: BureauQuiescenceReport = {
      scope: 'unit-test',
      quiescent: false,
      leaked: [
        { kind: 'timer', identifier: 'leaked-timer', discoveredVia: 'runtime-services-timers' },
      ],
      detached: [{ kind: 'durable-owner', id: 'detached-run-1' }],
      activeRoots: [],
      activeDescendants: [],
      runningScheduleFires: [],
      parkedWaits: [],
      pendingHookEffects: [],
      pendingAuditWrites: [],
      activeEvaluations: [],
      pendingWebhookDeliveries: [],
      openStorageResources: [],
      durableAttempts: [],
      incomplete: [{ kind: 'scheduler', id: 'task-1', reason: 'unresolved' }],
      shutdownReport: {
        admissionClosed: true,
        policy: 'abort',
        requested: 1,
        completed: 0,
        failed: 0,
        unresolved: 1,
        notRequired: 0,
        owners: [{ kind: 'scheduler', id: 'task-1', outcome: 'unresolved' }],
      },
    };

    const error = new BureauQuiescenceError(report);

    expect(error.message).toContain('leaked-timer');
    expect(error.message).toContain('Incomplete');
    expect(error.message).toContain('scheduler "task-1" (unresolved)');
    expect(error.message).toContain('Detached');
    expect(error.message).toContain('durable-owner "detached-run-1"');
  });
});

describe('AB-322: fault-forced leftovers populate the corresponding rows', () => {
  it('a schedule fire blocked (createFaultEngine) past a bounded shutdown names the task in runningScheduleFires, not leaked — the "scheduler" owner is already incomplete', async () => {
    const runtime = createManualRuntimeServices();
    let onReachedCalled = false;
    let releaseFire!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFire = resolve;
    });
    const plan: FaultPlan = [
      {
        id: 'blocked-schedule-fire',
        boundary: 'before-work',
        operation: 'generate',
        occurrence: { kind: 'every' },
        effect: {
          kind: 'block',
          release,
          onReached: () => {
            onReachedCalled = true;
          },
        },
      },
    ];
    const engine = createFaultEngine(plan, runtime);

    const storage = createMemoryStorageFixture();
    const harness = await createBureauTestHarness({
      agents: {},
      generate: engine.wrapGenerate(mockGenerate()),
      storage,
      runtime,
      scheduler: { enabled: true, idleDelay: 1 },
    });
    disposals.push(async () => {
      releaseFire();
      await harness.bureau.dispose();
      await storage.dispose();
    });

    await harness.submitSchedulerTask({ priority: 'background', message: 'blocked fire' });
    await waitForCondition(
      () => onReachedCalled,
      'fault engine block on the schedule fire was never reached',
    );

    const report = await harness.close({ timeoutMilliseconds: 50 });

    expect(report.runningScheduleFires).toHaveLength(1);
    const fire = report.runningScheduleFires[0]!;
    expect(fire.identifier).toBeDefined();
    expect(fire.discoveredVia).toBe('public-snapshot');
    expect(report.leaked).not.toContainEqual(fire);
    const incomplete = report.incomplete.find((entry) => entry.kind === 'scheduler');
    expect(incomplete?.reason).toBe('unresolved');
    expect(report.quiescent).toBe(true);

    releaseFire();
  });

  it('a judge evaluation blocked (createFaultEngine.wrapStorage, on the evaluation\'s own audit-record write) past a bounded shutdown names it in activeEvaluations, not leaked — the "online-evals" owner is already incomplete', async () => {
    // Deliberately NOT `wrapGenerate` on the judge's own model call: online
    // evals' `evaluateRun` (`online-evals.ts`) races EVERY judge call
    // against the same background-shutdown `AbortSignal` `bureau.shutdown()`
    // fires — so a judge blocked on ITS OWN generate call is abandoned
    // (untracked) the instant that signal aborts, regardless of whether the
    // underlying call ever actually settles, and never stays observable
    // past shutdown. `recordScore`'s `auditTrail.record()` write, right
    // after the judge returns, is NOT raced against that signal — blocking
    // IT (the same `storage:set` mechanism the audit-write test above
    // uses) keeps the evaluation genuinely, observably in flight.
    const runtime = createManualRuntimeServices();
    let onReachedCalled = false;
    let releaseWrite!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const plan: FaultPlan = [
      {
        id: 'blocked-eval-write',
        boundary: 'before-work',
        operation: 'storage:set',
        occurrence: { kind: 'every' },
        effect: {
          kind: 'block',
          release,
          onReached: () => {
            onReachedCalled = true;
          },
        },
      },
    ];
    const engine = createFaultEngine(plan, runtime);
    const rawStorage = new MemoryStorage();
    const kv = textValueStore(rawStorage);
    const wrappedKv = engine.wrapStorage(kv);

    const storage = createMemoryStorageFixture();
    const harness = await createBureauTestHarness({
      agents: {
        worker: createAgent({ name: 'worker', generate: mockGenerate('worker done') }),
      },
      generate: mockGenerate(),
      persistence: wrappedKv,
      storage,
      runtime,
      onlineEvals: {
        judges: [
          {
            name: 'instant-judge',
            async evaluate() {
              return { pass: true, score: 1, message: 'ok' };
            },
          },
        ],
        sampleRate: 1,
        rng: () => 0,
      },
    });
    disposals.push(async () => {
      releaseWrite();
      await harness.bureau.dispose();
      await storage.dispose();
      rawStorage[Symbol.dispose]();
    });

    // `bureau.run()` catalog dispatch (`harness.startRun`) never touches
    // the operative `Store`, so it never emits the `'action'` events
    // `createOnlineEvalSampler` listens for (or that `audit-trail.ts`
    // listens for, below) — only `startSession`'s
    // `createRun`/`createRunFromRequest` path does. `maximumSteps: 1`
    // forces `'run.completed'` on the very first step (`mockGenerate`'s
    // empty `toolCalls` never signals completion on its own).
    await harness.startSession({ message: 'hello', maximumSteps: 1 });
    await waitForCondition(
      () => onReachedCalled,
      'fault engine block on the evaluation audit write was never reached',
    );

    const report = await harness.close({ timeoutMilliseconds: 50 });

    expect(report.activeEvaluations).toHaveLength(1);
    const evaluation = report.activeEvaluations[0]!;
    expect(evaluation.identifier).toBeDefined();
    expect(evaluation.discoveredVia).toBe('public-snapshot');
    expect(report.leaked).not.toContainEqual(evaluation);
    const incomplete = report.incomplete.find((entry) => entry.kind === 'online-evals');
    expect(incomplete?.reason).toBe('unresolved');
    expect(report.quiescent).toBe(true);

    releaseWrite();
  });

  it('an audit write blocked (createFaultEngine.wrapStorage on the bare persistence KV) past a bounded shutdown names it in pendingAuditWrites via runtime.outstandingDeferred(), not leaked — the "audit-trail" owner is already incomplete', async () => {
    const runtime = createManualRuntimeServices();
    let onReachedCalled = false;
    let releaseWrite!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const plan: FaultPlan = [
      {
        id: 'blocked-audit-write',
        boundary: 'before-work',
        operation: 'storage:set',
        occurrence: { kind: 'nth', n: 1 },
        effect: {
          kind: 'block',
          release,
          onReached: () => {
            onReachedCalled = true;
          },
        },
      },
    ];
    const engine = createFaultEngine(plan, runtime);
    const rawStorage = new MemoryStorage();
    const kv = textValueStore(rawStorage);
    const wrappedKv = engine.wrapStorage(kv);

    const storage = createMemoryStorageFixture();
    const harness = await createBureauTestHarness({
      agents: {
        worker: createAgent({ name: 'worker', generate: mockGenerate('worker done') }),
      },
      generate: mockGenerate(),
      persistence: wrappedKv,
      storage,
      runtime,
    });
    disposals.push(async () => {
      releaseWrite();
      await harness.bureau.dispose();
      await storage.dispose();
      rawStorage[Symbol.dispose]();
    });

    // `harness.startRun` (catalog dispatch) never touches the operative
    // `Store` and so never emits an action the audit trail's listener
    // sees — only `startSession` does (see the evaluation test above for
    // the same distinction). The write is fire-and-forget from the run's
    // own perspective, so there is no need to wait for the session to
    // finish — only for the fault plan to have been reached.
    await harness.startSession({ message: 'hello', maximumSteps: 1 });
    await waitForCondition(
      () => onReachedCalled,
      'fault engine block on the audit write was never reached',
    );

    const report = await harness.close({ timeoutMilliseconds: 50 });

    expect(report.pendingAuditWrites).toHaveLength(1);
    const write = report.pendingAuditWrites[0]!;
    expect(write.identifier).toBe('audit-write#1');
    expect(write.owner).toBe('audit-trail');
    expect(write.discoveredVia).toBe('runtime-services-deferred');
    expect(report.leaked).not.toContainEqual(write);
    const incomplete = report.incomplete.find((entry) => entry.kind === 'audit-trail');
    expect(incomplete?.reason).toBe('unresolved');
    expect(report.quiescent).toBe(true);

    releaseWrite();
  });

  it('a call blocked on the memory storage fixture\'s own instance is named by openHandles(), reported in openStorageResources, and IS folded into leaked (unlike the three rows above, nothing shadows this one under "incomplete")', async () => {
    const runtime = createManualRuntimeServices();
    let onReachedCalled = false;
    let releaseGet!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    const plan: FaultPlan = [
      {
        id: 'blocked-storage-get',
        boundary: 'before-work',
        operation: 'storage:get',
        occurrence: { kind: 'nth', n: 1 },
        effect: {
          kind: 'block',
          release,
          onReached: () => {
            onReachedCalled = true;
          },
        },
      },
    ];
    const engine = createFaultEngine(plan, runtime);
    // A plain `engine.wrapStorage(raw)` would block the FIRST `get#N` this
    // instance ever sees — which, on this instance, is the session store's
    // own bootstrap read, not the audit query below. This thin router
    // (test-local, matching the pattern `fault-plan.ts` documents for
    // Bureau-scoped addressing) sends only an audit-prefixed key through
    // the fault-engine-wrapped path; every other key (session store,
    // anything else) reaches `raw` untouched.
    const storage = createMemoryStorageFixture({
      wrapStorage: (raw) => {
        const faulted = engine.wrapStorage(raw);
        return new Proxy(raw, {
          get(target, property, receiver) {
            if (property !== 'get') {
              const value: unknown = Reflect.get(target, property, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return async (key: string) => {
              if (key.startsWith('audit:v1:')) {
                return faulted.get(key);
              }
              return target.get(key);
            };
          },
        });
      },
    });
    const harness = await createBureauTestHarness({
      agents: {
        worker: createAgent({ name: 'worker', generate: mockGenerate('worker done') }),
      },
      generate: mockGenerate(),
      storage,
      runtime,
    });
    disposals.push(async () => {
      releaseGet();
      await harness.bureau.dispose();
      await storage.dispose();
    });

    // Writes the audit record `auditTrail.query()` below reads back —
    // deliberately unblocked (only `storage:get` is faulted, and this is
    // the run's own `storage:set`), so this session completes normally.
    // `harness.startRun` (catalog dispatch) never touches the operative
    // `Store` and so never produces an audit record at all — see the
    // evaluation test above for the same distinction; `startSession` is
    // the one dispatch path that does. Waited for via `bureau.getRun` (a
    // pure in-memory read, never touching `storage`) rather than
    // `auditTrail.query()` itself — polling with `query()` here would walk
    // straight into the SAME `nth: 1` block this test means to trigger
    // deliberately, deadlocking the wait on itself.
    const summary = await harness.startSession({ message: 'hello', maximumSteps: 1 });
    await waitForCondition(
      () => harness.bureau.getRun(summary.id)?.status === 'completed',
      'session run never completed',
    );

    // A genuinely public read: `bureau.auditTrail.query()` (AB-262 already
    // documents `auditTrail` as public Bureau surface) lists the prefix,
    // then `kv.get()`s each key — the second step is what the fault plan
    // above blocks.
    const queryPromise = harness.bureau.auditTrail?.query();
    await waitForCondition(
      () => onReachedCalled,
      'fault engine block on the storage get was never reached',
    );
    expect(storage.openHandles()).toHaveLength(1);
    expect(storage.openHandles()[0]).toMatch(/^get#\d+$/);

    try {
      await harness.close();
      throw new Error('expected harness.close() to reject with BureauQuiescenceError');
    } catch (error) {
      expect(error).toBeInstanceOf(BureauQuiescenceError);
      const report = (error as BureauQuiescenceError).report;
      const resource = report.openStorageResources[0]!;
      expect(report.openStorageResources).toHaveLength(1);
      expect(resource.identifier).toMatch(/^get#\d+$/);
      expect(resource.owner).toBe('storage');
      expect(resource.discoveredVia).toBe('public-snapshot');
      expect(report.leaked).toContainEqual(resource);
      expect(report.quiescent).toBe(false);
    }

    releaseGet();
    await queryPromise;
  });
});
