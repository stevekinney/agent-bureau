import type { CleanupAcknowledgement, ClosedOptions } from './types';

/**
 * Builds a `closed()` implementation shared by every `ActiveRun` factory
 * (`createActiveRun`, `createDurableActiveRun`, `reattachDurableActiveRun`).
 * Each factory supplies its own settlement promise and its own classifier —
 * this module owns only the parts that must behave identically everywhere:
 * memoization, the `not-required` fast path, and per-call `signal` handling.
 *
 * AB-37's decision record (`documentation/operative-type-safe-api.md`'s
 * started-work control contract) and AB-204's acceptance criteria are the
 * source of the contract implemented here:
 *
 * - `closed()` never rejects.
 * - It is idempotent: once the underlying cleanup has genuinely settled, a
 *   repeated call returns the identical cached `CleanupAcknowledgement`
 *   object by reference.
 * - The cache is scoped to resource-level settlement, not to any one call's
 *   outcome — a call whose own `options.signal` fires first resolves
 *   `unresolved`/`timed-out` for that caller only and never writes into the
 *   shared cache.
 * - `not-required` is returned immediately when, at the moment `closed()` is
 *   FIRST called, the run has already reached a terminal event, has no
 *   tracked in-flight work, and `disqualifiesFastPath()` says no. A
 *   cancellation request always disqualifies the fast path — even after the
 *   run has settled — because a durable cancellation still needs its own
 *   acknowledgement (AB-37's durable-cancellation section; see AB-204's
 *   AC7 rollback trigger). A factory whose `resolveOutcome()` can classify a
 *   settled-but-unresolvable outcome (e.g. `reattachDurableActiveRun`'s
 *   `unreachable` case, AC8) folds that same condition into
 *   `disqualifiesFastPath` too — otherwise the fast path could return
 *   `not-required` for a run `resolveOutcome()` would have classified
 *   `unresolved`, silently hiding it.
 */
export interface CreateClosedAcknowledgementOptions {
  /** The run's terminal result promise. */
  readonly result: Promise<unknown>;
  /**
   * Whether the fast `not-required` path must be skipped even though the run
   * has settled with nothing in flight — true when a cancellation was
   * requested, or when `resolveOutcome()` would classify this settlement as
   * something other than a trivial success (see this option's doc comment
   * above).
   */
  readonly disqualifiesFastPath: () => boolean;
  /** Whether any tracked unit of work (e.g. a toolbox call) is still in flight. */
  readonly hasInFlightWork: () => boolean;
  /**
   * Computes the acknowledgement once `result` has resolved. Not invoked when
   * `result` rejects — that path is classified `{ status: 'failed', error }`
   * automatically, matching "a definite, observed teardown failure".
   */
  readonly resolveOutcome: () => Promise<CleanupAcknowledgement>;
}

export type ClosedFunction = (options?: ClosedOptions) => Promise<CleanupAcknowledgement>;

export function createClosedAcknowledgement(
  options: CreateClosedAcknowledgementOptions,
): ClosedFunction {
  let cached: CleanupAcknowledgement | undefined;
  let pending: Promise<CleanupAcknowledgement> | undefined;
  let resultFulfilled = false;
  let resultRejected = false;
  let notRequiredEvaluated = false;

  void options.result.then(
    () => {
      resultFulfilled = true;
    },
    () => {
      resultRejected = true;
    },
  );

  function evaluateNotRequired(): CleanupAcknowledgement | undefined {
    if (notRequiredEvaluated) return undefined;
    notRequiredEvaluated = true;
    // A rejected settlement is a genuine, observed problem — never silently
    // swallowed into "nothing needed cleanup". Only a clean fulfillment is
    // eligible for the fast path.
    if (
      resultFulfilled &&
      !resultRejected &&
      !options.hasInFlightWork() &&
      !options.disqualifiesFastPath()
    ) {
      return { status: 'not-required' };
    }
    return undefined;
  }

  function getPending(): Promise<CleanupAcknowledgement> {
    if (cached) return Promise.resolve(cached);
    if (pending) return pending;

    const notRequired = evaluateNotRequired();
    if (notRequired) {
      cached = notRequired;
      return Promise.resolve(cached);
    }

    pending = options.result
      .then(classifyOutcome, (error: unknown): CleanupAcknowledgement => ({
        status: 'failed',
        error,
      }))
      .then((acknowledgement) => {
        cached = acknowledgement;
        return acknowledgement;
      });
    return pending;
  }

  // `closed()` never rejects: `resolveOutcome()` is caller-supplied and may
  // itself throw synchronously or return a rejected promise, so this wraps
  // it in an `async` boundary (turning a synchronous throw into a
  // catchable rejection) and classifies any failure `{ status: 'failed',
  // error }` rather than letting it propagate.
  async function classifyOutcome(): Promise<CleanupAcknowledgement> {
    try {
      return await options.resolveOutcome();
    } catch (error) {
      return { status: 'failed', error };
    }
  }

  return function closed(closedOptions?: ClosedOptions): Promise<CleanupAcknowledgement> {
    const settlement = getPending();
    const signal = closedOptions?.signal;
    if (!signal) return settlement;

    // A genuine settlement already cached means there is no remaining wait
    // for the signal to bound — honor the post-settlement idempotency
    // guarantee (the identical cached object) rather than manufacturing a
    // fresh `unresolved`/`timed-out` result for an already-aborted signal.
    if (cached) return Promise.resolve(cached);

    if (signal.aborted) {
      return Promise.resolve({ status: 'unresolved', reason: 'timed-out' });
    }

    return new Promise<CleanupAcknowledgement>((resolve) => {
      let callSettled = false;
      const onAbort = (): void => {
        if (callSettled) return;
        callSettled = true;
        resolve({ status: 'unresolved', reason: 'timed-out' });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void settlement.then((acknowledgement) => {
        if (callSettled) return;
        callSettled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(acknowledgement);
      });
    });
  };
}
