/**
 * Self-test for `reactive-source-suite.ts` (AB-258). Two things must be
 * proven:
 *
 * - The suite passes against a subject that actually conforms (the
 *   "positive" describe block below, run through the real `bun:test`
 *   `describe`/`it`).
 * - The suite catches a real violation: seven deliberately broken in-memory
 *   subjects, one per case, each failing exactly the case it violates and
 *   no other. Running these through the real `describe`/`it` would make
 *   this very file — and `bun test` — exit non-zero on purpose, so each
 *   negative fixture runs through a capturing `ReactiveSourceConformanceTestRunner`
 *   instead: it executes every case and records each one's outcome, and
 *   *that* recorded outcome is what a normal, passing `it()` block below
 *   asserts on.
 *
 * `triggerChange` is driven by `ManualRuntimeServices` (AB-252/tst-02a) —
 * a scheduled virtual timer plus `advance()` — rather than a real timer,
 * so every change (including the deliberately torn one) is deterministic.
 */

import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices, type ManualRuntimeServices } from 'lifecycle';
import { z } from 'zod';

import {
  type ReactiveSourceConformanceOptions,
  type ReactiveSourceConformanceTestRunner,
  type ReactiveSourceSubject,
  runReactiveSourceConformanceSuite,
} from './reactive-source-suite';

interface CounterSnapshot {
  readonly value: number;
  readonly version: number;
}

interface InMemoryCounterSubject extends ReactiveSourceSubject<CounterSnapshot> {
  applyChange(): Promise<void>;
}

const counterLocatorSchema = z.object({ value: z.number(), version: z.number() });

/** The conforming baseline every case must pass against. */
function createSeededCounterSubject(
  runtime: ManualRuntimeServices,
  seed: CounterSnapshot,
): InMemoryCounterSubject {
  let current: CounterSnapshot = seed;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribeSnapshot(invalidate) {
      listeners.add(invalidate);
      return () => {
        listeners.delete(invalidate);
      };
    },
    toLocator: () => ({ value: current.value, version: current.version }),
    async applyChange() {
      await new Promise<void>((resolve) => {
        runtime.timers.setTimeout(() => {
          current = { value: current.value + 1, version: current.version + 1 };
          for (const listener of listeners) listener();
          resolve();
        }, 5);
      });
    },
  };
}

async function triggerCounterChange(
  runtime: ManualRuntimeServices,
  subject: InMemoryCounterSubject,
): Promise<void> {
  const done = subject.applyChange();
  // Yield once *before* driving the virtual clock. `applyChange()` above
  // has already scheduled its timer but nothing has fired yet, so this is
  // what puts `subscribeReadRaceClosure`'s read genuinely between "change
  // started" and "change committed" — without it, `advance()` below would
  // fire the (single, synchronous) timer before control ever returns to a
  // caller reading mid-flight, and the case would only ever observe the
  // already-committed state.
  await Promise.resolve();
  await runtime.advance(50);
  await done;
}

function createTerminalCounterSubject(): ReactiveSourceSubject<CounterSnapshot> {
  const terminal: CounterSnapshot = { value: 99, version: 1 };
  return {
    getSnapshot: () => terminal,
    subscribeSnapshot: () => () => {},
  };
}

function reattachCounterSubject(locator: unknown): ReactiveSourceSubject<CounterSnapshot> {
  const parsed = counterLocatorSchema.parse(locator);
  const snapshot: CounterSnapshot = { value: parsed.value, version: parsed.version };
  return {
    getSnapshot: () => snapshot,
    subscribeSnapshot: () => () => {},
    toLocator: () => ({ value: snapshot.value, version: snapshot.version }),
  };
}

function createCleanOptions(
  runtime: ManualRuntimeServices,
): ReactiveSourceConformanceOptions<CounterSnapshot> {
  return {
    label: 'in-memory counter',
    createSubject: () => createSeededCounterSubject(runtime, { value: 0, version: 0 }),
    triggerChange(subject: InMemoryCounterSubject) {
      return triggerCounterChange(runtime, subject);
    },
    createAlreadyTerminalSubject: createTerminalCounterSubject,
    reattach: reattachCounterSubject,
  };
}

describe('runReactiveSourceConformanceSuite: positive self-test', () => {
  const runtime = createManualRuntimeServices({ origin: '2026-01-01T00:00:00.000Z' });
  runReactiveSourceConformanceSuite(createCleanOptions(runtime));
});

// --- Negative fixtures -----------------------------------------------------
//
// Each fixture below reuses `createCleanOptions` as its baseline and
// overrides exactly the piece that produces its one violation, so every
// case *other* than the one under test still runs against otherwise-correct
// behavior and passes.

interface CapturedCase {
  readonly name: string;
  readonly error: unknown;
}

function createCapturingTestRunner(): {
  readonly runner: ReactiveSourceConformanceTestRunner;
  run(): Promise<CapturedCase[]>;
} {
  const registered: { name: string; fn: () => void | Promise<void> }[] = [];
  const runner: ReactiveSourceConformanceTestRunner = {
    describe(_label, fn) {
      fn();
    },
    it(name, fn) {
      registered.push({ name, fn });
    },
  };
  return {
    runner,
    async run() {
      const results: CapturedCase[] = [];
      for (const { name, fn } of registered) {
        try {
          await fn();
          results.push({ name, error: undefined });
        } catch (error) {
          results.push({ name, error });
        }
      }
      return results;
    },
  };
}

/** Runs `options` through the suite and returns each case's outcome. */
async function runCapturingly<TSnapshot>(
  options: ReactiveSourceConformanceOptions<TSnapshot>,
): Promise<CapturedCase[]> {
  const { runner, run } = createCapturingTestRunner();
  runReactiveSourceConformanceSuite(options, runner);
  return run();
}

/** Asserts that exactly `failingCase` failed and every other case passed. */
function expectOnlyCaseFailed(results: CapturedCase[], failingCase: string): void {
  expect(results.some((result) => result.name === failingCase)).toBe(true);
  for (const result of results) {
    if (result.name === failingCase) {
      expect(result.error).toBeDefined();
    } else {
      expect(result.error).toBeUndefined();
    }
  }
}

it('fails only stableSnapshotIdentity when getSnapshot allocates a new object every call', async () => {
  const runtime = createManualRuntimeServices({ origin: '2026-02-01T00:00:00.000Z' });

  function createFreshObjectCounterSubject(): InMemoryCounterSubject {
    let value = 0;
    let version = 0;
    const listeners = new Set<() => void>();
    return {
      // BUG: a fresh object every call breaks reference stability while unchanged.
      getSnapshot: () => ({ value, version }),
      subscribeSnapshot(invalidate) {
        listeners.add(invalidate);
        return () => {
          listeners.delete(invalidate);
        };
      },
      async applyChange() {
        await new Promise<void>((resolve) => {
          runtime.timers.setTimeout(() => {
            value += 1;
            version += 1;
            for (const listener of listeners) listener();
            resolve();
          }, 5);
        });
      },
    };
  }

  const options: ReactiveSourceConformanceOptions<CounterSnapshot> = {
    ...createCleanOptions(runtime),
    createSubject: createFreshObjectCounterSubject,
    triggerChange(subject: InMemoryCounterSubject) {
      return triggerCounterChange(runtime, subject);
    },
    reattach: undefined,
  };

  const results = await runCapturingly(options);
  expectOnlyCaseFailed(results, 'stableSnapshotIdentity');
});

it('fails only immutableReplacementAfterChange when a change mutates the returned object in place', async () => {
  const runtime = createManualRuntimeServices({ origin: '2026-02-02T00:00:00.000Z' });

  function createMutateInPlaceCounterSubject(): InMemoryCounterSubject {
    // BUG: one mutable object, mutated in place instead of replaced.
    const current = { value: 0, version: 0 };
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => current,
      subscribeSnapshot(invalidate) {
        listeners.add(invalidate);
        return () => {
          listeners.delete(invalidate);
        };
      },
      async applyChange() {
        await new Promise<void>((resolve) => {
          runtime.timers.setTimeout(() => {
            current.value += 1;
            current.version += 1;
            for (const listener of listeners) listener();
            resolve();
          }, 5);
        });
      },
    };
  }

  const options: ReactiveSourceConformanceOptions<CounterSnapshot> = {
    ...createCleanOptions(runtime),
    createSubject: createMutateInPlaceCounterSubject,
    triggerChange(subject: InMemoryCounterSubject) {
      return triggerCounterChange(runtime, subject);
    },
    reattach: undefined,
  };

  const results = await runCapturingly(options);
  expectOnlyCaseFailed(results, 'immutableReplacementAfterChange');
});

it('fails only multipleIndependentSubscribers when a second subscriber replaces the first', async () => {
  const runtime = createManualRuntimeServices({ origin: '2026-02-03T00:00:00.000Z' });

  function createSingleSlotCounterSubject(): InMemoryCounterSubject {
    let current: CounterSnapshot = { value: 0, version: 0 };
    // BUG: one listener slot — subscribing a second time silently drops the first.
    let listener: (() => void) | undefined;
    return {
      getSnapshot: () => current,
      subscribeSnapshot(invalidate) {
        listener = invalidate;
        return () => {
          if (listener === invalidate) listener = undefined;
        };
      },
      async applyChange() {
        await new Promise<void>((resolve) => {
          runtime.timers.setTimeout(() => {
            current = { value: current.value + 1, version: current.version + 1 };
            listener?.();
            resolve();
          }, 5);
        });
      },
    };
  }

  const options: ReactiveSourceConformanceOptions<CounterSnapshot> = {
    ...createCleanOptions(runtime),
    createSubject: createSingleSlotCounterSubject,
    triggerChange(subject: InMemoryCounterSubject) {
      return triggerCounterChange(runtime, subject);
    },
    reattach: undefined,
  };

  const results = await runCapturingly(options);
  expectOnlyCaseFailed(results, 'multipleIndependentSubscribers');
});

it('fails only subscribeReadRaceClosure when a change commits in two non-atomic steps', async () => {
  const runtime = createManualRuntimeServices({ origin: '2026-02-04T00:00:00.000Z' });

  function createTornCounterSubject(): InMemoryCounterSubject {
    let current: CounterSnapshot = { value: 0, version: 0 };
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => current,
      subscribeSnapshot(invalidate) {
        listeners.add(invalidate);
        return () => {
          listeners.delete(invalidate);
        };
      },
      async applyChange() {
        // BUG: two separate reassignments with a real suspension point
        // between them (phase 1 lands synchronously, before this call even
        // returns — the immediate read below observes it directly) — a
        // reader in that window sees `value` already advanced but
        // `version` still stale: a torn intermediate snapshot, matching
        // neither the pre- nor the post-change state.
        current = { value: current.value + 1, version: current.version };
        await Promise.resolve();
        current = { value: current.value, version: current.version + 1 };
        for (const listener of listeners) listener();
      },
    };
  }

  const options: ReactiveSourceConformanceOptions<CounterSnapshot> = {
    ...createCleanOptions(runtime),
    createSubject: createTornCounterSubject,
    // Deliberately not `triggerCounterChange`: this fixture's own
    // `applyChange` already contains its suspension point (the mutation's
    // first phase runs synchronously, before this call returns), so no
    // additional yield or virtual-clock advance is needed to expose it.
    triggerChange(subject: InMemoryCounterSubject) {
      return subject.applyChange();
    },
    reattach: undefined,
  };

  const results = await runCapturingly(options);
  expectOnlyCaseFailed(results, 'subscribeReadRaceClosure');
});

it('fails only earlyCompletionBeforeSubscription when the terminal state is not available until subscribed', async () => {
  const runtime = createManualRuntimeServices({ origin: '2026-02-05T00:00:00.000Z' });

  function createLateTerminalCounterSubject(): ReactiveSourceSubject<CounterSnapshot> {
    // BUG: placeholder value until subscribeSnapshot is called and a
    // microtask elapses — the terminal state is not delivered immediately.
    let current: CounterSnapshot = { value: -1, version: -1 };
    return {
      getSnapshot: () => current,
      subscribeSnapshot(invalidate) {
        void Promise.resolve().then(() => {
          current = { value: 99, version: 1 };
          invalidate();
        });
        return () => {};
      },
    };
  }

  const options: ReactiveSourceConformanceOptions<CounterSnapshot> = {
    ...createCleanOptions(runtime),
    createAlreadyTerminalSubject: createLateTerminalCounterSubject,
    reattach: undefined,
  };

  const results = await runCapturingly(options);
  expectOnlyCaseFailed(results, 'earlyCompletionBeforeSubscription');
});

it('fails only subscribeUnsubscribeSubscribeNoDuplicateWork when subscribing replays the last state', async () => {
  const runtime = createManualRuntimeServices({ origin: '2026-02-06T00:00:00.000Z' });

  function createReplayOnSubscribeCounterSubject(): InMemoryCounterSubject {
    let current: CounterSnapshot = { value: 0, version: 0 };
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => current,
      subscribeSnapshot(invalidate) {
        listeners.add(invalidate);
        // BUG: replays immediately on every subscribe, even with no real change.
        invalidate();
        return () => {
          listeners.delete(invalidate);
        };
      },
      async applyChange() {
        await new Promise<void>((resolve) => {
          runtime.timers.setTimeout(() => {
            current = { value: current.value + 1, version: current.version + 1 };
            for (const listener of listeners) listener();
            resolve();
          }, 5);
        });
      },
    };
  }

  const options: ReactiveSourceConformanceOptions<CounterSnapshot> = {
    ...createCleanOptions(runtime),
    createSubject: createReplayOnSubscribeCounterSubject,
    triggerChange(subject: InMemoryCounterSubject) {
      return triggerCounterChange(runtime, subject);
    },
    reattach: undefined,
  };

  const results = await runCapturingly(options);
  expectOnlyCaseFailed(results, 'subscribeUnsubscribeSubscribeNoDuplicateWork');
});

it('fails only serializableLocatorRoundTrip when reattach ignores the locator', async () => {
  const runtime = createManualRuntimeServices({ origin: '2026-02-07T00:00:00.000Z' });

  function reattachIgnoringLocator(): ReactiveSourceSubject<CounterSnapshot> {
    // BUG: ignores the locator entirely and always reconstructs default state.
    const defaultSnapshot: CounterSnapshot = { value: 0, version: 0 };
    return {
      getSnapshot: () => defaultSnapshot,
      subscribeSnapshot: () => () => {},
    };
  }

  const options: ReactiveSourceConformanceOptions<CounterSnapshot> = {
    ...createCleanOptions(runtime),
    // A non-default seed so a reattach that ignores the locator is visibly wrong.
    createSubject: () => createSeededCounterSubject(runtime, { value: 7, version: 3 }),
    triggerChange(subject: InMemoryCounterSubject) {
      return triggerCounterChange(runtime, subject);
    },
    reattach: reattachIgnoringLocator,
  };

  const results = await runCapturingly(options);
  expectOnlyCaseFailed(results, 'serializableLocatorRoundTrip');
});

it('fails serializableLocatorRoundTrip clearly when reattach is present but the subject has no toLocator', async () => {
  const runtime = createManualRuntimeServices({ origin: '2026-02-08T12:00:00.000Z' });

  function createLocatorlessCounterSubject(): ReactiveSourceSubject<CounterSnapshot> {
    const seeded = createSeededCounterSubject(runtime, { value: 0, version: 0 });
    // Deliberately omit `toLocator`, even though `options.reattach` is supplied below.
    return {
      getSnapshot: seeded.getSnapshot,
      subscribeSnapshot: seeded.subscribeSnapshot,
    };
  }

  const options: ReactiveSourceConformanceOptions<CounterSnapshot> = {
    ...createCleanOptions(runtime),
    createSubject: createLocatorlessCounterSubject,
    reattach: reattachCounterSubject,
  };

  const results = await runCapturingly(options);
  const result = results.find((entry) => entry.name === 'serializableLocatorRoundTrip');
  expect(result?.error).toBeDefined();
});

it('does not register serializableLocatorRoundTrip when reattach is absent', async () => {
  const runtime = createManualRuntimeServices({ origin: '2026-02-08T00:00:00.000Z' });
  const options: ReactiveSourceConformanceOptions<CounterSnapshot> = {
    ...createCleanOptions(runtime),
    reattach: undefined,
  };

  const results = await runCapturingly(options);
  expect(results.some((result) => result.name === 'serializableLocatorRoundTrip')).toBe(false);
  expect(results.every((result) => result.error === undefined)).toBe(true);
});

it('names the failing case when a snapshot is not structured-cloneable', async () => {
  // Not `CounterSnapshot`: this fixture's whole point is a snapshot shape
  // `structuredClone` rejects, so it needs its own non-cloneable type.
  interface UnclonableSnapshot {
    readonly value: number;
    readonly handler: () => void;
  }

  function createUnclonableSubject(): ReactiveSourceSubject<UnclonableSnapshot> {
    const snapshot: UnclonableSnapshot = { value: 0, handler: () => {} };
    return {
      getSnapshot: () => snapshot,
      subscribeSnapshot: () => () => {},
    };
  }

  const options: ReactiveSourceConformanceOptions<UnclonableSnapshot> = {
    label: 'unclonable snapshot',
    createSubject: createUnclonableSubject,
    triggerChange: async () => {},
    createAlreadyTerminalSubject: createUnclonableSubject,
  };

  const results = await runCapturingly(options);
  const result = results.find((entry) => entry.name === 'immutableReplacementAfterChange');
  const error = result?.error;
  if (!(error instanceof Error)) {
    throw new Error('expected immutableReplacementAfterChange to fail with an Error');
  }
  expect(error.message).toContain('immutableReplacementAfterChange');
  expect(error.message).toContain('structured-cloneable');
});
