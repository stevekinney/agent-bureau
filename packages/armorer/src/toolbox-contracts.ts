import type { RuntimeServices } from '@lostgradient/lifecycle';
import type {
  Context as OpenTelemetryContext,
  Link as OpenTelemetrySpanLink,
} from '@opentelemetry/api';
import type { ApprovalStateStore, GrantStateStore } from './approval-binding';
import type { ApprovalPolicyConfiguration } from './approval-policy';
import type { ToolErrorCategory } from './core/errors';
import type { LoopDetectionOptions } from './core/loop-detection';
import type {
  QuerySelectionResult,
  ToolMatch,
  ToolQuery,
  ToolSearchOptions,
} from './core/registry';
import type { Embedder } from './core/registry/embeddings';
import type { SerializedToolDefinition } from './core/serialization';
import type { ToolExecutionIdentity } from './event-types';
import type { ExecutionHandle, ExecutionSnapshot } from './execution-lifecycle';
import type { ApprovalAdmissionRollback, ApprovalResumeState } from './internal/approval-resume';
import {
  approvalConsumeSymbol,
  approvalResumeSymbol,
  policyAuthorizationOnlySymbol,
} from './internal/approval-resume';
import type {
  MinimalAbortSignal,
  Tool,
  ToolCallWithArguments,
  ToolConfiguration,
  ToolConfigurationInput,
  ToolConfigurationInputWithoutExecute,
  ToolDigestOptions,
  ToolExecuteOptions,
  ToolParametersSchema,
  ToolPolicyContextProvider,
  ToolPolicyHooks,
} from './is-tool';
import type { ToolSettledEvent } from './tool-lifecycle-events';
import type { Toolbox } from './toolbox-contracts-advanced';
import type { ToolCall, ToolExecutionResult } from './types';
export type ToolboxContext = Record<string, unknown>;

export type ToolboxRuntimeContext<Ctx extends ToolboxContext = ToolboxContext> = Ctx & {
  dispatchEvent: ToolboxEventDispatcher;
  configuration: ToolConfiguration;
  toolCall: ToolCall;
  durableOperationKey?: string;
  signal?: MinimalAbortSignal;
  /** Execution timeout in milliseconds. */
  timeout?: number;
  stream?: boolean;
};

export type SerializedToolbox = readonly ToolConfiguration[];
export type SerializedToolboxJSONSchema = readonly SerializedToolDefinition[];

export type ToolMiddleware = (configuration: ToolConfiguration) => ToolConfiguration;

/**
 * Type-safe helper for creating middleware functions.
 *
 * @example
 * ```ts
 * const addMetadata = createMiddleware((configuration) => ({
 *   ...configuration,
 *   metadata: { ...configuration.metadata, source: 'middleware' },
 * }));
 *
 * const toolbox = createToolbox([], {
 *   middleware: [addMetadata],
 * });
 * ```
 */
export function createMiddleware(
  fn: (configuration: ToolConfiguration) => ToolConfiguration,
): ToolMiddleware {
  return fn;
}

export interface ToolboxOptions {
  signal?: MinimalAbortSignal;
  context?: ToolboxContext;
  catalogRevision?: string;
  toolboxRevision?: string;
  policyRevision?: string;
  approvalRevision?: string;
  redactionRevision?: string;
  embed?: Embedder;
  policy?: ToolPolicyHooks;
  policyContext?: ToolPolicyContextProvider | Record<string, unknown>;
  digests?: ToolDigestOptions;
  budget?: { maxCalls?: number; maxDurationMs?: number };
  concurrency?: number;
  telemetry?: boolean;
  readOnly?: boolean;
  allowMutation?: boolean;
  allowDangerous?: boolean;
  /**
   * The two-axis approval policy (AB-22): capability tier (read-only /
   * mutating / dangerous, derived from tool metadata) x approval mode (never
   * / on-mutation / always / deny). When set, this is evaluated before any
   * registry- or tool-level `policy.beforeExecute` hook, so persona/skill
   * tool policies can only narrow it further, never bypass it. `readOnly`,
   * `allowMutation`, and `allowDangerous` remain available as a simpler
   * boolean shorthand for the read-only/mutating/dangerous deny gates; when
   * both are configured, the most restrictive verdict of the two wins.
   */
  approvalPolicy?: ApprovalPolicyConfiguration;
  toolFactory?: (configuration: ToolConfiguration, context: ToolboxFactoryContext) => Tool;
  /**
   * Called when a tool configuration doesn't have an execute method.
   * This typically happens when deserializing a toolbox.
   * Should return an execute function or a promise that resolves to one.
   */
  getTool?: (
    configuration: ToolConfigurationInput | ToolConfigurationInputWithoutExecute,
  ) => ToolConfiguration['execute'];
  /**
   * Array of middleware functions to transform tool configurations during toolbox creation.
   * Middleware is applied in order before each tool is built.
   */
  middleware?: ToolMiddleware[];
  /**
   * Enable fuzzy tool name resolution for misnamed tool calls.
   */
  resolution?: boolean | { tiers?: Array<'case-insensitive' | 'normalized' | 'suffix'> };
  /**
   * Enable loop detection for stuck tool call patterns.
   * When true, uses default thresholds. Pass an object to customize.
   */
  loopDetection?: boolean | LoopDetectionOptions;
  /**
   * Called when a deprecated tool is executed via this toolbox.
   * Receives the tool definition and the call info (name and optional id).
   */
  onDeprecatedToolCalled?: (tool: ToolConfiguration, call: { name: string; id?: string }) => void;
  /**
   * Secret used to sign durable approval descriptors. Use the same value across
   * processes that need to resume approvals created by this toolbox.
   */
  approvalSecret?: string;
  approvalStateStore?: ApprovalStateStore;
  approvalBindingTtlMs?: number;
  approvalNow?: () => number;
  approvalNonce?: () => string;
  /**
   * Reusable-approval-grant storage (AB-46, AB-346). Grant matching inside
   * `mergePolicies`'s `beforeExecute` checks for a matching, unrevoked,
   * unexpired grant with `usesRemaining > 0` ahead of
   * `evaluateCapabilityApproval`'s `ask` outcome; a match lets the call
   * execute without prompting for approval. Grants are signed with the same
   * `approvalSecret` pending approvals use, so this only ever defaults to a
   * process-local store when `approvalSecret` is configured — there is no
   * trustworthy default without a secret to verify against.
   */
  grantStateStore?: GrantStateStore;
  /**
   * The injectable runtime-service seam (AB-92's `RuntimeServices`, AB-254):
   * wall time, monotonic time, timers, identifiers, and randomness for this
   * toolbox, its `ExecutionLifecycle`, and every tool it constructs.
   * Resolved once at construction — `options.runtime ?? createDefaultRuntimeServices()`
   * — and snapshotted; a test composes its own from
   * `armorer/test`'s `createManualRuntimeServices()` instead of touching a
   * real timer or a real clock. Unconfigured, this defaults to the real
   * globals, so an existing caller is unaffected.
   */
  runtime?: RuntimeServices;
}

export interface ImportedToolboxOptions extends ToolboxOptions {
  sourceToolbox?: Toolbox;
}

export interface ToolboxFactoryContext {
  dispatchEvent: ToolboxEventDispatcher;
  emit: <K extends ToolboxEventType>(type: K, detail: ToolboxEvents[K]) => boolean;
  baseContext: ToolboxContext;
  buildDefaultTool: (configuration: ToolConfiguration) => Tool;
}

/**
 * Status update payload for tool progress reporting.
 */
export interface ToolStatusUpdate {
  callId: string;
  name: string;
  status: string;
  percent?: number;
  eta?: number;
  message?: string;
}

export interface ToolboxEvents {
  call: {
    tool: Tool;
    call: ToolCall;
    parentContext?: OpenTelemetryContext;
    spanLinks?: OpenTelemetrySpanLink[];
  };
  complete: { tool: Tool; result: ToolExecutionResult } & ToolExecutionIdentity;
  error: { tool?: Tool; result: ToolExecutionResult } & ToolExecutionIdentity;
  'not-found': ToolCall;
  query: { criteria?: ToolQuery; results: QuerySelectionResult };
  search: { options: ToolSearchOptions; results: ToolMatch<unknown>[] };
  /** Tool status/progress updates for UI display */
  'status:update': ToolStatusUpdate & ToolExecutionIdentity;
  // Bubbled tool events (when executing multiple tools in parallel)
  'execute-start': { tool: Tool; call: ToolCall; params: unknown } & ToolExecutionIdentity;
  'validate-success': {
    tool: Tool;
    call: ToolCall;
    params: unknown;
    parsed: unknown;
  } & ToolExecutionIdentity;
  'validate-error': {
    tool: Tool;
    call: ToolCall;
    params: unknown;
    error: unknown;
  } & ToolExecutionIdentity;
  'execute-success': { tool: Tool; call: ToolCall; result: unknown } & ToolExecutionIdentity;
  'execute-error': { tool: Tool; call: ToolCall; error: unknown } & ToolExecutionIdentity;
  settled: {
    status?: ToolSettledEvent['status'];
    tool: Tool;
    call: ToolCall;
    result?: unknown;
    error?: unknown;
    /**
     * Settles only once this call's own tool callback has genuinely
     * returned or thrown, distinct from this event's own cancellation-race
     * settlement — see {@link ExecutionHandle.whenSettled} (AB-289).
     */
    callbackCompletion?: Promise<ExecutionSnapshot>;
  } & ToolExecutionIdentity;
  'policy-denied': {
    tool: Tool;
    call: ToolCall;
    params: unknown;
    reason?: string;
  } & ToolExecutionIdentity;
  'tool.started': {
    tool: Tool;
    call: ToolCall;
    // Original event properties
    toolCall: ToolCallWithArguments;
    configuration: ToolConfiguration;
    params: unknown;
    startedAt: number;
    inputDigest?: string;
  } & ToolExecutionIdentity;
  'tool.finished': {
    tool: Tool;
    call: ToolCall;
    // Original event properties
    toolCall: ToolCallWithArguments;
    configuration: ToolConfiguration;
    status: 'success' | 'error' | 'denied' | 'cancelled' | 'paused';
    durationMs: number;
    startedAt: number;
    finishedAt: number;
    result?: unknown;
    error?: unknown;
    reason?: string;
    errorCategory?: ToolErrorCategory;
    inputDigest?: string;
    outputDigest?: string;
  } & ToolExecutionIdentity;
  'budget-exceeded': { tool: Tool; call: ToolCall; reason: string };
  progress: {
    tool: Tool;
    call: ToolCall;
    percent?: number;
    message?: string;
  } & ToolExecutionIdentity;
  'stream-start': {
    tool: Tool;
    call: ToolCall;
    mode: 'stream' | 'collect';
  } & ToolExecutionIdentity;
  'stream-chunk': {
    tool: Tool;
    call: ToolCall;
    chunk: unknown;
    index: number;
  } & ToolExecutionIdentity;
  'stream-end': {
    tool: Tool;
    call: ToolCall;
    chunks: number;
    completed: boolean;
  } & ToolExecutionIdentity;
  'stream-error': {
    tool: Tool;
    call: ToolCall;
    error: unknown;
    index: number;
  } & ToolExecutionIdentity;
  'output-chunk': { tool: Tool; call: ToolCall; chunk: unknown } & ToolExecutionIdentity;
  log: {
    tool: Tool;
    call: ToolCall;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    data?: unknown;
  } & ToolExecutionIdentity;
  cancelled: { tool: Tool; call: ToolCall; reason?: string } & ToolExecutionIdentity;
  'name-resolved': { originalName: string; resolvedName: string; tier: string };
  'loop-warning': { tool: Tool; call: ToolCall; detector: string; count: number; message: string };
  'loop-blocked': { tool: Tool; call: ToolCall; detector: string; count: number; message: string };
  'grant.used': GrantUsedDetail;
}

/**
 * Detail carried by the `'grant.used'` toolbox event (AB-46, AB-346): the
 * audit entry a reusable-approval-grant match records when it short-circuits
 * `evaluateCapabilityApproval`'s `ask` outcome to an allow.
 */
export type GrantUsedDetail = {
  grantId: string;
  toolName: string;
  call: ToolCall;
  principalId: string;
  usesRemaining: number;
  /**
   * The consuming call's `requestContext.runId`/`agentId`, when supplied —
   * a shared toolbox (e.g. Bureau's base toolbox) serves many runs, so an
   * audit consumer needs run/agent identity to attribute a `grant.used`
   * entry, the same way every other toolbox event carries
   * `ToolExecutionIdentity`.
   */
  runId?: string;
  agentId?: string;
};

export type ToolboxEventType = Extract<keyof ToolboxEvents, string>;

export type ToolboxEventDispatcher = (event: Event) => boolean;

export interface ToolboxExecuteOptions extends Omit<ToolExecuteOptions, 'durableOperationKey'> {
  concurrency?: number;
  mode?: 'parallel' | 'sequential';
  errorMode?: 'failFast' | 'collect';
  parentContext?: OpenTelemetryContext;
  spanLinks?: OpenTelemetrySpanLink[];
  durableOperationKey?: string | ((call: ToolCall, index: number) => string | undefined);
  idempotencyKey?: string | ((call: ToolCall) => string | undefined);
  resolutionReceipt?: import('./idempotency/types').IdempotencyResolutionReceipt;
}

export type InternalToolboxExecuteOptions = ToolboxExecuteOptions & {
  [approvalResumeSymbol]?: ApprovalResumeState;
  [policyAuthorizationOnlySymbol]?: boolean;
  executionHandle?: ExecutionHandle;
};

export type InternalToolExecuteOptionsWithMirror = ToolboxExecuteOptions & {
  [approvalConsumeSymbol]?: () => Promise<ApprovalAdmissionRollback>;
  [approvalResumeSymbol]?: ApprovalResumeState;
  [policyAuthorizationOnlySymbol]?: boolean;
  executionHandle?: ExecutionHandle;
  privilegedContextMirrorHandle?: ExecutionHandle;
  parentCompletionHandle?: ExecutionHandle;
  onParentCompletionPending?: (pending: boolean) => void;
};

export type ResumeApprovalValidationResult =
  | {
      outcome: 'parsed';
      parsedArguments: Awaited<ReturnType<ToolParametersSchema['safeParseAsync']>>;
    }
  | { outcome: 'interrupted'; result: ToolExecutionResult };

export type ToolboxEntry = ToolConfigurationInput | Tool;
export type ToolboxEntries = readonly ToolboxEntry[];
