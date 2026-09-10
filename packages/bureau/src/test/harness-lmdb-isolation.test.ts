import type { GenerateFunction } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { ManualRuntimeServices } from 'lifecycle';
import { createManualRuntimeServices } from 'lifecycle';

import type { Bureau, RunSummary } from '../types';
import { type BureauTestHarness, createBureauTestHarness } from './harness';
import { createLmdbStorageFixture } from './storage-fixtures';

function mockGenerate(content = 'Done.'): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

async function waitForRunCompletion(bureau: Bureau, runId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const controller = new AbortController();
    try {
      bureau.subscribeRunSnapshot(
        runId,
        (snapshot) => {
          if (snapshot.status === 'terminal') {
            controller.abort();
            resolve();
          }
        },
        { signal: controller.signal },
      );
    } catch (error) {
      controller.abort();
      reject(error);
    }
  });
}

describe('two concurrent harnesses are fully isolated', () => {
  describe('lmdb: independent storage paths, timers, identifiers, and events', () => {
    /**
     * The LMDB fixture uses Weft's relaxed durability mode, and completion is
     * observed from the run's liveness subscription instead of a real timer.
     * Separate hooks keep setup, completion, and event-isolation ownership
     * explicit while preserving each assertion's original boundary.
     */
    let runtimeA: ManualRuntimeServices;
    let runtimeB: ManualRuntimeServices;
    let storageA: ReturnType<typeof createLmdbStorageFixture>;
    let storageB: ReturnType<typeof createLmdbStorageFixture>;
    let harnessA: BureauTestHarness;
    let harnessB: BureauTestHarness;
    let runA: RunSummary;
    let runB: RunSummary;
    let eventsSeenByA: string[];

    beforeAll(async () => {
      runtimeA = createManualRuntimeServices({ origin: '2024-01-01T00:00:00.000Z' });
      runtimeB = createManualRuntimeServices({ origin: '2025-06-15T00:00:00.000Z' });
      // Path allocation draws an identifier from its OWN fresh runtime, not
      // runtimeA/runtimeB — those are reserved for the harness's own run-id
      // minting, and the "mints identifiers independently" assertion below
      // depends on nothing else consuming from that counter first.
      storageA = createLmdbStorageFixture({ runtime: createManualRuntimeServices() });
      storageB = createLmdbStorageFixture({ runtime: createManualRuntimeServices() });

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

    it('has distinct storage paths and distinct clocks', () => {
      expect(storageA.path).not.toBe(storageB.path);
      expect(runtimeA.clock.now()).not.toBe(runtimeB.clock.now());
    });

    it('mints identifiers independently', () => {
      expect(runA.id).toBe(`${runtimeA.identifierPrefix}-run-1`);
      expect(runB.id).toBe(`${runtimeB.identifierPrefix}-run-1`);
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
  });
});
