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
 * Callers supply test registration and structural equality through
 * {@link ReactiveSourceConformanceTestRunner}. Importing the public library
 * never loads a test framework or requires a particular runtime.
 */

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
   *
   * Must not make the change visible — through `getSnapshot()` or by
   * invalidating any subscriber — until *after* the returned promise has
   * handed control back to its caller at least once (an `await` of
   * something other than the change itself, e.g. a microtask tick, before
   * committing). `subscribeReadRaceClosure` subscribes and reads
   * synchronously in the gap between calling `triggerChange` and it
   * resolving; an implementation that commits synchronously, before ever
   * yielding, collapses that gap to nothing and the case can only ever
   * observe the already-committed state — never a genuine test of the
   * "started, not yet committed" window.
   */
  triggerChange(subject: ReactiveSourceSubject<TSnapshot>): Promise<void>;
  /** Creates a subject whose represented work is already complete. */
  createAlreadyTerminalSubject(): ReactiveSourceSubject<TSnapshot>;
  /**
   * Reconstructs a subject from a previously serialized locator. Present
   * only for reattachable resources; when absent,
   * `serializableLocatorRoundTrip` is not registered at all.
   */
  reattach?: ((locator: unknown) => ReactiveSourceSubject<TSnapshot> | undefined) | undefined;
}

/** Test registration and structural equality supplied by the caller. */
export interface ReactiveSourceConformanceTestRunner {
  describe(label: string, fn: () => void): void;
  it(name: string, fn: () => void | Promise<void>): void;
  equal(left: unknown, right: unknown): boolean;
}

type SnapshotEquality = ReactiveSourceConformanceTestRunner['equal'];

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * `structuredClone`, guarded: several cases below clone a snapshot purely
 * to compare it against a later read without holding a live reference. A
 * snapshot type containing something the structured clone algorithm
 * rejects (a function, most host objects) makes that clone throw — without
 * this wrapper, a low-signal `DOMException` naming neither the case nor the
 * requirement violated. `caseName` names the `it()` this call is running
 * inside, so the rethrown error is actionable on its own.
 */
function cloneSnapshot<TSnapshot>(snapshot: TSnapshot, caseName: string): TSnapshot {
  try {
    return structuredClone(snapshot);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${caseName}: this suite clones each snapshot it reads, so TSnapshot must be structured-cloneable (see MDN's "structured clone algorithm"); structuredClone failed: ${reason}`,
      { cause: error },
    );
  }
}

function assertStableSnapshotIdentity<TSnapshot>(subject: ReactiveSourceSubject<TSnapshot>): void {
  const first = subject.getSnapshot();
  const second = subject.getSnapshot();
  assertCondition(
    Object.is(second, first),
    'stableSnapshotIdentity: unchanged reads must return the same object',
  );
}

async function assertImmutableReplacementAfterChange<TSnapshot>(
  options: ReactiveSourceConformanceOptions<TSnapshot>,
  equal: SnapshotEquality,
): Promise<void> {
  const subject = options.createSubject();
  const before = subject.getSnapshot();
  const beforeClone = cloneSnapshot(before, 'immutableReplacementAfterChange');
  await options.triggerChange(subject);
  const after = subject.getSnapshot();
  assertCondition(
    !Object.is(after, before),
    'immutableReplacementAfterChange: a change must replace the snapshot',
  );
  assertCondition(
    equal(before, beforeClone),
    'immutableReplacementAfterChange: previous snapshots must not mutate',
  );
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
  assertCondition(
    countA >= 1,
    'multipleIndependentSubscribers: first subscriber was not invalidated',
  );
  assertCondition(
    countB >= 1,
    'multipleIndependentSubscribers: second subscriber was not invalidated',
  );
  const countAAfterFirstChange = countA;
  const countBAfterFirstChange = countB;

  unsubscribeA();
  await options.triggerChange(subject);
  assertCondition(
    countA === countAAfterFirstChange,
    'multipleIndependentSubscribers: unsubscribed listener was called',
  );
  assertCondition(
    countB > countBAfterFirstChange,
    'multipleIndependentSubscribers: unsubscribing removed another listener',
  );
  unsubscribeB();
}

async function assertSubscribeReadRaceClosure<TSnapshot>(
  options: ReactiveSourceConformanceOptions<TSnapshot>,
  equal: SnapshotEquality,
): Promise<void> {
  const subject = options.createSubject();
  const before = cloneSnapshot(subject.getSnapshot(), 'subscribeReadRaceClosure');

  // The change starts here. `triggerChange` is deterministic (no wall-clock
  // sleep) but still asynchronous: control returns to this line before the
  // change has committed, which is the "started, not yet committed" window
  // this case exercises.
  const changeCommitted = options.triggerChange(subject);

  let invalidated = false;
  const unsubscribe = subject.subscribeSnapshot(() => {
    invalidated = true;
  });
  const observed = cloneSnapshot(subject.getSnapshot(), 'subscribeReadRaceClosure');

  await changeCommitted;
  const after = cloneSnapshot(subject.getSnapshot(), 'subscribeReadRaceClosure');
  unsubscribe();

  const matchesBefore = equal(observed, before);
  const matchesAfter = equal(observed, after);
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
  equal: SnapshotEquality,
): Promise<void> {
  const subject = options.createAlreadyTerminalSubject();
  const immediate = cloneSnapshot(subject.getSnapshot(), 'earlyCompletionBeforeSubscription');
  const unsubscribe = subject.subscribeSnapshot(() => {});
  // One microtask tick — enough time for a subject that (incorrectly) needs
  // the act of subscribing to finish delivering its terminal state to do so.
  await Promise.resolve();
  const afterSubscribe = cloneSnapshot(subject.getSnapshot(), 'earlyCompletionBeforeSubscription');
  unsubscribe();
  assertCondition(
    equal(afterSubscribe, immediate),
    'earlyCompletionBeforeSubscription: subscription changed terminal state',
  );
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

  assertCondition(
    countFirst === 0,
    'subscribeUnsubscribeSubscribeNoDuplicateWork: removed listener was called',
  );
  assertCondition(
    countSecond === 1,
    'subscribeUnsubscribeSubscribeNoDuplicateWork: expected exactly one invalidation',
  );
}

function assertSerializableLocatorRoundTrip<TSnapshot>(
  options: ReactiveSourceConformanceOptions<TSnapshot>,
  reattach: (locator: unknown) => ReactiveSourceSubject<TSnapshot> | undefined,
  equal: SnapshotEquality,
): void {
  const subject = options.createSubject();
  const toLocator = subject.toLocator;
  if (!toLocator) {
    throw new Error(
      'serializableLocatorRoundTrip requires the subject returned by createSubject() to implement toLocator',
    );
  }

  const before = cloneSnapshot(subject.getSnapshot(), 'serializableLocatorRoundTrip');
  // Round-trip through JSON, proving the locator is actually serializable
  // rather than merely structurally cloneable.
  const serializedLocator: unknown = JSON.parse(JSON.stringify(toLocator()));
  const reattached = reattach(serializedLocator);
  if (!reattached) throw new Error('serializableLocatorRoundTrip reattach returned no subject');
  const after = reattached.getSnapshot();
  assertCondition(
    equal(after, before),
    'serializableLocatorRoundTrip: reattachment changed the snapshot',
  );
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
  testRunner: ReactiveSourceConformanceTestRunner,
): void {
  testRunner.describe(`reactive-source conformance: ${options.label}`, () => {
    testRunner.it('stableSnapshotIdentity', () => {
      assertStableSnapshotIdentity(options.createSubject());
    });
    testRunner.it('immutableReplacementAfterChange', () =>
      assertImmutableReplacementAfterChange(options, testRunner.equal),
    );
    testRunner.it('multipleIndependentSubscribers', () =>
      assertMultipleIndependentSubscribers(options),
    );
    testRunner.it('subscribeReadRaceClosure', () =>
      assertSubscribeReadRaceClosure(options, testRunner.equal),
    );
    testRunner.it('earlyCompletionBeforeSubscription', () =>
      assertEarlyCompletionBeforeSubscription(options, testRunner.equal),
    );
    testRunner.it('subscribeUnsubscribeSubscribeNoDuplicateWork', () =>
      assertSubscribeUnsubscribeSubscribeNoDuplicateWork(options),
    );
    const reattach = options.reattach;
    if (reattach) {
      testRunner.it('serializableLocatorRoundTrip', () =>
        assertSerializableLocatorRoundTrip(options, reattach, testRunner.equal),
      );
    }
  });
}
