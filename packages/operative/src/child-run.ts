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
 * inside its own tool calls constructs one registry and supplies it in two
 * places: `createAgentRun`'s `childRegistry` option (or
 * `AgentRunContext.childRegistry` via `RunnableAgent.run()`), and
 * `createSubagentTool`'s `parentContext.registry`. This mirrors the
 * existing `parentContext.emitter` wiring F1 already requires for
 * `ChildWorkflowStartedEvent` — both are caller-supplied because a tool is
 * constructed once, independent of any particular run, so nothing can
 * inject a run-scoped registry into an already-built tool automatically.
 * `createSubagentTool` call sites that don't need discovery stay exactly as
 * simple as before: `parentContext` (and therefore `registry`) is entirely
 * optional.
 */

import type { RunEvent } from './agent-run';
import {
  ChildWorkflowAbortedEvent,
  ChildWorkflowCompletedEvent,
  ChildWorkflowFailedEvent,
  ChildWorkflowStartedEvent,
} from './events';
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
}

interface RegisteredChild {
  descriptor: ChildRunDescriptor;
  abort: (reason?: string) => void;
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
}

/** A `ChildRunRegistry` a `dispatchChildRun` caller can also register children into. */
export type MutableChildRunRegistry = ChildRunRegistry & ChildRunRegistrar;

/**
 * Creates an empty, in-memory child registry. Construct one per run and
 * supply it to both `createAgentRun`'s `childRegistry` option and every
 * `createSubagentTool` this run may dispatch through (via
 * `parentContext.registry`) to make that run's children discoverable
 * through `AgentRun.children()`/`.abortChild()`.
 */
export function createChildRunRegistry(): MutableChildRunRegistry {
  const entries = new Map<string, RegisteredChild>();

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
