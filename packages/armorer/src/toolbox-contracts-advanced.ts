import type {
  EventIteratorOptions,
  ObservableLike,
  Observer,
  Subscription,
} from '@lostgradient/lifecycle';
import { z } from 'zod';
import type { AnthropicTool } from './adapters/anthropic/types';
import type { GeminiTool } from './adapters/gemini/types';
import type { OpenAITool } from './adapters/openai/types';
import type { ReusableApprovalGrant } from './approval-binding';
import type { InspectorDetailLevel, RegistryInspection } from './core/inspect';
import type { LoopDetectionOptions, LoopDetectionResult } from './core/loop-detection';
import type { ToolboxEventMap } from './event-types';
import type {
  ExecutionCleanupReport,
  ExecutionLifecycle,
  ExecutionSelector,
} from './execution-lifecycle';
import type { Tool, ToolConfiguration, ToolParametersSchema } from './is-tool';
import type { ToolboxResolveApprovalOptions } from './toolbox-approval-api';
import type {
  SerializedToolbox,
  SerializedToolboxJSONSchema,
  ToolboxContext,
  ToolboxEntries,
  ToolboxEventDispatcher,
  ToolboxEventType,
  ToolboxEvents,
  ToolboxExecuteOptions,
  ToolboxOptions,
} from './toolbox-contracts';
import type {
  SignedPendingToolApproval,
  ToolApprovalResolution,
  ToolCallInput,
  ToolExecutionResult,
  ToolProvider,
} from './types';
export type ImportedToolConfiguration = {
  name: string;
  description: string;
  input: ToolParametersSchema;
  namespace?: string;
  version?: string;
  title?: string;
  examples?: readonly string[];
  tags?: ToolConfiguration['tags'];
  metadata?: ToolConfiguration['metadata'];
  risk?: ToolConfiguration['risk'];
  lifecycle?: ToolConfiguration['lifecycle'];
  availability?: ToolConfiguration['availability'];
  execute?: ToolConfiguration['execute'];
  policy?: ToolConfiguration['policy'];
  policyContext?: ToolConfiguration['policyContext'];
  digests?: ToolConfiguration['digests'];
  concurrency?: ToolConfiguration['concurrency'];
  diagnostics?: ToolConfiguration['diagnostics'];
};

export type EntryToTool<TEntry> = TEntry extends Tool ? TEntry : Tool;

export type ToolsFromEntries<TEntries extends ToolboxEntries> = ReadonlyArray<
  EntryToTool<TEntries[number]>
>;

export type MergeTools<
  TLeft extends readonly Tool[],
  TRight extends readonly Tool[],
> = ReadonlyArray<TLeft[number] | TRight[number]>;

type ToolboxToolName<TTools extends readonly Tool[]> = TTools[number]['name'] & string;

type ToolboxToolInput<TTool extends Tool> =
  TTool extends Tool<infer TSchema, any, any, any> ? z.infer<TSchema> : unknown;

type ToolboxToolOutput<TTool extends Tool> =
  TTool extends Tool<any, any, infer TOutput, any> ? TOutput : unknown;

type ToolboxToolByNameOrFallback<TTools extends readonly Tool[], Name extends string> =
  Extract<TTools[number], { name: Name }> extends never
    ? TTools[number]
    : Extract<TTools[number], { name: Name }>;

export type ToolboxCallInputForTools<TTools extends readonly Tool[]> = {
  [Name in ToolboxToolName<TTools>]: {
    id?: string;
    name: Name;
    arguments?: ToolboxToolInput<ToolboxToolByNameOrFallback<TTools, Name>>;
  };
}[ToolboxToolName<TTools>];

export type ToolboxResultForTool<TTool extends Tool> = Omit<
  ToolExecutionResult,
  'toolName' | 'result'
> & {
  toolName: TTool['name'];
  result: ToolboxToolOutput<TTool> | undefined;
};

export type ToolboxResultForCall<TTools extends readonly Tool[], TCall extends { name: string }> =
  TCall['name'] extends ToolboxToolName<TTools>
    ? ToolboxResultForTool<ToolboxToolByNameOrFallback<TTools, TCall['name']>>
    : ToolExecutionResult;

export type AvailableTools<TTools extends readonly Tool[]> = ReadonlyArray<TTools[number]>;

/**
 * Caller-supplied fields for {@link Toolbox.issueGrant} (AB-46, AB-346):
 * every {@link ReusableApprovalGrant} field except the ones the toolbox
 * mints itself (`version`, `id`, `issuedAt`, `usesRemaining`, `revoked`,
 * `signature`). `policyRevision` is optional — omitted, it defaults to the
 * issuing toolbox's current `policyRevision`.
 */
export type ReusableApprovalGrantInput = Omit<
  ReusableApprovalGrant,
  'version' | 'id' | 'issuedAt' | 'usesRemaining' | 'revoked' | 'signature' | 'policyRevision'
> & {
  policyRevision?: string;
};

/** Optional narrowing filter for {@link Toolbox.listGrants}. */
export type GrantListFilter = {
  principalId?: string;
  agentId?: string;
  toolName?: string;
};

export interface Toolbox<TTools extends readonly Tool[] = readonly Tool[]> {
  execute<const TCall extends ToolboxCallInputForTools<TTools>>(
    call: TCall,
    options?: ToolboxExecuteOptions,
  ): Promise<ToolboxResultForCall<TTools, TCall>>;
  execute<const TCalls extends readonly ToolboxCallInputForTools<TTools>[]>(
    calls: [...TCalls],
    options?: ToolboxExecuteOptions,
  ): Promise<{ [K in keyof TCalls]: ToolboxResultForCall<TTools, TCalls[K]> }>;
  execute(call: ToolCallInput, options?: ToolboxExecuteOptions): Promise<ToolExecutionResult>;
  execute(calls: ToolCallInput[], options?: ToolboxExecuteOptions): Promise<ToolExecutionResult[]>;
  resumeApproval(
    approval: SignedPendingToolApproval,
    options?: ToolboxExecuteOptions & { arguments?: unknown },
  ): Promise<ToolExecutionResult>;
  resolveApproval(
    approval: SignedPendingToolApproval,
    resolution: ToolApprovalResolution,
    options: ToolboxResolveApprovalOptions,
  ): Promise<ToolExecutionResult>;
  restoreApproval(approval: SignedPendingToolApproval): Promise<void>;
  revokeApproval(approval: SignedPendingToolApproval): Promise<void>;
  /**
   * Mints and signs a {@link ReusableApprovalGrant} (AB-46, AB-346):
   * `id`/`issuedAt` are minted from the toolbox's own nonce generator and
   * clock, `usesRemaining` is initialized to `maxUses`, `policyRevision`
   * defaults to the toolbox's current revision when omitted, and the result
   * is signed with `approvalSecret` before being handed to the grant state
   * store. Throws when the toolbox has no `approvalSecret` configured — an
   * unsigned grant can never be trusted at match time.
   */
  issueGrant(input: ReusableApprovalGrantInput): Promise<ReusableApprovalGrant>;
  /** Revokes a reusable approval grant by id; idempotent on an unknown or already-revoked id. */
  revokeGrant(id: string): Promise<void>;
  /** Lists reusable approval grants, optionally narrowed by principal, agent, or tool. */
  listGrants(filter?: GrantListFilter): Promise<ReusableApprovalGrant[]>;
  extend<const TEntries extends ToolboxEntries>(
    ...entries: TEntries
  ): Toolbox<MergeTools<TTools, ToolsFromEntries<TEntries>>>;
  extend<const TOtherTools extends readonly Tool[]>(
    toolbox: Toolbox<TOtherTools>,
  ): Toolbox<MergeTools<TTools, TOtherTools>>;
  tools: () => TTools;
  getAvailable: () => Promise<AvailableTools<TTools>>;
  getTool(nameOrId: string): TTools[number] | undefined;
  /**
   * Returns names of tools that are not present in this toolbox.
   * Useful for fail-soft agent gating.
   */
  getMissingTools: (names: string[]) => string[];
  /**
   * Checks if all specified tools are present in this toolbox.
   */
  hasAllTools: (names: string[]) => boolean;
  /**
   * Inspects the toolbox and returns a typed JSON summary of all configured tools.
   * Useful for debugging and logging which tools are available before model calls.
   *
   * @param detailLevel - Level of detail to include:
   *   - `summary`: Names, descriptions, tags, and counts only
   *   - `standard`: Adds schema keys and metadata flags (default)
   *   - `full`: Includes complete schema shape details
   */
  inspect: (detailLevel?: InspectorDetailLevel) => RegistryInspection;
  toProvider: (
    provider: ToolProvider,
    options?: unknown,
  ) => Promise<OpenAITool[] | AnthropicTool[] | GeminiTool[]>;
  toOpenAITools: () => Promise<OpenAITool[]>;
  toAnthropicTools: () => Promise<AnthropicTool[]>;
  toGeminiTools: () => Promise<GeminiTool[]>;
  asExecuteResolver: () => NonNullable<ToolboxOptions['getTool']>;
  toJSON: {
    (): SerializedToolbox;
    (options: { format: 'configuration' }): SerializedToolbox;
    (options: { format: 'json-schema' }): SerializedToolboxJSONSchema;
  };
  addEventListener: <K extends keyof ToolboxEventMap & string>(
    type: K,
    listener: (event: ToolboxEventMap[K]) => void | Promise<void>,
    options?: AddEventListenerOptions,
  ) => () => void;
  dispatchEvent: ToolboxEventDispatcher;
  emit: <K extends ToolboxEventType>(type: K, detail: ToolboxEvents[K]) => boolean;

  // Observable-based event methods
  on: <K extends keyof ToolboxEventMap & string>(
    type: K,
    options?: { signal?: AbortSignal },
  ) => ObservableLike<ToolboxEventMap[K]>;
  once: <K extends keyof ToolboxEventMap & string>(
    type: K,
    listener: (event: ToolboxEventMap[K]) => void,
  ) => void;
  subscribe: <K extends keyof ToolboxEventMap & string>(
    type: K,
    observerOrNext?: Observer<ToolboxEventMap[K]> | ((value: ToolboxEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  toObservable: () => ObservableLike<Event>;

  // Async iteration
  events: <K extends keyof ToolboxEventMap & string>(
    type: K,
    options?: EventIteratorOptions,
  ) => AsyncIterableIterator<ToolboxEventMap[K]>;

  // Lifecycle methods
  complete: () => Promise<void>;
  readonly completed: boolean;
  readonly activeExecutions: number;
  readonly executionSignal: AbortSignal;
  readonly executions: ExecutionLifecycle;
  whenIdle: () => Promise<void>;
  closeAdmission: () => void;
  abort: (selector?: ExecutionSelector, reason?: unknown) => number;
  shutdown: (options?: {
    policy?: 'abort' | 'drain';
    reason?: unknown;
  }) => Promise<ExecutionCleanupReport>;

  // Internal method to get toolbox context.
  getContext?: () => ToolboxContext;

  /**
   * Creates a loop detector for this toolbox.
   * The detector is shared across all execute() calls for the toolbox's lifetime.
   *
   * Detects:
   * - Ping-pong loops: alternating calls (A→B→A→B...)
   * - Repetition loops: same call repeated consecutively
   *
   * @param options - Loop detection configuration
   * @returns A LoopDetector instance
   *
   * @example
   * ```typescript
   * const toolbox = createToolbox([toolA, toolB]);
   * const detector = toolbox.createLoopDetector({
   *   pingPongThreshold: 10,
   *   repetitionThreshold: 10,
   * });
   *
   * await toolbox.execute(...);
   * const result = detector.detectLoop();
   * if (result.detected) {
   *   console.log(result.message);
   * }
   * ```
   */
  createLoopDetector: (options?: LoopDetectionOptions) => LoopDetectorInstance;
}

/**
 * An erased `Toolbox` whose tool-tuple type parameter has been widened away.
 *
 * `Toolbox<TTools>` is invariant in `TTools`: the tuple appears in both input
 * and output positions (the typed `execute` overloads, `extend`, `tools`,
 * `getAvailable`, and `getTool`), so a concretely-typed
 * `Toolbox<ConcreteTools>` (what `createToolbox([...])` returns) is not
 * assignable to the bare `Toolbox<readonly Tool[]>` default — TypeScript has
 * to check both directions, and the concrete tuple loses information in the
 * direction that matters.
 *
 * `AnyToolbox` sidesteps that by being a genuine supertype instead of relying
 * on the invariant generic's default: every member that doesn't depend on
 * `TTools` is carried over unchanged via `Omit`, and the handful that do are
 * redeclared against the untyped, tuple-independent overloads that already
 * exist on `Toolbox` (its untyped `execute(call: ToolCallInput, ...)`
 * overloads, `readonly Tool[]` for `tools`/`getAvailable`/`getTool`). Any
 * `Toolbox<TTools>`, for any `TTools`, structurally satisfies `AnyToolbox`
 * with no cast.
 *
 * Use `AnyToolbox` wherever a toolbox is accepted or stored but only ever
 * executed generically — its tool tuple is never inspected for compile-time
 * call/result typing (e.g. `CreateAgentOptions.toolbox`, a bureau's
 * pre-built toolbox). Use `Toolbox<TTools>` (with an inferred `TTools`) when
 * the tuple-aware `execute` overloads are actually exercised.
 */
export interface AnyToolbox extends Omit<
  Toolbox,
  'execute' | 'extend' | 'tools' | 'getAvailable' | 'getTool'
> {
  execute(call: ToolCallInput, options?: ToolboxExecuteOptions): Promise<ToolExecutionResult>;
  execute(calls: ToolCallInput[], options?: ToolboxExecuteOptions): Promise<ToolExecutionResult[]>;
  extend(...entries: ToolboxEntries): AnyToolbox;
  extend(toolbox: Toolbox | AnyToolbox): AnyToolbox;
  tools: () => readonly Tool[];
  getAvailable: () => Promise<readonly Tool[]>;
  getTool(nameOrId: string): Tool | undefined;
}

export interface LoopDetectorInstance {
  /**
   * Detect if a loop is currently happening.
   */
  detectLoop(): LoopDetectionResult;

  /**
   * Get statistics about loop detection state.
   */
  getLoopStatistics(): LoopStatistics;
}

export type InternalToolboxOptions = Pick<
  ToolboxOptions,
  | 'policy'
  | 'policyContext'
  | 'approvalPolicy'
  | 'approvalSecret'
  | 'approvalStateStore'
  | 'grantStateStore'
  | 'approvalBindingTtlMs'
  | 'approvalNow'
  | 'approvalNonce'
  | 'policyRevision'
  | 'approvalRevision'
  | 'toolboxRevision'
  | 'readOnly'
  | 'allowMutation'
  | 'allowDangerous'
>;

// Re-export loop detection types for public API
export type {
  LoopDetectionOptions,
  LoopDetectionResult,
  LoopStatistics,
} from './core/loop-detection';

interface LoopStatistics {
  callCount: number;
  hashCounts: Record<string, number>;
}

/**
 * Creates an immutable toolbox for managing and executing AI tools.
 *
 * A toolbox provides a central immutable tool set with validation, execution,
 * event hooks, policies, and provider adapters. Tools are provided up front at
 * creation time and can be executed individually or in batch.
 *
 * @param entries - Optional array of tool configurations or built tools
 * @param options - Configuration options for the toolbox
 * @param options.context - Shared context object passed to all tool executions
 * @param options.middleware - Array of middleware functions to transform tools during toolbox creation
 * @param options.policy - Global policy hooks for access control and validation
 * @param options.policyContext - Provider function for dynamic policy context
 * @param options.digests - Configuration for input/output hashing
 * @param options.concurrency - Max concurrent tool executions (default: 10)
 * @param options.telemetry - Enable telemetry events (tool.started, tool.finished)
 * @param options.embed - Embedding function for semantic search capabilities
 * @param options.budget - Execution budget limits (maxCalls, maxDurationMs)
 * @param options.readOnly - If true, blocks mutating tool execution by default
 * @param options.allowMutation - If false, blocks mutating tool execution
 * @param options.allowDangerous - If true, allows tools with 'dangerous' risk level (default: true)
 *
 * @returns A Toolbox instance with methods for inspecting and executing tools
 *
 * @example
 * ```typescript
 * import { createToolbox, createTool } from 'armorer';
 * import { z } from 'zod';
 *
 * // Create a toolbox with tools up front
 * const addTool = createTool({
 *   name: 'add',
 *   description: 'Add two numbers',
 *   input: z.object({ a: z.number(), b: z.number() }),
 *   execute: async ({ a, b }) => a + b,
 * });
 * const toolbox = createToolbox([addTool]);
 *
 * // Execute a tool
 * const result = await toolbox.execute({
 *   id: 'call-1',
 *   name: 'add',
 *   arguments: { a: 5, b: 3 },
 * });
 * console.log(result.result); // 8
 * ```
 *
 * @example With middleware and policies
 * ```typescript
 * const toolbox = createToolbox([addTool], {
 *   middleware: [
 *     (tool) => ({ ...tool, tags: [...tool.tags, 'monitored'] })
 *   ],
 *   policy: {
 *     async before(ctx) {
 *       if (!ctx.context.user) {
 *         return { status: 'denied', reason: 'Authentication required' };
 *       }
 *       return { status: 'allowed' };
 *     },
 *   },
 *   concurrency: 5,
 *   telemetry: true,
 * });
 * ```
 */
/**
 * The approval- and toolbox-identity-related subset of `ToolboxOptions`
 * that `combineToolboxes` (`combine-toolboxes.ts`) forwards from the first
 * toolbox into a combined toolbox (AB-362) — the same options `extend()`
 * already forwards into an extended toolbox. This is a narrow, explicit
 * allowlist, not "every option minus a growing exclude list": two fields
 * that seemed safe to forward broadly at first turned out not to be
 * (`middleware` double-applies to already-transformed configurations;
 * `signal` ties the combined toolbox's abort listener to a signal it
 * never gets a chance to detach from on normal completion, accumulating
 * listeners across repeated short-lived combinations under one long-lived
 * signal) — both AB-362 review findings. An allowlist means the next
 * option added to `ToolboxOptions` is excluded from forwarding by
 * default, not forwarded by default. `policyRevision`, `approvalRevision`,
 * and `toolboxRevision` are included even though they are not
 * approval-specific by name: `restoreApproval`'s staleness check compares
 * each against the *toolbox's own* resolved value (defaulting to
 * `'policy:1'` / `'approval:1'` / `'toolbox:1'` when unset), so silently
 * reverting to those defaults on combination would make every approval
 * binding issued by a toolbox with customized revisions look stale (or
 * pass when it should not) the moment it is combined. `policyContext` is
 * included alongside `policy` for the same reason they must travel
 * together: a registry-level `policy.beforeExecute` hook that branches on
 * `policyContext` (a tenant flag, an approval-context provider) would
 * otherwise be forwarded without the context it reads, silently defaulting
 * to whatever the hook does when that context is absent—which can mean
 * a call that should return `needs_approval` executes immediately instead
 * (AB-362 review finding).
 */
