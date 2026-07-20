import type { HeadlessPermissionPolicyConfiguration, Tool, Toolbox } from 'armorer';
import { createHeadlessPermissionPolicyHooks, createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

import type { AgentRun } from './agent-run';
import { createAgentRun } from './agent-run';
import { createActiveRun } from './create-run';
import type {
  ContextManagementOptions,
  ConversationHistory,
  GenerateFunction,
  OperativeExecuteOptions,
  RetryOptions,
  RunOptions,
  StopCondition,
  ToolExecutionResult,
} from './types';

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
   * agent with no tools is valid for pure-generation tasks. Mutually
   * exclusive with `toolbox`.
   */
  tools?: Record<string, Tool>;

  /**
   * A pre-built `Toolbox` instance, used as-is for every run started by this
   * agent. Mutually exclusive with `tools` (which composes a fresh internal
   * toolbox instead).
   *
   * Unlike `tools`, a `toolbox` you pass here is NOT rebuilt per run — every
   * `run()` call shares this exact instance. That's required for armorer's
   * cross-request approval flow: `toolbox.resumeApproval(signedApproval)`
   * only verifies a `SignedPendingToolApproval` signed by the *same*
   * `approvalSecret` the toolbox was created with. A host that owns a
   * module-scoped toolbox (stable `approvalSecret` per process) passes it
   * here so approvals minted on one run can be resumed on the next.
   *
   * Because the instance is shared, concurrent runs against the same
   * `StandaloneAgent` will cross-fire each other's toolbox events and share
   * budget/loop-detection counters — the same tradeoff as constructing the
   * toolbox yourself and reusing it. If you don't need cross-run state
   * (approvals, budgets), use `tools` instead for per-run isolation.
   */
  toolbox?: Toolbox;

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

  /**
   * Headless deny-by-default permission mode (AB-94, armorer's
   * `createHeadlessPermissionPolicyHooks`). When set, every tool call is
   * checked against an explicit allowlist/denylist and an optional
   * capability-tier policy and synchronous per-call gate — anything unlisted
   * or that would otherwise require human approval is denied outright (this
   * run never parks on a human). A denial feeds the model a tool-error
   * result and the loop continues; it never throws and never terminates the
   * run.
   *
   * For the opposite mode — parking on a pending approval instead of denying
   * it — pass a pre-built `toolbox` (with its own approval policy) and use
   * `stopWhen: stopWhen.pendingApproval()`. `permissions` only configures a
   * toolbox this factory builds itself, so it's mutually exclusive with
   * `toolbox`.
   */
  permissions?: HeadlessPermissionPolicyConfiguration;
}

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
   * Returns an `AgentRun` handle — NOT a Promise (non-thenable by design).
   * Access the result via `handle.result()`.
   */
  run(input: string | { conversation: ConversationHistory }): AgentRun;
}

// Re-export AgentRun from agent-run.ts so callers who import from create-agent
// still get the canonical type.
export type { AgentRun };

// ---------------------------------------------------------------------------
// resolvePendingApprovalResult — the park-on-approval resume helper
// ---------------------------------------------------------------------------

/**
 * Resolves a pending approval in a `Conversation` in place, for the
 * `stopWhen.pendingApproval()` resume recipe (see `createAgent`'s stateless
 * chat host example above).
 *
 * The agent loop unconditionally appends whatever `ToolExecutionResult` a
 * tool call produced — including a pending approval's `action_required`
 * result — to the conversation *before* evaluating stop conditions.
 * `stopWhen.pendingApproval()` then stops the loop right there, so by the
 * time a host holds the `RunResult`, the conversation already contains that
 * pending result as a real message. Simply appending `toolbox.resumeApproval()`'s
 * resolved result on top would leave TWO tool-result messages for the same
 * call — most providers reject that (or behave unpredictably) on the next
 * turn.
 *
 * This function undoes that pending-result commit and appends the resolved
 * result in its place, so the conversation ends up with exactly one
 * tool-result message for the call. It only undoes when the pending result
 * is still the conversation's most recent message — a safety check, not an
 * assumption: if anything else was appended after it (e.g. the host didn't
 * call this immediately after resuming), undoing would remove the wrong
 * commit, so this returns `false` and changes nothing instead.
 *
 * @returns `true` if the pending result was replaced; `false` if the
 * conversation's last message wasn't the matching pending result (nothing
 * was changed — inspect `conversation.current` before appending manually).
 */
export function resolvePendingApprovalResult(
  conversation: Conversation,
  resolvedResult: ToolExecutionResult,
): boolean {
  const history = conversation.current;
  const lastId = history.ids.at(-1);
  const lastMessage = lastId ? history.messages[lastId] : undefined;

  if (lastMessage?.toolResult?.callId !== resolvedResult.callId) {
    return false;
  }

  conversation.undo();
  conversation.appendToolResults([resolvedResult]);
  return true;
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
 *
 * @example Stateless chat host with a shared toolbox and park-on-approval
 * ```ts
 * import { createToolbox } from 'armorer';
 * import { createAgent, resolvePendingApprovalResult, stopWhen } from 'operative';
 *
 * // Built once per process — the stable approvalSecret is what makes
 * // resumeApproval() work across separate HTTP requests.
 * const toolbox = createToolbox([deleteFileTool], { approvalSecret: Bun.env['APPROVAL_SECRET'] });
 *
 * const agent = createAgent({
 *   generate: myProvider,
 *   toolbox,
 *   stopWhen: stopWhen.pendingApproval(),
 * });
 *
 * // Turn 1: run from the client-POSTed history.
 * const run = agent.run({ conversation: clientHistory });
 * const result = await run.result();
 * const pending = result.steps.at(-1)?.results.find((r) => r.pendingApproval)?.pendingApproval;
 * // ...send `pending` to a human, store `result.conversation.current` server-side...
 *
 * // Later, on approval: resume on the SAME toolbox instance, resolve the
 * // pending result in place on the stored `result.conversation` — replacing
 * // it, not appending alongside it — then start a fresh run from `.current`.
 * const resumedResult = await toolbox.resumeApproval(signedApproval);
 * resolvePendingApprovalResult(result.conversation, resumedResult);
 * const nextRun = agent.run({ conversation: result.conversation.current });
 * ```
 */
export function createAgent(options: CreateAgentOptions): StandaloneAgent {
  validateCreateAgentOptions(options);

  const { generate, tools, toolbox: providedToolbox, instructions, permissions, ...rest } = options;

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

  return {
    run(input: string | { conversation: ConversationHistory }): AgentRun {
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

      const runOptions: RunOptions = {
        generate,
        toolbox,
        conversation,
        ...rest,
      };

      const activeRun = createActiveRun(runOptions);
      return createAgentRun(activeRun);
    },
  };
}
