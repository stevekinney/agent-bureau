/**
 * Type-level definitions for the bureau/agent/run architecture.
 *
 * These types prove the design spike described in `architecture.md` Phase A4:
 * the chained bureau builder, name-keyed tool inheritance, the BureauTools<T>
 * extractor utility, the bureau.run() generic, and the non-thenable AgentRun
 * handle. No runtime code lives here — this is a pure-type module consumed
 * only by the `.test-d.ts` spike and eventually by the real bureau package
 * (Phase E).
 *
 * Pattern cribbed from weft's `workflow-builder-helpers.ts` — phantom marker
 * fields carry concrete types through the chain without the runtime entries
 * needing to be parameterised.
 */

// ---------------------------------------------------------------------------
// Tool map primitives — name-keyed, phantom-typed
// ---------------------------------------------------------------------------

/**
 * A raw callable or object accepted by `.tools({...})`. The key is canonical;
 * the inner `name` field is FORBIDDEN (key disagreement is the #1 authoring
 * bug). Input/output types are inferred via `NormalizeTools<T>`.
 *
 * The `name?: never` constraint on the object variant prevents armorer tools
 * (which carry a `.name` property) from being passed with their `.name` field
 * — the MAP KEY is the canonical name. If a tool object carries `.name`, the
 * entry must still be placed under a key; the `.name` field is silently ignored
 * at runtime, but TypeScript enforces that you do not rely on it.
 *
 * Concretely: `{ search: searchTool }` is valid even if `searchTool.name` is
 * `'web-search'` — the key `'search'` wins. But passing an object with `name`
 * directly in the entry position is a type error, preventing accidental
 * authoring of `{ 'web-search': { name: 'search', execute: ... } }` where the
 * key and name disagree.
 */
export type ToolEntryInput =
  | ((...arguments_: never[]) => unknown)
  | { readonly name?: never; readonly execute: (...arguments_: never[]) => unknown };

/** Shape accepted by `.tools({...})`. */
export type ToolMapInput = Record<string, ToolEntryInput>;

/**
 * Normalised entry stored on the builder after `.tools({...})`. The `input`
 * and `output` fields are phantom markers — never written at runtime, only
 * used by TypeScript to thread concrete types through the chain.
 */
export interface ToolEntry<TInput = unknown, TOutput = unknown> {
  /** Phantom marker: input type for tool call typing. Never assigned at runtime. */
  readonly input?: TInput;
  /** Phantom marker: output type for tool result typing. Never assigned at runtime. */
  readonly output?: TOutput;
}

/** The normalised shape stored on a builder after `.tools({...})`. */
export type ToolMap = Record<string, ToolEntry>;

/** Infer concrete `ToolEntry` from a raw `ToolEntryInput`. */
type NormalizeToolEntry<T extends ToolEntryInput> = T extends {
  execute: (input: infer TInput) => infer TOutput;
}
  ? ToolEntry<TInput, Awaited<TOutput>>
  : T extends () => infer TOutput
    ? ToolEntry<void, Awaited<TOutput>>
    : T extends (input: infer TInput) => infer TOutput
      ? ToolEntry<TInput, Awaited<TOutput>>
      : ToolEntry;

/** Map each entry in a `ToolMapInput` to a `ToolEntry`. */
export type NormalizeTools<T extends ToolMapInput> = {
  [K in keyof T & string]: NormalizeToolEntry<T[K]>;
};

// ---------------------------------------------------------------------------
// Tool name helpers — for autocomplete and BureauToolNames<T>
// ---------------------------------------------------------------------------

/**
 * `keyof BureauTools<typeof bureau> & string` — the union of all tool names
 * registered on a bureau, usable for autocomplete in hook selectors, policy
 * configs, etc.
 *
 * @example
 * ```ts
 * type Names = BureauToolNames<typeof bureau>;
 * //=> 'search' | 'clock'
 * ```
 */
export type BureauToolNames<T> = keyof BureauTools<T> & string;

// ---------------------------------------------------------------------------
// Agent tool name helpers — keyof union over inherited + own tools
// ---------------------------------------------------------------------------

/**
 * Extract the effective tool map from an `AgentBuilder` value — the union of
 * both bureau-inherited tools and the agent's own tools.
 *
 * Equivalent to `BureauTools<T>` but for the agent's combined toolset. Useful
 * for hook selectors, policy configs, and autocomplete outside the builder:
 *
 * @example
 * ```ts
 * const agent = bureau.agent({ name: 'researcher', tools: { scratchpad } });
 * type Tools = AgentTools<typeof agent>;
 * //=> { search: ToolEntry<…>; clock: ToolEntry<…>; scratchpad: ToolEntry<…> }
 * ```
 */
export type AgentTools<T> =
  T extends AgentBuilder<infer TBureauTools, infer TAgentTools>
    ? TBureauTools & TAgentTools
    : never;

/**
 * The union of all tool names available to an agent — both inherited from the
 * bureau AND added by the agent itself. This is `keyof (bureauTools & agentTools)`
 * surfaced as a string-literal union for autocomplete.
 *
 * This is the type B4 requires: "Agent surfaces only the tool-name union
 * (`keyof tools`)." The key is ALWAYS canonical; the inner `.name` field on
 * any tool object is forbidden (see `ToolEntryInput`).
 *
 * @example
 * ```ts
 * const agent = bureau.agent({ name: 'researcher', tools: { scratchpad } });
 * type Names = AgentToolNames<typeof agent>;
 * //=> 'search' | 'clock' | 'scratchpad'
 * ```
 */
export type AgentToolNames<T> = keyof AgentTools<T> & string;

// ---------------------------------------------------------------------------
// Agent table — bureau registry
// ---------------------------------------------------------------------------

/** A single agent slot in the bureau's registry. Carries tool types. */
export interface AgentConfig<TTools extends ToolMap = ToolMap> {
  readonly tools?: TTools;
}

/**
 * The name-keyed agent registry type carried by `BureauBuilder<TAgents>`.
 * Each key is an agent name; each value carries that agent's merged tool types.
 */
export type AgentTable = Record<string, AgentConfig>;

/** Input accepted by `bureau.agent({...})` and `createBureau({agents:{...}})`. */
export interface AgentOptions {
  name: string;
  tools?: ToolMapInput;
  instructions?: string;
  // More fields will be added in Phase E; these are the spike-minimum.
}

// ---------------------------------------------------------------------------
// AgentRun — the non-thenable run handle (assertion 6)
// ---------------------------------------------------------------------------

/**
 * The event emitted by a run while iterating. The exact union is defined in
 * Phase B; for the spike we use a structural placeholder.
 */
export interface RunEvent {
  type: string;
}

/**
 * The terminal result of a run. Defined fully in Phase B; placeholder here.
 */
export interface RunResult {
  content: string;
}

/**
 * The handle returned by `run()`. It is:
 * - `AsyncIterable<RunEvent>` — iterate with `for await`
 * - NOT a `Promise`/`PromiseLike` — result is accessed via `.result()` only
 * - Abortable via `.abort()`
 * - Disposable via `[Symbol.dispose]()`
 *
 * NOT extending Promise is load-bearing: a thenable would be auto-unwrapped
 * at every `async` boundary (`return run`, `Promise.all([run1])`, etc.) and
 * destroy the event stream. `.result()` is one extra method call; legibility
 * is a bonus.
 */
export interface AgentRun extends AsyncIterable<RunEvent> {
  /** Get the terminal result. Caches after first resolution (idempotent). */
  result(): Promise<RunResult>;
  /** Abort the in-flight run. Abort signal fires immediately. */
  abort(reason?: string): void;
  /** Dispose the run handle; releases internal resources. */
  [Symbol.dispose](): void;
}

// ---------------------------------------------------------------------------
// AgentInput helper — maps agent name → its merged input type
// ---------------------------------------------------------------------------

/**
 * Extracts the input type for a named agent in an `AgentTable`. Returns
 * `string` as the fallback (the most permissive input type an LLM prompt
 * accepts) — in the final implementation, agents may expose typed structured
 * inputs; for the spike, `string` is sufficient to prove the name-checking
 * machinery.
 */
export type AgentInput<
  TAgents extends AgentTable,
  TName extends keyof TAgents,
> = TAgents[TName] extends { input: infer TInput } ? TInput : string;

// ---------------------------------------------------------------------------
// AgentNameFor — name constraint for run(), depends on TExtra
//
// Uses a conditional type to create a circular dependency that prevents
// TypeScript from inferring TExtra backwards from the name argument. Without
// this, TypeScript would infer TExtra = {unknownName: AgentConfig} to satisfy
// any call, bypassing the closed-table safety.
//
// When TExtra = Record<never, never> (the default), keyof TExtra = never, so
// the condition is true and name is constrained to keyof TAgents & string.
// When TExtra has string keys (e.g. AgentTable, DynamicAgents), name is string.
// ---------------------------------------------------------------------------

/**
 * The name type accepted by `run()`. Depends on `TExtra`:
 * - Default (`TExtra = Record<never, never>`): `keyof TAgents & string` — closed table.
 * - Explicit `TExtra` with string keys (e.g. `AgentTable`, a named union): `string` — open.
 *
 * The conditional type prevents TypeScript from inferring `TExtra` backwards
 * from the name argument (it would otherwise infer `TExtra = {badName: AgentConfig}`
 * to satisfy any call — this design closes that hole).
 */
export type AgentNameFor<TAgents extends AgentTable, TExtra extends AgentTable> = [
  keyof TExtra,
] extends [never]
  ? keyof TAgents & string
  : string;

// ---------------------------------------------------------------------------
// BureauBuilder — the main chained type
// ---------------------------------------------------------------------------

/**
 * The bureau builder. `TTools` is the accumulated name-keyed tool map;
 * `TAgents` is the accumulated name-keyed agent registry.
 *
 * **The chain is on the BUREAU** (not the agent). Each `.agent()` call widens
 * `TAgents`; each `.tools()` call widens `TTools`. Both are captured through
 * reassignment:
 *
 * ```ts
 * const b1 = createBureau();
 * const b2 = b1.tools({ search });     // BureauBuilder<{search:…}, {}>
 * const b3 = b2.agent({ name: 'r' }); // BureauBuilder<{search:…}, {r:…}>
 * ```
 *
 * The **reassignment contract**: `.agent()` and `.tools()` return a WIDER
 * builder — you MUST capture the return value. Discarding it (as you might
 * naively do in a separate file) silently loses the widening. This mirrors
 * weft's `engine.register(...)` pattern.
 */
export interface BureauBuilder<
  TTools extends ToolMap = Record<never, never>,
  TAgents extends AgentTable = Record<never, never>,
> {
  /**
   * Add tools to the bureau's base toolset. Returns a builder with the new
   * tools merged into `TTools`.
   */
  tools<TNew extends ToolMapInput>(t: TNew): BureauBuilder<TTools & NormalizeTools<TNew>, TAgents>;

  /**
   * Register an agent with the bureau. Returns a builder with the agent added
   * to `TAgents`. The return value MUST be captured.
   *
   * **Tier 2 registration** (chain). See also `createBureau({agents})` for
   * Tier 1 (construction-time) registration.
   */
  agent<TName extends string>(
    options: AgentOptions & { name: TName },
  ): BureauBuilder<TTools, TAgents & Record<TName, AgentConfig<TTools>>>;

  /**
   * Run a named agent. Type-safe against the registered agent table.
   *
   * **Bare call** → `TExtra = Record<never, never>` (the default). The
   * `AgentNameFor<TAgents, TExtra>` conditional type resolves to
   * `keyof TAgents & string` when `TExtra` contributes no keys — so only
   * registered agent names are accepted. Auto-complete surfaces all agents.
   *
   * **`run<TExtra>('name', input)`** → "widen, never replace." When `TExtra`
   * has string keys (e.g. `AgentTable`, a named union), `AgentNameFor` opens
   * to `string`, accepting any name while the static `TAgents` table is still
   * preserved. Use: `bureau.run<KnownRuntimeAgents>(validatedName, input)`.
   *
   * Why the conditional type: TypeScript would otherwise infer
   * `TExtra = {badName: AgentConfig}` to satisfy any bare call. The
   * `AgentNameFor` conditional creates a circular dependency that prevents
   * that backwards inference — without an explicit `TExtra`, the default
   * `Record<never, never>` enforces the closed table.
   *
   * "Widen, never replace" is enforced: supplying `TExtra` ADDS to the
   * accepted names (opens `AgentNameFor` to `string`) without removing the
   * static agents (they remain in `TAgents`, typed as before).
   */
  run<TExtra extends AgentTable = Record<never, never>>(
    name: AgentNameFor<TAgents, TExtra>,
    input: string,
  ): AgentRun;
}

// ---------------------------------------------------------------------------
// BureauTools extractor — tRPC inferRouterInputs<typeof router> analog
// ---------------------------------------------------------------------------

/**
 * Extract the accumulated tool map from a bureau builder value.
 *
 * Equivalent to tRPC's `inferRouterInputs<typeof router>` — recovers the
 * concrete tool intersection from any bureau *value* for use outside the
 * builder chain (hook configs, policy rules, tool-name autocomplete, etc.).
 *
 * @example
 * ```ts
 * const bureau = createBureau().tools({ search, clock });
 * type Tools = BureauTools<typeof bureau>;
 * //=> { search: ToolEntry<SearchInput, SearchOutput>; clock: ToolEntry<…> }
 * ```
 */
export type BureauTools<T> = T extends BureauBuilder<infer TTools, AgentTable> ? TTools : never;

// ---------------------------------------------------------------------------
// Tier 1 construction — createBureau({ agents })
// ---------------------------------------------------------------------------

/**
 * Input shape for `createBureau({agents:{...}})`. Each value in the `agents`
 * map is an agent options object; keys become the agent names in the registry.
 */
export type BureauAgentsInput = Record<string, Omit<AgentOptions, 'name'>>;

/**
 * Convert `BureauAgentsInput` to `AgentTable` so the Tier-1 construction path
 * seeds the bureau with concrete agent names at construction time.
 */
export type NormalizeAgents<TTools extends ToolMap, TIn extends BureauAgentsInput> = {
  [K in keyof TIn & string]: AgentConfig<TTools>;
};

/**
 * Creates a new bureau builder. Accepts an optional `agents` map for Tier-1
 * construction-time registration.
 *
 * @example
 * ```ts
 * // Tier 1 — all agents at construction time
 * const bureau = createBureau({
 *   agents: { researcher: { instructions: '...' }, writer: {} },
 * });
 * bureau.run('researcher', 'Summarize the docs');
 *
 * // Tier 2 — chain additional agents after construction
 * const bureau2 = bureau.agent({ name: 'editor' });
 * bureau2.run('editor', '...');
 * bureau2.run('researcher', '...'); // still typechecks
 * ```
 */
export declare function createBureau<
  TAgentsInput extends BureauAgentsInput = Record<never, never>,
>(options?: {
  agents?: TAgentsInput;
}): BureauBuilder<Record<never, never>, NormalizeAgents<Record<never, never>, TAgentsInput>>;

// ---------------------------------------------------------------------------
// AgentBuilder — the standalone agent builder (bureau-less)
// ---------------------------------------------------------------------------

/**
 * Standalone agent builder, returned by `createAgent({...})`. The bureau slot
 * is empty (`TBureauTools = {}`) — no inheritance, no shared config, in-memory
 * only. `generate` is REQUIRED (no bureau to inherit from).
 *
 * Two type params keep bureau tools and agent tools distinguishable at use
 * sites; they merge only at the call site of `run()`.
 */
export interface AgentBuilder<
  TBureauTools extends ToolMap = Record<never, never>,
  TAgentTools extends ToolMap = Record<never, never>,
> {
  /** Add tools to this agent's toolset. Merges into `TAgentTools`. */
  tools<TNew extends ToolMapInput>(
    t: TNew,
  ): AgentBuilder<TBureauTools, TAgentTools & NormalizeTools<TNew>>;

  /** Run the agent with `input`. Returns an `AgentRun` handle. */
  run(input: string): AgentRun;
}

// ---------------------------------------------------------------------------
// Standalone agent options bag — createAgent({...})
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GenerateFunction alias — structural, avoids circular import from types.ts
// ---------------------------------------------------------------------------

/**
 * Structural alias for the `GenerateFunction` seam from `./types`. This file
 * is a pure-type module with no imports; we cannot import from `./types`
 * without creating a dependency edge. The structural shape is intentionally
 * identical — the real implementation's `CreateAgentOptions` will accept the
 * same function.
 *
 * The full `GenerateContext` / `GenerateResponse` pair is opaque here (`unknown`
 * inputs, `Promise<unknown>` output). Callers typing agents via the real
 * `createAgent` from `./types` will get the concrete types; this alias keeps
 * the spike self-contained.
 */
export type AgentGenerateFunction = (context: unknown) => Promise<unknown>;

/**
 * Options accepted by `createAgent({...})`. This is the OPTIONS BAG shape —
 * no chained builder, just a plain object. The design decision from
 * architecture.md: the agent is an options bag, the chain lives on the bureau.
 *
 * `generate` is REQUIRED on a standalone agent because there is no bureau to
 * inherit a provider from. On a bureau-owned agent (`bureau.agent({...})`),
 * `generate` is optional (the bureau provides a default).
 *
 * `tools` is a NAME-KEYED MAP (`{ search: tool, clock: tool }`). The map key
 * is canonical; any inner `.name` field on a tool object is forbidden (see
 * `ToolEntryInput`).
 *
 * `name` is REQUIRED for identification (logging, events, session naming).
 * Unlike the old `defineAgent` shape, there is NO `toolbox` field — tools are
 * expressed as the name-keyed map and normalized by the factory.
 */
export interface CreateAgentOptions<TTools extends ToolMapInput = ToolMapInput> {
  /** Canonical agent name. Used for events, session IDs, and registry lookup. */
  name: string;
  /** System prompt or persona text prepended on step 0. */
  instructions?: string;
  /**
   * The LLM provider. REQUIRED on a standalone agent (no bureau to inherit
   * from). Use the concrete `GenerateFunction` from `./types` at call sites.
   */
  generate: AgentGenerateFunction;
  /**
   * Name-keyed tool map. Keys are canonical tool names; the inner `.name`
   * field (if any) is ignored at runtime — the KEY wins.
   */
  tools?: TTools;
}

/**
 * Creates a standalone, bureau-less agent. Returns an `AgentBuilder` with
 * empty bureau-tool slot (`TBureauTools = Record<never, never>`) and the
 * agent's own tools normalized into `TAgentTools`.
 *
 * **Differences from `bureau.agent({...})`:**
 * - `generate` is **required** (no bureau to inherit from).
 * - Bureau tools slot is always empty — no inherited toolset.
 * - In-memory only — no durability, no shared memory, no scheduling.
 *
 * **Tools as options bag, not chain:** tools are expressed as a name-keyed map
 * in the options object, not via a `.tools()` builder call. Further tool
 * additions are possible via the returned builder's `.tools()` method.
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   name: 'researcher',
 *   generate: anthropicProvider({ model: 'claude-opus-4-5' }),
 *   tools: { search: searchTool, clock: clockTool },
 * });
 *
 * const run = agent.run('Summarize the Q3 report.');
 * for await (const event of run) { ... }
 * const result = await run.result();
 * ```
 */
export declare function createAgent<TTools extends ToolMapInput = Record<never, never>>(
  options: CreateAgentOptions<TTools>,
): AgentBuilder<Record<never, never>, NormalizeTools<TTools>>;
