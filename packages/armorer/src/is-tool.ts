import type {
  AddEventListenerOptionsLike,
  AsyncIteratorOptions,
  EmissionEvent,
  MinimalAbortSignal as EventMinimalAbortSignal,
} from 'event-emission';
import type { ObservableLike, Observer, Subscription } from 'event-emission/types';
import { z } from 'zod';

import type { ToolContext as CoreToolContext } from './core/context';
import type { ToolErrorCategory } from './core/errors';
import type { JsonObject } from './core/serialization/json';
import type { ToolDefinition } from './core/tool-definition';
import type { ToolCall, ToolResult } from './types';

export type ToolParametersSchema = z.ZodTypeAny;
export type { AddEventListenerOptionsLike, AsyncIteratorOptions } from 'event-emission';
export type { ObservableLike, Observer, Subscription } from 'event-emission/types';

export type MinimalAbortSignal = EventMinimalAbortSignal | AbortSignal;

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
  createRepairHints: (
    error: unknown,
    options?: { rootLabel?: string },
  ) => ToolRepairHint[];
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
  allow: boolean;
  reason?: string;
  status?: 'allow' | 'deny' | 'needs_approval' | 'needs_input';
  action?: {
    message?: string;
    schema?: unknown;
  };
};

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

export type ToolCustomEvent<Detail> = EmissionEvent<Detail>;

/**
 * Context passed to tool execute functions.
 */
export interface RuntimeToolContext<
  E extends ToolEventsMap = DefaultToolEvents,
> extends CoreToolContext {
  dispatch: <K extends keyof E & string>(event: ToolCustomEvent<E[K]>) => boolean;
  meta?: { toolName: string; callId?: string };
  toolCall: ToolCallWithArguments;
  configuration: ToolConfiguration;
  signal?: MinimalAbortSignal;
  /** Execution timeout in milliseconds. */
  timeout?: number;
  stream?: boolean;
}

export type ToolContext<E extends ToolEventsMap = DefaultToolEvents> =
  RuntimeToolContext<E>;

export interface ToolExecuteOptions {
  signal?: MinimalAbortSignal;
  /** Execution timeout in milliseconds. */
  timeout?: number;
  /**
   * When true, preserve async-iterable results as live streams.
   * When false/omitted, async-iterables are collected into arrays.
   */
  stream?: boolean;
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
  addEventListener: <K extends keyof E & string>(
    type: K,
    listener: (event: ToolCustomEvent<E[K]>) => void | Promise<void>,
    options?: AddEventListenerOptionsLike,
  ) => () => void;
  dispatchEvent: <K extends keyof E & string>(event: ToolCustomEvent<E[K]>) => boolean;

  // Observable-based event methods (new in event-emission 0.2.0)
  on: <K extends keyof E & string>(
    type: K,
    options?: AddEventListenerOptionsLike | boolean,
  ) => ObservableLike<ToolCustomEvent<E[K]>>;
  once: <K extends keyof E & string>(
    type: K,
    listener: (event: ToolCustomEvent<E[K]>) => void | Promise<void>,
    options?: Omit<AddEventListenerOptionsLike, 'once'>,
  ) => () => void;
  subscribe: <K extends keyof E & string>(
    type: K,
    observerOrNext?:
      | Observer<ToolCustomEvent<E[K]>>
      | ((value: ToolCustomEvent<E[K]>) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  toObservable: () => ObservableLike<ToolCustomEvent<E[keyof E]>>;

  // Async iteration (new in event-emission 0.2.0)
  events: <K extends keyof E & string>(
    type: K,
    options?: AsyncIteratorOptions,
  ) => AsyncIterableIterator<ToolCustomEvent<E[K]>>;

  // Lifecycle methods
  complete: () => void;
  readonly completed: boolean;

  // Tool execution methods
  execute: {
    (call: ToolCallWithArguments, options?: ToolExecuteOptions): Promise<ToolResult>;
    (params: unknown, options?: ToolExecuteOptions): Promise<R>;
  };
  executeWith: (options: ToolExecuteWithOptions) => Promise<ToolResult>;
  rawExecute: (params: unknown, context: ToolContext<E>) => Promise<R>;
};

export type RunnableTool<
  T extends ToolParametersSchema = ToolParametersSchema,
  E extends ToolEventsMap = DefaultToolEvents,
  R = unknown,
  M extends ToolMetadata | undefined = ToolMetadata | undefined,
> = Tool<T, E, R, M>;
