/**
 * createBureau — the runtime implementation of the bureau builder.
 *
 * The type-level machinery (BureauBuilder, BureauTools, AgentNameFor, etc.)
 * lives in operative/src/bureau-types.ts and is imported here as type imports.
 * This file provides the runtime object that satisfies those types.
 *
 * Three registration tiers (all do the same thing — widen Bureau<table>):
 *
 *   Tier 1 — createBureau({ agents })   construction-time object seed
 *   Tier 2 — bureau.agent({ name })     chained accretion (return MUST be captured)
 *   Tier 3 — bureau.run<TExtra>(name)   per-call widening for dynamic/runtime names
 *
 * The chain is on the BUREAU, not the agent (architecture.md §"The chain is on
 * the BUREAU"). The agent is an options bag. Each .agent() returns a wider
 * builder type — callers must reassign to preserve the widening:
 *
 *   const b2 = b1.agent({ name: 'editor' }); // ← MUST capture
 *   b2.run('editor', input);                  // ✓
 *   b2.run('researcher', input);              // ✓ (static agents preserved)
 *
 * Runtime structure:
 *   A `BureauState` object holds all mutable configuration (tools, generate,
 *   hooks, agents map, skills provider). It is SHARED across all builder
 *   objects returned by a chain — they reference the same state.
 *
 *   Each `.tools()` / `.agent()` call mutates `state` in place and returns
 *   a new builder *handle* (same runtime state, wider TS type). This is safe
 *   because the builder is used in a linear setup phase, not concurrently.
 *
 *   The `agents` Map stores the resolved `AgentSpec` for each registered
 *   name. When `run('name', input)` is called, the spec is looked up, merged
 *   with bureau defaults, and an `AgentRun` is produced via `createActiveRun`.
 */

import type { Tool, Toolbox } from 'armorer';
import { combineToolboxes, createToolbox, isTool } from 'armorer';
import { Conversation } from 'conversationalist';
import type { AgentRun, GenerateFunction, PrepareStepHook, RunOptions } from 'operative';
import { createActiveRun, createAgentRun } from 'operative';
import type {
  AgentNameFor,
  AgentOptions,
  AgentTable,
  BureauAgentsInput,
  BureauBuilder,
  NormalizeAgents,
  SkillPolicy,
  SkillProviderLike,
  ToolMap,
  ToolMapInput,
} from 'operative/bureau-types';

// ---------------------------------------------------------------------------
// Internal runtime types
// ---------------------------------------------------------------------------

/**
 * Resolved configuration for a single registered agent. Stored in the
 * bureau's `agents` Map after Tier-1 or Tier-2 registration.
 */
interface AgentSpec {
  readonly name: string;
  readonly instructions?: string;
  readonly generate?: GenerateFunction;
  readonly hooks?: PrepareStepHook | PrepareStepHook[];
  /** Agent-level toolbox built from the agent's own tools map. */
  readonly toolbox?: Toolbox;
  /** Per-agent skill filtering policy. */
  readonly skillPolicy?: SkillPolicy;
}

/**
 * Mutable runtime state shared across all handles produced by a bureau chain.
 * Type params only exist at the TypeScript level; at runtime we use plain maps.
 */
interface BureauState {
  /** The bureau-level toolbox (from accumulated `.tools()` calls). */
  bureauToolbox: Toolbox | undefined;
  /** The bureau's default generate function. */
  bureauGenerate: GenerateFunction | undefined;
  /** Bureau-level prepare-step hooks (run for every agent, bureau-first). */
  bureauHooks: PrepareStepHook[];
  /** Registered agents by name. */
  agents: Map<string, AgentSpec>;
  /** Skill provider attached via `.skills()`. */
  skillProvider: SkillProviderLike | undefined;
  /** Bureau-level skill policy. */
  skillPolicy: SkillPolicy | undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a `Toolbox` from a name-keyed tool map. The map key is canonical;
 * each tool's inner `.name` property is overridden by the key.
 *
 * At runtime, values must be armorer `Tool` objects (created via `createTool`).
 * The `ToolMapInput` type in bureau-types.ts is a TYPE-LEVEL phantom for
 * inference — at runtime, only proper armorer Tools are accepted.
 *
 * Note: if a tool's canonical `.name` differs from the map key, the MAP KEY
 * wins. Tools with a matching name are passed through directly; those with a
 * name mismatch are re-configured via `createToolbox` with a name-override entry.
 */
function toolboxFromMap(toolsMap: Record<string, unknown>): Toolbox {
  const entries: Array<Tool | ({ name: string } & Record<string, unknown>)> = [];

  for (const [key, value] of Object.entries(toolsMap)) {
    if (!isTool(value)) {
      throw new Error(
        `bureau.tools(): value at key "${key}" is not an armorer Tool. ` +
          `Create tools with createTool() from the armorer package.`,
      );
    }
    if (value.configuration.name === key) {
      // Name already matches the map key — pass directly.
      entries.push(value);
    } else {
      // Override the name: spread the tool configuration with the map key as name.
      entries.push({ ...value.configuration, name: key });
    }
  }

  // createToolbox accepts ToolboxEntry[] = (ToolConfiguration | Tool)[].
  // The spread entries are ToolConfiguration-shaped when the name was overridden.
  return createToolbox(entries as Parameters<typeof createToolbox>[0]);
}

/**
 * Merge a bureau toolbox and an agent toolbox. Agent tools win on name
 * collision (combineToolboxes last-writer-wins semantics). Returns undefined
 * when both are absent.
 */
function mergeToolboxes(
  bureau: Toolbox | undefined,
  agent: Toolbox | undefined,
): Toolbox | undefined {
  if (bureau && agent) {
    return combineToolboxes(bureau, agent) as unknown as Toolbox;
  }
  return bureau ?? agent;
}

/**
 * Combine bureau-level and agent-level prepare-step hooks in bureau-first
 * order. Returns undefined when neither side has hooks.
 */
function mergeHooks(
  bureauHooks: PrepareStepHook[],
  agentHooks: PrepareStepHook | PrepareStepHook[] | undefined,
): PrepareStepHook | PrepareStepHook[] | undefined {
  const agent: PrepareStepHook[] = agentHooks
    ? Array.isArray(agentHooks)
      ? agentHooks
      : [agentHooks]
    : [];
  const merged = [...bureauHooks, ...agent];
  return merged.length > 0 ? merged : undefined;
}

// ---------------------------------------------------------------------------
// Runtime bureau handle factory
// ---------------------------------------------------------------------------

/**
 * Creates a bureau handle that references `state`. All handles returned by
 * the same chain share one `state` object — mutations accumulate there.
 */
function makeBureauHandle<
  TTools extends ToolMap = Record<never, never>,
  TAgents extends AgentTable = Record<never, never>,
>(state: BureauState): BureauBuilder<TTools, TAgents> {
  const handle: BureauBuilder<TTools, TAgents> = {
    // ----- tools() --------------------------------------------------------

    tools<TNew extends ToolMapInput>(toolsMap: TNew) {
      const newToolbox = toolboxFromMap(toolsMap as Record<string, unknown>);
      if (state.bureauToolbox) {
        state.bureauToolbox = combineToolboxes(
          state.bureauToolbox,
          newToolbox,
        ) as unknown as Toolbox;
      } else {
        state.bureauToolbox = newToolbox;
      }
      return makeBureauHandle(state);
    },

    // ----- skills() -------------------------------------------------------

    skills(provider: SkillProviderLike, policy?: SkillPolicy): BureauBuilder<TTools, TAgents> {
      state.skillProvider = provider;
      state.skillPolicy = policy;
      return makeBureauHandle<TTools, TAgents>(state);
    },

    // ----- agent() --------------------------------------------------------

    agent<TName extends string>(options: AgentOptions & { name: TName }) {
      const { name, tools: agentToolsMap, instructions, skillPolicy } = options;
      // `generate` from AgentOptions is an `AgentGenerateFunction` (type alias).
      // At runtime it is structurally identical to `GenerateFunction`.
      const agentGenerate = options.generate as GenerateFunction | undefined;

      const agentToolbox =
        agentToolsMap && Object.keys(agentToolsMap).length > 0
          ? toolboxFromMap(agentToolsMap as Record<string, unknown>)
          : undefined;

      const spec: AgentSpec = {
        name,
        instructions,
        generate: agentGenerate,
        toolbox: agentToolbox,
        skillPolicy,
      };

      state.agents.set(name, spec);

      return makeBureauHandle(state);
    },

    // ----- run() ----------------------------------------------------------

    run<TExtra extends AgentTable = Record<never, never>>(
      name: AgentNameFor<TAgents, TExtra>,
      input: string,
    ): AgentRun {
      const specName = name as string;
      const spec = state.agents.get(specName);

      if (!spec) {
        throw new Error(
          `Bureau: no agent named "${specName}" is registered. ` +
            `Registered agents: [${[...state.agents.keys()].join(', ')}]`,
        );
      }

      // Provider: agent overrides bureau; bureau is the fallback.
      const effectiveGenerate = spec.generate ?? state.bureauGenerate;

      if (!effectiveGenerate) {
        throw new Error(
          `Bureau: agent "${specName}" has no generate function. ` +
            `Set one on the bureau (e.g. via a generate property) or supply one on the agent.`,
        );
      }

      // Toolbox: agent extends bureau (∪); agent wins on collision.
      const effectiveToolbox = mergeToolboxes(state.bureauToolbox, spec.toolbox);

      // Hooks: bureau-first, additive-only.
      const effectiveHooks = mergeHooks(state.bureauHooks, spec.hooks);

      // Build a fresh Conversation for this run (ephemeral per run).
      const conversation = new Conversation();
      if (spec.instructions) {
        conversation.appendSystemMessage(spec.instructions);
      }
      conversation.appendUserMessage(input);

      // RunOptions.toolbox is required; use an empty toolbox when no tools exist.
      // Cast needed: createToolbox([]) returns Toolbox<ToolsFromEntries<[]>> (a
      // concrete zero-length tuple type) which is not assignable to Toolbox<readonly Tool[]>
      // (the base type). The cast is safe — an empty toolbox is a valid Toolbox.
      const toolboxForRun: Toolbox = effectiveToolbox ?? (createToolbox([]) as unknown as Toolbox);

      const runOptions: RunOptions = {
        generate: effectiveGenerate,
        toolbox: toolboxForRun,
        conversation,
        ...(effectiveHooks ? { prepareStep: effectiveHooks } : {}),
      };

      const activeRun = createActiveRun(runOptions);
      return createAgentRun(activeRun);
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Creates a new bureau builder. Agents, tools, and configuration accumulate
 * via the returned builder's methods.
 *
 * **Three tiers of agent registration:**
 *
 * ```ts
 * // Tier 1 — construction-time object seed
 * const bureau = createBureau({
 *   agents: {
 *     researcher: { instructions: 'You are a research assistant.' },
 *     writer:     {},
 *   },
 * });
 *
 * // Tier 2 — chained accretion (return MUST be captured)
 * const bureau2 = bureau.agent({ name: 'editor' });
 * bureau2.run('editor', '...');
 * bureau2.run('researcher', '...'); // still typechecks
 *
 * // Tier 3 — per-call widening for dynamic/runtime agent names
 * import type { AgentTable } from 'bureau';
 * bureau2.run<AgentTable>('plugin-agent', '...');
 * ```
 */
export function createBureau<
  TAgentsInput extends BureauAgentsInput = Record<never, never>,
>(options?: {
  agents?: TAgentsInput;
}): BureauBuilder<Record<never, never>, NormalizeAgents<Record<never, never>, TAgentsInput>> {
  const state: BureauState = {
    bureauToolbox: undefined,
    bureauGenerate: undefined,
    bureauHooks: [],
    agents: new Map(),
    skillProvider: undefined,
    skillPolicy: undefined,
  };

  // Tier 1: seed agents from the construction-time map.
  if (options?.agents) {
    for (const [name, agentOptions] of Object.entries(options.agents)) {
      const { tools: agentToolsMap, instructions, skillPolicy } = agentOptions;
      // `generate` from AgentOptions is AgentGenerateFunction; structurally
      // identical to GenerateFunction at runtime.
      const agentGenerate = agentOptions.generate as GenerateFunction | undefined;

      const agentToolbox =
        agentToolsMap && Object.keys(agentToolsMap).length > 0
          ? toolboxFromMap(agentToolsMap as Record<string, unknown>)
          : undefined;

      state.agents.set(name, {
        name,
        instructions,
        generate: agentGenerate,
        toolbox: agentToolbox,
        skillPolicy,
      });
    }
  }

  return makeBureauHandle<
    Record<never, never>,
    NormalizeAgents<Record<never, never>, TAgentsInput>
  >(state);
}
