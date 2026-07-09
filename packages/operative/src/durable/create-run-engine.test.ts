import {
  activity,
  Scheduler,
  workflow,
  type WorkflowLogRecord,
  type WorkflowStatus,
} from '@lostgradient/weft';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { WorkflowVersionMismatchEvent } from '../events';
import { createCheckpointStore } from './checkpoint-store';
import { type AnyRunEngine, createRunEngine } from './create-run-engine';

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
// Sleep duration used by the negative (unarmed-poller) tests: short enough that
// a real-time poller WOULD fire it within POLLER_DETECTION_WINDOW_MS, making those
// tests falsifiable — they fail if createRunEngine accidentally arms the scheduler.
const PARKED_SLEEP_MILLISECONDS = DURABLE_SLEEP_MILLISECONDS;
// Scheduler poll interval injected into negative-test engines so that an
// accidentally armed poller fires expired timers within a few milliseconds,
// well inside POLLER_DETECTION_WINDOW_MS.
const DETECTION_SCHEDULER_POLL_INTERVAL_MS = 1;
// Window (ms) to wait after the run parks before asserting it is still
// non-terminal. Must be > PARKED_SLEEP_MILLISECONDS + several
// DETECTION_SCHEDULER_POLL_INTERVAL_MS cycles so a misfiring poller would have
// fired the now-expired timer before the assertion runs.
const POLLER_DETECTION_WINDOW_MS = PARKED_SLEEP_MILLISECONDS * 3 + 50;
// Margin added past a parked timer's deadline when ticking the scheduler manually,
// so the now-due timer is unambiguously expired regardless of small clock drift.
const TICK_DEADLINE_MARGIN_MILLISECONDS = 60_000;

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

/**
 * Assert a run parks on its durable `ctx.sleep` because nothing drives the
 * scheduler, then fires the moment the scheduler is driven explicitly. Falsifiable
 * and deterministic — it asserts scheduler STATE in three steps:
 *  1. Poll the inline launch until the pre-sleep marker arrives AND the run is
 *     `running` (proof the generator reached the sleep and the durable timer is
 *     persisted, not that the run merely never started) — generously bounded so
 *     inline-launch starvation under full bun-test concurrency cannot turn it red.
 *  2. Wait a real-time detection window ({@link POLLER_DETECTION_WINDOW_MS}) and
 *     then assert the run is non-terminal. The caller must create the engine with
 *     `schedulerPollIntervalMs: DETECTION_SCHEDULER_POLL_INTERVAL_MS` (1ms) and
 *     `PARKED_SLEEP_MILLISECONDS` sleep so that an accidentally-armed poller fires
 *     the now-expired timer well before the window closes — making the test fail
 *     when `createRunEngine` inadvertently enables the scheduler.
 *  3. Tick the scheduler directly past the deadline (the deterministic seam the
 *     durable-heartbeat tests use) and assert the now-due timer fires the run to
 *     `completed` — proof the run was genuinely parked on the durable timer and
 *     only advances when the scheduler runs, never on its own while unarmed.
 * `result()` is never awaited, so engine disposal has no pending promise to reject.
 */
async function assertRunStaysParkedWhenPollerUnarmed(
  engine: AnyRunEngine,
  reachedSleepMarkers: readonly WorkflowLogRecord[],
) {
  const handle = await engine.start('agentRun', { value: 21 });
  // Drive the deferred inline launch until the generator has provably reached
  // ctx.sleep (its pre-sleep marker logged) and parked (`running`, so the durable
  // timer is persisted and tickable below).
  await pollUntil(async () => {
    if (reachedSleepMarkers.length < 1) return false;
    const snapshot = await handle.snapshot();
    return snapshot !== null && !TERMINAL_STATUSES.has(snapshot.status);
  });
  expect(reachedSleepMarkers.length).toBe(1);
  // Give a real-time poller adequate opportunity to fire the due timer. The
  // engine under test uses DETECTION_SCHEDULER_POLL_INTERVAL_MS (1ms), so if
  // startScheduler is accidentally enabled, the poller fires many times and the
  // now-expired sleep completes the run before this window closes. Asserting
  // non-terminal here is the falsifiable gate: it fails when the poller misfires.
  await new Promise<void>((resolve) => setTimeout(resolve, POLLER_DETECTION_WINDOW_MS));
  const parkedSnapshot = await handle.snapshot();
  expect(parkedSnapshot).not.toBeNull();
  expect(TERMINAL_STATUSES.has(parkedSnapshot!.status)).toBe(false);
  // Drive the scheduler directly past the timer's deadline. The durable sleep is
  // real, so the now-due timer fires and the run completes — proving it was parked
  // on the timer (not stalled for another reason) and only advances when the
  // scheduler runs, which never happened on its own while the poller was unarmed.
  await engine.scheduler.tick(
    Date.now() + PARKED_SLEEP_MILLISECONDS + TICK_DEADLINE_MARGIN_MILLISECONDS,
  );
  await pollUntil(async () => {
    const snapshot = await handle.snapshot();
    return snapshot !== null && TERMINAL_STATUSES.has(snapshot.status);
  });
  const firedSnapshot = await handle.snapshot();
  expect(firedSnapshot).not.toBeNull();
  expect(firedSnapshot!.status).toBe('completed');
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
        workflowVersion: 'v1',
      });

      const mismatches: WorkflowVersionMismatchEvent[] = [];
      const { engine } = await createRunEngine({
        storage,
        runWorkflow,
        checkpointStore,
        recover: false,
        startScheduler: true,
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
        workflowVersion: 'v1',
      });

      const mismatches: WorkflowVersionMismatchEvent[] = [];
      const { engine } = await createRunEngine({
        storage,
        runWorkflow,
        checkpointStore,
        recover: false,
        startScheduler: true,
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

  it('leaves durable ctx.sleep timers parked under recover:false without startScheduler (#590)', async () => {
    // The inverse: with the poller unarmed (the recover:false default), nothing
    // drives the durable sleep, so the run parks on the timer. Falsifiable and
    // deterministic: the run reaches the sleep (pre-sleep marker arrives), stays
    // non-terminal through the POLLER_DETECTION_WINDOW_MS window (an accidentally-
    // armed poller with DETECTION_SCHEDULER_POLL_INTERVAL_MS interval would fire the
    // now-expired PARKED_SLEEP_MILLISECONDS sleep before the window closes), then
    // only completes when the scheduler is ticked explicitly.
    //
    // The spy is placed BEFORE engine creation so any accidental Scheduler.start()
    // call inside Engine.create is captured — directly proving the poller is never
    // armed, not merely that it hasn't fired yet.
    const schedulerStartSpy = spyOn(Scheduler.prototype, 'start');
    const reachedSleep: WorkflowLogRecord[] = [];
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeSleepingWorkflow(PARKED_SLEEP_MILLISECONDS),
      recover: false,
      schedulerPollIntervalMs: DETECTION_SCHEDULER_POLL_INTERVAL_MS,
      onLog: (record) => {
        if (record.message === REACHED_SLEEP_MARKER) reachedSleep.push(record);
      },
    });

    try {
      // Direct proof: recover:false with no startScheduler must never call
      // Scheduler.start(), so the real-time polling interval is never set up.
      expect(schedulerStartSpy).not.toHaveBeenCalled();
      await assertRunStaysParkedWhenPollerUnarmed(engine, reachedSleep);
    } finally {
      schedulerStartSpy.mockRestore();
      engine[Symbol.dispose]();
    }
  });

  it('does not arm the scheduler when startScheduler:false overrides recover:true (#590)', async () => {
    // The full cross-product: startScheduler:false suppresses the poller even
    // though recovery runs (recover:true). This exercises the branch where the
    // option is explicitly forwarded to override Weft's `recover !== false`
    // default, so the durable sleep stays parked. Same falsifiable proof as the
    // recover:false case (reached-sleep marker, non-terminal through detection
    // window, then fires on an explicit scheduler tick).
    //
    // The spy is placed BEFORE engine creation so any accidental Scheduler.start()
    // call inside Engine.create is captured — directly proving the poller is never
    // armed even when recovery itself runs.
    const schedulerStartSpy = spyOn(Scheduler.prototype, 'start');
    const reachedSleep: WorkflowLogRecord[] = [];
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeSleepingWorkflow(PARKED_SLEEP_MILLISECONDS),
      recover: true,
      startScheduler: false,
      schedulerPollIntervalMs: DETECTION_SCHEDULER_POLL_INTERVAL_MS,
      onLog: (record) => {
        if (record.message === REACHED_SLEEP_MARKER) reachedSleep.push(record);
      },
    });

    try {
      // Direct proof: startScheduler:false must suppress the call even when
      // recover:true — Scheduler.start() must never be invoked.
      expect(schedulerStartSpy).not.toHaveBeenCalled();
      await assertRunStaysParkedWhenPollerUnarmed(engine, reachedSleep);
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
