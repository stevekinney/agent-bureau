import type { BackendDescriptor, ModelCatalog } from '@lostgradient/operative/providers';

/**
 * Bureau-local model-catalog refresh mechanism.
 *
 * Conforms to AB-34's universal started-work control contract (see
 * `documentation/operative-type-safe-api.md` § "Required capabilities") as
 * ratified by AB-64's decision record and its `## Coordinator amendments
 * (2026-09-02)` section: a catalog refresh is **independently owned** by
 * Bureau's catalog (not parent-owned by a run), so its cleanup
 * acknowledgement is this module's own `CatalogRefreshHandle.closed()`, and
 * `Bureau.dispose()` awaits any in-flight refresh before reporting (AB-37).
 *
 * Naming follows AB-34's binding constraints: the observation method is
 * `subscribeSnapshot`, never `subscribe` (which already means event
 * subscription on `ActiveRun`/`Bureau`), and the cleanup outcome vocabulary
 * (`'not-required' | 'completed' | 'failed' | 'unresolved'`) is reused
 * verbatim from `packages/armorer/src/execution-lifecycle.ts:26`.
 *
 * **`closed()` naming provenance.** AB-204's pull request (#419, "Add
 * `closed()` cleanup acknowledgement to `ActiveRun`, `AgentRun`, and
 * `DiagnosticAgentRun`") had not merged when this module was written. Per
 * AB-246's coordinator ruling, the cleanup acknowledgement is therefore named
 * `closed()` — the issue-specified fallback name — rather than confirmed
 * against AB-204's merged surface. If AB-204 later merges under a different
 * name, this module's name should be reconciled to match.
 *
 * **`catalog()` identity, reconciled.** AB-246's acceptance criteria state,
 * in the same breath, that `catalog()` "returns the identical frozen
 * `ModelCatalog` by reference until a refresh commits a new revision" AND
 * that a failed refresh "leaves `service.catalog()` returning the prior
 * catalog... with `stale: true`" AND that "the prior catalog object is still
 * returned by reference identity after a failure." A single frozen plain
 * object cannot both keep one identity forever and also expose a `stale`
 * field that flips from `false` to `true` — those three sentences are only
 * jointly satisfiable if "the prior catalog" is read as "the prior catalog's
 * *content*" rather than "the prior catalog *object*". This module resolves
 * the tension by constructing a NEW frozen wrapper object on a failed
 * refresh (`{ ...priorCatalog, stale: true }`) that carries the SAME
 * `descriptors` array **by reference** and the SAME `revision`. A caller
 * therefore sees `catalog().descriptors === previousDescriptors` and
 * `catalog().revision === previousRevision` hold across the failure — the
 * substantive guarantee the rollback trigger cares about ("a failed refresh
 * observed to clear or replace the active catalog") — while `stale` is
 * honestly `true`. Repeated reads between represented changes still return
 * one identical object, satisfying AB-34's diff-by-identity requirement in
 * every interval where nothing changed.
 */

/** AB-64's `CatalogRefreshRequest`, field names unchanged. */
export interface CatalogRefreshRequest {
  readonly id: string;
  readonly requestedAt: string;
}

export type CatalogRefreshOutcome = 'completed' | 'failed';

/** AB-64's `CatalogRefreshResult`, field names unchanged. */
export interface CatalogRefreshResult {
  readonly id: string;
  readonly outcome: CatalogRefreshOutcome;
  readonly previousRevision: number;
  /** Present only when `outcome === 'completed'`. */
  readonly newRevision?: number;
  /** Present only when `outcome === 'failed'`. */
  readonly failureReason?: string;
  readonly completedAt: string;
}

/**
 * Armorer's cleanup-outcome vocabulary
 * (`packages/armorer/src/execution-lifecycle.ts:26`), reused verbatim per
 * AB-34's vocabulary constraint.
 */
export type CatalogRefreshCleanupAcknowledgement =
  'not-required' | 'completed' | 'failed' | 'unresolved';

export type CatalogRefreshHandleState = 'pending' | 'settled';

/**
 * A `CatalogRefreshHandle`'s own cached, immutable, monotonic-revision
 * snapshot (AB-34's "Cached snapshot" capability). `revision` here counts
 * transitions of THIS handle's own state (1 while pending, 2 once settled)
 * — it is deliberately a different number from `ModelCatalog.revision`,
 * which counts committed catalog generations. `previousRevision` is carried
 * on every snapshot so the two numbers are never confused for one another.
 */
export interface CatalogRefreshSnapshot {
  readonly refreshId: string;
  readonly revision: number;
  readonly state: CatalogRefreshHandleState;
  readonly previousRevision: number;
  /** Present once `state === 'settled'`. */
  readonly result?: CatalogRefreshResult;
}

export type CatalogRefreshSnapshotObserver = (snapshot: CatalogRefreshSnapshot) => void;

export interface SubscribeSnapshotOptions {
  /** Auto-unsubscribe when this signal aborts. */
  readonly signal?: AbortSignal;
}

/**
 * A live handle over one in-flight (or now-settled) catalog refresh,
 * satisfying AB-34's `Required capabilities` table for an independently
 * owned live handle: a cached immutable `snapshot()`, non-consuming
 * `subscribeSnapshot`, idempotent `abort`, an awaitable `result()`, and an
 * awaitable cleanup acknowledgement (`closed()`).
 */
export interface CatalogRefreshHandle {
  readonly refreshId: string;
  /** Cached, immutable, side-effect-free. Never starts work. */
  snapshot(): CatalogRefreshSnapshot;
  /**
   * Registers `observer` and delivers the current snapshot to it
   * synchronously, before this call returns — closing the read-then-
   * subscribe gap. Returns an unsubscribe function; disposing one
   * subscription never affects the underlying refresh or any other
   * observer. Subscribing after the refresh has settled delivers the
   * terminal snapshot immediately.
   */
  subscribeSnapshot(
    observer: CatalogRefreshSnapshotObserver,
    options?: SubscribeSnapshotOptions,
  ): () => void;
  /**
   * Idempotent, never throws. Requests cancellation; does not itself wait
   * for teardown — see {@link closed}.
   */
  abort(reason?: string): void;
  /** Never rejects. Resolves with the refresh's typed terminal result. */
  result(): Promise<CatalogRefreshResult>;
  /**
   * Awaitable cleanup acknowledgement. Never rejects. Resolves once
   * {@link result} has settled, with one of:
   *
   * - `'not-required'` — the refresh's own descriptors were discarded
   *   because a newer catalog revision was committed while it was in
   *   flight (a stale-revision-conflict); there was nothing to release.
   * - `'unresolved'` — the refresh was aborted. `result()` resolves
   *   immediately on abort without waiting for `descriptorSource` to
   *   actually settle (see AB-246's acceptance criteria), so this handle
   *   cannot honestly confirm whether `descriptorSource`'s own eventual
   *   effect was released.
   * - `'failed'` — an observer registered via {@link subscribeSnapshot}
   *   threw while being notified. Notifying observers of the terminal
   *   state is part of this handle's own teardown, so a throwing observer
   *   is a genuine cleanup failure, not a `descriptorSource` business
   *   failure (a `descriptorSource` rejection is a normal `'completed'`
   *   cleanup — the *refresh* failed, but this handle's own teardown
   *   didn't).
   * - `'completed'` — every other case: the refresh committed, or
   *   `descriptorSource` resolved or rejected on its own, and no observer
   *   threw.
   */
  closed(): Promise<CatalogRefreshCleanupAcknowledgement>;
}

/**
 * Injected descriptor source. Receives the winning request (a coalesced
 * second `refresh()` call's own request is discarded — see
 * {@link ModelCatalogService.refresh}) and this refresh's `AbortSignal`.
 *
 * This is deliberately the seam AB-246 leaves for a future live provider
 * probe: today every caller supplies a source that returns static rows (or,
 * in `createBureau`'s default, re-derives `@lostgradient/operative/providers`'s
 * static seed), but the signature — request in, descriptors out, abortable —
 * is shaped so a later probe-backed source can be substituted without
 * changing this module. Rate limiting and the probe itself are out of scope
 * for AB-246.
 */
export type CatalogDescriptorSource = (
  request: CatalogRefreshRequest,
  signal: AbortSignal,
) => Promise<readonly BackendDescriptor[]>;

export interface ModelCatalogService {
  /**
   * Synchronous, cached, side-effect-free. Never triggers a refresh. Returns
   * the identical frozen `ModelCatalog` object by reference until a refresh
   * or {@link replaceCatalog} commits a change — see this module's top-level
   * JSDoc for exactly what "identical" means across a failed refresh.
   */
  catalog(): ModelCatalog;
  /**
   * Starts (or coalesces onto) a catalog refresh. While one refresh is in
   * flight, every additional call returns the SAME handle — reporting the
   * same `refreshId` — and `descriptorSource` is invoked exactly once for
   * that in-flight refresh; the coalesced caller's own `request` is not
   * used (the first caller's `request` is the one passed to
   * `descriptorSource`). Returns synchronously and non-thenably, per AB-34.
   */
  refresh(request: CatalogRefreshRequest): CatalogRefreshHandle;
  /**
   * Synchronous operator-override commit path: bumps the revision without
   * going through `descriptorSource`, stamping every row `source:
   * 'operator-override'`. This is the second commit path AB-246 requires so
   * the stale-revision-conflict rule is reachable and testable — coalescing
   * means only one `refresh()` is ever in flight, so a stale result can only
   * ever be produced by a commit that happened through this method instead.
   */
  replaceCatalog(descriptors: readonly BackendDescriptor[]): ModelCatalog;
  /**
   * The currently in-flight refresh handle, or `undefined` when none is in
   * flight. Bureau's `dispose()` uses this to await any outstanding refresh
   * before reporting completion, without aborting it (AB-64's 2026-09-02
   * amendment: a refresh is independently owned, so Bureau's stop path
   * awaits it rather than cancelling it out from under a caller who may
   * still be awaiting the same handle).
   */
  inFlightRefresh(): CatalogRefreshHandle | undefined;
}

export interface CreateModelCatalogServiceOptions {
  /** The catalog `catalog()` returns before any refresh commits. */
  readonly seed: ModelCatalog;
  readonly descriptorSource: CatalogDescriptorSource;
  /**
   * The only clock this module reads — inject it in tests. Nothing in this
   * module reads the wall clock, sets a timer, or sleeps.
   */
  readonly now: () => string;
  /** Mints a fresh `refreshId` for each non-coalesced `refresh()` call. */
  readonly newRefreshId: () => string;
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

function describeFailure(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Merges a `descriptorSource` result into the prior descriptor set for the
 * partial-provider-failure rule: the committed set is exactly the returned
 * rows, PLUS the prior rows for every provider the source omitted, with
 * those omitted rows' `availability` overridden to `'unknown'` rather than
 * dropped.
 */
function mergeDescriptors(
  priorDescriptors: readonly BackendDescriptor[],
  returned: readonly BackendDescriptor[],
): readonly BackendDescriptor[] {
  const returnedProviders = new Set(returned.map((descriptor) => descriptor.provider));
  const omittedPriorRows = priorDescriptors
    .filter((descriptor) => !returnedProviders.has(descriptor.provider))
    .map((descriptor) => Object.freeze({ ...descriptor, availability: 'unknown' as const }));
  return Object.freeze([...returned, ...omittedPriorRows]);
}

interface CreateRefreshHandleOptions {
  readonly refreshId: string;
  readonly request: CatalogRefreshRequest;
  readonly previousRevision: number;
  readonly now: () => string;
  readonly descriptorSource: CatalogDescriptorSource;
  /** Reads the service's CURRENT catalog revision at settle time. */
  readonly getCatalogRevision: () => number;
  /**
   * Commits a new revision from `descriptors`, returning it. Called only
   * when the stale-revision-conflict check passes.
   */
  readonly commit: (descriptors: readonly BackendDescriptor[]) => ModelCatalog;
  /**
   * Marks the CURRENT catalog `stale: true` — a no-op if the current
   * catalog's revision has already moved past `previousRevision` (something
   * else committed more recently, so it is not stale).
   */
  readonly markStaleIfUnchanged: () => void;
  /** Clears the service's in-flight slot once this refresh settles. */
  readonly onSettled: () => void;
}

function createRefreshHandle(options: CreateRefreshHandleOptions): CatalogRefreshHandle {
  const { refreshId, request, previousRevision } = options;
  const controller = new AbortController();
  const observers = new Set<CatalogRefreshSnapshotObserver>();
  const resultDeferred = createDeferred<CatalogRefreshResult>();

  let handleRevision = 1;
  let resultSettled = false;
  let aborted = false;
  let staleConflict = false;
  let observerThrew = false;
  let currentSnapshot: CatalogRefreshSnapshot = Object.freeze({
    refreshId,
    revision: handleRevision,
    state: 'pending' as const,
    previousRevision,
  });

  function notify(next: CatalogRefreshSnapshot): void {
    currentSnapshot = next;
    for (const observer of [...observers]) {
      try {
        observer(next);
      } catch {
        observerThrew = true;
      }
    }
  }

  function resolveResult(result: CatalogRefreshResult): void {
    if (resultSettled) return; // settle-once guard: a late descriptorSource
    // settlement arriving after abort() (or after another settle path) must
    // never re-resolve result() or re-commit a revision.
    resultSettled = true;
    if (result.outcome === 'failed') {
      options.markStaleIfUnchanged();
    }
    handleRevision += 1;
    notify(
      Object.freeze({
        refreshId,
        revision: handleRevision,
        state: 'settled' as const,
        previousRevision,
        result,
      }),
    );
    resultDeferred.resolve(result);
    options.onSettled();
  }

  function abort(reason?: string): void {
    if (aborted) return; // idempotent, never throws
    aborted = true;
    controller.abort(reason);
    if (!resultSettled) {
      resolveResult({
        id: refreshId,
        outcome: 'failed',
        previousRevision,
        failureReason: reason ? `Refresh aborted: ${reason}` : 'Refresh aborted',
        completedAt: options.now(),
      });
    }
  }

  void (async () => {
    let descriptors: readonly BackendDescriptor[];
    try {
      descriptors = await options.descriptorSource(request, controller.signal);
    } catch (cause) {
      resolveResult({
        id: refreshId,
        outcome: 'failed',
        previousRevision,
        failureReason: describeFailure(cause),
        completedAt: options.now(),
      });
      return;
    }
    if (resultSettled) return; // aborted (or otherwise settled) while awaiting

    if (options.getCatalogRevision() !== previousRevision) {
      staleConflict = true;
      resolveResult({
        id: refreshId,
        outcome: 'failed',
        previousRevision,
        failureReason: `Revision conflict: the catalog moved to a newer revision while this refresh was in flight (expected revision ${previousRevision})`,
        completedAt: options.now(),
      });
      return;
    }

    const committed = options.commit(descriptors);
    resolveResult({
      id: refreshId,
      outcome: 'completed',
      previousRevision,
      newRevision: committed.revision,
      completedAt: committed.generatedAt,
    });
  })();

  function subscribeSnapshot(
    observer: CatalogRefreshSnapshotObserver,
    subscribeOptions?: SubscribeSnapshotOptions,
  ): () => void {
    observers.add(observer);
    const unsubscribe = (): void => {
      observers.delete(observer);
    };
    const signal = subscribeOptions?.signal;
    if (signal) {
      if (signal.aborted) {
        unsubscribe();
      } else {
        signal.addEventListener('abort', unsubscribe, { once: true });
      }
    }
    try {
      observer(currentSnapshot);
    } catch {
      observerThrew = true;
    }
    return unsubscribe;
  }

  function closed(): Promise<CatalogRefreshCleanupAcknowledgement> {
    return resultDeferred.promise.then((): CatalogRefreshCleanupAcknowledgement => {
      if (observerThrew) return 'failed';
      if (aborted) return 'unresolved';
      if (staleConflict) return 'not-required';
      return 'completed';
    });
  }

  return {
    refreshId,
    snapshot: () => currentSnapshot,
    subscribeSnapshot,
    abort,
    result: () => resultDeferred.promise,
    closed,
  };
}

/**
 * Creates a Bureau-local `ModelCatalogService`. See {@link CatalogRefreshHandle}
 * and the module-level JSDoc for the AB-34/AB-64 conformance this satisfies.
 */
export function createModelCatalogService(
  serviceOptions: CreateModelCatalogServiceOptions,
): ModelCatalogService {
  let catalog: ModelCatalog = serviceOptions.seed;
  let inFlight: CatalogRefreshHandle | undefined;

  function markStaleIfUnchanged(previousRevision: number): void {
    if (catalog.revision === previousRevision) {
      catalog = Object.freeze({ ...catalog, stale: true });
    }
  }

  function commit(descriptors: readonly BackendDescriptor[]): ModelCatalog {
    const generatedAt = serviceOptions.now();
    catalog = Object.freeze({
      revision: catalog.revision + 1,
      descriptors: mergeDescriptors(catalog.descriptors, descriptors),
      generatedAt,
      stale: false,
      projection: catalog.projection,
    });
    return catalog;
  }

  function refresh(request: CatalogRefreshRequest): CatalogRefreshHandle {
    if (inFlight) return inFlight;
    const refreshId = serviceOptions.newRefreshId();
    const previousRevision = catalog.revision;
    const handle = createRefreshHandle({
      refreshId,
      request,
      previousRevision,
      now: serviceOptions.now,
      descriptorSource: serviceOptions.descriptorSource,
      getCatalogRevision: () => catalog.revision,
      commit,
      markStaleIfUnchanged: () => markStaleIfUnchanged(previousRevision),
      onSettled: () => {
        if (inFlight?.refreshId === refreshId) inFlight = undefined;
      },
    });
    inFlight = handle;
    return handle;
  }

  function replaceCatalog(descriptors: readonly BackendDescriptor[]): ModelCatalog {
    const generatedAt = serviceOptions.now();
    catalog = Object.freeze({
      revision: catalog.revision + 1,
      descriptors: Object.freeze(
        descriptors.map((descriptor) =>
          Object.freeze({ ...descriptor, source: 'operator-override' as const }),
        ),
      ),
      generatedAt,
      stale: false,
      projection: catalog.projection,
    });
    return catalog;
  }

  return {
    catalog: () => catalog,
    refresh,
    replaceCatalog,
    inFlightRefresh: () => inFlight,
  };
}
