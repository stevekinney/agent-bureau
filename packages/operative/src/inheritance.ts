/**
 * Uniform inheritance mechanism — per-axis combine functions.
 *
 * Each function in this module encodes one inheritance axis from architecture.md:
 *
 * | Axis     | Rule                                                     |
 * |----------|----------------------------------------------------------|
 * | Tools    | ∪ — agent extends bureau toolset; agent wins on conflict |
 * | Provider | override — agent's generate overrides bureau's           |
 * | Hooks    | bureau-first, additive-only — agent cannot suppress      |
 * | Memory   | merged-read / private-write                              |
 * | Identity | layered — both render, bureau-first (ordered injection)  |
 *
 * These are pure functions consumed by Phase E (bureau package) when
 * composing an agent's effective configuration. No runtime coupling to
 * the bureau exists here — operative stays bureau-agnostic.
 */

import type { JSONValue } from '@lostgradient/tool-protocol';
import type { AnyToolbox } from 'armorer';
import { combineToolboxes } from 'armorer';

import type { MemoryLike } from './create-memory-bridge';
import type { GenerateFunction, PrepareStepHook } from './types';

// ---------------------------------------------------------------------------
// Tools — union (∪)
// ---------------------------------------------------------------------------

/**
 * Combines a bureau toolbox and an agent toolbox into a single merged toolbox.
 *
 * The agent's tools win on name collision (last-writer-wins semantics from
 * `combineToolboxes`). Either argument may be `undefined`; when both are
 * undefined, returns `undefined`.
 *
 * @example
 * ```ts
 * const effective = combineTools(bureauToolbox, agentToolbox);
 * // effective contains all bureau tools ∪ agent tools
 * ```
 */
export function combineTools(
  bureauTools: AnyToolbox | undefined,
  agentTools: AnyToolbox | undefined,
): AnyToolbox | undefined {
  if (bureauTools && agentTools) {
    return combineToolboxes(bureauTools, agentTools);
  }
  return bureauTools ?? agentTools;
}

// ---------------------------------------------------------------------------
// Provider — override
// ---------------------------------------------------------------------------

/**
 * Selects the effective `GenerateFunction`. The agent's provider overrides
 * the bureau's; the bureau's is the fallback when the agent has no provider.
 *
 * @example
 * ```ts
 * const generate = combineProvider(bureauGenerate, agentGenerate);
 * // agentGenerate wins when present; bureauGenerate is the fallback
 * ```
 */
export function combineProvider(
  bureauProvider: GenerateFunction | undefined,
  agentProvider: GenerateFunction | undefined,
): GenerateFunction | undefined {
  return agentProvider ?? bureauProvider;
}

// ---------------------------------------------------------------------------
// Hooks — bureau-first, additive-only
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The hooks axis used to live here as `combineHooks` (bureau-first,
// additive-only). It is gone (COR-1268).
//
// It composed the `Hook | Hook[]` shape the `RunOptions` hook arrays used, and
// that shape no longer exists — `HookRegistry` is the only hook surface on a
// run. It also never had a production caller: the axis it documented was real,
// but nothing wired it up.
//
// The rule itself is preserved, not dropped. `mergeHookRegistries(bureau,
// agent, direct)` composes the tiers in that order, and Bureau's invariants
// additionally pin themselves first or last per dispatch shape so a lower tier
// cannot pre-empt or post-empt them (COR-1265). Re-adding a second mechanism
// here would give the same rule two implementations to disagree about.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Memory — merged-read / private-write
// ---------------------------------------------------------------------------

/**
 * The configuration for one side of the memory axis.
 * @internal
 */
interface MemorySide {
  /** The memory instance to read from or write to. */
  memory: MemoryLike;
  /** The namespace that this side writes to. */
  namespace?: string | undefined;
}

/**
 * Creates a merged-read / private-write `MemoryLike` from bureau and agent memory.
 *
 * - **`recall(q)`** searches **agent namespace ∪ bureau namespace**, merges and
 *   re-ranks results by score (descending).
 * - **`remember(y)`** writes to the **agent's private** namespace only.
 *
 * Rationale (architecture.md): a shared pool any agent can write is a
 * fleet-wide mutable namespace — one bad memory poisons everyone's recall.
 * Benefit-on-read; isolate-on-write; promote-on-purpose.
 *
 * When either side is undefined, the other side's memory is returned as-is
 * (no merging needed).
 *
 * @example
 * ```ts
 * const memory = combineMemory(
 *   { memory: bureauMemory, namespace: 'bureau-global' },
 *   { memory: agentMemory, namespace: 'researcher' },
 * );
 * // memory.recall('query') searches both namespaces
 * // memory.remember('fact') writes only to 'researcher'
 * ```
 */
export function combineMemory(
  bureau: MemorySide | undefined,
  agent: MemorySide | undefined,
): MemoryLike | undefined {
  if (!bureau && !agent) return undefined;
  if (!bureau) return agent!.memory;
  if (!agent) return bureau.memory;

  const { memory: bureauMemory, namespace: bureauNamespace } = bureau;
  const { memory: agentMemory, namespace: agentNamespace } = agent;

  const merged: MemoryLike = {
    /** Write only to the agent's private namespace. */
    async remember(content, metadata) {
      return agentMemory.remember(content, metadata);
    },

    /** Recall from agent namespace first, then bureau namespace; merge and rank. */
    async recall(query, options) {
      const limit = options?.limit ?? 5;

      const [agentResults, bureauResults] = await Promise.all([
        agentMemory.recall(query, {
          ...options,
          ...(agentNamespace === undefined ? {} : { namespace: agentNamespace }),
          limit,
        }),
        bureauMemory.recall(query, {
          ...options,
          ...(bureauNamespace === undefined ? {} : { namespace: bureauNamespace }),
          limit,
        }),
      ]);

      // Merge and sort by score descending; deduplicate by content.
      const seen = new Set<string>();
      const combined: ReadonlyArray<{ content: string; score: number }> = [
        ...agentResults,
        ...bureauResults,
      ]
        .filter((r) => {
          if (seen.has(r.content)) return false;
          seen.add(r.content);
          return true;
        })
        .toSorted((a, b) => b.score - a.score)
        .slice(0, limit);

      return combined;
    },
  };

  return merged;
}

// ---------------------------------------------------------------------------
// Identity — layered, bureau-first (ordered injection)
// ---------------------------------------------------------------------------

/**
 * Options for building one identity layer.
 * @internal
 */
interface IdentityLayer {
  /**
   * Pre-bound resolver for this layer's identity string.
   * Returns the prose persona string to inject as a system message.
   */
  resolve: () => Promise<string>;
}

/**
 * Combines bureau and agent identity into a layered `PrepareStepHook`.
 *
 * Identity is NOT merged or concatenated into a single string — it is
 * **layered injection** (two system messages, bureau-first). The bureau
 * persona frames ("you are a Lost Gradient agent, you speak like X"); the
 * agent persona specializes ("...you are the researcher; meticulous, cite
 * sources"). Do NOT design a persona-merge function — it is ordered injection
 * of both, via the existing hook mechanism.
 *
 * The returned hook:
 * 1. Only fires on step 0 (idempotent — checks `_identityInjected` metadata).
 * 2. Appends bureau identity first (when present), then agent identity.
 * 3. Degrades gracefully on resolve errors — logs a warning, never throws.
 *
 * When only one side is present, a single-layer hook is returned.
 * When neither is present, returns `undefined`.
 *
 * @example
 * ```ts
 * const hook = combineIdentity(
 *   { resolve: () => bureauPersona.resolve() },
 *   { resolve: () => agentPersona.resolve() },
 * );
 * // On step 0: injects bureau persona, then agent persona, as system messages
 * ```
 */
export function combineIdentity(
  bureauIdentity: IdentityLayer | undefined,
  agentIdentity: IdentityLayer | undefined,
  options: { warn?: ((message: string) => void) | undefined } = {},
): PrepareStepHook | undefined {
  const warn = options.warn ?? console.warn;

  const layers: IdentityLayer[] = [];
  if (bureauIdentity) layers.push(bureauIdentity);
  if (agentIdentity) layers.push(agentIdentity);

  if (layers.length === 0) return undefined;

  /**
   * The combined PrepareStepHook. Injects all identity layers as system
   * messages on step 0, bureau-first.
   */
  const hook: PrepareStepHook = async (context) => {
    // Only inject on step 0.
    if (context.step !== 0) return;

    // Idempotency: if any identity was already injected, skip.
    // (handles reuse of the same hook across multiple run() calls)
    const alreadyInjected = context.conversation
      .getMessages()
      .some((message) => message.metadata && '_identityInjected' in message.metadata);
    if (alreadyInjected) return;

    for (const layer of layers) {
      try {
        const identity = await layer.resolve();
        if (identity && identity.length > 0) {
          // Mark only the first injection to satisfy the idempotency check on
          // subsequent hook calls; later layers in the same run do not need the
          // marker (the first one stops re-injection).
          const metadata: Record<string, JSONValue> = {};
          if (layer === layers[0]) {
            metadata['_identityInjected'] = true;
          }
          context.conversation.appendSystemMessage(identity, metadata);
        }
      } catch (error) {
        warn(`Identity resolution failed for a layer, proceeding: ${String(error)}`);
      }
    }
  };

  return hook;
}

// ---------------------------------------------------------------------------
// Re-export types consumers need from this module
// ---------------------------------------------------------------------------

export type { IdentityLayer as IdentityInheritanceLayer, MemorySide as MemoryInheritanceSide };
