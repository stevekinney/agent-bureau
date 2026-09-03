/**
 * The framework-neutral reactive-source conformance suite — AB-92's
 * Decision (2026-09-01), "Reactive-source conformance suite" (AC7), built
 * out per AB-258.
 *
 * This module takes exactly one shape, {@link ReactiveSourceSubject}, and
 * nothing from `packages/operative/src` outside its own generic parameter.
 * Any resource that later implements `getSnapshot()`/`subscribeSnapshot()`
 * — `ActiveRun`, `AgentRun`, a Bureau locator, or anything else — has a
 * fixed conformance target to satisfy by calling
 * {@link runReactiveSourceConformanceSuite} with an adapter, rather than a
 * second decision inventing checks per resource (AB-214 is the first
 * consumer, wired up separately per tst-05a).
 *
 * {@link ReactiveSourceConformanceTestRunner} is the one addition beyond
 * AB-92's sketch: an injectable `describe`/`it` pair, defaulted to
 * `bun:test`'s real ones for every production caller. It exists solely so
 * this module's own self-test (`reactive-source-suite.test.ts`) can run the
 * suite against seven deliberately broken fixtures and capture each case's
 * pass/fail outcome without those intentional failures making `bun test`
 * itself exit non-zero — the same factory-injection pattern this repo uses
 * everywhere else for testability (see `.claude/rules/testing-standards.md`),
 * applied to the suite's own test registration instead of a runtime
 * dependency.
 */

import { describe, expect, it } from 'bun:test';

/**
 * The public observation surface a reactive resource must implement to
 * satisfy this suite. `toLocator` is present only on resources that support
 * reattachment (a fresh handle reconstructed from a serialized locator);
 * its absence — together with an absent {@link
 * ReactiveSourceConformanceOptions.reattach} — skips
 * `serializableLocatorRoundTrip` entirely rather than failing it.
 */
export interface ReactiveSourceSubject<TSnapshot> {
  /**
   * Returns the current snapshot. Must return the exact same object by
   * reference across calls while nothing has changed, and a new object by
   * reference — never a mutation of a previously returned object — once
   * something has.
   */
  getSnapshot(): TSnapshot;
  /**
   * Registers `invalidate` to be called once per observed change. Returns
   * an unsubscribe function; calling it must stop further calls to this
   * particular `invalidate` without affecting any other subscriber.
   */
  subscribeSnapshot(invalidate: () => void): () => void;
  /** Present only for reattachable resources. */
  toLocator?(): unknown;
}

/**
 * Configures one run of the suite against one kind of subject. A test
 * author supplies this once per resource under test (an in-memory double,
 * `ActiveRun`, `AgentRun`, …) and calls
 * {@link runReactiveSourceConformanceSuite} with it.
 */
export interface ReactiveSourceConformanceOptions<TSnapshot> {
  /** Identifies this run in the generated `describe` block's name. */
  label: string;
  /** Creates one fresh, unchanged subject. */
  createSubject(): ReactiveSourceSubject<TSnapshot>;
  /**
   * Causes one real, observable change on `subject` and resolves once that
   * change has fully committed (every subscriber that was registered
   * before the change started has been invalidated). Deterministic —
   * callers use an injected clock/timer seam rather than a real timer, so
   * this never depends on wall-clock timing.
   */
  triggerChange(subject: ReactiveSourceSubject<TSnapshot>): Promise<void>;
  /** Creates a subject whose represented work is already complete. */
  createAlreadyTerminalSubject(): ReactiveSourceSubject<TSnapshot>;
  /**
   * Reconstructs a subject from a previously serialized locator. Present
   * only for reattachable resources; when absent,
   * `serializableLocatorRoundTrip` is not registered at all.
   */
  reattach?(locator: unknown): ReactiveSourceSubject<TSnapshot>;
}

/**
 * The `describe`/`it` pair {@link runReactiveSourceConformanceSuite}
 * registers its cases through. Defaults to `bun:test`'s real `describe`/
 * `it`; only overridden by this module's own self-test, to capture each
 * case's pass/fail outcome for the seven negative-fixture proofs instead of
 * letting an intentional failure fail the whole file.
 */
export interface ReactiveSourceConformanceTestRunner {
  describe(label: string, fn: () => void): void;
  it(name: string, fn: () => void | Promise<void>): void;
}

const defaultTestRunner: ReactiveSourceConformanceTestRunner = { describe, it };

function assertStableSnapshotIdentity<TSnapshot>(subject: ReactiveSourceSubject<TSnapshot>): void {
  const first = subject.getSnapshot();
  const second = subject.getSnapshot();
  expect(second).toBe(first);
}

async function assertImmutableReplacementAfterChange<TSnapshot>(
  options: ReactiveSourceConformanceOptions<TSnapshot>,
): Promise<void> {
  const subject = options.createSubject();
  const before = subject.getSnapshot();
  const beforeClone = structuredClone(before);
  await options.triggerChange(subject);
  const after = subject.getSnapshot();
  expect(after).not.toBe(before);
  expect(before).toEqual(beforeClone);
}

async function assertMultipleIndependentSubscribers<TSnapshot>(
  options: ReactiveSourceConformanceOptions<TSnapshot>,
): Promise<void> {
  const subject = options.createSubject();
  let countA = 0;
  let countB = 0;
  const unsubscribeA = subject.subscribeSnapshot(() => {
    countA += 1;
  });
  const unsubscribeB = subject.subscribeSnapshot(() => {
    countB += 1;
  });

  await options.triggerChange(subject);
  expect(countA).toBeGreaterThanOrEqual(1);
  expect(countB).toBeGreaterThanOrEqual(1);
  const countAAfterFirstChange = countA;
  const countBAfterFirstChange = countB;

  unsubscribeA();
  await options.triggerChange(subject);
  expect(countA).toBe(countAAfterFirstChange);
  expect(countB).toBeGreaterThan(countBAfterFirstChange);
  unsubscribeB();
}

async function assertSubscribeReadRaceClosure<TSnapshot>(
  options: ReactiveSourceConformanceOptions<TSnapshot>,
): Promise<void> {
  const subject = options.createSubject();
  const before = structuredClone(subject.getSnapshot());

  // The change starts here. `triggerChange` is deterministic (no wall-clock
  // sleep) but still asynchronous: control returns to this line before the
  // change has committed, which is the "started, not yet committed" window
  // this case exercises.
  const changeCommitted = options.triggerChange(subject);

  let invalidated = false;
  const unsubscribe = subject.subscribeSnapshot(() => {
    invalidated = true;
  });
  const observed = structuredClone(subject.getSnapshot());

  await changeCommitted;
  const after = structuredClone(subject.getSnapshot());
  unsubscribe();

  const matchesBefore = Bun.deepEquals(observed, before);
  const matchesAfter = Bun.deepEquals(observed, after);
  const missedChange = matchesBefore && !invalidated;
  if ((!matchesBefore && !matchesAfter) || missedChange) {
    const message = missedChange
      ? 'subscribeReadRaceClosure: subscribed before the commit but was never invalidated — the change was missed'
      : 'subscribeReadRaceClosure: observed a torn intermediate snapshot matching neither the pre- nor post-change state';
    throw new Error(message);
  }
}

async function assertEarlyCompletionBeforeSubscription<TSnapshot>(
  options: ReactiveSourceConformanceOptions<TSnapshot>,
): Promise<void> {
  const subject = options.createAlreadyTerminalSubject();
  const immediate = structuredClone(subject.getSnapshot());
  const unsubscribe = subject.subscribeSnapshot(() => {});
  // One microtask tick — enough time for a subject that (incorrectly) needs
  // the act of subscribing to finish delivering its terminal state to do so.
  await Promise.resolve();
  const afterSubscribe = structuredClone(subject.getSnapshot());
  unsubscribe();
  expect(afterSubscribe).toEqual(immediate);
}

async function assertSubscribeUnsubscribeSubscribeNoDuplicateWork<TSnapshot>(
  options: ReactiveSourceConformanceOptions<TSnapshot>,
): Promise<void> {
  const subject = options.createSubject();

  let countFirst = 0;
  const unsubscribeFirst = subject.subscribeSnapshot(() => {
    countFirst += 1;
  });
  unsubscribeFirst();

  let countSecond = 0;
  const unsubscribeSecond = subject.subscribeSnapshot(() => {
    countSecond += 1;
  });
  await options.triggerChange(subject);
  unsubscribeSecond();

  expect(countFirst).toBe(0);
  expect(countSecond).toBe(1);
}

function assertSerializableLocatorRoundTrip<TSnapshot>(
  options: ReactiveSourceConformanceOptions<TSnapshot>,
  reattach: (locator: unknown) => ReactiveSourceSubject<TSnapshot>,
): void {
  const subject = options.createSubject();
  const toLocator = subject.toLocator;
  if (!toLocator) {
    throw new Error(
      'serializableLocatorRoundTrip requires the subject returned by createSubject() to implement toLocator',
    );
  }

  const before = structuredClone(subject.getSnapshot());
  // Round-trip through JSON, proving the locator is actually serializable
  // rather than merely structurally cloneable.
  const serializedLocator: unknown = JSON.parse(JSON.stringify(toLocator()));
  const reattached = reattach(serializedLocator);
  const after = reattached.getSnapshot();
  expect(after).toEqual(before);
}

/**
 * Registers one `describe` block containing one `it` per case AB-92 names:
 * `stableSnapshotIdentity`, `immutableReplacementAfterChange`,
 * `multipleIndependentSubscribers`, `subscribeReadRaceClosure`,
 * `earlyCompletionBeforeSubscription`,
 * `subscribeUnsubscribeSubscribeNoDuplicateWork`, and — only when
 * `options.reattach` is supplied — `serializableLocatorRoundTrip`.
 */
export function runReactiveSourceConformanceSuite<TSnapshot>(
  options: ReactiveSourceConformanceOptions<TSnapshot>,
  testRunner: ReactiveSourceConformanceTestRunner = defaultTestRunner,
): void {
  testRunner.describe(`reactive-source conformance: ${options.label}`, () => {
    testRunner.it('stableSnapshotIdentity', () => {
      assertStableSnapshotIdentity(options.createSubject());
    });
    testRunner.it('immutableReplacementAfterChange', () =>
      assertImmutableReplacementAfterChange(options),
    );
    testRunner.it('multipleIndependentSubscribers', () =>
      assertMultipleIndependentSubscribers(options),
    );
    testRunner.it('subscribeReadRaceClosure', () => assertSubscribeReadRaceClosure(options));
    testRunner.it('earlyCompletionBeforeSubscription', () =>
      assertEarlyCompletionBeforeSubscription(options),
    );
    testRunner.it('subscribeUnsubscribeSubscribeNoDuplicateWork', () =>
      assertSubscribeUnsubscribeSubscribeNoDuplicateWork(options),
    );
    const reattach = options.reattach;
    if (reattach) {
      testRunner.it('serializableLocatorRoundTrip', () =>
        assertSerializableLocatorRoundTrip(options, reattach),
      );
    }
  });
}
