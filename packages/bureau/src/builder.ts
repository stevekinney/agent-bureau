/**
 * createBureau — the typed fleet builder.
 *
 * This module provides the three-tier typed registry/table API:
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
import { combineToolboxes, createTool, createToolbox, isTool } from 'armorer';
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
 * Three entry shapes are accepted:
 *  - A full armorer `Tool` (created via `createTool`) — used as-is; the map
 *    key overrides the inner `.name` when they differ.
 *  - A plain function `(params) => result` — normalized to a `Tool` using
 *    `createTool` with the map key as both `name` and `description`.
 *  - A plain `{ execute }` object — normalized the same way.
 *
 * This aligns the runtime with the `ToolEntryInput` type contract exposed in
 * `bureau-types.ts`, which explicitly accepts plain callables and `{execute}`
 * objects as first-class tool inputs.
 *
 * Note: if an armorer tool's canonical `.name` differs from the map key, the
 * MAP KEY wins. Tools with a matching name are passed through directly; those
 * with a name mismatch are re-configured via `createToolbox` with a
 * name-override entry.
 */
function toolboxFromMap(toolsMap: Record<string, unknown>): Toolbox {
  const entries: Array<Tool | ({ name: string } & Record<string, unknown>)> = [];

  for (const [key, value] of Object.entries(toolsMap)) {
    if (isTool(value)) {
      // Full armorer Tool — pass directly, using the map key as canonical name.
      if (value.configuration.name === key) {
        entries.push(value);
      } else {
        // Override the name: spread the tool configuration with the map key as name.
        entries.push({ ...value.configuration, name: key });
      }
    } else if (typeof value === 'function') {
      // Plain function: only accepted when it declares zero parameters.
      // A plain callable with declared parameters would be registered without
      // a Zod schema, causing Armorer to normalise the missing schema to
      // z.object({}) which strips every LLM-supplied argument before execute
      // is called. Callers must supply the { execute, input } object form so
      // the schema is explicit and arguments are not silently lost.
      if (value.length > 0) {
        throw new Error(
          `bureau.tools(): plain function at key "${key}" declares ${value.length} parameter(s). ` +
            `Armorer cannot infer a schema from a bare function — LLM-supplied arguments ` +
            `would be silently stripped. Use the { execute, input } form instead:\n` +
            `  { ${key}: { execute: yourFn, input: z.object({ ... }) } }`,
        );
      }
      // Zero-param function: safe to normalise — no arguments to lose.
      // Cast is justified: ToolEntryInput's callable variant is typed as
      // `(...arguments_: never[]) => unknown` for inference only; the real
      // signature at runtime is compatible with createTool's execute parameter.
      entries.push(
        createTool({
          name: key,
          description: key,
          execute: value as (params: Record<string, unknown>) => Promise<unknown>,
        }),
      );
    } else if (
      typeof value === 'object' &&
      value !== null &&
      'execute' in value &&
      typeof (value as { execute: unknown }).execute === 'function'
    ) {
      // Plain { execute } object: normalize to an armorer Tool.
      // Cast is justified: execute is validated as a function above.
      // Forward `input` when provided so LLM arguments are not stripped.
      const { execute, input } = value as {
        execute: (params: Record<string, unknown>) => Promise<unknown>;
        input?: unknown;
      };
      entries.push(
        createTool({
          name: key,
          description: key,
          execute,
          // Forward the caller's Zod schema (or raw shape) so Armorer uses it
          // instead of normalizing to z.object({}) which would strip all args.
          ...(input !== undefined && {
            input: input as Parameters<typeof createTool>[0]['input'],
          }),
        }),
      );
    } else {
      throw new Error(
        `bureau.tools(): value at key "${key}" is not a valid tool entry. ` +
          `Provide an armorer Tool, a plain function, or a plain { execute } object.`,
      );
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
 *
 * When only one side is present the stored reference is cloned via extend()
 * so each run() call gets its own CompletableEventTarget emitter. Sharing the
 * stored instance across concurrent run() calls causes cross-run tool event
 * pollution and shared budget/loop-detector state (the same pattern used by
 * createRunRuntime() in runtime-composition.ts which calls baseToolbox.extend()
 * per run).
 */
function mergeToolboxes(
  bureau: Toolbox | undefined,
  agent: Toolbox | undefined,
): Toolbox | undefined {
  if (bureau && agent) {
    return combineToolboxes(bureau, agent) as unknown as Toolbox;
  }
  const single = bureau ?? agent;
  return single !== undefined ? (single.extend() as Toolbox) : undefined;
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

/**
 * Merge a bureau-level SkillPolicy and an agent-level SkillPolicy.
 * Agent's denyList is additive on top of bureau's; agent's allowList narrows
 * bureau's (intersection). When both are absent, returns undefined.
 */
function mergeSkillPolicies(
  bureau: SkillPolicy | undefined,
  agent: SkillPolicy | undefined,
): SkillPolicy | undefined {
  if (!bureau && !agent) return undefined;
  // allowList narrows by INTERSECTION: an agent can only further restrict the
  // bureau's allowed set, never widen it. When both define an allowList, keep only
  // skills allowed by BOTH; when only one defines it, that one applies.
  let allowList: string[] | undefined;
  if (bureau?.allowList && agent?.allowList) {
    const bureauAllowed = new Set(bureau.allowList);
    allowList = agent.allowList.filter((skill) => bureauAllowed.has(skill));
  } else {
    allowList = agent?.allowList ?? bureau?.allowList;
  }
  const denyListItems = [...(bureau?.denyList ?? []), ...(agent?.denyList ?? [])];
  const denyList = denyListItems.length > 0 ? denyListItems : undefined;
  return allowList !== undefined || denyList !== undefined
    ? {
        ...(allowList !== undefined ? { allowList } : {}),
        ...(denyList !== undefined ? { denyList } : {}),
      }
    : undefined;
}

/** Escape XML special characters. */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Create a PrepareStepHook that injects the skill catalog as an
 * `<available_skills>` XML block on step 0 of every run.
 *
 * Uses only the `SkillProviderLike` seam (`listSkills` + `isEnabled`), which
 * keeps `builder.ts` free of a hard `skills` package import.
 * Degrades gracefully on provider errors so a catalog failure never aborts a run.
 */
function createSkillCatalogPrepareStep(
  provider: SkillProviderLike,
  effectivePolicy: SkillPolicy | undefined,
): PrepareStepHook {
  return async (context) => {
    if (context.step !== 0) return;

    try {
      const allSkills = await provider.listSkills();

      // Filter by enabled status.
      const enabledChecks = await Promise.all(
        allSkills.map(async (skill) => ({
          skill,
          enabled: await provider.isEnabled(skill.name),
        })),
      );
      let filtered = enabledChecks.filter((check) => check.enabled).map((check) => check.skill);

      // Apply allow/deny policy (deny wins).
      if (effectivePolicy?.allowList) {
        const allow = new Set(effectivePolicy.allowList);
        filtered = filtered.filter((s) => allow.has(s.name));
      }
      if (effectivePolicy?.denyList) {
        const deny = new Set(effectivePolicy.denyList);
        filtered = filtered.filter((s) => !deny.has(s.name));
      }

      if (filtered.length === 0) return;

      const skillElements = filtered
        .map(
          (s) => `<skill name="${escapeXmlAttr(s.name)}">${escapeXmlAttr(s.description)}</skill>`,
        )
        .join('\n');

      const catalog =
        `<available_skills>\n` +
        `You have the following skills available.\n\n` +
        `${skillElements}\n` +
        `</available_skills>`;

      context.conversation.appendSystemMessage(catalog, { _skillCatalogInjected: true });
    } catch {
      // Degrade gracefully — provider errors must not abort the run.
    }
  };
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

    // ----- generate() -----------------------------------------------------

    generate(generateFunction: GenerateFunction): BureauBuilder<TTools, TAgents> {
      state.bureauGenerate = generateFunction;
      return makeBureauHandle<TTools, TAgents>(state);
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

      // Skill catalog hook: inject catalog on step 0 when a provider is set.
      // The effective policy merges bureau + agent policies (agent narrows bureau).
      const skillHooks: PrepareStepHook[] = [];
      if (state.skillProvider) {
        const effectiveSkillPolicy = mergeSkillPolicies(state.skillPolicy, spec.skillPolicy);
        skillHooks.push(createSkillCatalogPrepareStep(state.skillProvider, effectiveSkillPolicy));
      }

      // Hooks: skill catalog first, then bureau-level, then agent-level.
      const effectiveHooks = mergeHooks([...skillHooks, ...state.bureauHooks], spec.hooks);

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

      // Stamp agentName and runId so curated tool.* bubble events carry
      // {agentName, runId, step} metadata on builder-driven runs, matching the
      // behaviour of createBureau().createRun() (create-bureau.ts:488-489).
      const runId = `run-${crypto.randomUUID()}`;

      const runOptions: RunOptions = {
        generate: effectiveGenerate,
        toolbox: toolboxForRun,
        conversation,
        agentName: spec.name,
        runId,
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
 * import type { AgentTable } from 'bureau/builder';
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
