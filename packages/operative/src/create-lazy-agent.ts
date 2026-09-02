/**
 * `createLazyAgent` — a type-preserving lazy `RunnableAgent` wrapper (AB-21).
 *
 * Mirrors `createLazyGenerate` (AB-20): a shared `unloaded | loading | loaded`
 * cache for the underlying `RunnableAgent`, with a rejection clearing only
 * the matching pending load so a later call retries. What's new here is
 * per-run state, because `RunnableAgent.run()` is synchronous and must
 * return an `AgentRun` handle immediately — before the underlying agent has
 * necessarily loaded. Each `run()` call therefore owns an isolated
 * `waiting | started | terminal` state machine that:
 *
 *   - buffers events that arrive before the underlying agent resolves,
 *   - resolves `result()`/`unwrap()`/`output()` through the real handle once
 *     it exists (delegating rather than re-implementing their logic),
 *   - and races `abort()` against resolution: if abort wins, the underlying
 *     agent's `run()` is never called; if resolution wins, the underlying
 *     handle is stored before any pending abort is forwarded, and forwarded
 *     at most once.
 */

import { Conversation } from 'conversationalist';

import type { AgentRun, RunEvent, UnwrappedValue } from './agent-run';
import { CompletedRunIterationError } from './agent-run';
import type { AgentRunError } from './errors';
import {
  AbortAgentRunError,
  AgentContractError,
  AsyncDefinitionLoadError,
  toAgentRunError,
} from './errors';
import { RunAbortedEvent, RunCompletedEvent, RunErrorEvent } from './events';
import type {
  AgentInput,
  AgentRunContext,
  DefinitionResolvingAgent,
  ResolveRunOptions,
  RunnableAgent,
} from './runnable-agent';
import { OPERATIVE_RESOLVE_RUN_OPTIONS } from './runnable-agent';
import type { FinishReason, RunResult, TokenUsage } from './types';

export type LazyAgentLoader<O, H extends boolean> = () =>
  RunnableAgent<O, H> | PromiseLike<RunnableAgent<O, H>>;

export interface CreateLazyAgentOptions {
  /** Human-readable label included in lazy loading and contract error messages. */
  label?: string;
}

// A fresh object per call — never a shared module-level singleton. `RunResult.usage`
// is a plain, externally-visible object; sharing one mutable instance across every
// synthetic (load-failure, contract-failure, or pre-start-abort) result would let a
// mutation on one run's `result.usage` bleed into every other run's.
function zeroUsage(): TokenUsage {
  return { prompt: 0, completion: 0, total: 0 };
}

function buildFallbackConversation(input: AgentInput): Conversation {
  if (typeof input === 'string') {
    const conversation = new Conversation();
    conversation.appendUserMessage(input);
    return conversation;
  }
  return new Conversation(structuredClone(input.conversation));
}

function isCallable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

/** Validates the shape `AgentRun` promises: `result`, `unwrap`, `abort`, iteration, and disposal. */
function isValidAgentRunHandle(value: unknown): value is AgentRun<unknown, boolean> {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<PropertyKey, unknown>;
  return (
    isCallable(candidate['result']) &&
    isCallable(candidate['unwrap']) &&
    isCallable(candidate['abort']) &&
    isCallable(candidate[Symbol.asyncIterator]) &&
    isCallable(candidate[Symbol.dispose])
  );
}

function isRunnableAgent(value: unknown): value is RunnableAgent<unknown, boolean> {
  if (value === null || typeof value !== 'object') return false;
  return isCallable((value as Record<PropertyKey, unknown>)['run']);
}

// ---------------------------------------------------------------------------
// A minimal push-based async iterator: buffers events pushed before a
// consumer starts iterating, and parks the consumer's `next()` call when the
// buffer is empty and the stream isn't done yet. Deliberately simpler than
// `agent-run.ts`'s observable-backed version — there is no upstream
// observable here, only events this module pushes itself.
// ---------------------------------------------------------------------------
interface EventQueue {
  push(event: RunEvent): void;
  complete(): void;
  fail(error: unknown): void;
  [Symbol.asyncIterator](): AsyncIterator<RunEvent>;
}

function createEventQueue(): EventQueue {
  const buffered: RunEvent[] = [];
  let done = false;
  let pendingError: unknown;
  let hasPendingError = false;
  let waitResolve: ((result: IteratorResult<RunEvent>) => void) | null = null;
  let waitReject: ((error: unknown) => void) | null = null;
  // Guards against concurrent or repeated iteration — matches `AgentRun`'s
  // own contract (`createAgentRun` throws `CompletedRunIterationError` for
  // the same misuse) rather than silently splitting events between two
  // consumers or replaying a finished stream.
  let iterating = false;
  let consumed = false;

  return {
    push(event) {
      if (done) return;
      if (waitResolve) {
        const resolve = waitResolve;
        waitResolve = null;
        waitReject = null;
        resolve({ value: event, done: false });
        return;
      }
      buffered.push(event);
    },
    complete() {
      if (done) return;
      done = true;
      if (waitResolve) {
        const resolve = waitResolve;
        waitResolve = null;
        waitReject = null;
        resolve({ value: undefined, done: true });
      }
    },
    fail(error) {
      if (done) return;
      done = true;
      if (waitReject) {
        const reject = waitReject;
        waitResolve = null;
        waitReject = null;
        reject(error);
        return;
      }
      hasPendingError = true;
      pendingError = error;
    },
    [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
      if (iterating || consumed) {
        throw new CompletedRunIterationError();
      }
      iterating = true;
      return {
        next(): Promise<IteratorResult<RunEvent>> {
          if (buffered.length > 0) {
            const event = buffered.shift();
            if (event !== undefined) return Promise.resolve({ value: event, done: false });
          }
          if (hasPendingError) {
            const error = pendingError;
            hasPendingError = false;
            pendingError = undefined;
            iterating = false;
            consumed = true;
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
          }
          if (done) {
            iterating = false;
            consumed = true;
            return Promise.resolve({ value: undefined as unknown as RunEvent, done: true });
          }
          return new Promise<IteratorResult<RunEvent>>((resolve, reject) => {
            waitResolve = (result) => {
              if (result.done) {
                iterating = false;
                consumed = true;
              }
              resolve(result);
            };
            waitReject = (error) => {
              iterating = false;
              consumed = true;
              reject(error instanceof Error ? error : new Error(String(error)));
            };
          });
        },
        return(): Promise<IteratorResult<RunEvent>> {
          iterating = false;
          consumed = true;
          return Promise.resolve({ value: undefined as unknown as RunEvent, done: true });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// createDeferredAgentRun — the per-run handle
// ---------------------------------------------------------------------------

function createDeferredAgentRun<O, H extends boolean>(
  resolveAgent: () => Promise<RunnableAgent<O, H>>,
  rawInput: AgentInput,
  context: AgentRunContext | undefined,
  label: string,
): AgentRun<O, H> {
  // Snapshot a `{ conversation }` input synchronously, at `run()` call time —
  // matching `createAgent`'s snapshot-at-`run()` semantics. Without this, the
  // caller's `ConversationHistory` object would be read only later (once the
  // underlying agent loads and its own `run()` clones it), so a mutation made
  // during the load-wait window would leak into this run.
  const input: AgentInput =
    typeof rawInput === 'string'
      ? rawInput
      : { conversation: structuredClone(rawInput.conversation) };

  type PerRunState = 'waiting' | 'started' | 'terminal';
  let state: PerRunState = 'waiting';
  // Reads `state` through a function so TypeScript's control-flow narrowing
  // — which otherwise keeps `state` pinned to its literal initial value
  // across the `await` inside the resolution IIFE below, since it can't see
  // the reassignments `requestAbort`/`finalizeSynthetic` perform from
  // outside that IIFE's own textual body — doesn't produce a false
  // "no overlap" comparison error against a state this run can genuinely be
  // in by the time that `await` resumes.
  function isTerminal(): boolean {
    return state === 'terminal';
  }
  let underlying: AgentRun<O, H> | undefined;
  let abortReason: string | undefined;
  let abortForwarded = false;

  const queue = createEventQueue();

  let settleResultPromise!: (result: RunResult<O, H>) => void;
  let resultSettled = false;
  const resultPromise = new Promise<RunResult<O, H>>((resolve) => {
    settleResultPromise = resolve;
  });

  function settleResult(result: RunResult<O, H>): void {
    if (resultSettled) return;
    resultSettled = true;
    settleResultPromise(result);
    detachSignalListener();
  }

  function finalizeSynthetic(
    error: AgentRunError,
    finishReason: FinishReason,
    isAbort: boolean,
  ): void {
    if (state === 'terminal') return;
    state = 'terminal';
    const conversation = buildFallbackConversation(input);
    const result = {
      conversation,
      steps: [],
      content: '',
      usage: zeroUsage(),
      finishReason,
      error,
    } as RunResult<O, H>;
    if (isAbort) {
      queue.push(new RunAbortedEvent(0, conversation, error, zeroUsage(), undefined, abortReason));
    } else {
      queue.push(new RunErrorEvent(0, error, 'contract'));
    }
    queue.push(new RunCompletedEvent(result));
    queue.complete();
    settleResult(result);
  }

  function requestAbort(reason?: string): void {
    if (state === 'terminal') return;
    abortReason = reason;
    if (state === 'waiting') {
      // Settle the abort immediately rather than waiting for `resolveAgent()`
      // to finish — a hung or slow loader would otherwise make a supposedly
      // fast cancellation hang too. The shared load itself is NOT cancelled
      // (module loads aren't cancellable, matching `createLazyGenerate`'s
      // AB-20 precedent): it continues in the background so the cache still
      // gets populated, but this run's outer resolution IIFE checks
      // `state === 'terminal'` before ever calling `agent.run()`.
      finalizeSynthetic(
        new AbortAgentRunError('The agent run was aborted while loading a lazy agent', reason),
        'aborted',
        true,
      );
      return;
    }
    // state === 'started'
    if (underlying && !abortForwarded) {
      abortForwarded = true;
      underlying.abort(reason);
    }
  }

  let detachSignalListener: () => void = () => {};
  const signal = context?.signal;
  if (signal) {
    if (signal.aborted) {
      requestAbort(typeof signal.reason === 'string' ? signal.reason : undefined);
    } else {
      const onAbort = (): void => {
        requestAbort(typeof signal.reason === 'string' ? signal.reason : undefined);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // Detach on settlement so a long-lived signal (a request-scoped or
      // root controller) doesn't keep this closure — and everything it
      // closes over (the run's state, `underlying`) — alive after the run
      // is done.
      detachSignalListener = () => signal.removeEventListener('abort', onAbort);
    }
  }

  // Draining `handle`'s own event stream is deliberately NOT started the
  // moment `handle` exists — only once this wrapper's OWN consumer actually
  // asks for events (`consumerRequestedIteration`, set by
  // `publicHandle[Symbol.asyncIterator]`). A caller who only ever calls
  // `result()` (the other documented consumption pattern) never subscribes,
  // so a long, tool-heavy, or streaming run doesn't grow an unbounded buffer
  // of events nobody will read — matching `createAgentRun`'s own handle,
  // which likewise only subscribes to its observable on first iteration.
  let consumerRequestedIteration = false;
  let eventsPumpStarted = false;

  function startPumpingEvents(): void {
    if (eventsPumpStarted) return;
    if (!underlying) return;
    if (!consumerRequestedIteration) return;
    eventsPumpStarted = true;
    const handle = underlying;
    void (async () => {
      try {
        for await (const event of handle) {
          queue.push(event);
        }
        queue.complete();
      } catch (error) {
        queue.fail(error);
      }
    })();
  }

  function watchResult(handle: AgentRun<O, H>): void {
    void handle.result().then(
      (result) => {
        state = 'terminal';
        settleResult(result);
      },
      (error: unknown) => {
        // `AgentRun.result()` is documented to always resolve, even on
        // abort or error (the terminal `RunResult` carries `.error`) — but
        // that's a contract only `createAgentRun`-produced handles are
        // guaranteed to uphold. A third-party `RunnableAgent` whose `result()`
        // rejects instead would otherwise leave this wrapper's `resultPromise`
        // pending forever; fold it into the same synthetic-result shape.
        state = 'terminal';
        settleResult({
          conversation: buildFallbackConversation(input),
          steps: [],
          content: '',
          usage: zeroUsage(),
          finishReason: 'error',
          error: toAgentRunError(error, { kind: 'contract' }),
        });
      },
    );
  }

  void (async () => {
    let agent: RunnableAgent<O, H>;
    try {
      agent = await resolveAgent();
    } catch (cause) {
      // `resolveAgent` (the shared loader cache's `resolve()`) always
      // rejects with an `AsyncDefinitionLoadError` already — it wraps every
      // loader failure before this catch ever sees it. `toAgentRunError`
      // passes an already-`AgentRunError` value through unchanged, so this
      // is just a type-safe way to hand `finalizeSynthetic` the error
      // without asserting a specific subclass here. `finalizeSynthetic` is
      // itself a no-op once `state` is already `'terminal'` (an abort that
      // settled while this load was in flight), so no explicit guard is
      // needed here.
      finalizeSynthetic(
        toAgentRunError(cause, { kind: 'load', code: 'LOAD_FAILED' }),
        'error',
        false,
      );
      return;
    }

    // An abort that arrived while `resolveAgent()` was in flight already
    // settled this run synthetically (see `requestAbort`) — do not start the
    // underlying agent at all.
    if (isTerminal()) return;

    if (!isRunnableAgent(agent)) {
      finalizeSynthetic(
        new AgentContractError(
          `Lazy agent "${label}" resolved to a value without a callable run() method`,
          agent,
        ),
        'error',
        false,
      );
      return;
    }

    let handle: AgentRun<O, H>;
    try {
      handle = agent.run(input, context);
    } catch (cause) {
      finalizeSynthetic(
        new AgentContractError(`Lazy agent "${label}" threw synchronously from run()`, cause),
        'error',
        false,
      );
      return;
    }

    if (!isValidAgentRunHandle(handle)) {
      finalizeSynthetic(
        new AgentContractError(`Lazy agent "${label}" returned an invalid run handle`, handle),
        'error',
        false,
      );
      return;
    }

    // Store the handle and flip to 'started' BEFORE any later `abort()` call
    // can be forwarded — the "resolution wins" half of the required race
    // behavior. The "abort wins" half is the `state === 'terminal'` check
    // above, which runs first and returns without ever calling
    // `agent.run()`. From this point, `requestAbort` sees `state ===
    // 'started'` and forwards directly to `underlying`, exactly once
    // (guarded by `abortForwarded`).
    underlying = handle;
    state = 'started';

    watchResult(handle);
    startPumpingEvents();
  })();

  const publicHandle = {
    result(): Promise<RunResult<O, H>> {
      return resultPromise;
    },

    unwrap(): Promise<UnwrappedValue<O, H>> {
      return resultPromise.then((result) => {
        if (underlying) return underlying.unwrap();
        // A result with no `underlying` only ever comes from
        // `finalizeSynthetic`, which never produces `finishReason:
        // 'stop-condition'` — there is no successful value to unwrap here.
        throw result.error;
      });
    },

    output(): Promise<O> {
      return resultPromise.then((result) => {
        if (underlying) {
          const underlyingOutput = (underlying as unknown as { output?: () => Promise<O> }).output;
          if (typeof underlyingOutput === 'function') {
            return underlyingOutput.call(underlying);
          }
          throw new AgentContractError(
            `Lazy agent "${label}" has no output() accessor for this run`,
          );
        }
        // Same reasoning as `unwrap()` above: no `underlying` means this
        // result came from `finalizeSynthetic`, which never succeeds.
        throw result.error;
      });
    },

    abort(reason?: string): void {
      requestAbort(reason);
    },

    [Symbol.dispose](): void {
      if (underlying) {
        underlying[Symbol.dispose]();
        return;
      }
      requestAbort(abortReason);
    },

    [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
      consumerRequestedIteration = true;
      // No-ops until `underlying` exists — the "waiting" window's events
      // still arrive via `finalizeSynthetic`/queue.push directly.
      startPumpingEvents();
      return queue[Symbol.asyncIterator]();
    },
    // `output()` is defined unconditionally at runtime — whether the
    // underlying agent actually has an `output` schema isn't known until it
    // resolves. `OutputMethod<O, H>` (a conditional type on the generic `H`)
    // hides it at the type level for `H = false`, matching the same
    // single-cast pattern `agent-run.ts`'s `createAgentRun` uses for the
    // same reason: TypeScript can't resolve a conditional intersection
    // against an unresolved generic `H`.
  } as AgentRun<O, H>;

  return publicHandle;
}

// ---------------------------------------------------------------------------
// createLazyAgent — the public factory
// ---------------------------------------------------------------------------

type LazyAgentState<O, H extends boolean> =
  | { kind: 'unloaded' }
  | { kind: 'loading'; pending: Promise<RunnableAgent<O, H>> }
  | { kind: 'loaded'; agent: RunnableAgent<O, H> };

/**
 * Lazily loads and memoizes a `RunnableAgent`, sharing its first load across
 * concurrent calls and returning `RunnableAgent<O, H>` itself — the same
 * shape as an eagerly-constructed agent, so it slots into an
 * `AgentDefinitions` map (AB-22) without unwrapping.
 *
 * `run()` is always synchronous, even while the underlying agent is still
 * loading: it returns an `AgentRun` handle immediately, buffering any events
 * emitted once loading completes and the underlying agent starts.
 */
export function createLazyAgent<O = never, H extends boolean = false>(
  loader: LazyAgentLoader<O, H>,
  options: CreateLazyAgentOptions = {},
): RunnableAgent<O, H> {
  const label = options.label ?? 'anonymous';
  let state: LazyAgentState<O, H> = { kind: 'unloaded' };

  function resolve(): Promise<RunnableAgent<O, H>> {
    if (state.kind === 'loaded') return Promise.resolve(state.agent);
    if (state.kind === 'loading') return state.pending;

    const pending = (async () => {
      try {
        return await loader();
      } catch (cause) {
        throw new AsyncDefinitionLoadError(
          'LOAD_FAILED',
          `Failed to load lazy agent "${label}"`,
          cause,
        );
      }
    })();

    state = { kind: 'loading', pending };
    void pending.then(
      (agent) => {
        if (state.kind === 'loading' && state.pending === pending) {
          state = { kind: 'loaded', agent };
        }
      },
      () => {
        if (state.kind === 'loading' && state.pending === pending) {
          state = { kind: 'unloaded' };
        }
      },
    );
    return pending;
  }

  const resolveRunOptions: ResolveRunOptions = async (input, context) => {
    const agent = await resolve();
    // Validate the same contract `run()` does — a `null`/non-object load
    // result would otherwise throw a raw `TypeError` here instead of the
    // promised `AgentContractError`, and an object exposing the resolver
    // symbol but no callable `run()` isn't a `RunnableAgent` at all.
    if (!isRunnableAgent(agent)) {
      throw new AgentContractError(
        `Lazy agent "${label}" resolved to a value without a callable run() method`,
        agent,
      );
    }
    // `RunnableAgent` doesn't itself declare the definition-resolution
    // symbol — it's an optional, private capability (`runnable-agent.ts`).
    // The cast only widens what we look for; `typeof resolver !== 'function'`
    // below is the actual runtime guard.
    const definitionResolvingAgent = agent as RunnableAgent<O, H> & DefinitionResolvingAgent;
    const resolver = definitionResolvingAgent[OPERATIVE_RESOLVE_RUN_OPTIONS];
    if (typeof resolver !== 'function') {
      throw new AgentContractError(`Lazy agent "${label}" does not support definition resolution`);
    }
    // Invoke through the object, not as a bare extracted function, so a
    // resolver implemented as a method that reads instance state via `this`
    // (a custom `DefinitionResolvingAgent`, not necessarily `createAgent`'s
    // own arrow-function implementation) still gets `agent` as its receiver.
    return definitionResolvingAgent[OPERATIVE_RESOLVE_RUN_OPTIONS]!(input, context);
  };

  const agent = {
    name: options.label ?? '(lazy)',
    run(input: AgentInput, context?: AgentRunContext): AgentRun<O, H> {
      return createDeferredAgentRun(resolve, input, context, label);
    },
    [OPERATIVE_RESOLVE_RUN_OPTIONS]: resolveRunOptions,
  };

  return agent;
}
