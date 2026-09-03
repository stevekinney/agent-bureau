/**
 * `dispatchChildRun` — the lower-level child dispatch primitive (AB-50).
 *
 * `createSubagentTool` is built on top of this: it wraps a
 * `RunnableAgent.run()` call with parent-child correlation (`childRunId`,
 * `parentRunId`, `agentName`), a composed abort signal so a parent abort
 * and a child-targeted abort both stop the child without either reaching
 * the child's siblings, and the four `multiagent.child-workflow.*`
 * lifecycle events (started/completed/failed/aborted). Code that dispatches
 * a subagent directly — not only through `createSubagentTool` — can retain
 * the returned `ChildRunHandle` to iterate the child's own event stream,
 * await its result, or abort it independently of any other concurrently
 * retained child handle.
 *
 * `createChildRunRegistry()` is the opt-in mechanism behind `AgentRun`'s
 * `children()`/`abortChild()` (documented in
 * `documentation/operative-type-safe-api.md`'s Required capabilities
 * table). A registry is not created or consulted automatically — a caller
 * that wants a running `AgentRun` to discover children dispatched from
 * inside its own tool calls constructs one registry and supplies it via
 * `AgentRunContext.childRegistry` (through `RunnableAgent.run()`) or
 * `createAgentRun`'s equivalent `childRegistry` option.
 *
 * AB-233: for a `createSubagentTool` reached through the ordinary
 * `createAgent`-driven agent loop, that one registry is now enough —
 * `run-step.ts`'s toolbox execute call site threads THIS run's own
 * `RunOptions.childRegistry` (derived from `AgentRunContext.childRegistry`)
 * into every tool call's per-execution `ToolContext.executionContext`, and
 * `createSubagentTool` reads it from there at execute time, in preference
 * to `parentContext.registry`. A tool instance built once and reused by
 * two different `agent.run()` calls therefore registers each call's
 * children into THAT call's own registry — never a registry captured once
 * at tool-construction time, and never the other call's registry.
 * `parentContext.registry` remains supported as a construction-time
 * default: a direct `dispatchChildRun` caller (bypassing `createSubagentTool`
 * entirely, or a tool built outside the ordinary loop, where no
 * per-execution `executionContext` reaches it) still supplies it exactly
 * as before. `createSubagentTool` call sites that don't need discovery stay
 * exactly as simple as before: neither `AgentRunContext.childRegistry` nor
 * `parentContext`/`registry` is required.
 */

import type { Subscription } from 'lifecycle';

import type { RunEvent } from './agent-run';
import {
  ChildWorkflowAbortedEvent,
  ChildWorkflowCompletedEvent,
  ChildWorkflowFailedEvent,
  ChildWorkflowStartedEvent,
} from './events';
import type { LivenessAssessment, LivenessObservable, LivenessSnapshot } from './liveness';
import type { AgentInput, RunnableAgent } from './runnable-agent';
import type { RunResult } from './types';

// ---------------------------------------------------------------------------
// ChildRunHandle — the primitive's own return value
// ---------------------------------------------------------------------------

/**
 * The handle `dispatchChildRun` returns: a child run's own identity
 * (`childRunId`, `parentRunId`, `agentName`) alongside the same
 * iterate/await/abort/dispose surface `AgentRun` exposes for the run it
 * wraps. Two concurrently retained handles never share identity, an
 * abort signal, or an event stream — aborting one, or iterating one's
 * events, never touches the other.
 */
export interface ChildRunHandle<
  O = never,
  H extends boolean = false,
> extends AsyncIterable<RunEvent> {
  /** This child's own run identifier — distinct from `parentRunId`. */
  readonly childRunId: string;
  /** The parent run's identifier, as supplied to `dispatchChildRun`. */
  readonly parentRunId: string;
  /** The child's agent name, as supplied to `dispatchChildRun`. */
  readonly agentName: string;
  /** Resolves to the child's terminal `RunResult`. Cached, like `AgentRun.result()`. */
  result(): Promise<RunResult<O, H>>;
  /**
   * Aborts only this child. A parent-composed abort (the `signal` passed to
   * `dispatchChildRun`) reaches the same underlying run; this method reaches
   * it independently, so a sibling dispatched from the same parent is
   * unaffected either way.
   */
  abort(reason?: string): void;
  /** Releases this handle's resources. Equivalent to `abort()` if still in flight. */
  [Symbol.dispose](): void;
}

// ---------------------------------------------------------------------------
// ChildRunRegistry — the opt-in discovery/cancellation backing store
// ---------------------------------------------------------------------------

/** A child's status as tracked by a `ChildRunRegistry`. */
export type ChildRunStatus = 'running' | 'completed' | 'failed' | 'aborted';

/**
 * A parent-owned, read-only description of one child — "enough edge
 * information to reassemble the tree without promoting any child to an
 * independently owned resource" (the Child discovery capability in
 * `documentation/operative-type-safe-api.md`).
 */
export interface ChildRunDescriptor {
  readonly id: string;
  readonly parentId: string;
  readonly agentName: string;
  readonly durable: boolean;
  readonly status: ChildRunStatus;
  /**
   * Present once `status` is terminal AND the child actually produced a
   * `RunResult` — absent while still `running`, and also absent for a
   * `'failed'` descriptor settled before one existed: `agent.run()`
   * throwing synchronously, or `agentRun.result()` rejecting (or itself
   * throwing) before resolving one. Those two paths have no `RunResult` to
   * report — the alternative would be fabricating one — so `'failed'`
   * genuinely can carry `result === undefined`; only `'completed'` and
   * `'aborted'` are guaranteed to carry one.
   */
  readonly result?: RunResult;
  /**
   * This child's own most recently observed `LivenessAssessment` (AB-88's
   * `LivenessSnapshot.assessment`), populated once `attachLiveness` has
   * received the child's first `subscribeSnapshot` delivery — which, per
   * AB-88's AC10, happens synchronously, so this is set before
   * `dispatchChildRun` returns the handle whenever a registry is supplied.
   * Absent when no registry-attached liveness observable exists yet for
   * this child (a synchronous `agent.run()` throw settles the child before
   * any liveness was ever attached) — AB-216's rollup treats an absent
   * `assessment` the same as a `'terminal'` one: excluded from the
   * worst-child fold, never a stale value standing in for real evidence.
   */
  readonly assessment?: LivenessAssessment;
}

/**
 * The read surface `AgentRun.children()`/`.abortChild()` delegate to.
 * `dispatchChildRun` populates a registry passed to it via `register`;
 * nothing here starts, or is required for, dispatching a child — a caller
 * that never constructs a registry gets an always-empty `children()` and a
 * no-op `abortChild()`, never a throw.
 */
export interface ChildRunRegistry {
  /** A snapshot of every child registered so far, in registration order. */
  children(): readonly ChildRunDescriptor[];
  /**
   * Aborts the child named `childId`. Idempotent: an unknown id, or one
   * already terminal, is not an error — matching `abort()`'s own rule.
   * Never propagates to any other registered child.
   */
  abortChild(childId: string, reason?: string): void;
  /**
   * Subscribes to "some child's `ChildRunDescriptor.assessment` may have
   * changed" (AB-216) — fired after `attachLiveness` records a new
   * assessment from a child's own `subscribeSnapshot` delivery. Carries no
   * payload; a subscriber re-reads `children()` to fold the current set.
   * A parent's own liveness rollup (`packages/operative/src/liveness/`)
   * subscribes to this to recompute `LivenessSnapshot.worstChildAssessment`
   * without polling.
   */
  subscribeLiveness(observer: () => void): Subscription;
}

interface RegisteredChild {
  descriptor: ChildRunDescriptor;
  abort: (reason?: string) => void;
  /** Set by `attachLiveness`; released once the child settles or is re-attached. */
  livenessSubscription?: Subscription;
}

/** Internal registration surface `dispatchChildRun` uses; not part of the public read contract. */
interface ChildRunRegistrar {
  register(entry: {
    id: string;
    parentId: string;
    agentName: string;
    durable: boolean;
    abort: (reason?: string) => void;
  }): void;
  settle(id: string, status: Exclude<ChildRunStatus, 'running'>, result?: RunResult): void;
  /**
   * Wires a child's own `LivenessObservable` (its `AgentRun`, once
   * `agent.run()` has returned one — AB-50's `ChildRunHandle` wraps the
   * same object) into this registry so `ChildRunDescriptor.assessment`
   * tracks the child's own `LivenessSnapshot.assessment` going forward.
   * A no-op for an unknown `id` (never registered, or already settled and
   * removed — this registry never removes entries, so in practice only
   * "never registered" applies). `dispatchChildRun` calls this once, right
   * after `agent.run()` returns successfully, never before — the delegated
   * `RunnableAgent`'s own liveness authority (AB-216's AC5) is read, never
   * recomputed or overridden here.
   */
  attachLiveness(id: string, observable: LivenessObservable<LivenessSnapshot>): void;
}

/** A `ChildRunRegistry` a `dispatchChildRun` caller can also register children into. */
export type MutableChildRunRegistry = ChildRunRegistry & ChildRunRegistrar;

/**
 * Structural guard for {@link MutableChildRunRegistry}. Exists so a
 * per-execution value read off an opaque bag (e.g.
 * `ToolContext.executionContext['childRegistry']`, AB-233) can be narrowed
 * from `unknown` at the point of use without a cast — the value's static
 * type at the point it was stored is often the read-only
 * {@link ChildRunRegistry} (e.g. `RunOptions.childRegistry`), even though
 * the concrete object `createChildRunRegistry()` produces always satisfies
 * the full mutable surface.
 */
export function isMutableChildRunRegistry(value: unknown): value is MutableChildRunRegistry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<MutableChildRunRegistry>).register === 'function' &&
    typeof (value as Partial<MutableChildRunRegistry>).settle === 'function' &&
    typeof (value as Partial<MutableChildRunRegistry>).attachLiveness === 'function' &&
    typeof (value as Partial<MutableChildRunRegistry>).children === 'function' &&
    typeof (value as Partial<MutableChildRunRegistry>).abortChild === 'function' &&
    typeof (value as Partial<MutableChildRunRegistry>).subscribeLiveness === 'function'
  );
}

/**
 * Structural guard for a "child lifecycle handle" (AB-50's `ChildRunHandle`
 * wraps one; `dispatchChildRun` also has direct access to it) that actually
 * implements AB-88's `LivenessObservable` — checked with `typeof`, not
 * assumed from `RunnableAgent<O, H>.run()`'s declared return type, because
 * a third-party or test-double `RunnableAgent` implementation can return an
 * object that satisfies the type only structurally-on-paper (a common
 * pattern in this repository's own test doubles, which cast `as unknown as
 * ReturnType<RunnableAgent['run']>` past members they never implement).
 * Calling `subscribeSnapshot` on such an object would throw at runtime;
 * this guard keeps `dispatchChildRun` from ever doing that, matching this
 * module's existing defensive posture toward a misbehaving `RunnableAgent`
 * (the `agent.run()` / `agentRun.result()` try/catches above).
 */
export function hasLivenessObservable(
  value: unknown,
): value is LivenessObservable<LivenessSnapshot> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<LivenessObservable<LivenessSnapshot>>).snapshot === 'function' &&
    typeof (value as Partial<LivenessObservable<LivenessSnapshot>>).subscribeSnapshot === 'function'
  );
}

/**
 * Creates an empty, in-memory child registry. Construct one per run and
 * supply it to both `createAgentRun`'s `childRegistry` option and every
 * `createSubagentTool` this run may dispatch through (via
 * `parentContext.registry`) to make that run's children discoverable
 * through `AgentRun.children()`/`.abortChild()`.
 */
export function createChildRunRegistry(): MutableChildRunRegistry {
  const entries = new Map<string, RegisteredChild>();
  const livenessListeners = new Set<() => void>();

  function notifyLivenessChange(): void {
    // Isolate each listener the same way `ActiveRunLiveness.notify()` does
    // (`active-run-liveness.ts`): a throwing listener must not prevent a
    // later-registered one from being notified, and must not propagate out
    // of this function — which is reached from inside a child's own
    // `subscribeSnapshot` delivery (`attachLiveness` below), where an
    // uncaught throw here would otherwise surface as this registry
    // breaking that child's own liveness propagation to its OTHER
    // subscribers, not just this one's bug.
    for (const listener of [...livenessListeners]) {
      try {
        listener();
      } catch {
        // The listener's own bug is the listener's problem, not this
        // registry's or the child's.
      }
    }
  }

  return {
    register(entry): void {
      entries.set(entry.id, {
        descriptor: {
          id: entry.id,
          parentId: entry.parentId,
          agentName: entry.agentName,
          durable: entry.durable,
          status: 'running',
        },
        abort: entry.abort,
      });
    },
    settle(id, status, result): void {
      const existing = entries.get(id);
      if (!existing) return;
      existing.descriptor = { ...existing.descriptor, status, ...(result ? { result } : {}) };
      // Release the subscription now — the child's own `subscribeSnapshot`
      // will already have delivered its one terminal snapshot (AB-88's
      // AC10) by the time `dispatchChildRun`'s `settle()` runs, so
      // `descriptor.assessment` is already `'terminal'`; this only stops
      // holding a `Subscription` object this registry no longer needs.
      existing.livenessSubscription?.unsubscribe();
      existing.livenessSubscription = undefined;
    },
    attachLiveness(id, observable): void {
      const existing = entries.get(id);
      if (!existing) return;
      existing.livenessSubscription = observable.subscribeSnapshot((snapshot) => {
        const current = entries.get(id);
        if (!current) return;
        current.descriptor = { ...current.descriptor, assessment: snapshot.assessment };
        notifyLivenessChange();
      });
    },
    subscribeLiveness(observer): Subscription {
      livenessListeners.add(observer);
      let closed = false;
      return {
        unsubscribe(): void {
          if (closed) return;
          closed = true;
          livenessListeners.delete(observer);
        },
        get closed() {
          return closed;
        },
      };
    },
    children(): readonly ChildRunDescriptor[] {
      // A frozen clone per call, not the registry's own stored object: every
      // field is already `readonly` at the type level, but that boundary is
      // compile-time-only — a JavaScript consumer, or any TypeScript code
      // that crosses it with a cast, could otherwise mutate a returned
      // descriptor's `status` in place and corrupt this registry's actual
      // control state (e.g. forcing it to `'completed'` would make a later
      // `abortChild(id)` treat a still-running child as already terminal and
      // silently no-op instead of aborting it).
      return [...entries.values()].map((entry) => Object.freeze({ ...entry.descriptor }));
    },
    abortChild(childId, reason): void {
      const entry = entries.get(childId);
      if (!entry) return; // unknown id: no-op, never an error
      if (entry.descriptor.status !== 'running') return; // already terminal: no-op
      entry.abort(reason);
    },
  };
}

// ---------------------------------------------------------------------------
// dispatchChildRun — the primitive itself
// ---------------------------------------------------------------------------

/** Minimal event-dispatch surface `dispatchChildRun` emits lifecycle events onto. */
export interface ChildEventEmitter {
  dispatchEvent(event: Event): boolean;
}

export interface DispatchChildRunOptions {
  /** The child's own agent name — distinct from the parent's. */
  agentName: string;
  /** The parent run's identifier, stamped on every emitted event and on `parentRunId`. */
  parentRunId: string;
  /** The parent's agent name, stamped on every emitted event. Defaults to `''` when omitted. */
  parentAgentName?: string;
  /**
   * Composed with a private per-child `AbortController`: aborting `signal`
   * (a parent abort) and calling the returned handle's own `abort()` (a
   * child-targeted abort) both stop the child; neither reaches a sibling
   * dispatched from the same parent.
   */
  signal?: AbortSignal;
  traceContext?: unknown;
  withTraceContext?: <T>(parentContext: unknown, fn: () => Promise<T>) => Promise<T>;
  /** When supplied, the four `multiagent.child-workflow.*` events are dispatched onto it. */
  emitter?: ChildEventEmitter;
  /**
   * True when this child runs as a durable Weft child workflow; false for
   * an in-process one. `dispatchChildRun` dispatches through
   * `RunnableAgent.run()` — the in-process route — so this is caller
   * metadata describing the child's actual route, not derived from it; a
   * caller dispatching a durable child through a durable-aware
   * `RunnableAgent` is responsible for passing `durable: true` here to
   * match.
   */
  durable?: boolean;
  /** Overrides the generated `childRunId`. Exists for deterministic tests. */
  childRunId?: string;
  /** When supplied, this dispatch registers into it — see `createChildRunRegistry`. */
  registry?: MutableChildRunRegistry;
}

/** True when `result.finishReason` reflects a signal-driven abort. */
function isAbortedResult(result: RunResult): boolean {
  return result.finishReason === 'aborted';
}

/**
 * Dispatches a child run from `agent`, returning a `ChildRunHandle` that
 * carries the child's own identity alongside `AgentRun`'s iterate / await /
 * abort / dispose surface. `createSubagentTool` is implemented on top of
 * this; a caller may also call it directly to retain a typed handle instead
 * of going through a tool at all.
 */
export function dispatchChildRun<O = never, H extends boolean = false>(
  agent: RunnableAgent<O, H>,
  input: AgentInput,
  options: DispatchChildRunOptions,
): ChildRunHandle<O, H> {
  const childRunId = options.childRunId ?? crypto.randomUUID();
  const parentAgentName = options.parentAgentName ?? '';
  const durable = options.durable ?? false;

  // A private controller so a child-targeted abort() never reaches a
  // sibling, composed with the parent's signal (when supplied) so a parent
  // abort stops this child too. `AbortSignal.any` degrades gracefully when
  // `options.signal` is omitted — the child then only reacts to its own
  // controller.
  const childController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, childController.signal])
    : childController.signal;

  // Set once `agent.run()` returns a handle (below). Some `RunnableAgent`
  // implementations cancel only through their own `AgentRun.abort()` and
  // never observe the `signal` this dispatch composed and passed to
  // `agent.run()` — the optional `AgentRunContext.signal` parameter, not a
  // required one. Without also forwarding to the live handle, a
  // child-targeted `abort()` on such an agent would abort only this
  // private controller and leave the child itself running, its `result()`
  // pending forever.
  const liveAgentRun: { current?: ReturnType<typeof agent.run> } = {};

  const abort = (reason?: string): void => {
    childController.abort(reason);
    liveAgentRun.current?.abort(reason);
  };

  const correlation = {
    parentAgentName,
    parentRunId: options.parentRunId,
    childAgentName: options.agentName,
    childRunId,
  };

  options.registry?.register({
    id: childRunId,
    parentId: options.parentRunId,
    agentName: options.agentName,
    durable,
    abort,
  });

  options.emitter?.dispatchEvent(
    new ChildWorkflowStartedEvent({
      ...correlation,
      input: typeof input === 'string' ? input : '[conversation history]',
      durable,
    }),
  );

  // `RunnableAgent.run()` is documented to start synchronously and can
  // throw before ever producing a handle (a misbehaving or third-party
  // implementation). Without this try/catch, that throw would leave the
  // registry entry `register()` just added permanently stuck at 'running'
  // — nothing would ever call `settle()` for it, since there is no
  // `agentRun.result()` promise to attach to.
  let agentRun: ReturnType<typeof agent.run>;
  try {
    agentRun = agent.run(input, {
      agentName: options.agentName,
      signal,
      traceContext: options.traceContext,
      withTraceContext: options.withTraceContext,
    });
  } catch (error) {
    options.registry?.settle(childRunId, 'failed');
    options.emitter?.dispatchEvent(
      new ChildWorkflowFailedEvent({
        ...correlation,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
  liveAgentRun.current = agentRun;

  // AB-216 — wire this child's own liveness (its `AgentRun`'s
  // `snapshot()`/`subscribeSnapshot()`, AB-88/AB-214) into the registry so
  // a parent's rollup can read `ChildRunDescriptor.assessment`. Guarded by
  // `hasLivenessObservable` rather than assumed from the declared
  // `RunnableAgent<O, H>.run()` return type — see that guard's own doc
  // comment for why an unguarded call here would be unsafe against a
  // misbehaving or test-double `RunnableAgent`. Reads the child's own
  // already-computed assessment only; never selects, overrides, or
  // re-evaluates the child's own `StallPolicy` (AB-216's delegated-policy
  // acceptance criterion) — this registry has no watchdog of its own.
  if (options.registry && hasLivenessObservable(agentRun)) {
    options.registry.attachLiveness(childRunId, agentRun);
  }

  const settle = (result: RunResult<O, H>): RunResult<O, H> => {
    const asBaseResult = result as unknown as RunResult;
    const status = isAbortedResult(asBaseResult)
      ? 'aborted'
      : asBaseResult.finishReason === 'stop-condition'
        ? 'completed'
        : 'failed';
    options.registry?.settle(childRunId, status, asBaseResult);

    if (status === 'aborted') {
      // `signal` (the composed one), not `childController.signal`: a
      // parent-propagated abort only fires the PARENT half of the
      // composition, leaving the private controller's own `.reason`
      // `undefined` even though the child genuinely aborted with a
      // reason. The composed signal reflects whichever source fired.
      options.emitter?.dispatchEvent(
        new ChildWorkflowAbortedEvent({
          ...correlation,
          reason: typeof signal.reason === 'string' ? signal.reason : undefined,
        }),
      );
    } else if (status === 'completed') {
      options.emitter?.dispatchEvent(new ChildWorkflowCompletedEvent(correlation));
    } else {
      options.emitter?.dispatchEvent(
        new ChildWorkflowFailedEvent({ ...correlation, reason: asBaseResult.finishReason }),
      );
    }
    return result;
  };

  const settleRejection = (error: unknown): never => {
    options.registry?.settle(childRunId, 'failed');
    options.emitter?.dispatchEvent(
      new ChildWorkflowFailedEvent({
        ...correlation,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  };

  // `agentRun.result()` is documented to return a `Promise`, but a
  // misbehaving or third-party `AgentRun` implementation can throw
  // synchronously from the method itself rather than rejecting the promise
  // it returns. That throw would otherwise escape before `.then()` is ever
  // reached, leaving the registry entry stuck at 'running' forever and
  // emitting no failed lifecycle event — the same gap the `agent.run()`
  // try/catch above closes for dispatch itself. Routing it through
  // `settleRejection` gives it the identical failure-settlement path a
  // rejected `result()` promise already gets.
  const settledResult = ((): Promise<RunResult<O, H>> => {
    try {
      return agentRun.result();
    } catch (error) {
      // `settleRejection` below narrows via `error instanceof Error`
      // regardless, so wrapping a non-`Error` throw here (matching
      // `create-lazy-agent.ts`'s identical pattern) costs nothing and
      // satisfies `prefer-promise-reject-errors`.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  })().then(settle, settleRejection);

  return {
    childRunId,
    parentRunId: options.parentRunId,
    agentName: options.agentName,
    result(): Promise<RunResult<O, H>> {
      return settledResult;
    },
    abort,
    [Symbol.dispose](): void {
      abort();
      agentRun[Symbol.dispose]();
    },
    [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
      return agentRun[Symbol.asyncIterator]();
    },
  };
}
