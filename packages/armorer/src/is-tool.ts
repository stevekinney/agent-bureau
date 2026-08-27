import type { EventIteratorOptions, ObservableLike, Observer, Subscription } from 'lifecycle';
import { z } from 'zod';

import type { ToolContext as CoreToolContext } from './core/context';
import type { ToolErrorCategory } from './core/errors';
import type { JsonObject } from './core/serialization/json';
import type { ToolAvailabilityHook, ToolDefinition } from './core/tool-definition';
import type { ToolEventMap } from './events';
import type { EffectiveToolExecutionContext, ToolRequestContext } from './execution-context';
import type { ExecutionHandle, ExecutionLifecycle } from './execution-lifecycle';
import { policyPauseDecisionsSymbol, policyPauseTierSymbol } from './internal/approval-resume';
import type { PolicyPauseTier, ToolCall, ToolExecutionResult } from './types';

export type ToolParametersSchema = z.ZodTypeAny;
/** @deprecated Use standard AddEventListenerOptions instead. */
export type AddEventListenerOptionsLike = AddEventListenerOptions;
/** @deprecated Use EventIteratorOptions from lifecycle instead. */
export type AsyncIteratorOptions = EventIteratorOptions;
export type { EventIteratorOptions, ObservableLike, Observer, Subscription } from 'lifecycle';

export type MinimalAbortSignal = AbortSignal;
export type TimeoutHandle = unknown;
export type ScheduleTimeout = (callback: () => void, milliseconds?: number) => TimeoutHandle;
export type ClearScheduledTimeout = (handle: TimeoutHandle) => void;

/**
 * Unified tool configuration type.
 *
 * Uses `unknown` for execute params and context to prevent type explosion
 * from z.infer<T> while remaining compatible with all tool signatures.
 * Runtime schema validation provides actual type safety.
 */
export type ToolConfiguration = ToolDefinition<Record<string, unknown>, unknown> & {
  input: ToolParametersSchema;
  metadata?: ToolMetadata;
  availability?: ToolAvailabilityHook;
  execute:
    | ((params: unknown, context?: unknown) => Promise<unknown>)
    | Promise<(params: unknown, context?: unknown) => Promise<unknown>>;
  policy?: ToolPolicyHooks;
  policyContext?: ToolPolicyContextProvider;
  digests?: ToolDigestOptions;
  concurrency?: number;
  diagnostics?: ToolDiagnostics;
};

export type ToolEventsMap = Record<string, unknown>;

export type ToolValidationWarning = {
  path: Array<string | number>;
  code: string;
  from: unknown;
  to: unknown;
  via: string;
};

export type ToolValidationReport = {
  warnings: ToolValidationWarning[];
  cost: number;
};

export type ToolRepairHint = {
  path: string;
  message: string;
  suggestion: string;
};

export type ToolDiagnosticsAdapter = {
  safeParseWithReport: (
    schema: unknown,
    value: unknown,
  ) =>
    | { success: true; data: unknown; report: ToolValidationReport }
    | { success: false; error: unknown; report: ToolValidationReport };
  createRepairHints: (error: unknown, options?: { rootLabel?: string }) => ToolRepairHint[];
};

export type ToolDiagnostics = Partial<ToolDiagnosticsAdapter>;

/**
 * Tool call with parsed arguments.
 * Uses unknown to prevent type explosion from z.infer<T> in generic positions.
 * Runtime schema validation provides actual type safety.
 */
export type ToolCallWithArguments = ToolCall & {
  arguments: unknown;
};

export type ToolEventDetailContext = {
  toolCall: ToolCall;
  configuration: ToolConfiguration;
};

export type ToolMetadata = JsonObject & {
  mutates?: boolean;
  readOnly?: boolean;
  dangerous?: boolean;
  concurrency?: number;
};

export type ToolPolicyDecision = {
  /** A policy may only reduce the caller's capabilities. */
  capabilities?: readonly string[];
  [policyPauseDecisionsSymbol]?: readonly ToolPolicyDecision[];
  [policyPauseTierSymbol]?: PolicyPauseTier;
  /**
   * Whether the call may proceed. Optional: when omitted, it is derived from
   * `status` (`'allow'` or no status → `true`; `'deny'`, `'needs_approval'`,
   * `'needs_input'` → `false`). An explicit `allow` is used as-is — no
   * agreement with `status` is validated. The two answer different
   * questions: `status: 'needs_approval'`/`'needs_input'` pauses the call
   * regardless of `allow`, while `allow: false` denies outright when no
   * pause is requested.
   */
  allow?: boolean;
  reason?: string;
  status?: 'allow' | 'deny' | 'needs_approval' | 'needs_input';
  action?: {
    message?: string;
    schema?: unknown;
  };
};

/**
 * A `ToolPolicyDecision` whose `allow` has been resolved — what the policy
 * pipeline consumes after `resolveToolPolicyAllow` fills in an omitted
 * `allow` from `status`.
 */
export type ResolvedToolPolicyDecision = ToolPolicyDecision & {
  allow: boolean;
};

/**
 * Fill in an omitted `allow` from `status`: `'deny'`, `'needs_approval'`,
 * and `'needs_input'` resolve to `allow: false`; `'allow'` (or no status —
 * a decision carrying only, say, a `reason`) resolves to `allow: true`.
 * A decision that already sets `allow` is returned unchanged.
 */
export function resolveToolPolicyAllow(decision: ToolPolicyDecision): ResolvedToolPolicyDecision {
  if (decision.allow !== undefined) {
    return decision as ResolvedToolPolicyDecision;
  }
  const allow = decision.status === undefined || decision.status === 'allow';
  return { ...decision, allow };
}

export type ToolPolicyContext = {
  toolName: string;
  toolCall: ToolCall;
  params: unknown;
  inputDigest?: string;
  policyContext?: Record<string, unknown>;
  tags?: readonly string[];
  metadata?: ToolMetadata;
  configuration: ToolConfiguration;
};

export type ToolPolicyAfterContext = ToolPolicyContext & {
  outcome: 'success' | 'error' | 'denied' | 'action_required';
  result?: unknown;
  outputDigest?: string;
  errorCategory?: ToolErrorCategory;
  error?: unknown;
  reason?: string;
};

export type ToolPolicyHooks = {
  beforeExecute?: (
    context: ToolPolicyContext,
  ) => ToolPolicyDecision | void | Promise<ToolPolicyDecision | void>;
  afterExecute?: (context: ToolPolicyAfterContext) => void | Promise<void>;
};

export type ToolPolicyContextProvider = (
  context: ToolPolicyContext,
) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;

export type ToolDigestOptions =
  | boolean
  | {
      input?: boolean;
      output?: boolean;
      algorithm?: 'sha256';
    };

export type DefaultToolEvents = {
  'status-update': { status: string };
  'execute-start': { params: unknown } & ToolEventDetailContext;
  'validate-success': { params: unknown; parsed: unknown } & ToolEventDetailContext;
  'validate-error': {
    params: unknown;
    error: unknown;
    report?: ToolValidationReport;
    repairHints?: ToolRepairHint[];
  } & ToolEventDetailContext;
  'execute-success': { result: unknown } & ToolEventDetailContext;
  'execute-error': { error: unknown } & ToolEventDetailContext;
  settled: {
    result?: unknown;
    error?: unknown;
  } & ToolEventDetailContext;
  'policy-denied': { params: unknown; reason?: string } & ToolEventDetailContext;
  'policy-action-required': { params: unknown; reason?: string } & ToolEventDetailContext;
  'tool.started': {
    params: unknown;
    startedAt: number;
    inputDigest?: string;
  } & ToolEventDetailContext;
  'tool.finished': {
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
  } & ToolEventDetailContext;
  progress: { percent?: number; message?: string };
  'stream-start': { mode: 'stream' | 'collect' };
  'stream-chunk': { chunk: unknown; index: number };
  'stream-end': { chunks: number; completed: boolean };
  'stream-error': { error: unknown; index: number };
  'output-chunk': { chunk: unknown };
  log: { level: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown };
  cancelled: { reason?: string };
};

export type MergeEvents<Custom extends ToolEventsMap> = DefaultToolEvents & Custom;

/**
 * Event type used by tool event listeners.
 * With lifecycle, events are native Event subclasses with named properties.
 * The Detail type parameter is kept for backward compatibility but maps to Event.
 */
export type ToolCustomEvent<Detail = unknown> = Event & Detail;

/**
 * A form-mode elicitation request: asks for structured data matching a JSON
 * Schema object.
 */
export interface ToolElicitationFormRequest {
  message: string;
  mode?: 'form';
  /** JSON Schema object describing the requested form data. */
  schema?: Record<string, unknown>;
}

/**
 * A URL-mode elicitation request: asks the caller to open a link out-of-band.
 */
export interface ToolElicitationUrlRequest {
  message: string;
  mode: 'url';
  /** The URL the caller should open. */
  url: string;
}

/**
 * A request to elicit input (approval, form data, or a URL-mode
 * out-of-band flow) from whoever is on the other end of a tool's
 * execution — typically an MCP client, but the shape is transport-agnostic.
 *
 * Mirrors the MCP spec's form/URL elicitation split without depending on
 * `@modelcontextprotocol/sdk` types. This is a discriminated union on `mode`
 * so a URL-mode request can never be constructed without its `url`, and a
 * form-mode request can never carry a stray `url` that would silently be
 * dropped by a `mode`-unaware caller.
 */
export type ToolElicitationRequest = ToolElicitationFormRequest | ToolElicitationUrlRequest;

/** The response to a {@link ToolElicitationRequest}. */
export type ToolElicitationResult =
  | { action: 'accept'; content?: Record<string, unknown> }
  | { action: 'decline' }
  | { action: 'cancel' };

/** Requests elicitation from whoever is driving the current tool execution. */
export type ToolElicitationRequester = (
  request: ToolElicitationRequest,
) => Promise<ToolElicitationResult>;

/**
 * Context passed to tool execute functions.
 */
export interface RuntimeToolContext extends CoreToolContext {
  requestContext?: Readonly<ToolRequestContext>;
  effectiveContext?: Readonly<EffectiveToolExecutionContext>;
  dispatch: (event: Event) => boolean;
  meta?: { toolName: string; callId?: string };
  toolCall: ToolCallWithArguments;
  configuration: ToolConfiguration;
  durableOperationKey?: string;
  signal?: MinimalAbortSignal;
  /** Execution timeout in milliseconds. */
  timeout?: number;
  stream?: boolean;
  /** Requests elicitation (approval/human input) from the calling MCP client, when available. */
  elicit?: ToolElicitationRequester;
  /** Stable locator for this execution and its revisioned state. */
  execution?: ExecutionHandle;
}

export type ToolContext<_E extends ToolEventsMap = DefaultToolEvents> = RuntimeToolContext;

export interface ToolExecuteOptions {
  requestContext?: ToolRequestContext;
  effectiveContext?: EffectiveToolExecutionContext;
  clearTimeoutFunction?: ClearScheduledTimeout;
  durableOperationKey?: string;
  now?: () => number;
  signal?: MinimalAbortSignal;
  setTimeoutFunction?: ScheduleTimeout;
  /** Execution timeout in milliseconds. */
  timeout?: number;
  /**
   * When true, preserve async-iterable results as live streams.
   * When false/omitted, async-iterables are collected into arrays.
   */
  stream?: boolean;
  /** Requests elicitation (approval/human input) from the calling MCP client, when available. */
  elicit?: ToolElicitationRequester;
  /** Stable identity supplied by an owning runtime or durable projection. */
  executionId?: string;
  /** Identity of the runtime that owns this execution. */
  ownerId?: string;
  /** Parent execution used to correlate nested toolbox and tool calls. */
  parentExecutionId?: string;
}

/**
 * Options for tool execution with parsed parameters.
 */
export type ToolExecuteWithOptions = ToolExecuteOptions & {
  params: unknown;
  callId?: string;
};

/**
 * Type guard to check if a value is a Toolbox tool.
 *
 * @param obj - The value to check
 * @returns True if the value is an Tool (has required properties: id, identity, name, description, input, execute, configuration)
 *
 * @example
 * ```typescript
 * import { isTool, createTool } from 'armorer';
 *
 * const tool = createTool({ ... });
 * if (isTool(tool)) {
 *   // TypeScript knows tool is an Tool
 *   await tool.execute({ ... });
 * }
 * ```
 */
export function isTool(obj: unknown): obj is Tool {
  return (
    typeof obj === 'function' &&
    'id' in obj &&
    'identity' in obj &&
    'name' in obj &&
    'description' in obj &&
    'input' in obj &&
    'execute' in obj &&
    'configuration' in obj
  );
}

/**
 * A tool that can be included in a Toolbox and executed.
 *
 * Use with type parameters for compile-time safety on a specific tool:
 * ```ts
 * const myTool: Tool<typeof mySchema> = createTool({...});
 * ```
 *
 * Use without type parameters for collections:
 * ```ts
 * const tools: Tool[] = [tool1, tool2, tool3];
 * ```
 */
export type Tool<
  T extends ToolParametersSchema = ToolParametersSchema,
  E extends ToolEventsMap = DefaultToolEvents,
  R = unknown,
  M extends ToolMetadata | undefined = ToolMetadata | undefined,
> = ToolDefinition & {
  name: string;
  description: string;
  input: ToolParametersSchema;
  configuration: ToolConfiguration;
  /** @internal Schema marker for inference. */
  __schema?: T;
  tags?: readonly string[];
  metadata: M;
  (params: unknown): Promise<R>;
  run: (params: unknown, context: ToolContext<E>) => Promise<R>;

  // Event listener methods
  addEventListener: <K extends keyof (E & ToolEventMap) & string>(
    type: K,
    listener: (
      event: K extends keyof ToolEventMap ? ToolEventMap[K] : Event,
    ) => void | Promise<void>,
    options?: AddEventListenerOptions,
  ) => () => void;
  dispatchEvent: (event: Event) => boolean;
  emit: <K extends keyof E & string>(type: K, detail: E[K]) => boolean;

  // Observable-based event methods
  on: <K extends keyof (E & ToolEventMap) & string>(
    type: K,
    options?: { signal?: AbortSignal },
  ) => ObservableLike<K extends keyof ToolEventMap ? ToolEventMap[K] : Event>;
  once: <K extends keyof (E & ToolEventMap) & string>(
    type: K,
    listener: (event: K extends keyof ToolEventMap ? ToolEventMap[K] : Event) => void,
  ) => void;
  subscribe: <K extends keyof (E & ToolEventMap) & string>(
    type: K,
    observerOrNext?:
      | Observer<K extends keyof ToolEventMap ? ToolEventMap[K] : Event>
      | ((value: K extends keyof ToolEventMap ? ToolEventMap[K] : Event) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  toObservable: () => ObservableLike<Event>;

  // Async iteration
  events: <K extends keyof (E & ToolEventMap) & string>(
    type: K,
    options?: EventIteratorOptions,
  ) => AsyncIterableIterator<K extends keyof ToolEventMap ? ToolEventMap[K] : Event>;

  // Lifecycle methods
  complete: () => Promise<void>;
  readonly completed: boolean;
  readonly activeExecutions: number;
  readonly executionSignal: AbortSignal;
  readonly executions: ExecutionLifecycle;
  whenIdle: () => Promise<void>;

  // Tool execution methods
  execute: {
    (call: ToolCallWithArguments, options?: ToolExecuteOptions): Promise<ToolExecutionResult>;
    (params: unknown, options?: ToolExecuteOptions): Promise<R>;
  };
  executeWith: (options: ToolExecuteWithOptions) => Promise<ToolExecutionResult>;
  rawExecute: (params: unknown, context: ToolContext<E>) => Promise<R>;
};

export type RunnableTool<
  T extends ToolParametersSchema = ToolParametersSchema,
  E extends ToolEventsMap = DefaultToolEvents,
  R = unknown,
  M extends ToolMetadata | undefined = ToolMetadata | undefined,
> = Tool<T, E, R, M>;
