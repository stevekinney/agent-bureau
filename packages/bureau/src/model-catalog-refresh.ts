import type { BackendDescriptor, ModelCatalog } from '@lostgradient/operative/providers';

/**
 * Bureau-local model-catalog refresh mechanism.
 *
 * Conforms to AB-34's universal started-work control contract (see
 * `documentation/operative-type-safe-api.md` § "Required capabilities" and
 * § "The common facts") as ratified by AB-64's decision record and its
 * `## Coordinator amendments (2026-09-02)` section: a catalog refresh is
 * **independently owned** by Bureau's catalog (not parent-owned by a run),
 * so its cleanup acknowledgement is this module's own
 * `CatalogRefreshHandle.closed()`, and `Bureau.dispose()` awaits any
 * in-flight refresh before reporting (AB-37).
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
 *
 * **`CatalogRefreshSnapshot` structurally satisfies `StartedWorkSnapshot`**
 * (`documentation/operative-type-safe-api.md` § "The common facts") — the
 * `id`/`kind`/`startedAt`/`revision`/`status`/`lastTransitionAt`/
 * `projection`/`ownership`/`detached`/`durability`/`cancellable`/`result`
 * floor, structurally (never nominally, per that section's own rule), plus
 * this module's own extra field (`previousRevision`) beyond the floor.
 * `owner`/`parentId` are omitted: this handle has no principal and no
 * Bureau-issued locator to report, which is the doc's own stated meaning of
 * an absent optional owner — a truthful "no authorization context", not
 * missing data. `projection` is always `'privileged'`: this Bureau-internal
 * administrative handle has no authorization/redaction split of its own
 * (distinct from `ModelCatalog.projection`, which mod-02e's `'general'`
 * projection function operates over separately). `detached` is always
 * `false`: this handle has no owner/parent construct to detach FROM.
 * `durability` is always `'process-local'`: the refresh OPERATION's own
 * lifecycle state is not itself persisted (only the descriptors it commits
 * are, via whatever backs `ModelCatalog`).
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

export type CatalogRefreshStatus = 'pending' | 'settled';

/**
 * A `CatalogRefreshHandle`'s own cached, immutable, monotonic-revision
 * snapshot (AB-34's "Cached snapshot" capability), structurally satisfying
 * `StartedWorkSnapshot` — see the module-level JSDoc. `revision` here counts
 * transitions of THIS handle's own state (1 while pending, 2 once settled)
 * — it is deliberately a different number from `ModelCatalog.revision`,
 * which counts committed catalog generations. `previousRevision` is carried
 * on every snapshot so the two numbers are never confused for one another.
 */
export interface CatalogRefreshSnapshot {
  readonly id: string;
  readonly kind: 'model-catalog-refresh';
  readonly startedAt: string;
  readonly revision: number;
  readonly status: CatalogRefreshStatus;
  readonly lastTransitionAt: string;
  readonly projection: 'privileged';
  readonly ownership: 'independent';
  readonly detached: false;
  readonly durability: 'process-local';
  /** `true` while pending (abort still has effect); `false` once settled. */
  readonly cancellable: boolean;
  readonly previousRevision: number;
  /** Present once `status === 'settled'`. */
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
   * observer, including a second subscription registered with the exact
   * same observer function. Subscribing after the refresh has settled
   * delivers the terminal snapshot immediately.
   */
  subscribeSnapshot(
    observer: CatalogRefreshSnapshotObserver,
    options?: SubscribeSnapshotOptions,
  ): () => void;
  /**
   * Idempotent, never throws. Requests cancellation; does not itself wait
   * for teardown — see {@link closed}. A no-op once the refresh has already
   * settled (by any means — completion, failure, or a prior abort): aborting
   * already-terminal work has no additional effect.
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
   * - `'failed'` — an observer threw while being notified of the TERMINAL
   *   transition specifically (not the initial current-state delivery a
   *   fresh `subscribeSnapshot` call makes, pending or settled). Notifying
   *   observers of the terminal transition is part of this handle's own
   *   teardown, so a throwing observer there is a genuine cleanup failure,
   *   not a `descriptorSource` business failure (a `descriptorSource`
   *   rejection is a normal `'completed'` cleanup — the *refresh* failed,
   *   but this handle's own teardown didn't). This outcome is fixed at the
   *   moment the refresh settles; a `subscribeSnapshot` call — throwing or
   *   not — made after that moment cannot change it.
   * - `'completed'` — every other case: the refresh committed, or
   *   `descriptorSource` resolved or rejected on its own, and no observer
   *   threw during the terminal transition.
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
 * Recursively freezes an object graph, mutating in place and returning the
 * SAME top-level reference (never cloning) — freezing an already-frozen
 * value is a harmless no-op, so this is safe to call unconditionally on
 * every row this module commits, whether or not `descriptorSource` already
 * froze it. Needed because `BackendDescriptor` carries nested mutable
 * structures (`aliases`, `modalities`, `mediaLimits`, `effort.degradesTo`,
 * `pricing`) that a shallow `Object.freeze` on the row itself does not
 * protect — a caller retaining a reference to one of those could otherwise
 * mutate a published catalog row without a new object or revision (review
 * finding, PR #432).
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    deepFreeze(record[key]);
  }
  return Object.freeze(value);
}

/**
 * Merges a `descriptorSource` result into the prior descriptor set for the
 * partial-provider-failure rule: the committed set is exactly the returned
 * rows, PLUS the prior rows for every provider the source omitted, with
 * those omitted rows' `availability` overridden to `'unknown'` rather than
 * dropped. Every committed row is deep-frozen (see {@link deepFreeze}).
 */
function mergeDescriptors(
  priorDescriptors: readonly BackendDescriptor[],
  returned: readonly BackendDescriptor[],
): readonly BackendDescriptor[] {
  const returnedProviders = new Set(returned.map((descriptor) => descriptor.provider));
  const omittedPriorRows = priorDescriptors
    .filter((descriptor) => !returnedProviders.has(descriptor.provider))
    .map((descriptor) => deepFreeze({ ...descriptor, availability: 'unknown' as const }));
  const frozenReturnedRows = returned.map((descriptor) => deepFreeze({ ...descriptor }));
  return Object.freeze([...frozenReturnedRows, ...omittedPriorRows]);
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
  /**
   * Clears the service's in-flight slot for this refresh. Called BEFORE the
   * terminal snapshot is delivered to observers, so an observer that reacts
   * to settlement by calling `service.refresh()` again starts a genuinely
   * new refresh rather than coalescing onto the one that just finished
   * (review finding, PR #432). Idempotent-safe to call even if this
   * refresh's slot was never actually occupied (see the synchronous-source
   * race note on {@link createRefreshHandle}).
   */
  readonly onSettled: () => void;
  /**
   * Synchronously reserves this handle as the service's in-flight refresh.
   * Called once, before `descriptorSource` is ever invoked, closing a race
   * where a `descriptorSource` that throws SYNCHRONOUSLY would otherwise
   * settle this handle before `refresh()` had a chance to assign it to the
   * service's `inFlight` slot — permanently stranding the slot on an
   * already-settled handle (review finding, PR #432).
   */
  readonly reserveInFlight: (handle: CatalogRefreshHandle) => void;
}

function createRefreshHandle(options: CreateRefreshHandleOptions): CatalogRefreshHandle {
  const { refreshId, request, previousRevision } = options;
  const controller = new AbortController();
  // Keyed by a unique token per subscription, never by the observer
  // function itself — two `subscribeSnapshot(sameFn)` calls must stay
  // independently disposable (review finding, PR #432).
  const observers = new Map<symbol, CatalogRefreshSnapshotObserver>();
  const resultDeferred = createDeferred<CatalogRefreshResult>();
  const startedAt = options.now();

  let handleRevision = 1;
  let resultSettled = false;
  let aborted = false;
  let staleConflict = false;
  let terminalObserverThrew = false;
  let currentSnapshot: CatalogRefreshSnapshot = Object.freeze({
    id: refreshId,
    kind: 'model-catalog-refresh' as const,
    startedAt,
    revision: handleRevision,
    status: 'pending' as const,
    lastTransitionAt: startedAt,
    projection: 'privileged' as const,
    ownership: 'independent' as const,
    detached: false as const,
    durability: 'process-local' as const,
    cancellable: true,
    previousRevision,
  });

  /** Delivers `next` to every current observer, isolating a throwing one. */
  function deliver(next: CatalogRefreshSnapshot, onObserverThrow?: () => void): void {
    currentSnapshot = next;
    for (const observer of [...observers.values()]) {
      try {
        observer(next);
      } catch {
        onObserverThrow?.();
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
    // Clear the in-flight slot BEFORE notifying observers of the terminal
    // transition, so an observer that reacts by starting a new refresh
    // isn't incorrectly coalesced onto this now-finished one.
    options.onSettled();
    const lastTransitionAt = options.now();
    handleRevision += 1;
    deliver(
      Object.freeze({
        id: refreshId,
        kind: 'model-catalog-refresh' as const,
        startedAt,
        revision: handleRevision,
        status: 'settled' as const,
        lastTransitionAt,
        projection: 'privileged' as const,
        ownership: 'independent' as const,
        detached: false as const,
        durability: 'process-local' as const,
        cancellable: false,
        previousRevision,
        result: deepFreeze(result),
      }),
      () => {
        terminalObserverThrew = true;
      },
    );
    resultDeferred.resolve(result);
  }

  function abort(reason?: string): void {
    if (aborted || resultSettled) return; // idempotent, never throws, and a
    // no-op once the refresh is already terminal by any means.
    aborted = true;
    controller.abort(reason);
    resolveResult({
      id: refreshId,
      outcome: 'failed',
      previousRevision,
      failureReason: reason ? `Refresh aborted: ${reason}` : 'Refresh aborted',
      completedAt: options.now(),
    });
  }

  async function runRefresh(): Promise<void> {
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

    try {
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
    } catch (cause) {
      // Commit-path failure (e.g. `now()` or descriptor normalization
      // throwing) must still settle this handle — otherwise `result()`,
      // `closed()`, and `Bureau.dispose()`'s await on an in-flight refresh
      // hang forever (review finding, PR #432).
      resolveResult({
        id: refreshId,
        outcome: 'failed',
        previousRevision,
        failureReason: describeFailure(cause),
        completedAt: options.now(),
      });
    }
  }

  function subscribeSnapshot(
    observer: CatalogRefreshSnapshotObserver,
    subscribeOptions?: SubscribeSnapshotOptions,
  ): () => void {
    const token = Symbol('catalog-refresh-observer');
    observers.set(token, observer);
    const signal = subscribeOptions?.signal;
    const onSignalAbort = (): void => {
      observers.delete(token);
    };
    const unsubscribe = (): void => {
      observers.delete(token);
      // Remove the abort listener too — otherwise a caller that unsubscribes
      // BEFORE the signal ever aborts leaves the listener (and this
      // observer's closure) referenced by the signal until it eventually
      // fires, or forever if it never does (review finding, PR #432).
      signal?.removeEventListener('abort', onSignalAbort);
    };
    if (signal) {
      if (signal.aborted) {
        unsubscribe();
      } else {
        signal.addEventListener('abort', onSignalAbort, { once: true });
      }
    }
    // The initial "closing the read-then-subscribe gap" delivery is
    // deliberately NOT part of the terminal-teardown accounting `closed()`
    // reads: it happens for every fresh subscription (pending OR settled),
    // not only at the moment this refresh actually settles, so a throw here
    // must not flip `closed()`'s outcome (review finding, PR #432).
    try {
      observer(currentSnapshot);
    } catch {
      // Swallowed deliberately — see above.
    }
    return unsubscribe;
  }

  function closed(): Promise<CatalogRefreshCleanupAcknowledgement> {
    return resultDeferred.promise.then((): CatalogRefreshCleanupAcknowledgement => {
      if (terminalObserverThrew) return 'failed';
      if (aborted) return 'unresolved';
      if (staleConflict) return 'not-required';
      return 'completed';
    });
  }

  const handle: CatalogRefreshHandle = {
    refreshId,
    snapshot: () => currentSnapshot,
    subscribeSnapshot,
    abort,
    result: () => resultDeferred.promise,
    closed,
  };

  // Reserve the in-flight slot BEFORE any chance of `descriptorSource`
  // running (including a synchronous throw) — see `reserveInFlight`'s
  // JSDoc. `runRefresh` itself is deferred to a microtask for the same
  // reason: this guarantees `reserveInFlight` has already run by the time
  // `descriptorSource` is ever invoked, synchronous-throw included.
  options.reserveInFlight(handle);
  void Promise.resolve().then(runRefresh);

  return handle;
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
    return createRefreshHandle({
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
      reserveInFlight: (handle) => {
        inFlight = handle;
      },
    });
  }

  function replaceCatalog(descriptors: readonly BackendDescriptor[]): ModelCatalog {
    const generatedAt = serviceOptions.now();
    catalog = Object.freeze({
      revision: catalog.revision + 1,
      descriptors: Object.freeze(
        descriptors.map((descriptor) =>
          deepFreeze({ ...descriptor, source: 'operator-override' as const }),
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
