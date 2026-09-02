/**
 * `RunnableAgent` — the type-preserving agent contract (AB-15, AB-21).
 *
 * Every entry point that starts a run — a `createAgent`-produced agent, a
 * `createLazyAgent`-produced agent, and (eventually) `Bureau.run`, AB-22) —
 * accepts the same `AgentInput` and `AgentRunContext` shapes and returns the
 * same non-thenable `AgentRun` handle. This file defines that shared
 * contract; `create-lazy-agent.ts` is its lazy-loading implementation.
 */

import type { ConversationHistory } from 'conversationalist';

import type { AgentRun, RunEvent } from './agent-run';
import type { ChildRunRegistry } from './child-run';
import type { RunOptions } from './types';

export type { RunEvent };

/**
 * Input accepted by every `RunnableAgent.run()` call. A bare string starts a
 * fresh conversation. `{ conversation }` resumes from an existing
 * `ConversationHistory` and is snapshotted (cloned) before the run begins,
 * so the run's state and the caller's object are independent from the
 * moment `run()` is called.
 */
export type AgentInput = string | { conversation: ConversationHistory };

/**
 * Per-run context accepted alongside `AgentInput`. `agentName` is for a
 * `RunnableAgent` invoked outside a named registry (a standalone agent, or a
 * `createLazyAgent` agent resolved and run directly) that still wants its
 * identity stamped on curated `tool.*` events.
 */
export interface AgentRunContext {
  signal?: AbortSignal;
  traceContext?: unknown;
  withTraceContext?: <T>(parentContext: unknown, fn: () => Promise<T>) => Promise<T>;
  agentName?: string;
  /**
   * AB-50 — backs the returned `AgentRun`'s `children()`/`abortChild()`.
   * Opt-in: supply the same registry to every `createSubagentTool` this run
   * may dispatch through (its `parentContext.registry`) to make this run's
   * children discoverable. See `child-run.ts`'s module docs for why this
   * can't be wired automatically from `run()` alone.
   */
  childRegistry?: ChildRunRegistry;
}

/**
 * A type-preserving, synchronously-starting agent. `O` is the agent's
 * validated output type (`never` when the agent has no `output` schema); `H`
 * ("has output") tracks, at the type level, whether an `output` schema was
 * supplied at all.
 *
 * `run()` is synchronous — it always returns an `AgentRun` immediately,
 * never a `Promise<AgentRun>`, regardless of whether the agent itself was
 * produced lazily (see `createLazyAgent`).
 */
export interface RunnableAgent<O = never, H extends boolean = false> {
  readonly name: string;
  run(input: AgentInput, context?: AgentRunContext): AgentRun<O, H>;
}

// ---------------------------------------------------------------------------
// Definition-resolution protocol
//
// Private and unstable. Not part of the public `RunnableAgent` contract —
// an agent that doesn't support durable execution simply omits it, and
// `createLazyAgent` forwards it only when the resolved agent exposes it.
// It exists so a durable engine (Bureau, AB-22) can resolve the SAME
// `RunOptions` bag a `RunnableAgent.run()` call would build and drive it
// through `createActiveRun(options, durable)` directly, instead of being
// limited to the opaque, process-local `run()` handle — the "opaque
// in-memory run" problem the old `RegistryAgent.run(): Promise<unknown>`
// shape had no answer for.
// ---------------------------------------------------------------------------

/**
 * Symbol key for the definition-resolution protocol. `Symbol.for` (a
 * registry symbol, not `Symbol()`) so it identifies consistently across
 * package instances — durable Bureau code in a different package must be
 * able to find the exact same key operative attaches it under.
 *
 * @internal
 */
export const OPERATIVE_RESOLVE_RUN_OPTIONS: unique symbol = Symbol.for(
  '@lostgradient/operative/resolve-run-options',
);

/**
 * Resolves the `RunOptions` bag a `RunnableAgent.run(input, context)` call
 * would hand to `createActiveRun` — without starting an in-memory run.
 *
 * @internal
 */
export type ResolveRunOptions = (
  input: AgentInput,
  context?: AgentRunContext,
) => Promise<RunOptions>;

/**
 * Optional capability a `RunnableAgent` may expose alongside `run`. Present
 * on agents created with `createAgent`; forwarded transparently by
 * `createLazyAgent` when the resolved agent exposes it.
 *
 * @internal
 */
export interface DefinitionResolvingAgent {
  readonly [OPERATIVE_RESOLVE_RUN_OPTIONS]?: ResolveRunOptions;
}
