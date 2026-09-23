import { deepCloneAndFreeze, type SkillCatalogRevision } from './catalog';
import { discoverSkills, type DiscoverSkillsOptions } from './discover';

/**
 * How a refresh ended.
 *
 * `unchanged` is not a failure: a source re-scanned and found identical commits no revision, so a
 * run holding the previous one keeps it by identity rather than being handed an equal-but-different
 * object on every poll.
 */
export type SkillCatalogRefreshOutcome = 'committed' | 'unchanged' | 'cancelled' | 'failed';

/**
 * The cleanup-outcome vocabulary, reused verbatim from
 * `packages/armorer/src/execution-lifecycle.ts` as the started-work contract requires.
 */
export type SkillCatalogRefreshCleanup = 'not-required' | 'completed' | 'failed' | 'unresolved';

export type SkillCatalogRefreshStatus = 'pending' | 'settled';

/** The terminal facts about one refresh. */
export interface SkillCatalogRefreshResult {
  readonly id: string;
  readonly outcome: SkillCatalogRefreshOutcome;
  readonly previousRevision: number;
  /** Present only when `outcome === 'committed'`. */
  readonly newRevision?: number;
  /** Present only when `outcome === 'failed'`. */
  readonly failureReason?: string;
  readonly completedAt: string;
}

/**
 * A refresh's own cached, immutable snapshot.
 *
 * `revision` counts this handle's own transitions — 1 while pending, 2 once settled — and is
 * deliberately a different number from the catalog revision it may commit. `previousRevision` is
 * carried on every snapshot so the two are never read as the same counter.
 */
export interface SkillCatalogRefreshSnapshot {
  readonly id: string;
  readonly kind: 'skill-catalog-refresh';
  readonly startedAt: string;
  readonly revision: number;
  readonly status: SkillCatalogRefreshStatus;
  readonly lastTransitionAt: string;
  readonly projection: 'privileged';
  readonly ownership: 'independent';
  readonly detached: false;
  readonly durability: 'process-local';
  /**
   * Truthful at construction, as the contract requires.
   *
   * A handle returned by joining an in-flight refresh reports `false`: that work belongs to whoever
   * started it, and letting a late joiner cancel it would be one caller silently killing another's
   * scan. Its `abort()` is then the contract's documented no-op.
   */
  readonly cancellable: boolean;
  readonly previousRevision: number;
  readonly result?: SkillCatalogRefreshResult;
}

/** A live refresh, exposing the started-work contract's required capabilities. */
export interface SkillCatalogRefreshHandle {
  /** Cached and side-effect-free. Calling it starts nothing and waits for nothing. */
  snapshot(): SkillCatalogRefreshSnapshot;
  /** Delivers the current snapshot before returning, then every later revision. */
  subscribeSnapshot(observer: (snapshot: SkillCatalogRefreshSnapshot) => void): () => void;
  /** Idempotent. A second call on a settled refresh is a no-op. */
  abort(reason?: string): void;
  /** The terminal result. Never rejects. */
  result(): Promise<SkillCatalogRefreshResult>;
  /** Memoized cleanup acknowledgement. Never rejects. */
  closed(): Promise<SkillCatalogRefreshCleanup>;
}

/** A catalog that can be read without cost and refreshed deliberately. */
export interface SkillCatalogService {
  /**
   * The current revision.
   *
   * Pure: it starts no scan, touches no filesystem, and returns the identical frozen object by
   * reference until a refresh commits a new one.
   */
  catalog(): SkillCatalogRevision;
  /**
   * Starts a refresh, or joins the one already running.
   *
   * Coalescing is not an optimization. Two refreshes that both read the same `previousRevision` and
   * both commit assign the *same* revision number to two different catalogs, and the slower
   * silently overwrites the faster — a lost update a run diffing by revision number cannot see.
   *
   * Two consequences a caller must know about, because they are not free. A joined handle reports
   * `cancellable: false` and its `abort()` does nothing: that scan belongs to whoever started it,
   * and letting a joiner cancel it would be one caller silently killing another's work. And the
   * result reflects the filesystem as of when the *original* refresh started, which may predate
   * the joiner's reason for asking — so a caller that must observe a change it just made should
   * await the in-flight refresh first and then start another.
   */
  refresh(options?: SkillCatalogRefreshOptions): SkillCatalogRefreshHandle;
}

/** Per-refresh overrides. */
export interface SkillCatalogRefreshOptions {
  readonly signal?: AbortSignal;
  readonly id?: string;
}

/** Options for {@link createSkillCatalogService}. */
export interface CreateSkillCatalogServiceOptions extends Omit<
  DiscoverSkillsOptions,
  'revision' | 'signal'
> {
  /**
   * Milliseconds after which a refresh gives up. Default 30 seconds; `0` disables the bound.
   *
   * A refresh that never settles would hold the in-flight slot for the process's lifetime, so every
   * later `refresh()` would join a scan that is never going to finish — a wedged service rather
   * than one slow call. A transport that ignores its abort signal is exactly that case.
   */
  readonly refreshTimeoutMilliseconds?: number;
  /** The revision to start from, already discovered. Omit to start empty at revision 0. */
  readonly initial?: SkillCatalogRevision;
  /** Identifier factory for refreshes. Injectable so tests need not read a real random source. */
  readonly createId?: () => string;
}

/** SHA-256 of the empty string — the digest of a catalog with no records. */
const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function emptyRevision(createdAt: string): SkillCatalogRevision {
  return deepCloneAndFreeze({
    revision: 0,
    createdAt,
    outcome: 'completed' as const,
    records: [],
    sourceDiagnostics: [],
    digest: EMPTY_DIGEST,
  });
}

interface LiveRefresh extends SkillCatalogRefreshHandle {
  readonly refreshId: string;
}

/**
 * Creates a catalog whose revisions are immutable inputs to a run.
 *
 * The contract that matters: a source changing on disk affects a *later* revision. A run that
 * bound revision 3 keeps revision 3, by object identity and at every level of the graph, no matter
 * what happens in the filesystem afterwards.
 */
export function createSkillCatalogService(
  options: CreateSkillCatalogServiceOptions,
): SkillCatalogService {
  const now = options.now ?? ((): string => new Date().toISOString());
  let current: SkillCatalogRevision = options.initial
    ? deepCloneAndFreeze(options.initial)
    : emptyRevision(now());
  let inFlight: LiveRefresh | undefined;
  let counter = 0;

  const createId =
    options.createId ??
    ((): string => {
      counter += 1;
      return `skill-catalog-refresh-${counter}`;
    });

  const timeoutMilliseconds = options.refreshTimeoutMilliseconds ?? 30_000;

  /**
   * A read-only view over an in-flight refresh for a caller that joined it.
   *
   * Shares every terminal fact and refuses the one capability that is not the joiner's to exercise.
   */
  function joinHandle(shared: LiveRefresh): SkillCatalogRefreshHandle {
    const withoutCancellation = (
      snapshot: SkillCatalogRefreshSnapshot,
    ): SkillCatalogRefreshSnapshot => Object.freeze({ ...snapshot, cancellable: false });

    return {
      snapshot: () => withoutCancellation(shared.snapshot()),
      subscribeSnapshot: (observer) =>
        shared.subscribeSnapshot((snapshot) => observer(withoutCancellation(snapshot))),
      // The contract's documented no-op for a handle whose `cancellable` is false.
      abort: () => undefined,
      result: () => shared.result(),
      closed: () => shared.closed(),
    };
  }

  function startRefresh(refreshOptions?: SkillCatalogRefreshOptions): LiveRefresh {
    const id = refreshOptions?.id ?? createId();
    const startedAt = now();
    const previousRevision = current.revision;
    const controller = new AbortController();

    let cancellationRequested = false;
    let timedOut = false;
    let terminalDeliveryFailed = false;
    /** Captured at settle so `closed()` cannot answer differently depending on when it is called. */
    let teardownFacts: { cancelled: boolean; deliveryFailed: boolean } | undefined;

    const removeExternalListener = ((): (() => void) => {
      const external = refreshOptions?.signal;
      if (external === undefined) return () => undefined;
      if (external.aborted) {
        cancellationRequested = true;
        controller.abort();
        return () => undefined;
      }
      const onAbort = (): void => {
        cancellationRequested = true;
        controller.abort();
      };
      external.addEventListener('abort', onAbort, { once: true });
      // Removed on settle so a long-lived external signal does not accumulate one listener per
      // refresh for the lifetime of the process.
      return () => external.removeEventListener('abort', onAbort);
    })();

    let snapshot: SkillCatalogRefreshSnapshot = Object.freeze({
      id,
      kind: 'skill-catalog-refresh' as const,
      startedAt,
      revision: 1,
      status: 'pending' as const,
      lastTransitionAt: startedAt,
      projection: 'privileged' as const,
      ownership: 'independent' as const,
      detached: false as const,
      durability: 'process-local' as const,
      cancellable: true,
      previousRevision,
    });

    const observers = new Set<(value: SkillCatalogRefreshSnapshot) => void>();

    /**
     * Delivers to every current observer, isolating a throwing one.
     *
     * `terminal` is what separates a teardown failure from an ordinary subscriber bug: a throw
     * while delivering the *final* transition means cleanup notification failed, while a throw
     * during a routine delivery is the subscriber's problem and must not flip this handle's
     * cleanup acknowledgement.
     */
    function deliver(next: SkillCatalogRefreshSnapshot, terminal: boolean): void {
      snapshot = next;
      // A copy, not the live set: an observer may unsubscribe — or subscribe — from inside its own
      // callback, and mutating the collection being iterated is how that turns into a skipped
      // delivery or an unbounded loop.
      for (const observer of Array.from(observers)) {
        try {
          observer(next);
        } catch {
          // A subscriber's bug must not turn `result()` or `closed()` — both documented never to
          // reject — into rejected promises, nor stop the remaining observers being told.
          if (terminal) terminalDeliveryFailed = true;
        }
      }
    }

    // Raced, not merely signalled. Aborting a controller does nothing to a transport that ignores
    // it, so a signal-only bound leaves the handle pending for ever — which is the wedged-service
    // case, not a slow one.
    let abandon: ((result: SkillCatalogRefreshResult) => void) | undefined;
    const abandoned = new Promise<SkillCatalogRefreshResult>((resolve) => {
      abandon = resolve;
    });

    const scan = (async (): Promise<SkillCatalogRefreshResult> => {
      const timer =
        timeoutMilliseconds > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
              abandon?.({
                id,
                outcome: 'failed',
                previousRevision,
                failureReason: `Refresh exceeded ${timeoutMilliseconds}ms and was abandoned.`,
                completedAt: now(),
              });
            }, timeoutMilliseconds)
          : undefined;

      try {
        const next = await discoverSkills({
          ...options,
          revision: previousRevision + 1,
          signal: controller.signal,
        });

        // A scan that finishes after the deadline must not commit: the handle already reported a
        // terminal result, and committing now would move the catalog under a caller who was told
        // the refresh was abandoned.
        if (timedOut) {
          return {
            id,
            outcome: 'failed',
            previousRevision,
            failureReason: `Refresh exceeded ${timeoutMilliseconds}ms and was abandoned.`,
            completedAt: now(),
          };
        }

        if (next.outcome === 'cancelled') {
          return { id, outcome: 'cancelled', previousRevision, completedAt: now() };
        }

        if (next.digest === current.digest) {
          return { id, outcome: 'unchanged', previousRevision, completedAt: now() };
        }

        current = deepCloneAndFreeze(next);
        return {
          id,
          outcome: 'committed',
          previousRevision,
          newRevision: current.revision,
          completedAt: now(),
        };
      } catch (error) {
        return {
          id,
          outcome: 'failed',
          previousRevision,
          failureReason: error instanceof Error ? error.message : String(error),
          completedAt: now(),
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();

    const work = Promise.race([scan, abandoned]);

    const settled = work.then((result) => {
      removeExternalListener();
      if (inFlight?.refreshId === id) inFlight = undefined;
      // Read before delivery: a `refresh()` reaching this handle from inside an observer must not
      // see a cancellation request that arrives after the work is already over.
      const cancelledBeforeSettle = cancellationRequested;
      deliver(
        Object.freeze({
          ...snapshot,
          revision: 2,
          status: 'settled' as const,
          lastTransitionAt: result.completedAt,
          result,
        }),
        true,
      );
      observers.clear();
      teardownFacts = {
        cancelled: cancelledBeforeSettle,
        deliveryFailed: terminalDeliveryFailed,
      };
      return result;
    });

    let cleanup: Promise<SkillCatalogRefreshCleanup> | undefined;

    return {
      refreshId: id,

      snapshot(): SkillCatalogRefreshSnapshot {
        return snapshot;
      },

      subscribeSnapshot(observer): () => void {
        // Delivered before returning, as the contract requires. Isolated for the same reason
        // `deliver` is: a throwing subscriber must not propagate into whoever called subscribe.
        try {
          observer(snapshot);
        } catch {
          // Deliberately does not touch the teardown facts. This delivery happens for every fresh
          // subscription, pending or settled, so letting it flip `closed()` would make the
          // acknowledgement depend on who subscribed rather than on what cleanup did.
        }
        if (snapshot.status === 'settled') return () => undefined;
        observers.add(observer);
        return () => observers.delete(observer);
      },

      abort(): void {
        // After settlement this is the contract's documented no-op, so it must not retroactively
        // change the cleanup acknowledgement either.
        if (teardownFacts !== undefined) return;
        cancellationRequested = true;
        if (!controller.signal.aborted) controller.abort();
      },

      // Not `async`, for the same reason as `closed()`: callers compare the terminal result by
      // identity, and an async wrapper would hand each of them a different promise.
      result(): Promise<SkillCatalogRefreshResult> {
        return settled;
      },

      // Deliberately not `async`: an async method wraps its return value in a *new* promise on
      // every call, so the memoized promise below would be invisible to a caller and the
      // acknowledgement would be re-derived per await.
      closed(): Promise<SkillCatalogRefreshCleanup> {
        cleanup ??= settled.then((result): SkillCatalogRefreshCleanup => {
          const facts = teardownFacts ?? { cancelled: false, deliveryFailed: false };
          // A throw while delivering the terminal transition is a definite cleanup failure.
          if (facts.deliveryFailed) return 'failed';
          // A *refresh* that failed is not a *teardown* that failed: the scan produced no result,
          // and this handle's own cleanup still completed normally. Reporting `failed` here would
          // send a caller looking for leaked resources that do not exist.
          if (facts.cancelled) {
            // A cancellation request disqualifies the `not-required` fast path. Honoured, that is
            // `completed`; arriving too late to take effect, `unresolved` — never `not-required`,
            // which would claim there was nothing to stop.
            return result.outcome === 'cancelled' ? 'completed' : 'unresolved';
          }
          return 'not-required';
        });
        return cleanup;
      },
    };
  }

  return {
    catalog(): SkillCatalogRevision {
      return current;
    },

    refresh(refreshOptions?: SkillCatalogRefreshOptions): SkillCatalogRefreshHandle {
      if (inFlight) return joinHandle(inFlight);
      const handle = startRefresh(refreshOptions);
      inFlight = handle;
      return handle;
    },
  };
}
