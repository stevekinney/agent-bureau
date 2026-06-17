import { activity, workflow, type WorkflowLogRecord } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { afterEach, describe, expect, it } from 'bun:test';

import { createCheckpointStore } from './checkpoint-store';
import { createRunEngine } from './create-run-engine';

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
      const snapshot = observability!.metrics.snapshot();
      expect(snapshot).toBeDefined();
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
});
