import type { AnyToolbox, HeadlessPermissionPolicyConfiguration, Tool } from 'armorer';
import { createHeadlessPermissionPolicyHooks, createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';
import type { ZodType } from 'zod';

import type { AgentRun } from './agent-run';
import { createAgentRun } from './agent-run';
import { noToolCalls } from './conditions/predicates';
import { createActiveRun } from './create-run';
import type { AgentRunContext, DefinitionResolvingAgent } from './runnable-agent';
import { OPERATIVE_RESOLVE_RUN_OPTIONS } from './runnable-agent';
import { toOutputJsonSchema } from './structured-output/response-schema';
import type {
  ContextManagementOptions,
  ConversationHistory,
  GenerateFunction,
  OperativeExecuteOptions,
  RetryOptions,
  RunOptions,
  StopCondition,
} from './types';

// ---------------------------------------------------------------------------
// CreateAgentOptions — the options bag
//
// `generate` is REQUIRED here (no bureau to inherit a provider from).
// `tools` is a name-keyed map: the map KEY is canonical, not the tool's
// inner `.name` (map-form avoids the `.name`-disagreement authoring bug).
// ---------------------------------------------------------------------------

/**
 * Fields shared by every `CreateAgentOptions` tool-configuration variant.
 * Split out from `CreateAgentOptions` so the exclusive tool-configuration
 * union below can be intersected with it.
 */
export interface CreateAgentOptionsBase {
  /**
   * The LLM provider function. REQUIRED — no bureau to inherit from.
   * Receives a `GenerateContext` and returns a `GenerateResponse`.
   */
  generate: GenerateFunction;

  /**
   * Identifies this agent — stamped on curated `tool.*` bubble events
   * (`AgentRunContext.agentName`'s standalone-path default) and populates
   * the returned agent's `RunnableAgent.name`. Optional here (unlike the
   * final `RunnableAgent` contract, where AB-15 makes it required): a
   * `createAgent` result already satisfies `RunnableAgent<O, H>`
   * structurally without one, defaulting to `'(agent)'`.
   */
  name?: string;

  /**
   * System instructions injected as a system message on step 0.
   * Prepended to every run started by this agent.
   */
  instructions?: string;

  /**
   * Stop conditions checked after each step.
   *
   * Defaults to `stopWhen.noToolCalls()` when omitted — `createAgent` (unlike
   * the lower-level `createActiveRun`, which never applies a default) has no
   * caller to fall back on, and a run with no stop condition at all runs
   * every step to `maximumSteps` (`DEFAULT_MAXIMUM_STEPS`, 25) before
   * exiting with `finishReason: 'maximum-steps'`. For a plain text-in/
   * text-out agent this default is exactly "stop once the model replies
   * without calling a tool" — pass an explicit `stopWhen` (including
   * `stopWhen.toolCalled(...)` for agents that MUST end on a tool call, e.g.
   * `createHandoffTool`) to override it.
   */
  stopWhen?: StopCondition | StopCondition[];

  /** Hard cap on the number of steps before the loop exits. */
  maximumSteps?: number;

  /** Options forwarded to toolbox.execute() within the loop. */
  executeOptions?: OperativeExecuteOptions;

  /** Retry configuration for transient generate failures. */
  retry?: RetryOptions;

  /** Context window management (compaction). */
  contextManagement?: ContextManagementOptions;

  /**
   * Zod schema for the validated terminal `output` value (AB-18) — the
   * single validated output contract. Drives type inference
   * (`z.output<typeof schema>`), the provider-native JSON Schema sent to the
   * model, and runtime validation of the model's final text. There is no
   * separate `responseSchema`/`responseJsonSchema` pair and no non-Zod
   * Standard Schema branch.
   *
   * MUST NOT declare a field intended to carry binary or media content
   * (AB-70's amendment to this issue) — `output` is JSON-only, and a
   * generated asset a run produces belongs in `RunResult.parts` as a
   * managed-asset reference part, never inlined as base64 here.
   */
  output?: ZodType<unknown>;
}

/**
 * The exclusive tool-configuration surface of `CreateAgentOptions`. Encodes
 * the runtime-enforced exclusivity at the type level: `toolbox` is exclusive
 * with BOTH `tools` and `permissions`, which may otherwise be combined
 * freely (including "neither" — no tool configuration at all) —
 * `tools`/`permissions` combined with `toolbox` is a type error, not just a
 * runtime throw.
 *
 * Deliberately just two variants, not one per row of the accepted matrix
 * ("no tool configuration", `tools`, `permissions`, `tools` + `permissions`,
 * `toolbox`): a caller commonly forwards an already-optional value, e.g.
 * `const tools: Record<string, Tool> | undefined = maybeTools();
 * createAgent({ generate, tools })`. A one-variant-per-row union rejects
 * that — `tools: X | undefined` doesn't structurally match either "tools
 * required" or "tools absent". Widening `tools` and `permissions` to
 * `T | undefined` within a single non-toolbox variant accepts every
 * combination of "present, absent, or explicitly undefined" for both at
 * once, while the separate toolbox variant still excludes both.
 *
 * The excluded `toolbox`/`tools`/`permissions` fields in each variant are
 * typed `?: undefined` rather than omitted, so an explicitly `undefined`
 * value (e.g. `{ toolbox, tools: undefined }`) is still accepted —
 * `undefined` is treated as omitted, matching the runtime guards in
 * `validateCreateAgentOptions`. `?: undefined` (rather than `?: never`)
 * keeps this true even under `exactOptionalPropertyTypes: true`, where an
 * optional property no longer implicitly includes `undefined` — this repo
 * currently disables that flag (`tsconfig.base.json`), but the excluded
 * fields don't depend on it either way.
 */
export type CreateAgentToolConfiguration =
  | {
      tools?: Record<string, Tool> | undefined;
      toolbox?: undefined;
      permissions?: HeadlessPermissionPolicyConfiguration | undefined;
    }
  | { tools?: undefined; toolbox: AnyToolbox; permissions?: undefined };

/**
 * Options for `createAgent({...})`. Distinct from the old `DefineAgentOptions`
 * (which requires a `toolbox`). Here `tools` is a name-keyed map and `generate`
 * is unconditionally required — there is no bureau to inherit a provider from.
 *
 * The tool-configuration fields (`tools`, `toolbox`, `permissions`) are
 * mutually exclusive along the axes documented on
 * `CreateAgentToolConfiguration`:
 *
 * - `tools` — agent tools as a name-keyed map. The map key is the canonical
 *   tool name; the tool's own `.name` property is ignored (key wins).
 *   Optional — an agent with no tools is valid for pure-generation tasks.
 *   Mutually exclusive with `toolbox`.
 * - `toolbox` — a pre-built `Toolbox` instance, used as-is for every run
 *   started by this agent. Mutually exclusive with `tools` (which composes a
 *   fresh internal toolbox instead) and with `permissions` (which configures
 *   a toolbox this factory builds itself).
 *
 *   Unlike `tools`, a `toolbox` you pass here is NOT rebuilt per run — every
 *   `run()` call shares this exact instance. Armorer's cross-request approval
 *   flow additionally requires versioned tools, request-scoped authority in
 *   `executeOptions.requestContext`, the same authority re-authenticated when
 *   calling `toolbox.resumeApproval()`, and approval state shared between the
 *   issuing and resuming toolbox. A module-scoped toolbox supplies process-local
 *   state; multi-process or restart-safe hosts must configure the same durable
 *   `ApprovalStateStore` and `approvalSecret` on every toolbox instance.
 *
 *   Because the instance is shared, concurrent runs against the same
 *   `StandaloneAgent` will cross-fire each other's toolbox events and share
 *   budget/loop-detection counters — the same tradeoff as constructing the
 *   toolbox yourself and reusing it. If you don't need cross-run state
 *   (approvals, budgets), use `tools` instead for per-run isolation.
 * - `permissions` — headless deny-by-default permission mode (AB-94,
 *   armorer's `createHeadlessPermissionPolicyHooks`). When set, every tool
 *   call is checked against an explicit allowlist/denylist and an optional
 *   capability-tier policy and synchronous per-call gate — anything unlisted
 *   or that would otherwise require human approval is denied outright (this
 *   run never parks on a human). A denial feeds the model a tool-error
 *   result and the loop continues; it never throws and never terminates the
 *   run.
 *
 *   For the opposite mode — parking on a pending approval instead of denying
 *   it — pass a pre-built `toolbox` (with its own approval policy) and use
 *   `stopWhen: stopWhen.pendingApproval()`. `permissions` only configures a
 *   toolbox this factory builds itself, so it's mutually exclusive with
 *   `toolbox`.
 *
 * This is a `type` (intersecting `CreateAgentOptionsBase` with the
 * `CreateAgentToolConfiguration` union), not an `interface`, as of AB-16 —
 * enforcing exclusivity requires a union, and TypeScript interfaces can't
 * `extends` a type containing a union, nor declaration-merge into one. A
 * consumer that previously wrote `interface MyOptions extends
 * CreateAgentOptions` for the full options bag needs `MyOptions =
 * CreateAgentOptions & { ... }` instead; extending or declaration-merging
 * onto just the non-exclusive fields still works via the separately
 * exported `CreateAgentOptionsBase` interface.
 */
export type CreateAgentOptions = CreateAgentOptionsBase & CreateAgentToolConfiguration;

/**
 * Validates the mutually-exclusive option combinations in
 * `CreateAgentOptions` once, at `createAgent()` call time (not per-run).
 */
function validateCreateAgentOptions(options: CreateAgentOptions): void {
  if (options.tools && options.toolbox) {
    throw new Error(
      'createAgent: `tools` and `toolbox` are mutually exclusive. Pass `tools` for a fresh, ' +
        'per-run internal toolbox, or `toolbox` to use a pre-built Toolbox instance as-is across ' +
        "every run (required for armorer's cross-request approval flow, where " +
        '`toolbox.resumeApproval` must share the same `approvalSecret` that minted the pending ' +
        'approval).',
    );
  }

  if (options.toolbox && options.permissions) {
    throw new Error(
      'createAgent: `permissions` configures a freshly-built internal toolbox and cannot be ' +
        'combined with `toolbox` (a pre-built Toolbox instance already owns its own policy and ' +
        'hooks). Configure permissions directly on the toolbox you pass, via ' +
        '`createHeadlessPermissionPolicyHooks`, instead.',
    );
  }

  // AB-18: an unrepresentable `output` schema fails FAST, synchronously, at
  // `createAgent()` call time — not on `await run.result()` after a run has
  // already started. `toOutputJsonSchema` throws `OutputSchemaConversionError`
  // for a schema `z.toJSONSchema` can't convert; its result is discarded here
  // (the loop recomputes it per run via `resolveResponseFormat`, a cheap
  // re-derivation once this guard has already proven the schema convertible).
  if (options.output) {
    toOutputJsonSchema(options.output);
  }
}

// ---------------------------------------------------------------------------
// StandaloneAgent — the runtime agent returned by createAgent()
//
// NOT a `RunnableAgent` from the deleted synchronous builder chain (AB-22).
// The runtime object just needs `.run()`.
// ---------------------------------------------------------------------------

/**
 * The runtime agent returned by `createAgent({...})`. Bureau-less, in-memory
 * only. Calling `.run(input)` starts a new ephemeral run each time.
 */
export interface StandaloneAgent<
  O = never,
  H extends boolean = false,
> extends DefinitionResolvingAgent {
  /**
   * This agent's identity — `options.name`, defaulting to `'(agent)'` when
   * omitted. Makes a `createAgent` result structurally satisfy
   * `RunnableAgent<O, H>` (AB-21), so it can be passed to `createLazyAgent`
   * or placed in an `AgentDefinitions` map without a cast.
   */
  readonly name: string;

  /**
   * A runtime witness for `H` (AB-234) — `output !== undefined` in the
   * options this agent was created with. See `RunnableAgent.hasOutput`'s
   * doc comment (`runnable-agent.ts`) for why this exists alongside the
   * compile-time-only `H` parameter.
   */
  readonly hasOutput: boolean;

  /**
   * Start a new in-memory run.
   *
   * - `run('some text')` starts a fresh conversation: `instructions` (if
   *   given) is appended as a system message, followed by `input` as a user
   *   message.
   * - `run({ conversation })` starts the loop from an existing
   *   `ConversationHistory` — the shape a stateless HTTP chat host holds
   *   between requests. The history is SNAPSHOTTED: this run CLONES it
   *   before wrapping it in a fresh internal `Conversation`, so the run's
   *   state and the caller's `ConversationHistory` object are independent
   *   from the moment `run()` is called — the run never mutates the
   *   caller's object, and later mutations by the caller (a stateless host
   *   commonly holds a mutable reference it keeps touching between turns)
   *   never affect an in-flight run. This matches the durable path's
   *   existing snapshot semantics. `instructions` is NOT re-appended in
   *   this form — the supplied history is assumed to already carry
   *   whatever system context it needs, so resuming it repeatedly never
   *   duplicates system messages.
   *
   * `context` (AB-21's `AgentRunContext`) is optional, matching
   * `RunnableAgent.run`: `signal` becomes `RunOptions.signal`, `agentName`
   * overrides the run's stamped agent name, `traceContext` becomes
   * `RunOptions.parentContext`, and `withTraceContext` is forwarded as-is.
   *
   * Returns an `AgentRun` handle — NOT a Promise (non-thenable by design).
   * Access the result via `handle.result()`.
   *
   * Declared as a property-typed function, not method shorthand — see
   * `RunnableAgent.run`'s doc comment (`runnable-agent.ts`) for why.
   */
  run: (
    input: string | { conversation: ConversationHistory },
    context?: AgentRunContext,
  ) => AgentRun<O, H>;
}

// Re-export AgentRun from agent-run.ts so callers who import from create-agent
// still get the canonical type.
export type { AgentRun };

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
 *
 * @example Stateless chat host with a shared toolbox and park-on-approval
 * ```ts
 * import { createToolbox } from 'armorer';
 * import { createAgent, stopWhen } from '@lostgradient/operative';
 *
 * // Built once for this process. This example requires both HTTP requests to
 * // reach this toolbox instance. Multi-process or restart-safe hosts must also
 * // configure every toolbox with the same durable ApprovalStateStore.
 * // Approval-gated tools must declare a stable version, for example `version: '1'`.
 * const toolbox = createToolbox([deleteFileTool], {
 *   approvalPolicy: { mode: 'on-mutation' },
 *   approvalSecret: Bun.env['APPROVAL_SECRET'],
 * });
 *
 * const requestContext = {
 *   authority: {
 *     principalId: currentUser.id,
 *     tenantId: currentTenant.id,
 *     ownerId: currentSession.id,
 *     capabilities: currentAuthorization.capabilities,
 *     authorizationRevision: currentAuthorization.revision,
 *   },
 *   audience: 'tenant',
 *   agentId,
 *   runId,
 * } as const;
 *
 * const agent = createAgent({
 *   generate: myProvider,
 *   toolbox,
 *   executeOptions: { requestContext },
 *   // Combined with noToolCalls(): pendingApproval() alone never stops a
 *   // normal, no-tool-call turn, so a plain text reply would otherwise run
 *   // to maximumSteps instead of finishing.
 *   stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
 * });
 *
 * // Turn 1: run from the client-POSTed history.
 * const run = agent.run({ conversation: clientHistory });
 * const result = await run.result();
 * const pending = result.steps.at(-1)?.results.find((r) => r.pendingApproval)?.pendingApproval;
 * // ...send `pending` to a human, store `result.conversation.current` server-side...
 *
 * // Later, authenticate the approval request and build a fresh context with
 * // the same bound identity fields. Do not reuse an expired request deadline.
 * const approvalRequestContext = {
 *   authority: {
 *     principalId: approvalUser.id,
 *     tenantId: approvalTenant.id,
 *     ownerId: approvalSession.id,
 *     capabilities: approvalAuthorization.capabilities,
 *     authorizationRevision: approvalAuthorization.revision,
 *   },
 *   audience: requestContext.audience,
 *   agentId: requestContext.agentId,
 *   runId: requestContext.runId,
 *   deadline: Date.now() + 30_000,
 * };
 * const resumedResult = await toolbox.resumeApproval(signedApproval, {
 *   requestContext: approvalRequestContext,
 * });
 * // `result.conversation` already has an `action_required` tool-result for
 * // this call (the loop appends it before stopWhen ever runs) — appending
 * // `resumedResult` on top would leave two results for the same call, which
 * // most providers reject on the next turn. Use conversationalist's
 * // resolveToolResult(conversation, callId, resumedResult) to replace the
 * // pending result before starting the next run.
 * ```
 */
export function createAgent<O>(
  options: CreateAgentOptions & { output: ZodType<O> },
): StandaloneAgent<O, true>;
export function createAgent(options: CreateAgentOptions & { output?: undefined }): StandaloneAgent;
export function createAgent(options: CreateAgentOptions): StandaloneAgent<unknown, boolean>;
export function createAgent(options: CreateAgentOptions): StandaloneAgent<unknown, boolean> {
  validateCreateAgentOptions(options);

  const {
    generate,
    tools,
    toolbox: providedToolbox,
    instructions,
    permissions,
    output,
    name: configuredName,
    // Default to `noToolCalls()` when the caller doesn't supply a `stopWhen`
    // — see the doc comment on `CreateAgentOptionsBase.stopWhen`. Falls back
    // to `createActiveRun`'s own "no stop conditions at all" behavior only
    // when explicitly overridden with an empty array.
    stopWhen = noToolCalls(),
    ...rest
  } = options;

  const resolvedName = configuredName ?? '(agent)';

  // Pre-compute tool entries once (pure transform — no per-run state).
  // The map key is canonical — override each tool's inner `.name` with the
  // map key so that the LLM-issued tool call name always matches the key,
  // regardless of what the tool was originally authored with. Skipped
  // entirely when a pre-built `toolbox` is supplied (mutually exclusive).
  const toolEntries = tools
    ? Object.entries(tools).map(([key, tool]) => ({
        ...tool.configuration,
        name: key,
      }))
    : [];

  // Shared by `run()` and the AB-21 definition-resolution protocol below —
  // both need the exact same `RunOptions` bag; only what happens to it
  // (start an in-memory run vs. hand it to a durable engine) differs.
  function buildRunOptions(
    input: string | { conversation: ConversationHistory },
    context?: AgentRunContext,
  ): RunOptions {
    // A caller-supplied `toolbox` is used AS-IS, shared across every run —
    // that's the point (see the `toolbox` option's doc comment: it's what
    // makes armorer's cross-request approval flow possible). Otherwise
    // build a fresh Toolbox for each run: `createActiveRun` attaches
    // listeners to the toolbox emitter and the toolbox tracks per-instance
    // state (loop detection, budget counters), so a toolbox this factory
    // owns must not be shared between concurrent runs.
    const toolbox =
      providedToolbox ??
      createToolbox(
        toolEntries,
        permissions ? { policy: createHeadlessPermissionPolicyHooks(permissions) } : undefined,
      );

    const conversation =
      typeof input === 'string'
        ? (() => {
            // Build a fresh Conversation for each run (ephemeral — no session state).
            const fresh = new Conversation();
            if (instructions) {
              fresh.appendSystemMessage(instructions);
            }
            fresh.appendUserMessage(input);
            return fresh;
          })()
        : // Snapshot semantics: CLONE the supplied history before wrapping it
          // in a fresh Conversation instance. `Conversation`'s constructor
          // only validates its input — it does not copy it — so without the
          // clone this run's initial node would alias the caller's own
          // ConversationHistory object. A stateless host commonly holds a
          // mutable reference it keeps touching between turns; aliasing
          // would let either side's mutations leak into the other. The
          // clone makes this run's state and the caller's object fully
          // independent from the moment `run()` is called: later mutations
          // by the caller (or by another run resuming the same object)
          // never affect this in-flight run, and this run never mutates the
          // caller's object (`ConversationHistory` is a structuredClone-safe
          // tree — see `durable/types.ts`).
          new Conversation(structuredClone(input.conversation));

    return {
      generate,
      toolbox,
      conversation,
      stopWhen,
      output,
      // AB-21: `AgentRunContext` fields translate onto their `RunOptions`
      // equivalents — `agentName` stamps curated `tool.*` events (falling
      // back to this agent's own `name`), `signal` drives per-run abort,
      // `traceContext` is `RunOptions.parentContext` (the field this engine
      // already uses for the same concept), and `withTraceContext` forwards
      // unchanged.
      agentName: context?.agentName ?? resolvedName,
      ...(context?.signal ? { signal: context.signal } : {}),
      ...(context?.traceContext !== undefined ? { parentContext: context.traceContext } : {}),
      ...(context?.withTraceContext ? { withTraceContext: context.withTraceContext } : {}),
      // AB-233 — also thread `childRegistry` into `RunOptions` itself (not
      // just `createAgentRun`'s option below), so `run-step.ts` can hand it
      // to every tool call as `ToolContext.executionContext.childRegistry`.
      ...(context?.childRegistry ? { childRegistry: context.childRegistry } : {}),
      ...rest,
    };
  }

  return {
    name: resolvedName,
    hasOutput: output !== undefined,
    run(
      input: string | { conversation: ConversationHistory },
      context?: AgentRunContext,
    ): AgentRun<unknown, boolean> {
      const activeRun = createActiveRun(buildRunOptions(input, context));
      return createAgentRun<unknown, boolean>(activeRun, {
        hasOutput: output !== undefined,
        // AB-50 — opt-in: only present when the caller supplied one.
        ...(context?.childRegistry ? { childRegistry: context.childRegistry } : {}),
      });
    },
    // AB-21's definition-resolution protocol: resolves the same `RunOptions`
    // bag `run()` builds, without starting an in-memory run, so a durable
    // engine can drive it through `createActiveRun(options, durable)`
    // directly. Private/unstable — see `runnable-agent.ts`.
    [OPERATIVE_RESOLVE_RUN_OPTIONS](
      input: string | { conversation: ConversationHistory },
      context?: AgentRunContext,
    ): Promise<RunOptions> {
      return Promise.resolve(buildRunOptions(input, context));
    },
  };
}
