import { activity, workflow } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { afterEach, describe, expect, it } from 'bun:test';

import { createCheckpointStore } from './checkpoint-store';
import { createRunEngine } from './create-run-engine';

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

afterEach(async () => {
  // Drain Weft's deferred inline launch (see runtime-composition.test.ts) so a
  // pending `setTimeout(0)` macrotask from one engine run is not starved under
  // full `bun test` concurrency, which would time out a later run. Matches the
  // drain in active-run-adapter.test.ts and run-workflow.test.ts.
  await yieldToPortableEventLoop();
});

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
});
