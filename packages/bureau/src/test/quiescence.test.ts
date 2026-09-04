import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GenerateFunction } from '@lostgradient/operative';
import { createAgent } from '@lostgradient/operative';
import { waitForCondition } from '@lostgradient/operative/test';
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
