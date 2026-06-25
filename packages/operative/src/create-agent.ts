import type { Tool } from 'armorer';
import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

import type { AgentRun } from './agent-run';
import { createAgentRun } from './agent-run';
import { createActiveRun } from './create-run';
import type {
  ContextManagementOptions,
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

      const activeRun = createActiveRun(runOptions);
      return createAgentRun(activeRun);
    },
  };
}
