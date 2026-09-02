/**
 * `AgentRun` — the non-thenable run handle.
 *
 * Wraps the internal `ActiveRun` (which owns the event emitter and result
 * promise) and exposes the new public interface:
 *   - `AsyncIterable<RunEvent>` — stream all operative events with `for await`
 *   - `result(): Promise<RunResult>` — access the terminal result (cached)
 *   - `abort(reason?)` — abort the in-flight run immediately
 *   - `[Symbol.dispose]()` — release resources
 *
 * Critically, `AgentRun` does NOT extend `Promise` or `PromiseLike`. A thenable
 * handle is auto-unwrapped at every `async` boundary (`return run`,
 * `Promise.all([run])`, `Promise.resolve(run)`) and destroys the event stream.
 * The cost of avoiding it is one method call (`run.result()`). See
 * architecture.md for the 3-reviewer consensus on this decision.
 */

import type { ChildRunDescriptor, ChildRunRegistry } from './child-run';
import type { ActiveRun } from './create-run';
import type { CombinedOperativeEventMap, CombinedOperativeEventType } from './events';
import type { RunResult, RunResultBase } from './types';

export type { ChildRunDescriptor, ChildRunRegistry } from './child-run';

// ---------------------------------------------------------------------------
// RunEvent — the event type yielded by AgentRun's async iterator
// ---------------------------------------------------------------------------

/**
 * A single event emitted by a run. This is the union of all operative event
 * types that the run stream carries. Each event is an `Event` subclass with
 * a `type` discriminant and additional typed properties.
 *
 * Phase C will enrich this with curated `tool.*` events stamped with
 * `{agentName, runId, step}`. For now, the stream carries operative's own
 * events (run.*, step.*, generate.*, etc.).
 */
export type RunEvent = CombinedOperativeEventMap[CombinedOperativeEventType];

// ---------------------------------------------------------------------------
// AgentRun interface
// ---------------------------------------------------------------------------

/**
 * The handle returned by `run()` (and eventually `bureau.run()` / `agent.run()`).
 *
 * Consumption patterns:
 *
 * ```ts
 * // 1. Iterate over events:
 * for await (const event of run) {
 *   process(event.type);
 * }
 *
 * // 2. Await just the result (skips events):
 * const result = await run.result();
 *
 * // 3. Iterate-then-result (cache proof — result() after full iteration):
 * for await (const event of run) { ... }
 * const result = await run.result(); // same Promise, no re-run
 *
 * // 4. Abort mid-run:
 * run.abort('user cancelled');
 * ```
 */
export type OutputMethod<O, H extends boolean> = [H] extends [true]
  ? { output(): Promise<O> }
  : Record<never, never>;

export type UnwrappedValue<O, H extends boolean> = [H] extends [true] ? O : string;

export type AgentRun<O = never, H extends boolean = false> = AsyncIterable<RunEvent> &
  OutputMethod<O, H> & {
    /**
     * Returns a `Promise` that resolves to the terminal `RunResult`. The promise
     * is cached after first resolution — calling `result()` multiple times,
     * before/during/after iteration, always returns the same promise.
     *
     * This is the ONLY path to a `RunResult`. `AgentRun` is non-thenable by
     * design; `await agentRun` is a type error (it doesn't extend
     * `PromiseLike`).
     */
    result(): Promise<RunResult<O, H>>;

    /** Resolve the validated output, or plain text for an untyped agent. */
    unwrap(): Promise<UnwrappedValue<O, H>>;

    /**
     * Abort the in-flight run. The abort signal fires immediately; the provider
     * connection drops within ~1s. Any pending `result()` promise rejects with
     * an abort reason.
     */
    abort(reason?: string): void;

    /**
     * Child discovery (AB-50 / AB-34's Required capabilities table). A
     * snapshot of every child this run has dispatched through
     * `createSubagentTool` (or `dispatchChildRun` directly) with a matching
     * `childRegistry` — see `createAgentRun`'s `childRegistry` option and
     * `child-run.ts`'s module docs for how the two are wired together.
     * Empty when no registry was supplied; never throws.
     */
    children(): readonly ChildRunDescriptor[];

    /**
     * Scoped child cancellation (AB-50 / AB-34's Required capabilities
     * table). Aborts only the named child — never a sibling — and is
     * idempotent: an unknown id, or one already terminal, is a no-op, not
     * an error. Distinct from `abort()`, which AB-15 fixed and this does
     * not change.
     */
    abortChild(childId: string, reason?: string): void;

    /**
     * Dispose the run handle and release internal resources. Equivalent to
     * `abort()` when the run is still in flight.
     */
    [Symbol.dispose](): void;
  };

/** A durable run recovered without a trusted live agent definition. */
export interface DiagnosticAgentRun extends AsyncIterable<RunEvent> {
  result(): Promise<RunResult<unknown, false>>;
  abort(reason?: string): void;
  /** See `AgentRun.children()` — AB-34 applies the same capability here. */
  children(): readonly ChildRunDescriptor[];
  /** See `AgentRun.abortChild()` — AB-34 applies the same capability here. */
  abortChild(childId: string, reason?: string): void;
  [Symbol.dispose](): void;
}

// ---------------------------------------------------------------------------
// SuccessfulRunResult — the narrowed shape createSubagentTool projects
// ---------------------------------------------------------------------------
//
// `RunnableAgent`/`AgentInput`/`AgentRunContext` (AB-19's directional
// contract for `createSubagentTool`'s `agent` option) now live in
// `runnable-agent.ts` — AB-21 landed that file as the canonical,
// package-wide definition of the same three types (this file originally
// carried a deliberately-narrower local copy, forward-compatible by design
// with AB-21's fuller one; see this PR's history). `create-subagent-tool.ts`
// imports them from there instead of duplicating them here.

/**
 * A `RunResult` narrowed to the one shape `createSubagentTool`'s
 * `toToolOutput` projection is ever invoked with: a clean stop with no
 * failed schema validation. `toToolOutput` runs after every non-success
 * terminal (abort, execution error, tripwire, budget, elicitation denial,
 * maximum steps, and invalid output) has already been rejected as a
 * `SubagentRunError` — see `create-subagent-tool.ts`.
 *
 * `schemaValidation` is narrowed to `success: true` (absent, or present and
 * successful) alongside `finishReason` — a `SuccessfulRunResult` can never
 * structurally carry a failed validation, matching what `isSuccessfulRunResult`
 * actually checks below rather than only half of it.
 *
 * Built from `RunResultBase` rather than intersecting `RunResult<O, H>`
 * (whose `output` is always optional, `H`-gated or not) so the `H extends
 * true` branch can REQUIRE `output: O` instead of merely allowing it:
 * `run-lifecycle.ts` only ever includes the `output` key at all when
 * `finishReason === 'stop-condition' && schemaValidation?.success`, so once
 * both of those hold for an `H = true` agent, `output` is always present.
 */
export type SuccessfulRunResult<O = never, H extends boolean = false> = RunResultBase & {
  finishReason: 'stop-condition';
  schemaValidation?: { success: true; error?: unknown };
} & ([H] extends [true] ? { output: O } : Record<never, never>);

/**
 * True when `result` is a clean, schema-valid stop — the only terminal
 * shape `createSubagentTool` projects through `toToolOutput`. Every other
 * terminal (abort, execution error, tripwire, budget, elicitation denial,
 * maximum steps, or a `stop-condition` whose output failed schema
 * validation) rejects with `SubagentRunError` instead. Enforces
 * `run-lifecycle.ts:226`'s own invariant — `output` is present exactly when
 * `finishReason === 'stop-condition' && schemaValidation?.success` — so a
 * `RunResult` this package constructs is always classified correctly.
 *
 * This is NOT the same soundness guarantee `AgentRun.unwrap()`/`.output()`
 * have above: those close over a runtime `hasOutput` boolean
 * (`CreateAgentRunOptions.hasOutput`) that is independent of anything on
 * `result` itself, so they can positively detect "an `H = true` run whose
 * `schemaValidation` went missing" and throw. `isSuccessfulRunResult` has no
 * such witness — `RunnableAgent`'s `H` is a compile-time-only phantom
 * parameter with no runtime representation on the interface (just `run`),
 * so a hand-written `RunnableAgent<O, true>` that omits `schemaValidation`
 * entirely is structurally indistinguishable from a genuinely schema-less
 * (`H = false`) child; both fall through the `schemaValidation === undefined`
 * branch and narrow successfully. Closing that residual gap needs a runtime
 * signal for `H` that `RunnableAgent`'s contract doesn't carry (AB-15/AB-19
 * didn't ratify one) — consistent with `toToolOutput` being documented as
 * "a projection, not runtime validation" and "separate tool-output
 * validation" being explicitly out of this issue's scope. What this
 * function DOES guarantee: whenever `schemaValidation` is present and
 * reports success, `output` is verified present before narrowing — the
 * concrete case a hand-written agent could otherwise trip (see the
 * `'output' in result` check below).
 */
export function isSuccessfulRunResult<O, H extends boolean>(
  result: RunResult<O, H>,
): result is SuccessfulRunResult<O, H> {
  return (
    result.finishReason === 'stop-condition' &&
    (result.schemaValidation === undefined ||
      (result.schemaValidation.success && 'output' in result))
  );
}

// ---------------------------------------------------------------------------
// createAgentRun — the factory
// ---------------------------------------------------------------------------

/**
 * Options for controlling the async-iterator behaviour on a completed run.
 */
export interface CreateAgentRunOptions {
  /**
   * Controls what happens when a `for await` loop is started on an already-
   * completed run (i.e. the underlying `ActiveRun`'s emitter has already
   * completed).
   *
   * - `'error'` (default) — throws `CompletedRunIterationError` immediately.
   *   This is the safest choice: it surfaces the mis-use, rather than hanging.
   * - `'empty'` — returns immediately without yielding any events.
   */
  onCompletedIteration?: 'error' | 'empty';
  /** Whether this handle has a configured schema-backed output accessor. */
  hasOutput?: boolean;
  /**
   * Backs `children()`/`abortChild()` (AB-50). Opt-in: omit it and both
   * methods are safe no-ops (`children()` returns `[]`, `abortChild()` does
   * nothing). Supply the SAME registry to every `createSubagentTool` this
   * run dispatches through (via its `parentContext.registry`) to make this
   * run's children discoverable — see `child-run.ts`'s module docs for why
   * this can't be wired automatically.
   */
  childRegistry?: ChildRunRegistry;
}

/**
 * Thrown when a caller starts a second `for await` loop on a run whose event
 * stream has already completed. This is a programming mistake: the stream is
 * consumed once. Use `run.result()` to access the terminal value.
 */
export class CompletedRunIterationError extends Error {
  constructor() {
    super(
      'AgentRun: the event stream has already completed. ' +
        'A run can only be iterated once. Use run.result() to access the terminal value.',
    );
    this.name = 'CompletedRunIterationError';
  }
}

/** Returns an immediately-done async iterator that yields nothing. */
function emptyIterator(): AsyncIterator<RunEvent> {
  return {
    next(): Promise<IteratorResult<RunEvent>> {
      return Promise.resolve({ value: undefined as unknown as RunEvent, done: true });
    },
  };
}

/**
 * Creates an `AgentRun` handle that wraps an `ActiveRun`.
 *
 * The `AgentRun` is the public interface; `ActiveRun` is the internal engine.
 * This separation lets the internal event surface evolve independently of the
 * public contract.
 *
 * @param activeRun - The internal run to wrap.
 * @param options - Controls behaviour on a completed-run iteration attempt.
 */
export function createAgentRun<O = never, H extends boolean = false>(
  activeRun: ActiveRun,
  options: CreateAgentRunOptions = {},
): AgentRun<O, H> {
  const { onCompletedIteration = 'error' } = options;
  const hasOutput = options.hasOutput ?? false;
  const childRegistry = options.childRegistry;

  // Cache the result promise so result() is idempotent across all calls
  // (before, during, and after iteration).
  const cachedResult: Promise<RunResult<O, H>> = activeRun.result as Promise<RunResult<O, H>>;

  // Track whether the run has finished. We attach to the result promise so this
  // flag is set regardless of whether anyone is iterating — this covers the case
  // where result() is awaited without ever calling for-await, and then someone
  // tries to iterate after the fact.
  let runSettled = false;
  void cachedResult.then(
    () => {
      runSettled = true;
    },
    () => {
      runSettled = true;
    },
  );

  // Track whether a `for await` is currently active on this handle.
  let iterating = false;
  // Track whether the iteration stream has been consumed via for-await.
  // Distinct from runSettled: runSettled is true after result() resolves;
  // streamConsumed is true after a for-await has completed its iteration.
  let streamConsumed = false;

  function isCompleted(): boolean {
    return runSettled || streamConsumed;
  }

  const handle = {
    result(): Promise<RunResult<O, H>> {
      return cachedResult;
    },

    unwrap(): Promise<UnwrappedValue<O, H>> {
      return cachedResult.then((result) => {
        if (result.finishReason !== 'stop-condition') {
          throw result.error instanceof Error
            ? result.error
            : new Error(`Agent run did not finish successfully: ${result.finishReason}`);
        }
        if (result.schemaValidation && !result.schemaValidation.success) {
          throw result.schemaValidation.error instanceof Error
            ? result.schemaValidation.error
            : new Error('Agent run output failed schema validation');
        }
        if (hasOutput) {
          if (!result.schemaValidation?.success || !('output' in result)) {
            throw result.schemaValidation?.error instanceof Error
              ? result.schemaValidation.error
              : new Error('Agent run has no validated output');
          }
          return result.output as UnwrappedValue<O, H>;
        }
        return result.content as UnwrappedValue<O, H>;
      });
    },

    ...(hasOutput
      ? {
          output(): Promise<O> {
            return cachedResult.then((result) => {
              if (result.finishReason !== 'stop-condition') {
                throw result.error instanceof Error
                  ? result.error
                  : new Error(`Agent run did not finish successfully: ${result.finishReason}`);
              }
              if (!result.schemaValidation?.success || !('output' in result)) {
                throw result.schemaValidation?.error instanceof Error
                  ? result.schemaValidation.error
                  : new Error('Agent run has no validated output');
              }
              return result.output as O;
            });
          },
        }
      : {}),

    abort(reason?: string): void {
      activeRun.abort(reason);
    },

    children(): readonly ChildRunDescriptor[] {
      return childRegistry?.children() ?? [];
    },

    abortChild(childId: string, reason?: string): void {
      childRegistry?.abortChild(childId, reason);
    },

    [Symbol.dispose](): void {
      activeRun[Symbol.dispose]();
    },

    [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
      // Guard: reject a concurrent second iteration.
      if (iterating) {
        if (onCompletedIteration === 'empty') return emptyIterator();
        throw new CompletedRunIterationError();
      }

      // Guard: reject a post-completion iteration attempt.
      if (isCompleted()) {
        if (onCompletedIteration === 'empty') return emptyIterator();
        throw new CompletedRunIterationError();
      }

      iterating = true;

      // Pull events from the ActiveRun's observable into a pull-based queue.
      // We use a resolve/reject pair so the consumer's next() call can park
      // until the next event arrives from the push-based source.
      const queue: RunEvent[] = [];
      let done = false;
      let pendingError: unknown = null;
      let hasPendingError = false;
      let waitResolve: ((value: IteratorResult<RunEvent>) => void) | null = null;
      let waitReject: ((reason?: unknown) => void) | null = null;

      function settle(): void {
        done = true;
        streamConsumed = true;
        iterating = false;
      }

      const subscription = activeRun.toObservable().subscribe({
        next(event: RunEvent): void {
          if (waitResolve) {
            const resolve = waitResolve;
            waitResolve = null;
            waitReject = null;
            resolve({ value: event, done: false });
          } else {
            queue.push(event);
          }
        },
        error(err: unknown): void {
          settle();
          if (waitReject) {
            const reject = waitReject;
            waitResolve = null;
            waitReject = null;
            reject(err);
          } else {
            hasPendingError = true;
            pendingError = err;
          }
        },
        complete(): void {
          settle();
          if (waitResolve) {
            const resolve = waitResolve;
            waitResolve = null;
            waitReject = null;
            resolve({ value: undefined, done: true });
          }
        },
      });

      // If the run was already settled before we subscribed, the observable's
      // complete() callback may not fire (the underlying AbortSignal is already
      // aborted and adding a listener to an already-aborted signal does not fire
      // in Bun). We detect this by checking whether the run promise has settled
      // synchronously (which happens when the underlying loop completes before
      // the subscription is set up).
      //
      // We schedule the check as a microtask so any synchronous `complete()`
      // callbacks from the subscription setup can run first.
      void Promise.resolve().then(() => {
        if (!done && runSettled) {
          // The run is done but the observable's complete() never fired
          // (because the signal was already aborted when we subscribed).
          // Flush the queue and mark done.
          subscription.unsubscribe();
          settle();
          if (waitResolve) {
            const resolve = waitResolve;
            waitResolve = null;
            waitReject = null;
            resolve({ value: undefined, done: true });
          }
        }
      });

      return {
        next(): Promise<IteratorResult<RunEvent>> {
          // Drain buffered events first.
          if (queue.length > 0) {
            const event = queue.shift()!;
            return Promise.resolve({ value: event, done: false });
          }
          // Surface a buffered error.
          if (hasPendingError) {
            const err =
              pendingError instanceof Error ? pendingError : new Error(String(pendingError));
            hasPendingError = false;
            pendingError = null;
            return Promise.reject(err);
          }
          // Already done — signal completion.
          if (done) {
            return Promise.resolve({ value: undefined as unknown as RunEvent, done: true });
          }
          // Park until the next push arrives.
          return new Promise<IteratorResult<RunEvent>>((resolve, reject) => {
            waitResolve = resolve;
            waitReject = reject;
          });
        },

        return(): Promise<IteratorResult<RunEvent>> {
          // The `for await` loop exited early (break / return / throw in body).
          subscription.unsubscribe();
          settle();
          return Promise.resolve({ value: undefined as unknown as RunEvent, done: true });
        },
      };
    },
  } as AgentRun<O, H>;

  return handle;
}

/**
 * Wrap a recovered active run without offering an output or unwrap accessor.
 * A diagnostic run is intentionally useful for inspection and cancellation
 * only: its originating schema may no longer be available to validate data.
 *
 * `options.childRegistry` is forwarded straight through to `createAgentRun`
 * — a `DiagnosticAgentRun`'s `children()`/`abortChild()` back the same
 * capability `AgentRun` does (AB-34 applies it to both alike), so a caller
 * recovering a run whose tools were wired into a registry can still supply
 * that same registry here and get real discovery, not the empty default.
 */
export function createDiagnosticAgentRun(
  activeRun: ActiveRun,
  options: Pick<CreateAgentRunOptions, 'childRegistry'> = {},
): DiagnosticAgentRun {
  const run = createAgentRun<unknown, false>(
    activeRun,
    options,
  ) as unknown as DiagnosticAgentRun & {
    unwrap?: () => Promise<string>;
    output?: () => Promise<unknown>;
  };
  delete run.unwrap;
  delete run.output;
  return run;
}
