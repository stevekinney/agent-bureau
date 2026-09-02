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
import type { AgentRunError } from './errors';
import { AbortAgentRunError, AgentContractError, AsyncDefinitionLoadError } from './errors';
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

const EMPTY_USAGE: TokenUsage = { prompt: 0, completion: 0, total: 0 };

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

/** Validates the shape `AgentRun` promises: `result`, `abort`, iteration, and disposal. */
function isValidAgentRunHandle(value: unknown): value is AgentRun<unknown, boolean> {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<PropertyKey, unknown>;
  return (
    isCallable(candidate['result']) &&
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
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as RunEvent, done: true });
          }
          return new Promise<IteratorResult<RunEvent>>((resolve, reject) => {
            waitResolve = resolve;
            waitReject = reject;
          });
        },
        return(): Promise<IteratorResult<RunEvent>> {
          done = true;
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
  input: AgentInput,
  context: AgentRunContext | undefined,
  label: string,
): AgentRun<O, H> {
  type PerRunState = 'waiting' | 'started' | 'terminal';
  let state: PerRunState = 'waiting';
  let underlying: AgentRun<O, H> | undefined;
  let skipStart = false;
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
      usage: EMPTY_USAGE,
      finishReason,
      error,
    } as RunResult<O, H>;
    if (isAbort) {
      queue.push(new RunAbortedEvent(0, conversation, error, EMPTY_USAGE, undefined, abortReason));
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
      skipStart = true;
      return;
    }
    // state === 'started'
    if (underlying && !abortForwarded) {
      abortForwarded = true;
      underlying.abort(reason);
    }
  }

  const signal = context?.signal;
  if (signal) {
    if (signal.aborted) {
      requestAbort(typeof signal.reason === 'string' ? signal.reason : undefined);
    } else {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort);
        requestAbort(typeof signal.reason === 'string' ? signal.reason : undefined);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  function pump(handle: AgentRun<O, H>): void {
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

    void handle.result().then((result) => {
      settleResult(result);
      state = 'terminal';
    });
  }

  void (async () => {
    let agent: RunnableAgent<O, H>;
    try {
      agent = await resolveAgent();
    } catch (cause) {
      const error =
        cause instanceof AsyncDefinitionLoadError
          ? cause
          : new AsyncDefinitionLoadError(
              'LOAD_FAILED',
              `Failed to load lazy agent "${label}"`,
              cause,
            );
      finalizeSynthetic(error, 'error', false);
      return;
    }

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

    if (skipStart) {
      finalizeSynthetic(
        new AbortAgentRunError('The agent run was aborted while loading a lazy agent', abortReason),
        'aborted',
        true,
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
    // behavior. The "abort wins" half is the `skipStart` check above, which
    // runs first and returns without ever calling `agent.run()`. From this
    // point, `requestAbort` sees `state === 'started'` and forwards directly
    // to `underlying`, exactly once (guarded by `abortForwarded`).
    underlying = handle;
    state = 'started';

    pump(handle);
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
    // `RunnableAgent` doesn't itself declare the definition-resolution
    // symbol — it's an optional, private capability (`runnable-agent.ts`).
    // The cast only widens what we look for; `typeof resolver !== 'function'`
    // below is the actual runtime guard.
    const resolver = (agent as RunnableAgent<O, H> & DefinitionResolvingAgent)[
      OPERATIVE_RESOLVE_RUN_OPTIONS
    ];
    if (typeof resolver !== 'function') {
      throw new AgentContractError(`Lazy agent "${label}" does not support definition resolution`);
    }
    return resolver(input, context);
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
