import {
  activity,
  workflow,
  type WorkflowLogRecord,
  type WorkflowStatus,
} from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { afterEach, describe, expect, it } from 'bun:test';

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

// Weft's durable-timer poller ticks on a fixed ~1000ms real-time interval
// (pollIntervalMs default). A sleep due comfortably inside one poll cycle but
// past the inline-launch drain window is the discriminator: an ARMED poller fires
// it within a cycle, while an UNARMED poller never does. Kept short so a poller
// that DID arm cannot be mistaken for "just not due yet".
const SCHEDULER_POLL_INTERVAL_MILLISECONDS = 1000;
const DURABLE_SLEEP_MILLISECONDS = 50;
// Wait past a full poll cycle (plus margin) before asserting a run stayed parked,
// so an armed poller would provably have fired by now. The poll is a real-time
// setInterval, not the inline-launch macrotask queue, so this interval is
// reliable and not subject to the bun-test starvation this file otherwise guards.
const POLL_CYCLE_WAIT_MILLISECONDS = SCHEDULER_POLL_INTERVAL_MILLISECONDS + 500;

// Logged by makeSleepingWorkflow on the step BEFORE ctx.sleep. Observing it via
// the onLog sink is positive proof the generator actually reached the sleep —
// "non-terminal" alone would also hold if the run never started, which is not
// what the parked-timer tests mean to assert.
const REACHED_SLEEP_MARKER = 'reached sleep';

/**
 * A probe workflow that parks on a durable `ctx.sleep` before finishing. It logs
 * {@link REACHED_SLEEP_MARKER} on the step immediately before the sleep, so a test
 * can prove the generator reached the timer. The sleep only resolves if the
 * engine's durable-timer poller is armed, so this workflow's completion is a
 * direct observation of whether `startScheduler` took effect (the #590 seam).
 */
function makeSleepingWorkflow(sleepMilliseconds: number) {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx, input: { value: number }) {
    ctx.log?.info(REACHED_SLEEP_MARKER);
    yield* ctx.sleep(sleepMilliseconds);
    return { doubled: input.value * 2 };
  });
}

/**
 * Assert a run stays parked on its durable `ctx.sleep` because the poller is NOT
 * armed. Discriminating and deterministic:
 *  1. drain the inline launch until the pre-sleep marker arrives (proof the
 *     generator reached the sleep, not that it merely never started);
 *  2. wait past one full poll cycle — an ARMED poller would have fired the
 *     now-due {@link DURABLE_SLEEP_MILLISECONDS} timer and driven the run
 *     terminal by now;
 *  3. assert the run is still non-terminal — only an unarmed poller leaves it so.
 * `result()` is never awaited, so engine disposal has no pending promise to reject.
 */
async function assertRunStaysParkedWhenPollerUnarmed(
  engine: AnyRunEngine,
  reachedSleepMarkers: readonly WorkflowLogRecord[],
) {
  const handle = await engine.start('agentRun', { value: 21 });
  // Drain Weft's deferred inline launch until the generator has provably reached
  // ctx.sleep (its pre-sleep marker logged). A single drain is not always enough
  // for the inline start to advance, so loop with a bounded cap — the marker is
  // emitted synchronously as the generator runs, so a handful of yields suffice;
  // the cap turns a genuine hang into a clear failure rather than a spin.
  for (let attempt = 0; attempt < 50 && reachedSleepMarkers.length === 0; attempt++) {
    await yieldToPortableEventLoop();
  }
  expect(reachedSleepMarkers.length).toBe(1);
  // Give an armed poller more than a full cycle to fire the now-due timer.
  await new Promise((resolve) => setTimeout(resolve, POLL_CYCLE_WAIT_MILLISECONDS));
  // Still non-terminal ⇒ no poller fired the due timer ⇒ the poller is unarmed.
  const snapshot = await handle.snapshot();
  expect(snapshot).not.toBeNull();
  expect(TERMINAL_STATUSES.has(snapshot!.status)).toBe(false);
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
    // Weft 0.6.0's startScheduler arms the poller independently of recover, so a
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
    // The inverse: with the poller unarmed (the recover:false default), the
    // durable sleep never elapses, so the run parks on the timer forever. Proven
    // deterministically (not a wall-clock race): the run reaches the sleep (the
    // pre-sleep marker arrives) and stays non-terminal (a day-long timer cannot
    // fire on its own, and an unarmed poller cannot drive it terminal).
    const reachedSleep: WorkflowLogRecord[] = [];
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeSleepingWorkflow(DURABLE_SLEEP_MILLISECONDS),
      recover: false,
      onLog: (record) => {
        if (record.message === REACHED_SLEEP_MARKER) reachedSleep.push(record);
      },
    });

    try {
      await assertRunStaysParkedWhenPollerUnarmed(engine, reachedSleep);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('does not arm the scheduler when startScheduler:false overrides recover:true (#590)', async () => {
    // The full cross-product: startScheduler:false suppresses the poller even
    // though recovery runs (recover:true). This exercises the branch where the
    // option is explicitly forwarded to override Weft's `recover !== false`
    // default, so the durable sleep stays parked. Same deterministic proof as the
    // recover:false case (reached-sleep marker + non-terminal status).
    const reachedSleep: WorkflowLogRecord[] = [];
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeSleepingWorkflow(DURABLE_SLEEP_MILLISECONDS),
      recover: true,
      startScheduler: false,
      onLog: (record) => {
        if (record.message === REACHED_SLEEP_MARKER) reachedSleep.push(record);
      },
    });

    try {
      await assertRunStaysParkedWhenPollerUnarmed(engine, reachedSleep);
    } finally {
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
