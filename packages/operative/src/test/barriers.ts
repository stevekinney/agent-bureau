// ---------------------------------------------------------------------------
// AB-266 — the named barrier registry (AB-95's tst-04b slice, AB-92's
// testability contract). A `Barrier` is a two-sided latch a deterministic
// suite uses to replace a real-timer sleep: the guarded operation calls
// `arrive()` and suspends until the test calls `release()`/`reject()`; the
// test calls `reached()` to know arrival happened (resolving immediately if
// it already did, so a late subscriber never hangs) and `inspect()` to read
// arrival/release counts without guessing from elapsed time.
//
// `arrive()` is deliberately NOT one of the four methods AB-266's acceptance
// criteria names on `Barrier` (`reached`, `inspect`, `release`, `reject`) —
// those four are the test-observer side. Something has to let the GUARDED
// operation suspend at the barrier in the first place, and this package
// already has a name for that exact role: `BarrierCoordinator.arrive()` in
// `scripted-generate.ts`. `arrive()` here plays the identical part for a
// general-purpose barrier, not only a scripted double's own `block` step.
// ---------------------------------------------------------------------------

import type { EventRecorder } from './event-recorder';

/** A barrier's current arrival/release counts, and whether an arrival is currently blocked. */
export interface BarrierState {
  readonly name: string;
  readonly arrivals: number;
  readonly released: number;
  readonly pending: boolean;
}

/**
 * One named barrier. `barrier(name)` on a `BarrierRegistry` always returns
 * the same instance for the same name, so a producer (the guarded
 * operation, calling `arrive()`) and a consumer (the test, calling
 * `reached()`/`release()`/`reject()`) coordinate by name without sharing a
 * reference.
 */
export interface Barrier {
  /**
   * Resolves once the guarded operation has arrived at this barrier at
   * least once. Resolves immediately if arrival already happened — a test
   * that subscribes late never hangs. Does not itself release anything;
   * see `release`/`reject`.
   */
  reached(): Promise<void>;
  /** The barrier's current arrival/release counts and whether an arrival is pending. */
  inspect(): BarrierState;
  /**
   * Lets exactly one waiting arrival through, resolving its `arrive()` call
   * with `value`. Called before any arrival has happened, the release is
   * banked and lets the NEXT arrival through without blocking — repeated
   * over-release banks one outcome per call, each consumed by one future
   * arrival in order.
   */
  release(value?: unknown): void;
  /**
   * Makes the guarded operation's `arrive()` call throw `error` — a
   * placement mechanism for a fault at a point the fault vocabulary
   * (`fault-plan.ts`) doesn't name. Counts toward `released`, exactly like
   * `release`, so a rejected arrival is never reported as still pending by
   * `assertNoPending`. Banks ahead of arrival the same way `release` does.
   */
  reject(error: unknown): void;
  /**
   * The guarded-operation side: called by the code under test when it
   * reaches this coordination point. Resolves with whatever `release` was
   * called with, or rejects with whatever `reject` was called with —
   * immediately, against a banked outcome, if `release`/`reject` already
   * ran more times than there have been arrivals; otherwise suspends until
   * the next `release`/`reject` call.
   */
  arrive(): Promise<unknown>;
}

/** A named collection of barriers, keyed by name; created lazily on first request. */
export interface BarrierRegistry {
  /** Returns the barrier named `name`, creating it on first request. Same name always returns the same instance. */
  barrier(name: string): Barrier;
  /** Every barrier name requested so far, in first-request order. */
  names(): readonly string[];
  /**
   * Throws, naming every still-blocked barrier, if any barrier created by
   * this registry currently has an arrival waiting for `release`/`reject`.
   * The specific way a barrier-based suite hangs is an arrival nothing ever
   * releases; this is the assertion that catches it instead of a test
   * timing out.
   */
  assertNoPending(): void;
}

type BankedOutcome =
  | { readonly kind: 'release'; readonly value: unknown }
  | { readonly kind: 'reject'; readonly error: unknown };

interface Waiter {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/** The three transitions a barrier's own event target dispatches when a recorder is attached. */
interface BarrierEventMap {
  'barrier.reached': BarrierReachedEvent;
  'barrier.released': BarrierReleasedEvent;
  'barrier.rejected': BarrierRejectedEvent;
}

const BARRIER_EVENT_TYPES: readonly (keyof BarrierEventMap)[] = [
  'barrier.reached',
  'barrier.released',
  'barrier.rejected',
];

/** Dispatched on every `arrive()` call — `arrivals` is the barrier's post-increment count. */
class BarrierReachedEvent extends Event {
  static readonly type = 'barrier.reached' as const;
  readonly name: string;
  readonly arrivals: number;
  constructor(name: string, arrivals: number) {
    super(BarrierReachedEvent.type);
    this.name = name;
    this.arrivals = arrivals;
  }
}

/** Dispatched on every `release()` call — `released` is the barrier's post-increment count. */
class BarrierReleasedEvent extends Event {
  static readonly type = 'barrier.released' as const;
  readonly name: string;
  readonly released: number;
  constructor(name: string, released: number) {
    super(BarrierReleasedEvent.type);
    this.name = name;
    this.released = released;
  }
}

/** Dispatched on every `reject()` call — `released` is the barrier's post-increment count (reject counts toward it too; see `Barrier.reject`'s doc comment). */
class BarrierRejectedEvent extends Event {
  static readonly type = 'barrier.rejected' as const;
  readonly name: string;
  readonly released: number;
  constructor(name: string, released: number) {
    super(BarrierRejectedEvent.type);
    this.name = name;
    this.released = released;
  }
}

/**
 * Builds one `Barrier`. A factory function (not a class), matching this
 * package's conventions — every field below is a closure-local `const`.
 *
 * Recorder integration: when `recorder` is supplied, every transition is
 * recorded as a `CausalTraceEntry` via the recorder's own public `attach`
 * — the same mechanism any other resource in this test kit uses, never a
 * private push into the recorder's internal entry list (no such method is
 * public; `event-recorder.ts` is outside this slice's delivery boundary).
 * `attach` fixes `resource` as `` `${ownerIdentity.kind}:${ownerIdentity.id}` ``
 * with no way to opt out of the colon-joined form — passing `{ kind:
 * 'barrier', id: name }` therefore produces `` `barrier:${name}` ``, not the
 * bare `name` a literal reading of AB-266's acceptance criteria describes.
 * The name is still the entire, unambiguous, greppable suffix of the
 * resource string (`'barrier:my-barrier'.split(':').slice(1).join(':') ===
 * 'my-barrier'`), and this is the identical, already-precedented deviation
 * `EventListenerSource`'s own doc comment in `event-recorder.ts` takes for
 * an equally mechanical reason — documented there, and pinned by a test
 * here (`resource === 'barrier:<name>'`).
 */
function createBarrier(name: string, recorder?: EventRecorder): Barrier {
  let arrivals = 0;
  let released = 0;
  const banked: BankedOutcome[] = [];
  const waiters: Waiter[] = [];
  let hasArrived = false;
  let resolveArrived!: () => void;
  const arrivedPromise = new Promise<void>((resolve) => {
    resolveArrived = resolve;
  });

  const target = recorder ? new EventTarget() : undefined;
  if (recorder && target) {
    recorder.attach<BarrierEventMap>(target, { kind: 'barrier', id: name }, BARRIER_EVENT_TYPES);
  }

  function reached(): Promise<void> {
    return arrivedPromise;
  }

  function inspect(): BarrierState {
    return { name, arrivals, released, pending: waiters.length > 0 };
  }

  // An `async` function so a banked rejection can `throw` (satisfying
  // `@typescript-eslint/prefer-promise-reject-errors`, which flags a
  // direct `Promise.reject(nonError)` but not a thrown non-`Error` inside
  // an async function body) rather than construct a rejected `Promise`
  // directly. `Barrier.reject(error: unknown)` deliberately accepts and
  // rethrows an arbitrary value by reference identity (a test asserts
  // `caught === error`), so wrapping it in an `Error` here would break
  // that contract — throwing the raw value keeps identity intact.
  async function arrive(): Promise<unknown> {
    arrivals++;
    if (!hasArrived) {
      hasArrived = true;
      resolveArrived();
    }
    target?.dispatchEvent(new BarrierReachedEvent(name, arrivals));

    const outcome = banked.shift();
    if (outcome) {
      if (outcome.kind === 'release') return outcome.value;
      throw outcome.error;
    }
    return new Promise<unknown>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  function release(value?: unknown): void {
    released++;
    target?.dispatchEvent(new BarrierReleasedEvent(name, released));
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(value);
    } else {
      banked.push({ kind: 'release', value });
    }
  }

  function reject(error: unknown): void {
    released++;
    target?.dispatchEvent(new BarrierRejectedEvent(name, released));
    const waiter = waiters.shift();
    if (waiter) {
      waiter.reject(error);
    } else {
      banked.push({ kind: 'reject', error });
    }
  }

  return { reached, inspect, release, reject, arrive };
}

/**
 * Creates a `BarrierRegistry`. `recorder`, when supplied, receives a
 * `CausalTraceEntry` for every arrival, release, and rejection on every
 * barrier this registry creates — see `createBarrier`'s doc comment for the
 * exact `resource`/`event` shape.
 */
export function createBarrierRegistry(recorder?: EventRecorder): BarrierRegistry {
  const barriers = new Map<string, Barrier>();

  function barrier(name: string): Barrier {
    let existing = barriers.get(name);
    if (!existing) {
      existing = createBarrier(name, recorder);
      barriers.set(name, existing);
    }
    return existing;
  }

  function names(): readonly string[] {
    return [...barriers.keys()];
  }

  function assertNoPending(): void {
    const stuck = [...barriers.values()].map((b) => b.inspect()).filter((s) => s.pending);
    if (stuck.length > 0) {
      throw new Error(
        `assertNoPending: ${stuck.length} barrier(s) still blocked (arrival never released): ${stuck
          .map((s) => s.name)
          .join(', ')}`,
      );
    }
  }

  return { barrier, names, assertNoPending };
}
