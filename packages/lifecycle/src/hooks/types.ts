export type HookMap = Record<string, (...args: never[]) => unknown>;

export type HookErrorHandler = (
  error: unknown,
  context: {
    hookName: string;
    /**
     * Position in the sorted run order for THIS invocation. Not stable across
     * invocations — use `id` to name the registration.
     */
    handlerIndex: number;
    /** Stable registration identity — see {@link HookRegistrationOptions.id}. */
    id: string;
  },
) => 'continue' | 'abort';

/**
 * How a hook behaves when its step re-runs on durable recovery (seam #11).
 *
 * - `safe` — read-only / no external side effect; re-running it is harmless.
 * - `effectful` — performs an external side effect (writes to a store, posts to
 *   a service). On a durable recovery the crashed in-flight step re-runs from its
 *   boundary, so an `effectful` hook fires AGAIN (at-least-once). The correct
 *   mitigation is to make the hook IDEMPOTENT (e.g. content/key-addressed writes),
 *   NOT to skip it on replay — skipping would drop the side effect for a step
 *   whose work (generate + tools) did re-execute. This classification is
 *   METADATA ONLY: it documents a hook's replay contract for authors and review.
 *   It does NOT gate execution. When unset, a hook is treated as the
 *   conservative `effectful`.
 *
 * One thing does read it, and only to report (COR-1267): a registry
 * configured with {@link HookRegistryOptions.onUnclassifiedReplay} calls that
 * callback for a registration which omitted `replay` altogether, so an author
 * who never considered replay stays distinguishable from one who chose
 * `effectful` deliberately. That is a diagnostic, not a gate — it cannot stop
 * a hook running, change its classification, or fail a run.
 */
export type HookReplayPolicy = 'safe' | 'effectful';

export interface HookRegistrationOptions {
  priority?: number;
  onError?: HookErrorHandler;
  /**
   * Stable identity for this registration, for correlating observations of it
   * (COR-567).
   *
   * Nothing before this could name one registration. `handlerIndex` in
   * {@link HookErrorHandler}'s context is an index into a freshly sorted copy
   * computed inside each `run()` call, and the unregister closure splices the
   * live array, so it shifts when an earlier handler is removed — usable for
   * "which one threw, just now", never as a name. `hookName` identifies the
   * hook POINT, not a registration on it.
   *
   * Supplied by the registrant when it has a meaningful name to give. When
   * absent, {@link HookRegistry.on} assigns `<hookName>#<n>` from a
   * per-registry counter that never reuses a value, so an id is stable for a
   * registration's lifetime and is not recycled after unregistration.
   *
   * `mergeHookRegistries` spreads registration options through unchanged, so
   * an id survives a merge without extra handling.
   */
  id?: string;
  /**
   * Durable-recovery replay classification — see {@link HookReplayPolicy}.
   * Documentation/diagnostics only; never gates whether the hook runs.
   */
  replay?: HookReplayPolicy;
  /**
   * Which ownership tier registered this entry (COR-1265) — `bureau`,
   * `agent`, `direct`, or a narrower label a tier gives one registration.
   *
   * Normally inherited from {@link HookRegistryOptions.source} rather than
   * passed per registration: a tier builds its own registry, names it once,
   * and every `on()` call stamps that name onto the entry. It lives on the
   * ENTRY rather than only on the registry because a merged plan has one
   * registry and many tiers — after `mergeHookRegistries`, the registry can
   * no longer answer where an entry came from, but the entry still can.
   *
   * `mergeHookRegistries` spreads registration options through unchanged, so
   * a source survives any number of merges without extra handling.
   */
  source?: string;
}

/**
 * One thing that happened to a hook plan, reported to every observer attached
 * with {@link HookRegistry.observe}.
 *
 * `invoked` and `failed` are mutually exclusive outcomes of a single
 * invocation: exactly one fires per handler call, never both and never
 * neither. There is deliberately no `replayed` variant — see
 * {@link HookReplayPolicy}: a registry cannot know that a specific entry ran
 * before without durable per-entry invocation history, and keeping that
 * history in order to suppress a second `invoked` would contradict the
 * idempotency contract that makes replay safe in the first place. A durable
 * re-execution is reported as an ordinary `invoked`; a consumer that needs to
 * distinguish one reads the recovery marker on its own run correlation.
 */
export type HookPlanObservation =
  | ({
      kind: 'registered';
      priority: number;
      replay: HookReplayPolicy;
    } & HookPlanObservationIdentity)
  | ({ kind: 'removed' } & HookPlanObservationIdentity)
  | ({ kind: 'invoked'; durationMilliseconds: number } & HookPlanObservationIdentity)
  | ({
      kind: 'failed';
      durationMilliseconds: number;
      error: unknown;
    } & HookPlanObservationIdentity);

/**
 * Which parent dispatched which child (COR-1269).
 *
 * Declared inline and structurally rather than imported. The operative type
 * that satisfies it, `ChildWorkflowCorrelation`, lives in
 * `packages/operative/src/events.ts`, and `@lostgradient/lifecycle` declares no
 * runtime dependencies at all — operative already depends on lifecycle, so the
 * reverse edge would be circular. Operative's type satisfies this one
 * structurally, which is the whole point of writing it out.
 */
export interface HookObservationCorrelation {
  readonly parentAgentName: string;
  readonly parentRunId: string;
  readonly childAgentName: string;
  readonly childRunId: string;
}

/**
 * What an observer is watching on behalf of (COR-1269), supplied when it
 * attaches through {@link HookRegistry.observe}.
 *
 * Attached rather than configured on the registry, and stamped per observer
 * rather than onto a shared observation, because one plan can be watched by
 * more than one party and a run is not a property of the plan: a merged
 * registry is built at dispatch from tiers that existed before the run did.
 * Two observers of one registry can therefore report different `runId`s
 * truthfully.
 */
export interface HookObservationContext {
  /** The run being observed, when it has a stable identity. */
  readonly runId?: string;
  /** The session that run belongs to, when it belongs to one. */
  readonly sessionId?: string;
  /**
   * Present only for a run dispatched as somebody's child. A parent's own
   * observations carry none, which is how a consumer tells the two apart.
   */
  readonly correlation?: HookObservationCorrelation;
}

/**
 * The fields every {@link HookPlanObservation} variant carries, whatever
 * happened (COR-1269).
 *
 * `runId`, `sessionId` and `correlation` are optional because they come from
 * the observer's {@link HookObservationContext}, and a registry can be watched
 * outside a run entirely — an agent tier is observable at `createAgent()` time,
 * when no run exists to name. Optional is the honest shape; requiring them
 * would force a caller to invent one.
 */
export interface HookPlanObservationIdentity {
  hookName: string;
  id: string;
  /**
   * The tier this entry was registered by, when one is known — see
   * {@link HookRegistrationOptions.source}. Absent on a registry that names no
   * tier, which is every registry outside a composed run.
   */
  source?: string;
  /** The plan's version at the moment of this observation — see {@link HookRegistry.revision}. */
  revision: number;
  /** The observing run, from the context its observer attached with. */
  runId?: string;
  /** The observing run's session, from the context its observer attached with. */
  sessionId?: string;
  /** The parent-child pair this run belongs to, when it is a child run. */
  correlation?: HookObservationCorrelation;
}

/**
 * One entry of a hook plan, as an inspector sees it (COR-1270).
 *
 * Deliberately NOT a projection of `RegisteredHandler`: it is a separate
 * shape that happens to share four field names, so a field added to a
 * registration does not silently become readable through inspection. The
 * handler, the `onError` closure, and anything either closes over are absent
 * by construction rather than filtered out — redaction is the whole security
 * boundary here, because there is no authorization gate in front of it.
 */
export interface HookPlanEntryDescription {
  readonly hookName: string;
  /** Stable registration identity — see {@link HookRegistrationOptions.id}. */
  readonly id: string;
  readonly priority: number;
  /** The classification in force, with the conservative default resolved. */
  readonly replay: HookReplayPolicy;
  /** The owning tier, when one claimed it — see {@link HookRegistrationOptions.source}. */
  readonly source?: string;
}

/**
 * A run's effective hook plan, redacted for inspection (COR-1270).
 *
 * Answers the two questions the project's success criterion asks — which hook
 * sources applied, and in what order — without handing the inspector anything
 * executable.
 */
export interface HookPlanDescription {
  /** The plan's version — see {@link HookRegistry.revision}. */
  readonly revision: number;
  /**
   * Every registered entry, grouped by hook point and, within each, in the
   * order the dispatch would iterate them: highest priority first.
   *
   * Iteration order, not winner order. The three dispatch shapes disagree
   * about which END of this sequence wins — `runFirst` takes the first entry
   * to answer, `runLast` and the waterfall the last — so a single "winner"
   * ordering would be a lie for two shapes out of three. The sequence itself
   * is the same for all of them.
   */
  readonly entries: readonly HookPlanEntryDescription[];
}

/**
 * Observes a hook plan. Read-only: an observer cannot change what runs, what a
 * handler receives, or what it returns.
 *
 * Must not throw. One that does is reported to the registry's `onError` when
 * configured, and otherwise re-thrown from a microtask so it surfaces as an
 * unhandled error — never allowed to fail the hook invocation it observed,
 * because a diagnostic that can kill a run is worse than no diagnostic.
 */
export type HookPlanObserver = (observation: HookPlanObservation) => void;

export interface HookRegistryOptions {
  onError?: HookErrorHandler;
  /**
   * The ownership tier every entry registered on this registry belongs to
   * (COR-1265). Set once when a tier builds its registry; `on()` stamps it
   * onto each entry so it survives into a merged plan, where the registry
   * itself can no longer answer the question. A per-registration
   * {@link HookRegistrationOptions.source} overrides it.
   */
  source?: string;
  /**
   * Called when a registration omits {@link HookRegistrationOptions.replay}
   * entirely and therefore falls back to the conservative `effectful` class
   * (COR-1267).
   *
   * The two cases are indistinguishable everywhere else — a hook that
   * declared `effectful` and one whose author never thought about replay both
   * read as `effectful` — and only the second is a latent durability bug,
   * because a crashed step re-runs its hooks and an effectful handler that is
   * not idempotent doubles its side effect. This makes the second case
   * visible at registration, while the author is still there to answer.
   *
   * Diagnostic only. It cannot gate execution, change the classification, or
   * fail a run: a callback that throws is swallowed, exactly as a plan
   * observer's throw is isolated, because a diagnostic that can kill a
   * registration is worse than no diagnostic.
   *
   * Not inherited through `mergeHookRegistries`: the merged plan is
   * constructed with no options, so the policy belongs to whoever builds a
   * tier rather than to the composed result.
   */
  onUnclassifiedReplay?: (registration: { hookName: string; id: string }) => void;
  /**
   * Clock backing the `durationMilliseconds` an observer receives. Defaults to
   * `Date.now`; inject for deterministic tests.
   */
  now?: () => number;
}
