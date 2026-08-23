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

import type { ActiveRun } from './create-run';
import type { CombinedOperativeEventMap, CombinedOperativeEventType } from './events';
import type { RunResult } from './types';

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
    result(): Promise<RunResult>;

    /** Resolve the validated output, or plain text for an untyped agent. */
    unwrap(): Promise<UnwrappedValue<O, H>>;

    /**
     * Abort the in-flight run. The abort signal fires immediately; the provider
     * connection drops within ~1s. Any pending `result()` promise rejects with
     * an abort reason.
     */
    abort(reason?: string): void;

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
  [Symbol.dispose](): void;
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

  // Cache the result promise so result() is idempotent across all calls
  // (before, during, and after iteration).
  const cachedResult: Promise<RunResult> = activeRun.result;

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
    result(): Promise<RunResult> {
      return cachedResult;
    },

    unwrap(): Promise<UnwrappedValue<O, H>> {
      return cachedResult.then((result) => {
        if (result.finishReason !== 'stop-condition' && result.finishReason !== 'maximum-steps') {
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
          if (
            !result.schemaValidation?.success ||
            !('output' in result) ||
            result.output === undefined
          ) {
            throw result.schemaValidation?.error instanceof Error
              ? result.schemaValidation.error
              : new Error('Agent run has no validated output');
          }
          return result.output as UnwrappedValue<O, H>;
        }
        return result.content as UnwrappedValue<O, H>;
      });
    },

    output(): Promise<O> {
      return cachedResult.then((result) => {
        if (result.finishReason !== 'stop-condition' && result.finishReason !== 'maximum-steps') {
          throw result.error instanceof Error
            ? result.error
            : new Error(`Agent run did not finish successfully: ${result.finishReason}`);
        }
        if (
          !result.schemaValidation?.success ||
          !('output' in result) ||
          result.output === undefined
        ) {
          throw result.schemaValidation?.error instanceof Error
            ? result.schemaValidation.error
            : new Error('Agent run has no validated output');
        }
        return result.output as O;
      });
    },

    abort(reason?: string): void {
      activeRun.abort(reason);
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
 */
export function createDiagnosticAgentRun(activeRun: ActiveRun): DiagnosticAgentRun {
  const run = createAgentRun<unknown, false>(activeRun) as unknown as DiagnosticAgentRun & {
    unwrap?: () => Promise<string>;
    output?: () => Promise<unknown>;
  };
  delete run.unwrap;
  delete run.output;
  return run;
}
