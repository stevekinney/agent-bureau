import type {
  EventIteratorOptions,
  ObservableLike,
  Observer,
  Subscription,
} from '@lostgradient/lifecycle';
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
import type { Tool } from './is-tool';
import type { ToolboxResolveApprovalOptions } from './toolbox-approval-api';
import type { GrantListFilter, ReusableApprovalGrantInput } from './toolbox-approval-contracts';
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
  AvailableTools,
  MergeTools,
  ToolboxCallInputForTools,
  ToolboxResultForCall,
  ToolsFromEntries,
} from './toolbox-type-inference';
import type {
  SignedPendingToolApproval,
  ToolApprovalResolution,
  ToolCallInput,
  ToolExecutionResult,
  ToolProvider,
} from './types';
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
  detectLoop(): LoopDetectionResult;
  getLoopStatistics(): LoopStatistics;
}

interface LoopStatistics {
  callCount: number;
  hashCounts: Record<string, number>;
}
