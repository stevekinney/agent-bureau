import {
  activity,
  Engine,
  Scheduler,
  workflow,
  WorkflowClaimUnavailableError,
  type WorkflowLogRecord,
  type WorkflowStatus,
} from '@lostgradient/weft';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { WorkflowVersionMismatchEvent } from '../events';
import { createCheckpointStore } from './checkpoint-store';
import { createRunEngine } from './create-run-engine';

// A run is "parked" — not finished — when its status is neither completed nor a
// failure terminal. Asserting non-terminal (rather than a specific intermediate
// status) is robust to which intermediate Weft reports: `snapshot()` gives
// 'pending' for a still-queued inline start and 'running' once the generator has
// reached the sleep — both are non-terminal.
const TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

// Drain Weft's deferred inline-launch queue between tests — a pending setTimeout(0)
// inline-launch left by one durable run can starve a later one under full
// `bun test` concurrency (CI). 0.3.0's dispose-drain does not replace this flush.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

/**
 * A throwaway workflow standing in for the real `agentRun` body (which depends
 * on the loop refactor). Task #6 only verifies the engine WIRING — that
 * `createRunEngine` registers the workflow + activities and boots a runnable
 * engine — so a trivial workflow is sufficient and keeps this test independent.
 */
function makeProbeWorkflow() {
  // Weft requires the `.activities({ key })` key to match the activity's inner
  // `name` (and the same for `Engine.create({ activities })`).
  const probe = activity({
    name: 'probe',
    execute: async (input: { value: number }) => ({ doubled: input.value * 2 }),
  });
  return workflow({ name: 'agentRun' })
    .activities({ probe })
    .execute(async function* (ctx, input: { value: number }) {
      const result = yield* ctx.run('probe', input);
      return result;
    });
}

/**
 * A probe workflow that emits a `ctx.log` record so the `onLog` host sink can be
 * observed. Named `agentRun` like the real body so `engine.start('agentRun', …)`
 * resolves it.
 */
function makeLoggingWorkflow() {
  const probe = activity({
    name: 'probe',
    execute: async (input: { value: number }) => ({ doubled: input.value * 2 }),
  });
  return workflow({ name: 'agentRun' })
    .activities({ probe })
    .execute(async function* (ctx, input: { value: number }) {
      ctx.log?.info('probe running', { value: input.value });
      const result = yield* ctx.run('probe', input);
      return result;
    });
}

function makeRecoverableServicesWorkflow(sleepMilliseconds: number) {
  return workflow({ name: 'agentRun' })
    .services<{ multiplier: number }>()
    .execute(async function* (ctx, input: { value: number }) {
      yield* ctx.sleep(sleepMilliseconds);
      const services = ctx.services;
      if (!services) throw new Error('missing services');
      return { multiplied: input.value * services.multiplier };
    });
}

// Weft's durable-timer poller fires due `ctx.sleep` timers when the scheduler is
// armed. The positive (`startScheduler:true`) and recovery tests use a short sleep
// so an armed poller drives the run to completion promptly; they await `result()`,
// so a starved poller delays the test rather than failing it falsely.
const DURABLE_SLEEP_MILLISECONDS = 50;
// Sleep duration used by the negative (unarmed-poller) test below and the
// (AB-330-split) poller-unarmed proof tests in
// create-run-engine-poller-unarmed.test.ts — short enough that a real-time
// poller would fire it quickly, making those tests falsifiable.
const PARKED_SLEEP_MILLISECONDS = DURABLE_SLEEP_MILLISECONDS;
// Scheduler poll interval injected into negative-test engines so that an
// accidentally armed poller fires expired timers within a few milliseconds.
const DETECTION_SCHEDULER_POLL_INTERVAL_MS = 1;
// Fixed, arbitrarily far-future epoch millisecond value used to drive
// maintenance/scheduler ticks unambiguously past a parked timer's deadline.
// Not derived from the real clock (AB-330): the deadline itself is computed
// from Weft's real getNow() when ctx.sleep() ran, bounded by whenever the
// test executes — far short of this constant — so any sufficiently distant
// future instant works just as well as `Date.now() + margin`.
const FAR_FUTURE_EPOCH_MILLISECONDS = 4_102_444_800_000; // 2100-01-01T00:00:00.000Z

// Logged by makeSleepingWorkflow on the step BEFORE ctx.sleep. Observing it via
// the onLog sink is positive proof the generator actually reached the sleep —
// "non-terminal" alone would also hold if the run never started, which is not
// what the parked-timer tests mean to assert.
const REACHED_SLEEP_MARKER = 'reached sleep';

/**
 * A probe workflow that parks on a durable `ctx.sleep` before finishing. It logs
 * {@link REACHED_SLEEP_MARKER} on the step immediately before the sleep, so a test
 * can prove the generator reached the timer. The sleep only resolves when the
 * engine's durable-timer scheduler runs (its armed poller, or an explicit
 * `engine.scheduler.tick(...)`), so this workflow's completion is a direct
 * observation of whether the scheduler drove the timer (the #590 seam).
 */
function makeSleepingWorkflow(sleepMilliseconds: number) {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx, input: { value: number }) {
    ctx.log?.info(REACHED_SLEEP_MARKER);
    yield* ctx.sleep(sleepMilliseconds);
    return { doubled: input.value * 2 };
  });
}

// Generously-bounded poll: yield the portable event loop until `predicate` holds.
// The bound exists only to turn a genuine hang into a clear failure; it sits far
// above what any non-hung durable transition needs, so loaded-CI scheduling jitter
// and the inline-launch starvation this file otherwise guards against cannot turn a
// passing run red. It is a backstop, NOT a tuned timing value.
const POLL_UNTIL_MAX_ATTEMPTS = 1000;
async function pollUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < POLL_UNTIL_MAX_ATTEMPTS; attempt++) {
    if (await predicate()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('pollUntil exceeded its attempt bound before the condition held');
}

describe('createRunEngine', () => {
  it('boots an engine that registers and runs the injected workflow', async () => {
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeProbeWorkflow(),
      recover: false,
    });

    try {
      const handle = await engine.start('agentRun', { value: 21 });
      const result = await handle.result();
      expect(result).toEqual({ doubled: 42 });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('returns a checkpoint store backed by the same storage', async () => {
    const storage = new MemoryStorage();
    const { engine, checkpointStore } = await createRunEngine({
      storage,
      runWorkflow: makeProbeWorkflow(),
      recover: false,
    });

    try {
      // The returned checkpoint store writes through to the shared backend.
      const fullCursor = {
        step: 4,
        totalUsage: { prompt: 0, completion: 0, total: 0 },
        lastContent: '',
        schemaAttempts: 0,
        lastAppliedConfigVersion: 0,
      };
      await checkpointStore.saveCursor('run-x', fullCursor);
      expect(await checkpointStore.loadCursor('run-x')).toEqual(fullCursor);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('uses an injected checkpoint store when provided', async () => {
    const storage = new MemoryStorage();
    const { textValueStore } = await import('@lostgradient/weft/storage');
    const injected = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );

    const { engine, checkpointStore } = await createRunEngine({
      storage,
      runWorkflow: makeProbeWorkflow(),
      recover: false,
      checkpointStore: injected,
    });

    try {
      expect(checkpointStore).toBe(injected);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('defaults recover to true when unspecified', async () => {
    // recover:true triggers recoverAll() on boot; against an empty MemoryStorage
    // that is a no-op, so the engine still boots cleanly. This guards the default.
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeProbeWorkflow(),
    });

    try {
      const handle = await engine.start('agentRun', { value: 5 });
      expect(await handle.result()).toEqual({ doubled: 10 });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('delegates recovered agentRun service resolution to the configured resolver', async () => {
    const storage = new MemoryStorage();
    const runWorkflow = makeRecoverableServicesWorkflow(DURABLE_SLEEP_MILLISECONDS);
    const firstEngine = await createRunEngine({
      storage,
      runWorkflow,
      recover: false,
      startScheduler: false,
    });

    try {
      const handle = await firstEngine.engine.start(
        'agentRun',
        { value: 7 },
        { id: 'recoverable-services-run', services: { multiplier: 2 } },
      );
      void handle.result().catch(() => {});
      for (let turn = 0; turn < 5; turn++) {
        await yieldToPortableEventLoop();
      }
    } finally {
      firstEngine.engine[Symbol.dispose]();
    }

    const seenWorkflowTypes: string[] = [];
    const { engine } = await createRunEngine({
      storage,
      runWorkflow,
      recover: false,
      startScheduler: true,
      resolveWorkflowServices: (info) => {
        seenWorkflowTypes.push(info.workflowType);
        return { status: 'available', services: { multiplier: 3 } };
      },
    });

    try {
      const handles = await engine.recoverAll();
      expect(handles).toHaveLength(1);
      expect(await handles[0]!.result()).toEqual({ multiplied: 21 });
      expect(seenWorkflowTypes).toEqual(['agentRun']);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('fails a recovered services-backed agentRun when no service resolver is configured', async () => {
    const storage = new MemoryStorage();
    const runWorkflow = makeRecoverableServicesWorkflow(DURABLE_SLEEP_MILLISECONDS);
    const firstEngine = await createRunEngine({
      storage,
      runWorkflow,
      recover: false,
      startScheduler: false,
    });

    try {
      const handle = await firstEngine.engine.start(
        'agentRun',
        { value: 7 },
        { id: 'unresolved-services-run', services: { multiplier: 2 } },
      );
      void handle.result().catch(() => {});
      for (let turn = 0; turn < 5; turn++) {
        await yieldToPortableEventLoop();
      }
    } finally {
      firstEngine.engine[Symbol.dispose]();
    }

    const { engine } = await createRunEngine({
      storage,
      runWorkflow,
      recover: false,
      startScheduler: true,
    });

    try {
      const handles = await engine.recoverAll();
      expect(handles).toHaveLength(1);
      try {
        await handles[0]!.result();
        throw new Error('expected recovered run to fail without services');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('has no configured workflow services resolver');
      }
    } finally {
      engine[Symbol.dispose]();
    }
  });

  // AB-10 — workflow versioning: `onWorkflowVersionMismatch` fires when a
  // recovered run's checkpointed `workflowVersion` differs from the currently
  // registered `runWorkflowVersion`, and recovery is NOT blocked by it
  // (pin-and-warn, unlike Weft's own `WorkflowDefinition.version` recovery
  // check — see `runWorkflowVersion`'s JSDoc).
  describe('workflow version mismatch on recovery', () => {
    it('fires onWorkflowVersionMismatch for a recovered run stamped with an older version', async () => {
      const storage = new MemoryStorage();
      const runWorkflow = makeRecoverableServicesWorkflow(DURABLE_SLEEP_MILLISECONDS);
      const checkpointStore = createCheckpointStore(
        textValueStore(storage, { disposeUnderlyingStorage: false }),
      );

      const firstEngine = await createRunEngine({
        storage,
        runWorkflow,
        checkpointStore,
        recover: false,
        startScheduler: false,
      });
      try {
        const handle = await firstEngine.engine.start(
          'agentRun',
          { value: 7 },
          { id: 'versioned-recovery-run', services: { multiplier: 2 } },
        );
        void handle.result().catch(() => {});
        for (let turn = 0; turn < 5; turn++) {
          await yieldToPortableEventLoop();
        }
      } finally {
        firstEngine.engine[Symbol.dispose]();
      }

      // `makeRecoverableServicesWorkflow` is a standalone probe (not the real
      // `agentRun` body from run-workflow.ts), so it never calls
      // `createRunWorkflow`'s stamping logic. Write the stamp directly here —
      // this is exactly what `createRunWorkflow`'s `version` option persists
      // for a real run (see run-workflow.test.ts's "workflow version stamping"
      // suite, which exercises the real stamping path end-to-end).
      await checkpointStore.saveCursor('versioned-recovery-run', {
        step: 0,
        totalUsage: { prompt: 0, completion: 0, total: 0 },
        lastContent: '',
        schemaAttempts: 0,
        lastAppliedConfigVersion: 0,
        workflowVersion: 'v1',
      });

      const mismatches: WorkflowVersionMismatchEvent[] = [];
      const { engine } = await createRunEngine({
        storage,
        runWorkflow,
        checkpointStore,
        recover: false,
        startScheduler: true,
        schedulerPollIntervalMs: DETECTION_SCHEDULER_POLL_INTERVAL_MS,
        runWorkflowVersion: 'v2',
        onWorkflowVersionMismatch: (event) => {
          mismatches.push(event);
        },
        resolveWorkflowServices: () => ({ status: 'available', services: { multiplier: 3 } }),
      });

      try {
        const handles = await engine.recoverAll();
        expect(handles).toHaveLength(1);
        // Recovery is NOT blocked by the mismatch — the run still completes
        // normally against the currently-deployed code (pin-and-warn).
        expect(await handles[0]!.result()).toEqual({ multiplied: 21 });
        expect(mismatches).toHaveLength(1);
        expect(mismatches[0]).toMatchObject({
          type: 'workflow.version-mismatch',
          runId: 'versioned-recovery-run',
          storedVersion: 'v1',
          registeredVersion: 'v2',
        });
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('does not fire onWorkflowVersionMismatch when the stamped and registered versions match', async () => {
      const storage = new MemoryStorage();
      const runWorkflow = makeRecoverableServicesWorkflow(DURABLE_SLEEP_MILLISECONDS);
      const checkpointStore = createCheckpointStore(
        textValueStore(storage, { disposeUnderlyingStorage: false }),
      );

      const firstEngine = await createRunEngine({
        storage,
        runWorkflow,
        checkpointStore,
        recover: false,
        startScheduler: false,
      });
      try {
        const handle = await firstEngine.engine.start(
          'agentRun',
          { value: 7 },
          { id: 'matched-version-run', services: { multiplier: 2 } },
        );
        void handle.result().catch(() => {});
        for (let turn = 0; turn < 5; turn++) {
          await yieldToPortableEventLoop();
        }
      } finally {
        firstEngine.engine[Symbol.dispose]();
      }

      await checkpointStore.saveCursor('matched-version-run', {
        step: 0,
        totalUsage: { prompt: 0, completion: 0, total: 0 },
        lastContent: '',
        schemaAttempts: 0,
        lastAppliedConfigVersion: 0,
        workflowVersion: 'v1',
      });

      const mismatches: WorkflowVersionMismatchEvent[] = [];
      const { engine } = await createRunEngine({
        storage,
        runWorkflow,
        checkpointStore,
        recover: false,
        startScheduler: true,
        schedulerPollIntervalMs: DETECTION_SCHEDULER_POLL_INTERVAL_MS,
        runWorkflowVersion: 'v1',
        onWorkflowVersionMismatch: (event) => {
          mismatches.push(event);
        },
        resolveWorkflowServices: () => ({ status: 'available', services: { multiplier: 3 } }),
      });

      try {
        const handles = await engine.recoverAll();
        expect(await handles[0]!.result()).toEqual({ multiplied: 21 });
        expect(mismatches).toHaveLength(0);
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('does not fire onWorkflowVersionMismatch when the run has no stamped version', async () => {
      const storage = new MemoryStorage();
      const runWorkflow = makeRecoverableServicesWorkflow(DURABLE_SLEEP_MILLISECONDS);
      const checkpointStore = createCheckpointStore(
        textValueStore(storage, { disposeUnderlyingStorage: false }),
      );

      const firstEngine = await createRunEngine({
        storage,
        runWorkflow,
        checkpointStore,
        recover: false,
        startScheduler: false,
      });
      try {
        const handle = await firstEngine.engine.start(
          'agentRun',
          { value: 7 },
          { id: 'unstamped-run', services: { multiplier: 2 } },
        );
        void handle.result().catch(() => {});
        for (let turn = 0; turn < 5; turn++) {
          await yieldToPortableEventLoop();
        }
      } finally {
        firstEngine.engine[Symbol.dispose]();
      }
      // No saveCursor call — this run's checkpoint carries no `workflowVersion`
      // at all (as if it predated versioning, or the engine that created it had
      // no `runWorkflowVersion` configured).

      const mismatches: WorkflowVersionMismatchEvent[] = [];
      const { engine } = await createRunEngine({
        storage,
        runWorkflow,
        checkpointStore,
        recover: false,
        startScheduler: true,
        schedulerPollIntervalMs: DETECTION_SCHEDULER_POLL_INTERVAL_MS,
        runWorkflowVersion: 'v2',
        onWorkflowVersionMismatch: (event) => {
          mismatches.push(event);
        },
        resolveWorkflowServices: () => ({ status: 'available', services: { multiplier: 3 } }),
      });

      try {
        const handles = await engine.recoverAll();
        expect(await handles[0]!.result()).toEqual({ multiplied: 21 });
        expect(mismatches).toHaveLength(0);
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  it('omits the observability handle when not requested', async () => {
    const { engine, observability } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeProbeWorkflow(),
      recover: false,
    });
    try {
      expect(observability).toBeUndefined();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('returns a metrics collector and disposer when observability is enabled', async () => {
    const { engine, observability } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeProbeWorkflow(),
      recover: false,
      observability: true,
    });

    try {
      expect(observability).toBeDefined();
      // The metrics collector exposes a serializable snapshot; running a workflow
      // records activity/workflow metrics through the attached interceptor.
      expect(typeof observability!.metrics.snapshot).toBe('function');
      const handle = await engine.start('agentRun', { value: 3 });
      expect(await handle.result()).toEqual({ doubled: 6 });
      // The interceptor actually recorded metrics for the run (a no-op interceptor
      // would leave the snapshot empty) — assert it is populated, not merely defined.
      const snapshot = observability!.metrics.snapshot();
      expect(Object.keys(snapshot).length).toBeGreaterThan(0);
    } finally {
      // dispose() must be callable and idempotent-safe before engine teardown.
      observability!.dispose();
      engine[Symbol.dispose]();
    }
  });

  it('accepts an observability options object (custom tracer name)', async () => {
    const { engine, observability } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeProbeWorkflow(),
      recover: false,
      observability: { tracerName: 'agent-bureau-test', recordPayloads: false },
    });
    try {
      expect(observability).toBeDefined();
    } finally {
      observability!.dispose();
      engine[Symbol.dispose]();
    }
  });

  it('routes ctx.log records to the onLog host sink', async () => {
    const records: WorkflowLogRecord[] = [];
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeLoggingWorkflow(),
      recover: false,
      onLog: (record) => {
        records.push(record);
      },
    });

    try {
      const handle = await engine.start('agentRun', { value: 7 });
      expect(await handle.result()).toEqual({ doubled: 14 });
      // The workflow emitted exactly one ctx.log.info record; the envelope fields
      // are engine-owned, caller attributes nest under `attributes`.
      const infoRecords = records.filter((r) => r.message === 'probe running');
      expect(infoRecords.length).toBe(1);
      expect(infoRecords[0]!.level).toBe('info');
      expect(infoRecords[0]!.workflowType).toBe('agentRun');
      expect(infoRecords[0]!.attributes).toEqual({ value: 7 });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('surfaces CheckpointSizeWarningEvent to the onCheckpointSizeWarning subscriber', async () => {
    // A 1-byte threshold trips on the first checkpoint write of any run, so the
    // subscriber fires — proving the engine wires the event through rather than
    // dispatching it into the void.
    let warningCount = 0;
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeProbeWorkflow(),
      recover: false,
      checkpointSizeWarningThreshold: 1,
      onCheckpointSizeWarning: () => {
        warningCount++;
      },
    });

    try {
      const handle = await engine.start('agentRun', { value: 11 });
      expect(await handle.result()).toEqual({ doubled: 22 });
      expect(warningCount).toBeGreaterThan(0);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('accepts a history policy without breaking a run that stays under the limit', async () => {
    // The history policy is threaded into Engine.create. A generous maxEvents
    // leaves a normal run unaffected. (The circuit-breaker TRIP + the adapter's
    // error classification are covered against the real agentRun body in
    // active-run-adapter.test.ts, where the multi-step transcript breaches a low
    // limit; the trivial probe workflow here does not generate enough history to
    // trip a tight bound deterministically, so this only guards the passthrough.)
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeProbeWorkflow(),
      recover: false,
      history: { maxEvents: 10_000 },
      payloadSize: { maxBytes: 1_000_000 },
    });

    try {
      const handle = await engine.start('agentRun', { value: 4 });
      expect(await handle.result()).toEqual({ doubled: 8 });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('fires durable ctx.sleep timers under recover:false when startScheduler:true (#590)', async () => {
    // The bureau owns recovery (recover:false) but still needs durable timers.
    // Weft's startScheduler arms the poller independently of recover, so a
    // workflow parked on ctx.sleep resolves. This is the regression that proves
    // recover:false hosts can run timers — the whole reason #590 was filed.
    // A short sleep keeps the test fast; `result()` is awaited with no artificial
    // deadline, so a starved poller delays the test rather than failing it falsely.
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeSleepingWorkflow(DURABLE_SLEEP_MILLISECONDS),
      recover: false,
      startScheduler: true,
    });

    try {
      const handle = await engine.start('agentRun', { value: 21 });
      // result() only settles once the durable sleep elapses, which only happens
      // if the poller is armed; an unarmed poller would leave this pending forever.
      expect(await handle.result()).toEqual({ doubled: 42 });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  // AB-330: the two "poller stays unarmed" negative-proof tests
  // (recover:false without startScheduler, and startScheduler:false
  // overriding recover:true) moved to
  // `create-run-engine-poller-unarmed.test.ts` — they need a real detection
  // window (see that file's header comment), which is a real-runtime
  // exemption, so they're isolated from this otherwise-deterministic file.

  it('supports host-driven maintenance without starting background intervals', async () => {
    const schedulerStartSpy = spyOn(Scheduler.prototype, 'start');
    const reachedSleep: WorkflowLogRecord[] = [];
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeSleepingWorkflow(PARKED_SLEEP_MILLISECONDS),
      backgroundTasks: 'manual',
      onLog: (record) => {
        if (record.message === REACHED_SLEEP_MARKER) reachedSleep.push(record);
      },
    });

    try {
      expect(schedulerStartSpy).not.toHaveBeenCalled();
      const handle = await engine.start('agentRun', { value: 21 });
      await pollUntil(async () => {
        if (reachedSleep.length === 0) return false;
        const snapshot = await handle.snapshot();
        return snapshot !== null && !TERMINAL_STATUSES.has(snapshot.status);
      });

      await engine.runMaintenance(FAR_FUTURE_EPOCH_MILLISECONDS);
      await pollUntil(async () => {
        const snapshot = await handle.snapshot();
        return snapshot?.status === 'completed';
      });
      const completedSnapshot = await handle.snapshot();
      expect(completedSnapshot?.status).toBe('completed');
    } finally {
      schedulerStartSpy.mockRestore();
      engine[Symbol.dispose]();
    }
  });

  it('defaults startScheduler to recover (poller armed when recover defaults to true)', async () => {
    // startScheduler defaults to `recover !== false`. With recover left at its
    // true default, the poller arms, so a durable sleep fires without passing the
    // flag — the common in-process host keeps prior behavior.
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeSleepingWorkflow(DURABLE_SLEEP_MILLISECONDS),
    });

    try {
      const handle = await engine.start('agentRun', { value: 9 });
      expect(await handle.result()).toEqual({ doubled: 18 });
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

/**
 * A workflow that commits one step (folding in its claim under
 * `ownership: 'workflow-lease'`) and then durably parks on
 * `ctx.waitForSignal('proceed')` until signaled. Used by the AB-178 ownership
 * tests below to hold a workflow open across two engines without relying on
 * `engine.suspend()`/`engine.resume()` on the SAME engine — see
 * 'known weft defect' below for why that specific combination is avoided.
 */
function makeParkingWorkflow() {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx, input: { value: number }) {
    yield* ctx.run(async () => 'started');
    yield* ctx.waitForSignal('proceed');
    return { doubled: input.value * 2 };
  });
}

/** True once `handle`'s workflow has left `pending` and is parked `running`. */
async function isParkedRunning(handle: { snapshot: () => Promise<{ status: string } | null> }) {
  const snapshot = await handle.snapshot();
  return snapshot !== null && snapshot.status === 'running';
}

describe('createRunEngine ownership (AB-178)', () => {
  it('defaults ownership to "none" (unchanged single-writer-by-convention posture)', async () => {
    // No explicit `ownership` passed — spy on the underlying `Engine.create`
    // call to prove `createRunEngine` still passes `'none'` by default,
    // rather than silently changing to `'workflow-lease'`. Asserting the
    // literal option passed to weft is deterministic; racing two live
    // engines against the same workflow under the (intentionally
    // unfenced) default posture is exactly the uncoordinated scenario AB-39
    // describes as "outside the contract entirely" and is not something a
    // test should assert a specific outcome for.
    const engineCreateSpy = spyOn(Engine, 'create');
    try {
      const { engine } = await createRunEngine({
        storage: new MemoryStorage(),
        runWorkflow: makeProbeWorkflow(),
        recover: false,
      });
      try {
        expect(engineCreateSpy).toHaveBeenCalledTimes(1);
        expect(engineCreateSpy.mock.calls[0]?.[0]).toMatchObject({ ownership: 'none' });
      } finally {
        engine[Symbol.dispose]();
      }
    } finally {
      engineCreateSpy.mockRestore();
    }
  });

  it('fences a second engine out of a workflow the first engine still holds (two-engine fence)', async () => {
    const storage = new MemoryStorage();
    const a = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(),
      recover: false,
      ownership: 'workflow-lease',
    });

    const handle = await a.engine.start('agentRun', { value: 21 });
    // Poll until engine A's step-0 commit has folded in its claim AND the
    // workflow is parked on the signal wait (not yet completed).
    await pollUntil(() => isParkedRunning(handle));

    const b = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(),
      recover: false,
      ownership: 'workflow-lease',
    });

    try {
      // B has never touched this workflow (no cached epoch), so it takes the
      // fresh-acquire path — which loses the race to A's live, unexpired
      // claim and fails closed instead of adopting a workflow A still owns.
      // (`expect(...).rejects` types as a synchronous `Matchers`, not a
      // Promise, per bun-types — an explicit try/catch is the correctly
      // typed way to assert a rejection here, rather than an `await` the
      // type checker cannot verify actually waits for anything.)
      try {
        await b.engine.resume(handle.id);
        throw new Error('expected b.engine.resume to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowClaimUnavailableError);
      }

      // A is unaffected by B's rejected attempt: signaling and completing
      // through A still works.
      await a.engine.signal(handle.id, 'proceed');
      expect(await handle.result()).toEqual({ doubled: 42 });
    } finally {
      a.engine[Symbol.dispose]();
      b.engine[Symbol.dispose]();
    }
  });

  // AB-330: the crash-and-adopt test (waits out a real workflow-lease claim
  // TTL — weft's getNow is not injectable, so this needs a genuine
  // real-clock wait) moved to `create-run-engine-crash-and-adopt.test.ts`,
  // isolating the real-runtime exemption from this otherwise-deterministic
  // file.

  /**
   * Tripwire for a weft 0.23.1 defect (see `CreateRunEngineOptions.ownership`'s
   * JSDoc for the full write-up): `engine.suspend()` releases a workflow's
   * `workflow-lease` claim as a side effect of reusing the terminal-commit
   * code path, even though suspend is documented as non-terminal and later
   * resumable. A same-engine `engine.resume()` right after then throws
   * `WorkflowClaimUnavailableError` instead of silently re-acquiring.
   *
   * This test PINS that current (broken) behavior rather than asserting the
   * desired one, specifically so it starts FAILING the moment weft ships a
   * fix — the signal to flip `ownership`'s default and remove the JSDoc
   * warning against combining it with the scheduler's suspend/resume
   * preemption path.
   */
  it('[tripwire] suspend-then-resume on the SAME engine currently throws under workflow-lease (weft 0.23.1 defect)', async () => {
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeSleepingWorkflow(DURABLE_SLEEP_MILLISECONDS),
      recover: false,
      ownership: 'workflow-lease',
    });

    try {
      const handle = await engine.start('agentRun', { value: 3 });
      await pollUntil(() => isParkedRunning(handle));

      await engine.suspend(handle.id);
      try {
        await engine.resume(handle.id);
        throw new Error('expected engine.resume to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowClaimUnavailableError);
      }
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
