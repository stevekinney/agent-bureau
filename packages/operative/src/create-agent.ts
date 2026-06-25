import type { Tool } from 'armorer';
import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

import { createRun } from './create-run';
import type {
  ContextManagementOptions,
  GenerateFunction,
  OperativeExecuteOptions,
  RetryOptions,
  RunOptions,
  RunResult,
  StopCondition,
} from './types';

// ---------------------------------------------------------------------------
// AgentRun — the non-thenable run handle (B1 spec)
//
// Distinct from `ActiveRun` (which has `result` as a plain Promise property).
// `AgentRun` exposes `result()` as a METHOD — this is load-bearing: a thenable
// auto-unwraps at every `async` boundary, destroying the event stream.
//
// Behavior contract (from plan.md B1 ACCEPTANCE):
//   (a) iterate-then-result() returns the cached terminal value without re-running
//   (b) result() is idempotent (callable before/after/without iteration)
//   (c) the async iterator is independent of result-resolution state
// ---------------------------------------------------------------------------

/**
 * The run event emitted by an agent run while iterating.
 * Structural placeholder; the full event union lives in `events.ts`.
 */
export interface RunEvent {
  readonly type: string;
}

/**
 * The handle returned by `createAgent(...).run(input)`.
 *
 * - Extends `AsyncIterable<RunEvent>` — iterate with `for await`
 * - NOT a `Promise`/`PromiseLike` — access the result via `.result()` only
 * - Abortable via `.abort(reason?)`
 * - Disposable via `[Symbol.dispose]()`
 *
 * The non-thenable design is deliberate: a thenable handle is auto-unwrapped
 * at every `async` boundary (`return run`, `Promise.all([run])`, etc.) and
 * destroys the event stream. One extra method call (`.result()`) prevents
 * the AWS-SDK-v3 / tRPC footgun.
 */
export interface AgentRun extends AsyncIterable<RunEvent> {
  /**
   * Get the terminal result. Caches after first resolution — idempotent
   * whether called before, after, or without iteration.
   */
  result(): Promise<RunResult>;
  /** Abort the in-flight run. Fires the abort signal immediately. */
  abort(reason?: string): void;
  /** Dispose the handle; releases internal resources and aborts the run. */
  [Symbol.dispose](): void;
}

// ---------------------------------------------------------------------------
// CreateAgentOptions — the options bag
//
// `generate` is REQUIRED here (no bureau to inherit a provider from).
// `tools` is a name-keyed map: the map KEY is canonical, not the tool's
// inner `.name` (map-form avoids the `.name`-disagreement authoring bug).
// ---------------------------------------------------------------------------

/**
 * Options for `createAgent({...})`. Distinct from the old `DefineAgentOptions`
 * (which requires a `toolbox`). Here `tools` is a name-keyed map and `generate`
 * is unconditionally required — there is no bureau to inherit a provider from.
 */
export interface CreateAgentOptions {
  /**
   * The LLM provider function. REQUIRED — no bureau to inherit from.
   * Receives a `GenerateContext` and returns a `GenerateResponse`.
   */
  generate: GenerateFunction;

  /**
   * Agent tools as a name-keyed map. The map key is the canonical tool name;
   * the tool's own `.name` property is ignored (key wins). Optional — an
   * agent with no tools is valid for pure-generation tasks.
   */
  tools?: Record<string, Tool>;

  /**
   * System instructions injected as a system message on step 0.
   * Prepended to every run started by this agent.
   */
  instructions?: string;

  /** Stop conditions checked after each step. */
  stopWhen?: StopCondition | StopCondition[];

  /** Hard cap on the number of steps before the loop exits. */
  maximumSteps?: number;

  /** Options forwarded to toolbox.execute() within the loop. */
  executeOptions?: OperativeExecuteOptions;

  /** Retry configuration for transient generate failures. */
  retry?: RetryOptions;

  /** Context window management (compaction). */
  contextManagement?: ContextManagementOptions;
}

// ---------------------------------------------------------------------------
// createAgentRun — wraps ActiveRun in the AgentRun interface
// ---------------------------------------------------------------------------

/**
 * Wraps an `ActiveRun` (which has `result` as a Promise property) in the
 * `AgentRun` interface (which exposes `result()` as a method). The caching
 * contract is inherited from `ActiveRun` — the underlying Promise settles
 * exactly once.
 *
 * The async iterator re-emits ALL operative event types from `activeRun.events()`.
 * This is intentionally broad at this phase; Phase C will curate the subset.
 */
function createAgentRunHandle(activeRun: ReturnType<typeof createRun>): AgentRun {
  // Cache the result promise so result() is always the same Promise instance.
  // The ActiveRun.result is already a cached Promise (set once on construction).
  const resultPromise = activeRun.result;

  return {
    result(): Promise<RunResult> {
      return resultPromise;
    },

    abort(reason?: string): void {
      activeRun.abort(reason);
    },

    [Symbol.dispose](): void {
      activeRun[Symbol.dispose]();
    },

    [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
      // Use activeRun.toObservable() to get all operative events as a stream.
      // Phase C will curate and re-wrap these as typed RunEvents.
      const observable = activeRun.toObservable();

      // Convert the ObservableLike into an AsyncIterator backed by a queue.
      const queue: RunEvent[] = [];
      let pending: ((value: IteratorResult<RunEvent>) => void) | undefined;
      let done = false;

      const subscription = observable.subscribe(
        (event) => {
          const runEvent: RunEvent = { type: event.type };
          if (pending) {
            const r = pending;
            pending = undefined;
            r({ value: runEvent, done: false });
          } else {
            queue.push(runEvent);
          }
        },
        undefined,
        () => {
          done = true;
          if (pending) {
            const r = pending;
            pending = undefined;
            r({ value: undefined as unknown as RunEvent, done: true });
          }
        },
      );

      return {
        next(): Promise<IteratorResult<RunEvent>> {
          if (queue.length > 0) {
            // queue is non-empty — shift is safe
            return Promise.resolve({ value: queue.shift() as RunEvent, done: false });
          }
          if (done) {
            subscription.unsubscribe();
            return Promise.resolve({ value: undefined as unknown as RunEvent, done: true });
          }
          return new Promise((resolve) => {
            pending = resolve;
          });
        },
        return(): Promise<IteratorResult<RunEvent>> {
          done = true;
          subscription.unsubscribe();
          if (pending) {
            const r = pending;
            pending = undefined;
            r({ value: undefined as unknown as RunEvent, done: true });
          }
          return Promise.resolve({ value: undefined as unknown as RunEvent, done: true });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// StandaloneAgent — the runtime agent returned by createAgent()
//
// NOT an `AgentBuilder<TBureauTools, TAgentTools>` — that's the TYPE-LEVEL
// declaration in bureau-types.ts. The runtime object just needs `.run()`.
// ---------------------------------------------------------------------------

/**
 * The runtime agent returned by `createAgent({...})`. Bureau-less, in-memory
 * only. Calling `.run(input)` starts a new ephemeral run each time.
 */
export interface StandaloneAgent {
  /**
   * Start a new in-memory run with the given user input.
   * Returns an `AgentRun` handle — NOT a Promise (non-thenable by design).
   * Access the result via `handle.result()`.
   */
  run(input: string): AgentRun;
}

// ---------------------------------------------------------------------------
// createAgent — the public factory
// ---------------------------------------------------------------------------

/**
 * Creates a standalone, bureau-less agent. `generate` is required — there is
 * no bureau to inherit a provider from. Runs are in-memory and ephemeral;
 * there is no durability, no session, no shared memory.
 *
 * For bureau-owned agents (with shared tools, hooks, memory, and durability),
 * use `bureau.agent({...})` instead (Phase E).
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   generate: myProvider,
 *   instructions: 'You are a research assistant.',
 *   tools: { search: searchTool },
 * });
 *
 * const run = agent.run('Summarize the Q3 report.');
 * for await (const event of run) { ... }  // iterate, OR
 * const result = await run.result();       // await — same handle
 * ```
 */
export function createAgent(options: CreateAgentOptions): StandaloneAgent {
  const { generate, tools = {}, instructions, ...rest } = options;

  // Build a Toolbox from the name-keyed tool map.
  // The map key is canonical; for now we take the tool values as-is.
  // Phase B4 will enforce key-wins-over-tool.name at the builder level.
  const toolEntries = Object.values(tools);
  const toolbox = createToolbox(toolEntries);

  return {
    run(input: string): AgentRun {
      // Build a fresh Conversation for each run (ephemeral — no session state).
      const conversation = new Conversation();

      if (instructions) {
        conversation.appendSystemMessage(instructions);
      }
      conversation.appendUserMessage(input);

      const runOptions: RunOptions = {
        generate,
        toolbox,
        conversation,
        ...rest,
      };

      const activeRun = createRun(runOptions);
      return createAgentRunHandle(activeRun);
    },
  };
}
