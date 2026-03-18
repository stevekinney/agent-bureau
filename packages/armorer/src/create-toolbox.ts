import {
  type AddEventListenerOptionsLike,
  type AsyncIteratorOptions,
  createEventTarget,
  type EmissionEvent,
} from 'event-emission';
import type { ObservableLike, Observer, Subscription } from 'event-emission/types';
import { z } from 'zod';

import type { AnthropicTool } from './adapters/anthropic/types';
import type { GeminiTool } from './adapters/gemini/types';
import type { OpenAITool } from './adapters/openai/types';
import type { ToolError, ToolErrorCategory } from './core/errors';
import {
  type InspectorDetailLevel,
  inspectRegistry,
  type RegistryInspection,
} from './core/inspect';
import type {
  QuerySelectionResult,
  ToolMatch,
  ToolQuery,
  ToolSearchOptions,
} from './core/registry';
import { registerToolIndexes } from './core/registry';
import type { Embedder, EmbeddingVector } from './core/registry/embeddings';
import { registerRegistryEmbedder, warmToolEmbeddings } from './core/registry/embeddings';
import type { ToolRisk } from './core/risk';
import { isZodObjectSchema, isZodSchema } from './core/schema-utilities';
import {
  type SerializedToolDefinition,
  serializeToolDefinition,
} from './core/serialization';
import { assertJsonValue } from './core/serialization/json';
import type { AnyToolDefinition } from './core/tool-definition';
import { defineTool } from './core/tool-definition';
import {
  createTool as createToolFactory,
  createToolCall,
  type CreateToolOptions,
} from './create-tool';
import type {
  DefaultToolEvents,
  MinimalAbortSignal,
  Tool,
  ToolCallWithArguments,
  ToolConfiguration,
  ToolContext,
  ToolDigestOptions,
  ToolEventsMap,
  ToolExecuteOptions,
  ToolMetadata,
  ToolParametersSchema,
  ToolPolicyContext,
  ToolPolicyContextProvider,
  ToolPolicyDecision,
  ToolPolicyHooks,
} from './is-tool';
import { isTool } from './is-tool';
import type {
  JSONValue,
  ToolCall,
  ToolCallInput,
  ToolExecutionResult,
  ToolProvider,
} from './types';
import { createConcurrencyLimiter, normalizeConcurrency } from './utilities/concurrency';

export type ToolboxContext = Record<string, unknown>;

export type ToolboxRuntimeContext<Ctx extends ToolboxContext = ToolboxContext> = Ctx & {
  dispatchEvent: ToolboxEventDispatcher;
  configuration: ToolConfiguration;
  toolCall: ToolCall;
  signal?: MinimalAbortSignal;
  /** Execution timeout in milliseconds. */
  timeout?: number;
  stream?: boolean;
};

function normalizeToolCallArguments(argumentsValue: unknown): JSONValue {
  if (argumentsValue === undefined) {
    return {};
  }

  try {
    assertJsonValue(argumentsValue, 'tool call arguments');
    return argumentsValue;
  } catch {
    try {
      const serialized = JSON.stringify(argumentsValue);
      return serialized === undefined
        ? String(argumentsValue)
        : (JSON.parse(serialized) as JSONValue);
    } catch {
      return String(argumentsValue);
    }
  }
}

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
  toolFactory?: (
    configuration: ToolConfiguration,
    context: ToolboxFactoryContext,
  ) => Tool;
  /**
   * Called when a tool configuration doesn't have an execute method.
   * This typically happens when deserializing a toolbox.
   * Should return an execute function or a promise that resolves to one.
   */
  getTool?: (
    configuration: Omit<ToolConfiguration, 'execute'>,
  ) => ToolConfiguration['execute'];
  /**
   * Array of middleware functions to transform tool configurations during toolbox creation.
   * Middleware is applied in order before each tool is built.
   */
  middleware?: ToolMiddleware[];
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
  call: { tool: Tool; call: ToolCall };
  complete: { tool: Tool; result: ToolExecutionResult };
  error: { tool?: Tool; result: ToolExecutionResult };
  'not-found': ToolCall;
  query: { criteria?: ToolQuery; results: QuerySelectionResult };
  search: { options: ToolSearchOptions; results: ToolMatch<unknown>[] };
  /** Tool status/progress updates for UI display */
  'status:update': ToolStatusUpdate;
  // Bubbled tool events (when executing multiple tools in parallel)
  'execute-start': { tool: Tool; call: ToolCall; params: unknown };
  'validate-success': {
    tool: Tool;
    call: ToolCall;
    params: unknown;
    parsed: unknown;
  };
  'validate-error': {
    tool: Tool;
    call: ToolCall;
    params: unknown;
    error: unknown;
  };
  'execute-success': { tool: Tool; call: ToolCall; result: unknown };
  'execute-error': { tool: Tool; call: ToolCall; error: unknown };
  settled: { tool: Tool; call: ToolCall; result?: unknown; error?: unknown };
  'policy-denied': {
    tool: Tool;
    call: ToolCall;
    params: unknown;
    reason?: string;
  };
  'tool.started': {
    tool: Tool;
    call: ToolCall;
    // Original event properties
    toolCall: ToolCallWithArguments;
    configuration: ToolConfiguration;
    params: unknown;
    startedAt: number;
    inputDigest?: string;
  };
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
  };
  'budget-exceeded': { tool: Tool; call: ToolCall; reason: string };
  progress: { tool: Tool; call: ToolCall; percent?: number; message?: string };
  'stream-start': { tool: Tool; call: ToolCall; mode: 'stream' | 'collect' };
  'stream-chunk': { tool: Tool; call: ToolCall; chunk: unknown; index: number };
  'stream-end': {
    tool: Tool;
    call: ToolCall;
    chunks: number;
    completed: boolean;
  };
  'stream-error': { tool: Tool; call: ToolCall; error: unknown; index: number };
  'output-chunk': { tool: Tool; call: ToolCall; chunk: unknown };
  log: {
    tool: Tool;
    call: ToolCall;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    data?: unknown;
  };
  cancelled: { tool: Tool; call: ToolCall; reason?: string };
}

type ToolboxEventType = Extract<keyof ToolboxEvents, string>;

export type ToolboxEventDispatcher = (
  event: EmissionEvent<ToolboxEvents[ToolboxEventType]>,
) => boolean;

export interface ToolboxExecuteOptions extends ToolExecuteOptions {
  concurrency?: number;
  mode?: 'parallel' | 'sequential';
  errorMode?: 'failFast' | 'collect';
}

export type ToolboxEntry = ToolConfiguration | Tool;
export type ToolboxEntries = readonly ToolboxEntry[];

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
  execute?: ToolConfiguration['execute'];
  policy?: ToolConfiguration['policy'];
  policyContext?: ToolConfiguration['policyContext'];
  digests?: ToolConfiguration['digests'];
  concurrency?: ToolConfiguration['concurrency'];
  diagnostics?: ToolConfiguration['diagnostics'];
};

type EntryToTool<TEntry> = TEntry extends Tool ? TEntry : Tool;

export type ToolsFromEntries<TEntries extends ToolboxEntries> = ReadonlyArray<
  EntryToTool<TEntries[number]>
>;

type MergeTools<
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

type ToolboxResultForTool<TTool extends Tool> = Omit<
  ToolExecutionResult,
  'toolName' | 'result'
> & {
  toolName: TTool['name'];
  result: ToolboxToolOutput<TTool> | undefined;
};

type ToolboxResultForCall<
  TTools extends readonly Tool[],
  TCall extends { name: string },
> =
  TCall['name'] extends ToolboxToolName<TTools>
    ? ToolboxResultForTool<ToolboxToolByNameOrFallback<TTools, TCall['name']>>
    : ToolExecutionResult;

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
  extend<const TEntries extends ToolboxEntries>(
    ...entries: TEntries
  ): Toolbox<MergeTools<TTools, ToolsFromEntries<TEntries>>>;
  extend<const TOtherTools extends readonly Tool[]>(
    toolbox: Toolbox<TOtherTools>,
  ): Toolbox<MergeTools<TTools, TOtherTools>>;
  tools: () => TTools;
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
  addEventListener: <K extends ToolboxEventType>(
    type: K,
    listener: (event: EmissionEvent<ToolboxEvents[K]>) => void | Promise<void>,
    options?: AddEventListenerOptionsLike,
  ) => () => void;
  dispatchEvent: ToolboxEventDispatcher;
  emit: <K extends ToolboxEventType>(type: K, detail: ToolboxEvents[K]) => boolean;

  // Observable-based event methods (event-emission 0.3.0)
  on: <K extends ToolboxEventType>(
    type: K,
    options?: AddEventListenerOptionsLike | boolean,
  ) => ObservableLike<EmissionEvent<ToolboxEvents[K]>>;
  once: <K extends ToolboxEventType>(
    type: K,
    listener: (event: EmissionEvent<ToolboxEvents[K]>) => void | Promise<void>,
    options?: Omit<AddEventListenerOptionsLike, 'once'>,
  ) => () => void;
  subscribe: <K extends ToolboxEventType>(
    type: K,
    observerOrNext?:
      | Observer<EmissionEvent<ToolboxEvents[K]>>
      | ((value: EmissionEvent<ToolboxEvents[K]>) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  toObservable: () => ObservableLike<EmissionEvent<ToolboxEvents[keyof ToolboxEvents]>>;

  // Async iteration (event-emission 0.3.0)
  events: <K extends ToolboxEventType>(
    type: K,
    options?: AsyncIteratorOptions,
  ) => AsyncIterableIterator<EmissionEvent<ToolboxEvents[K]>>;

  // Lifecycle methods
  complete: () => void;
  readonly completed: boolean;

  // Internal method to get toolbox context.
  getContext?: () => ToolboxContext;
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
function createToolboxBase<const TEntries extends ToolboxEntries = []>(
  entries: TEntries = [] as unknown as TEntries,
  options: ToolboxOptions = {},
): Toolbox<ToolsFromEntries<TEntries>> {
  const toolsById = new Map<string, Tool>();
  const toolsByName = new Map<string, Tool[]>();
  // Backward compat: registry acts as 'name' based lookup for simple cases
  // but we need to change how we access it.
  // const registry = new Map<string, Tool>();

  const storedConfigurations = new Map<string, ToolConfiguration>();
  const emitter = createEventTarget<ToolboxEvents>();
  const {
    addEventListener,
    dispatchEvent,
    emit,
    clear,
    on,
    once,
    subscribe,
    toObservable,
    events,
    complete,
  } = emitter;
  const baseContext = options.context ? { ...options.context } : {};
  const readOnly = options.readOnly ?? false;
  const allowMutation = options.allowMutation ?? !readOnly;
  const allowDangerous = options.allowDangerous ?? true;
  const telemetryEnabled = options.telemetry === true;
  const registryPolicy = options.policy;
  const registryPolicyContext = options.policyContext;
  const registryDigests = options.digests;
  const registryConcurrency = options.concurrency;
  const budget = options.budget;
  const budgetStart = Date.now();
  let budgetCalls = 0;
  const embedder = options.embed ? createCachedEmbedder(options.embed) : undefined;
  const buildTool =
    typeof options.toolFactory === 'function'
      ? (configuration: ToolConfiguration) =>
          options.toolFactory!(configuration, {
            dispatchEvent,
            emit,
            baseContext,
            buildDefaultTool,
          })
      : buildDefaultTool;

  if (options.signal) {
    const signal = options.signal;
    const onAbort = () => {
      clear();
      signal.removeEventListener('abort', onAbort);
    };
    if (signal.aborted) {
      clear();
    } else {
      signal.addEventListener('abort', onAbort);
    }
  }

  async function execute<
    const TCall extends ToolboxCallInputForTools<ToolsFromEntries<TEntries>>,
  >(
    call: TCall,
    options?: ToolboxExecuteOptions,
  ): Promise<ToolboxResultForCall<ToolsFromEntries<TEntries>, TCall>>;
  async function execute<
    const TCalls extends readonly ToolboxCallInputForTools<ToolsFromEntries<TEntries>>[],
  >(
    calls: [...TCalls],
    options?: ToolboxExecuteOptions,
  ): Promise<{
    [K in keyof TCalls]: ToolboxResultForCall<ToolsFromEntries<TEntries>, TCalls[K]>;
  }>;
  async function execute(
    call: ToolCallInput,
    options?: ToolboxExecuteOptions,
  ): Promise<ToolExecutionResult>;
  async function execute(
    calls: ToolCallInput[],
    options?: ToolboxExecuteOptions,
  ): Promise<ToolExecutionResult[]>;
  async function execute(
    input: ToolCallInput | ToolCallInput[],
    options?: ToolboxExecuteOptions,
  ): Promise<ToolExecutionResult | ToolExecutionResult[]> {
    const calls = Array.isArray(input) ? input : [input];
    const isMultiple = Array.isArray(input);
    const mode = options?.mode ?? 'parallel';
    const errorMode = options?.errorMode ?? 'collect';
    const globalConcurrency = options?.concurrency;

    // Resolve limiter
    const limit = mode === 'sequential' ? 1 : globalConcurrency;
    const limiter = createConcurrencyLimiter(limit);
    const runTask = <T>(task: () => Promise<T>) => (limiter ? limiter.run(task) : task());

    // Map calls to tasks
    const tasks = calls.map((call) => async () => {
      const toolCall = normalizeToolCall(call);
      const tool = getTool(toolCall.name) as Tool | undefined; // toolCall.name might be ID
      if (!tool) {
        const toolError = createToolError(
          'not_found',
          `Tool not found: ${toolCall.name}`,
          'NOT_FOUND',
          false,
        );
        const notFound: ToolExecutionResult = {
          callId: toolCall.id,
          outcome: 'error',
          content: toolError.message,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: undefined,
          error: toolError,
          errorMessage: toolError.message,
          errorCategory: toolError.category,
        };
        emit('not-found', toolCall);
        if (errorMode === 'failFast') {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw toolError;
        }
        return notFound;
      }

      emit('call', { tool, call: toolCall });

      const budgetReason = checkBudget(budget, budgetStart, budgetCalls);
      if (budgetReason) {
        const toolError = createToolError(
          'conflict',
          budgetReason,
          'BUDGET_EXCEEDED',
          false,
        );
        const denied: ToolExecutionResult = {
          callId: toolCall.id,
          outcome: 'error',
          content: toolError.message,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: undefined,
          error: toolError,
          errorMessage: toolError.message,
          errorCategory: toolError.category,
        };
        emit('budget-exceeded', { tool, call: toolCall, reason: budgetReason });
        emit('error', { tool, result: denied });
        if (errorMode === 'failFast') {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw toolError;
        }
        return denied;
      }

      budgetCalls += 1;

      // Bubble up events
      const cleanup: (() => void)[] = [];
      // Always bubble up events for consistency
      const toolEventTypes: (keyof DefaultToolEvents)[] = [
        'tool.started',
        'tool.finished',
        'execute-start',
        'validate-success',
        'validate-error',
        'execute-success',
        'execute-error',
        'settled',
        'policy-denied',
        'progress',
        'stream-start',
        'stream-chunk',
        'stream-end',
        'stream-error',
        'output-chunk',
        'log',
        'cancelled',
        'status-update',
      ];
      for (const eventType of toolEventTypes) {
        const unsubscribe = tool.addEventListener(eventType, (toolEvent) => {
          // Bubble up the event with tool and call context
          const bubbledDetail = {
            ...toolEvent.detail,
            tool,
            call: toolCall,
          };
          // Use emit helper which handles the type conversion
          emit(
            eventType as keyof ToolboxEvents,
            bubbledDetail as ToolboxEvents[keyof ToolboxEvents],
          );
        });
        cleanup.push(unsubscribe);
      }

      try {
        const executeOptions: ToolExecuteOptions =
          options?.signal ||
          options?.timeout !== undefined ||
          options?.stream !== undefined
            ? {
                ...(options?.signal ? { signal: options.signal } : {}),
                ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
                ...(options?.stream !== undefined ? { stream: options.stream } : {}),
              }
            : {};

        const result = await tool.execute(
          toolCall as ToolCallWithArguments,
          executeOptions,
        );
        let hasLiveStream = false;
        const stream = resolveResultStream(result);
        if (stream) {
          hasLiveStream = true;
          const wrapped = wrapAsyncIterable(stream, () => {
            cleanup.forEach((fn) => fn());
          });
          if (result.stream === stream) {
            result.stream = wrapped;
          }
          if (result.result === stream) {
            result.result = wrapped;
          }
        }
        if (result.error) {
          emit('error', { tool, result });
          cleanup.forEach((fn) => fn());
          if (errorMode === 'failFast') {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw result.error;
          }
        } else {
          emit('complete', { tool, result });
          if (!hasLiveStream) {
            cleanup.forEach((fn) => fn());
          }
        }
        return result;
      } catch (error) {
        cleanup.forEach((fn) => fn());
        if (errorMode === 'failFast') {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        const toolError = createToolError(
          'internal',
          message,
          extractErrorCode(error) ?? 'EXECUTION_ERROR',
          false,
        );
        const errResult: ToolExecutionResult = {
          callId: toolCall.id,
          outcome: 'error',
          content: toolError.message,
          toolCallId: toolCall.id,
          toolName: tool.name,
          result: undefined,
          error: toolError,
          errorMessage: toolError.message,
          errorCategory: toolError.category,
        };
        emit('error', { tool, result: errResult });
        return errResult;
      }
    });

    const promises = tasks.map((task) => runTask(task));
    const results = await Promise.all(promises);
    return isMultiple ? results : results[0]!;
  }

  function extend<const TExtendEntries extends ToolboxEntries>(
    ...entries: TExtendEntries
  ): Toolbox<MergeTools<ToolsFromEntries<TEntries>, ToolsFromEntries<TExtendEntries>>>;
  function extend<const TOtherTools extends readonly Tool[]>(
    toolbox: Toolbox<TOtherTools>,
  ): Toolbox<MergeTools<ToolsFromEntries<TEntries>, TOtherTools>>;
  function extend(...inputs: readonly unknown[]): Toolbox<any> {
    const context = { ...baseContext };
    const mergedEntries: ToolboxEntry[] = [...Array.from(storedConfigurations.values())];

    if (inputs.length === 1 && isToolbox(inputs[0])) {
      const other = inputs[0];
      Object.assign(context, other.getContext?.() ?? {});
      mergedEntries.push(...other.toJSON());
    } else if (inputs.length > 0) {
      mergedEntries.push(...(inputs as ToolboxEntries));
    }

    return createToolboxBase(mergedEntries, {
      ...options,
      context,
    });
  }

  function normalizeToolCall(call: ToolCallInput): ToolCall {
    const args = Object.prototype.hasOwnProperty.call(call, 'arguments')
      ? call.arguments
      : {};
    const id = typeof call.id === 'string' && call.id.length ? call.id : undefined;
    return createToolCall(call.name, normalizeToolCallArguments(args), id);
  }

  function resolveResultStream(
    result: ToolExecutionResult,
  ): AsyncIterable<unknown> | undefined {
    if (isAsyncIterable(result.stream)) {
      return result.stream;
    }
    if (isAsyncIterable(result.result)) {
      return result.result;
    }
    return undefined;
  }

  function wrapAsyncIterable(
    stream: AsyncIterable<unknown>,
    onFinalize: () => void,
  ): AsyncIterable<unknown> {
    let finalized = false;
    const finalize = () => {
      if (!finalized) {
        finalized = true;
        onFinalize();
      }
    };
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const chunk of stream) {
            yield chunk;
          }
        } finally {
          finalize();
        }
      },
    };
  }

  function tools(): ToolsFromEntries<TEntries> {
    return Array.from(toolsById.values()) as unknown as ToolsFromEntries<TEntries>;
  }

  function getTool(nameOrId: string): ToolsFromEntries<TEntries>[number] | undefined;
  function getTool(nameOrId: string): Tool | undefined {
    if (toolsById.has(nameOrId)) return toolsById.get(nameOrId);
    const matches = toolsByName.get(nameOrId);
    if (matches && matches.length > 0) {
      // Return the last configured tool with this name (priority to latest)
      return matches[matches.length - 1];
    }
    return undefined;
  }

  function getMissingTools(names: string[]): string[] {
    return names.filter((name) => !getTool(name));
  }

  function hasAllTools(names: string[]): boolean {
    return names.every((name) => getTool(name));
  }

  function inspect(detailLevel: InspectorDetailLevel = 'standard'): RegistryInspection {
    const tools = Array.from(toolsById.values());
    return inspectRegistry(tools, detailLevel);
  }

  async function toOpenAITools(): Promise<OpenAITool[]> {
    const { toOpenAITools: convertToOpenAITools } = await import('./adapters/openai');
    return convertToOpenAITools(api);
  }

  async function toAnthropicTools(): Promise<AnthropicTool[]> {
    const { toAnthropicTools: convertToAnthropicTools } = await import(
      './adapters/anthropic'
    );
    return convertToAnthropicTools(api);
  }

  async function toGeminiTools(): Promise<GeminiTool[]> {
    const { toGeminiTools: convertToGeminiTools } = await import('./adapters/gemini');
    return convertToGeminiTools(api);
  }

  async function toProvider(
    provider: ToolProvider,
    adapterOptions?: unknown,
  ): Promise<OpenAITool[] | AnthropicTool[] | GeminiTool[]> {
    switch (provider) {
      case 'openai': {
        const { openAIToolAdapter } = await import('./adapters/openai');
        return openAIToolAdapter.export(api, adapterOptions as never) as OpenAITool[];
      }
      case 'anthropic': {
        const { anthropicToolAdapter } = await import('./adapters/anthropic');
        return anthropicToolAdapter.export(api) as AnthropicTool[];
      }
      case 'gemini': {
        const { geminiToolAdapter } = await import('./adapters/gemini');
        return geminiToolAdapter.export(api) as GeminiTool[];
      }
    }
  }

  function asExecuteResolver(): NonNullable<ToolboxOptions['getTool']> {
    return (configuration) => {
      const sourceTool = getTool(configuration.name);
      if (!sourceTool) {
        return createImportedExecute(configuration.name);
      }
      return async (parameters, context) =>
        sourceTool.run(parameters, context as ToolContext);
    };
  }

  function toJSON(): SerializedToolbox;
  function toJSON(options: { format: 'configuration' }): SerializedToolbox;
  function toJSON(options: { format: 'json-schema' }): SerializedToolboxJSONSchema;
  function toJSON(options?: {
    format?: 'configuration' | 'json-schema';
  }): SerializedToolbox | SerializedToolboxJSONSchema {
    if (options?.format === 'json-schema') {
      return Array.from(storedConfigurations.values()).map((configuration) =>
        serializeToolDefinition(configuration as AnyToolDefinition),
      );
    }

    return Array.from(storedConfigurations.values());
  }

  const api: Toolbox<ToolsFromEntries<TEntries>> = {
    execute,
    extend,
    tools,
    getTool,
    getMissingTools,
    hasAllTools,
    inspect,
    toProvider,
    toOpenAITools,
    toAnthropicTools,
    toGeminiTools,
    asExecuteResolver,
    toJSON,
    addEventListener,
    dispatchEvent,
    emit,
    // Observable-based event methods (event-emission 0.3.0)
    on,
    once,
    subscribe,
    toObservable,
    // Async iteration (event-emission 0.3.0)
    events,
    // Lifecycle methods
    complete,
    get completed() {
      return emitter.completed;
    },
    // Internal method to get toolbox context
    getContext: () => baseContext,
  };

  if (isTestRuntime()) {
    type LegacyMutableToolbox = Toolbox<ToolsFromEntries<TEntries>> & {
      register: (...toolEntries: ToolboxEntries) => LegacyMutableToolbox;
      createTool: (
        configuration: Parameters<typeof createToolFactory>[0],
      ) => ReturnType<typeof createToolFactory>;
    };

    const legacyApi = api as LegacyMutableToolbox;
    const emitLegacy = (type: string, detail: unknown) =>
      emit(type as ToolboxEventType, detail as ToolboxEvents[ToolboxEventType]);

    legacyApi.register = (...toolEntries: ToolboxEntries): LegacyMutableToolbox => {
      for (const toolEntry of toolEntries) {
        emitLegacy('registering', { tool: toolEntry });
        registerSerialized([toolEntry], 'registration');
        const registeredTool = isTool(toolEntry) ? toolEntry : getTool(toolEntry.name);
        emitLegacy('registered', {
          tool: registeredTool,
        });
      }
      return legacyApi;
    };

    legacyApi.createTool = (configuration) => {
      const created = createToolFactory(configuration);
      if (isPromise(created)) {
        return created.then((tool) => {
          legacyApi.register(tool.configuration);
          return (getTool(tool.name) ?? tool) as Tool;
        }) as ReturnType<typeof createToolFactory>;
      }
      legacyApi.register(created.configuration);
      return (getTool(created.name) ?? created) as ReturnType<typeof createToolFactory>;
    };
  }

  if (embedder) {
    registerRegistryEmbedder(api, embedder);
  }

  if (entries.length) {
    registerSerialized(entries);
  }

  return api;

  function buildDefaultTool(configuration: ToolConfiguration): Tool {
    const resolveExecute = createLazyExecuteResolver(
      configuration.execute,
      configuration.name,
    );
    const resolvedPolicy = mergePolicies(registryPolicy, configuration.policy, {
      readOnly,
      allowMutation,
      allowDangerous,
    });
    const resolvedPolicyContext = mergePolicyContexts(
      registryPolicyContext,
      configuration.policyContext,
    );
    const resolvedDigests = resolveToolDigests(configuration, registryDigests);
    const resolvedConcurrency = resolveToolConcurrency(
      configuration,
      registryConcurrency,
    );
    const options: Omit<
      CreateToolOptions<
        object,
        unknown,
        ToolEventsMap,
        readonly string[],
        ToolMetadata | undefined,
        ToolContext<ToolEventsMap>,
        unknown
      >,
      'metadata'
    > & {
      metadata?: ToolMetadata | undefined;
    } = {
      name: configuration.identity.name,
      description: configuration.display.description,
      ...(configuration.identity?.namespace !== undefined
        ? { namespace: configuration.identity.namespace }
        : {}),
      ...(configuration.identity?.version !== undefined
        ? { version: configuration.identity.version }
        : {}),
      ...(configuration.display?.title !== undefined
        ? { title: configuration.display.title }
        : {}),
      ...(configuration.display?.examples !== undefined
        ? { examples: configuration.display.examples }
        : {}),
      ...(configuration.risk !== undefined ? { risk: configuration.risk } : {}),
      ...(configuration.lifecycle !== undefined
        ? { lifecycle: configuration.lifecycle }
        : {}),
      input: configuration.input,
      async execute(params, toolContext) {
        const executeFn = await resolveExecute();
        return executeFn(params, {
          ...baseContext,
          dispatchEvent,
          emit,
          configuration: toolContext.configuration,
          toolCall: toolContext.toolCall,
          signal: toolContext.signal,
          timeout: toolContext.timeout,
          stream: toolContext.stream,
        });
      },
    };
    if (configuration.tags) {
      options.tags = configuration.tags;
    }
    if (configuration.metadata) {
      options.metadata = configuration.metadata;
    }
    if (resolvedPolicy) {
      options.policy = resolvedPolicy;
    }
    if (resolvedPolicyContext) {
      options.policyContext = resolvedPolicyContext;
    }
    if (resolvedDigests) {
      options.digests = resolvedDigests;
    }
    if (resolvedConcurrency !== undefined) {
      options.concurrency = resolvedConcurrency;
    }
    if (telemetryEnabled) {
      options.telemetry = true;
    }
    if (configuration.diagnostics) {
      options.diagnostics = configuration.diagnostics;
    }
    return createToolFactory<
      object,
      unknown,
      ToolEventsMap,
      readonly string[],
      ToolMetadata | undefined,
      ToolContext<ToolEventsMap>,
      unknown
    >(options) as unknown as Tool;
  }

  function normalizeConfiguration(configuration: ToolConfiguration): ToolConfiguration {
    if (!configuration || typeof configuration !== 'object') {
      throw new TypeError('createToolbox entries must be ToolConfiguration objects');
    }
    const candidate = configuration as unknown as Record<string, unknown>;
    const name =
      (candidate['name'] as string | undefined) ?? configuration.identity?.name;
    if (typeof name !== 'string' || !name.trim()) {
      throw new TypeError('createToolbox entries must be ToolConfiguration objects');
    }
    const rawInput = configuration.input;
    if (configuration.execute === undefined || configuration.execute === null) {
      throw new TypeError(
        `Tool "${name}" is missing execute. Provide execute or configure createToolbox({ getTool }) to resolve it.`,
      );
    }
    if (
      typeof configuration.execute !== 'function' &&
      !isPromise(configuration.execute)
    ) {
      throw new TypeError(
        `Tool "${name}" has invalid execute. Expected a function or a promise that resolves to a function.`,
      );
    }
    const normalizedInput = normalizeToolSchema(rawInput);
    const description =
      (candidate['description'] as string | undefined) ??
      configuration.display?.description;
    if (typeof description !== 'string' || !description.trim()) {
      throw new TypeError('createToolbox entries must be ToolConfiguration objects');
    }
    const resolvedRisk =
      configuration.risk ?? deriveRiskFromMetadata(configuration.metadata);
    const definition = defineTool({
      name,
      description,
      ...(configuration.identity?.namespace !== undefined
        ? { namespace: configuration.identity.namespace }
        : {}),
      ...(configuration.identity?.version !== undefined
        ? { version: configuration.identity.version }
        : {}),
      ...(configuration.display?.title !== undefined
        ? { title: configuration.display.title }
        : {}),
      ...(configuration.display?.examples !== undefined
        ? { examples: configuration.display.examples }
        : {}),
      ...(configuration.tags ? { tags: configuration.tags } : {}),
      ...(configuration.metadata ? { metadata: configuration.metadata } : {}),
      ...(resolvedRisk !== undefined ? { risk: resolvedRisk } : {}),
      ...(configuration.lifecycle ? { lifecycle: configuration.lifecycle } : {}),
      input: normalizedInput,
    }) as AnyToolDefinition;
    const result = {
      ...definition,
      input: normalizedInput,
      execute: configuration.execute,
    } as unknown as ToolConfiguration;
    if (configuration.policy) {
      result.policy = configuration.policy;
    }
    if (configuration.policyContext) {
      result.policyContext = configuration.policyContext;
    }
    if (configuration.digests !== undefined) {
      result.digests = configuration.digests;
    }
    if (configuration.concurrency !== undefined) {
      result.concurrency = configuration.concurrency;
    }
    if (configuration.diagnostics) {
      result.diagnostics = configuration.diagnostics;
    }
    return result;
  }

  function normalizeRegistration(entry: ToolConfiguration | Tool): ToolConfiguration {
    if (isTool(entry)) {
      return entry.configuration;
    }
    return entry;
  }

  function resolveMissingExecute(configuration: ToolConfiguration): ToolConfiguration {
    if (!configuration || typeof configuration !== 'object') {
      return configuration;
    }
    const candidate = configuration as Partial<ToolConfiguration>;
    if (candidate.execute !== undefined && candidate.execute !== null) {
      return configuration;
    }
    if (!options.getTool) {
      return configuration;
    }
    const execute = options.getTool(configuration as Omit<ToolConfiguration, 'execute'>);
    return { ...configuration, execute };
  }

  function registerConfiguration(configuration: ToolConfiguration): void {
    const normalized = normalizeConfiguration(configuration);
    const tool = buildTool(normalized);
    if (tool.name !== normalized.name) {
      throw new Error(`Failed to register tool: ${normalized.name}`);
    }
    storedConfigurations.set(normalized.id, normalized);

    toolsById.set(tool.id, tool);
    const byName = toolsByName.get(tool.name) || [];
    // Remove existing with same ID if any (update)
    const filtered = byName.filter((t) => t.id !== tool.id);
    filtered.push(tool);
    toolsByName.set(tool.name, filtered);

    registerToolIndexes(api, tool, toolsById.size);
    if (embedder) {
      warmToolEmbeddings(tool, embedder, (resolvedTool) => {
        if (toolsById.get(resolvedTool.id) !== resolvedTool) {
          return;
        }
        registerToolIndexes(api, resolvedTool, toolsById.size);
      });
    }
  }

  function registerSerialized(
    configurations: ToolboxEntries,
    source: 'deserializing' | 'registration' = 'deserializing',
  ): void {
    for (let index = 0; index < configurations.length; index += 1) {
      const serializedConfiguration = normalizeRegistration(configurations[index]!);
      let configuration = normalizeConfiguration(
        resolveMissingExecute(serializedConfiguration),
      );

      if (options.middleware && options.middleware.length > 0) {
        for (const middleware of options.middleware) {
          const result = middleware(configuration);
          if (isPromise(result)) {
            const message =
              source === 'deserializing'
                ? 'Async middleware is not supported when deserializing. Provide synchronous middleware only.'
                : 'Async middleware is not supported. Provide synchronous middleware only.';
            throw new Error(
              message,
            );
          }
          configuration = result;
        }
      }

      configuration = resolveMissingExecute(configuration);

      registerConfiguration(configuration);
    }
  }
}

async function createToolboxFromOpenAITools(
  tools: OpenAITool | readonly OpenAITool[],
  options: ImportedToolboxOptions = {},
): Promise<Toolbox> {
  const { fromOpenAITools: convertFromOpenAITools } = await import('./adapters/openai');
  if (Array.isArray(tools)) {
    return createImportedToolbox(convertFromOpenAITools(tools), options);
  }

  return createImportedToolbox(convertFromOpenAITools(tools as OpenAITool), options);
}

async function createToolboxFromAnthropicTools(
  tools: AnthropicTool | readonly AnthropicTool[],
  options: ImportedToolboxOptions = {},
): Promise<Toolbox> {
  const { fromAnthropicTools: convertFromAnthropicTools } = await import(
    './adapters/anthropic'
  );
  if (Array.isArray(tools)) {
    return createImportedToolbox(convertFromAnthropicTools(tools), options);
  }

  return createImportedToolbox(convertFromAnthropicTools(tools as AnthropicTool), options);
}

async function createToolboxFromGeminiTools(
  tools: GeminiTool | readonly GeminiTool[],
  options: ImportedToolboxOptions = {},
): Promise<Toolbox> {
  const { fromGeminiTools: convertFromGeminiTools } = await import('./adapters/gemini');
  return createImportedToolbox(convertFromGeminiTools(tools), options);
}

async function createToolboxFromProvider(
  provider: ToolProvider,
  definitions:
    | OpenAITool
    | readonly OpenAITool[]
    | AnthropicTool
    | readonly AnthropicTool[]
    | GeminiTool
    | readonly GeminiTool[],
  options: ImportedToolboxOptions = {},
): Promise<Toolbox> {
  switch (provider) {
    case 'openai':
      return createToolboxFromOpenAITools(definitions as OpenAITool | readonly OpenAITool[], options);
    case 'anthropic':
      return createToolboxFromAnthropicTools(
        definitions as AnthropicTool | readonly AnthropicTool[],
        options,
      );
    case 'gemini':
      return createToolboxFromGeminiTools(definitions as GeminiTool | readonly GeminiTool[], options);
  }
}

export type CreateToolbox = typeof createToolboxBase & {
  fromProvider: typeof createToolboxFromProvider;
  fromOpenAITools: typeof createToolboxFromOpenAITools;
  fromAnthropicTools: typeof createToolboxFromAnthropicTools;
  fromGeminiTools: typeof createToolboxFromGeminiTools;
};

export const createToolbox: CreateToolbox = Object.assign(createToolboxBase, {
  fromProvider: createToolboxFromProvider,
  fromOpenAITools: createToolboxFromOpenAITools,
  fromAnthropicTools: createToolboxFromAnthropicTools,
  fromGeminiTools: createToolboxFromGeminiTools,
});

function createImportedToolbox(
  importedConfigurations: ImportedToolConfiguration | readonly ImportedToolConfiguration[],
  options: ImportedToolboxOptions,
): Toolbox {
  const resolvedOptions = resolveImportedToolboxOptions(options);
  const configurations = Array.isArray(importedConfigurations)
    ? importedConfigurations
    : [importedConfigurations];

  return createToolboxBase(
    configurations.map((configuration) =>
      materializeImportedToolConfiguration(configuration, resolvedOptions),
    ),
    resolvedOptions,
  );
}

function materializeImportedToolConfiguration(
  configuration: ImportedToolConfiguration,
  options: ToolboxOptions,
): ToolConfiguration {
  const definition = defineTool({
    name: configuration.name,
    description: configuration.description,
    ...(configuration.namespace !== undefined
      ? { namespace: configuration.namespace }
      : {}),
    ...(configuration.version !== undefined ? { version: configuration.version } : {}),
    ...(configuration.title !== undefined ? { title: configuration.title } : {}),
    ...(configuration.examples !== undefined
      ? { examples: configuration.examples }
      : {}),
    ...(configuration.tags !== undefined ? { tags: configuration.tags } : {}),
    ...(configuration.metadata !== undefined ? { metadata: configuration.metadata } : {}),
    ...(configuration.risk !== undefined ? { risk: configuration.risk } : {}),
    ...(configuration.lifecycle !== undefined
      ? { lifecycle: configuration.lifecycle }
      : {}),
    input: configuration.input,
  }) as AnyToolDefinition;

  const importedConfiguration = {
    ...definition,
    input: configuration.input,
  } as Omit<ToolConfiguration, 'execute'>;

  if (configuration.policy) {
    importedConfiguration.policy = configuration.policy;
  }
  if (configuration.policyContext) {
    importedConfiguration.policyContext = configuration.policyContext;
  }
  if (configuration.digests !== undefined) {
    importedConfiguration.digests = configuration.digests;
  }
  if (configuration.concurrency !== undefined) {
    importedConfiguration.concurrency = configuration.concurrency;
  }
  if (configuration.diagnostics) {
    importedConfiguration.diagnostics = configuration.diagnostics;
  }

  const execute =
    configuration.execute ??
    options.getTool?.(importedConfiguration) ??
    createImportedExecute(configuration.name);

  return {
    ...importedConfiguration,
    execute,
  };
}

function createImportedExecute(toolName: string): ToolConfiguration['execute'] {
  return () => Promise.reject(new Error(`Imported tool "${toolName}" does not have an execute implementation. Provide createToolbox.fromProvider(..., { sourceToolbox }), createToolbox.from<Provider>Tools(..., { getTool }), or supply execute before creating the toolbox.`));
}

function resolveImportedToolboxOptions(
  options: ImportedToolboxOptions,
): ToolboxOptions {
  const { sourceToolbox, ...rest } = options;
  if (!sourceToolbox) {
    return rest;
  }
  return {
    ...rest,
    getTool: rest.getTool ?? sourceToolbox.asExecuteResolver(),
  };
}

function resolveToolConcurrency(
  configuration: ToolConfiguration,
  registryConcurrency?: number,
): number | undefined {
  const direct = normalizeConcurrency(configuration.concurrency);
  if (direct !== undefined) {
    return direct;
  }
  const metadataConcurrency = normalizeConcurrency(configuration.metadata?.concurrency);
  if (metadataConcurrency !== undefined) {
    return metadataConcurrency;
  }
  return normalizeConcurrency(registryConcurrency);
}

function resolveToolDigests(
  configuration: ToolConfiguration,
  registryDigests?: ToolDigestOptions,
): ToolDigestOptions | undefined {
  if (configuration.digests !== undefined) {
    return configuration.digests;
  }
  return registryDigests;
}

function mergePolicyContexts(
  registryContext?: ToolPolicyContextProvider | Record<string, unknown>,
  toolContext?: ToolPolicyContextProvider,
): ToolPolicyContextProvider | undefined {
  const registryProvider = toPolicyContextProvider(registryContext);
  const toolProvider = toPolicyContextProvider(toolContext);
  if (!registryProvider && !toolProvider) {
    return undefined;
  }
  return async (context) => {
    const base = registryProvider ? await registryProvider(context) : undefined;
    const next = toolProvider ? await toolProvider(context) : undefined;
    return {
      ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}),
      ...(next && typeof next === 'object' && !Array.isArray(next) ? next : {}),
    };
  };
}

function toPolicyContextProvider(
  input?: ToolPolicyContextProvider | Record<string, unknown>,
): ToolPolicyContextProvider | undefined {
  if (!input) return undefined;
  if (typeof input === 'function') return input;
  if (typeof input === 'object' && !Array.isArray(input)) {
    return () => input;
  }
  return undefined;
}

function mergePolicies(
  registryPolicy: ToolPolicyHooks | undefined,
  toolPolicy: ToolPolicyHooks | undefined,
  options: { readOnly: boolean; allowMutation: boolean; allowDangerous: boolean },
): ToolPolicyHooks | undefined {
  const enforceMutating = options.readOnly || !options.allowMutation;
  const enforceDangerous = !options.allowDangerous;
  const hasBefore =
    enforceMutating ||
    enforceDangerous ||
    registryPolicy?.beforeExecute !== undefined ||
    toolPolicy?.beforeExecute !== undefined;
  const hasAfter =
    registryPolicy?.afterExecute !== undefined || toolPolicy?.afterExecute !== undefined;
  if (!hasBefore && !hasAfter) {
    return undefined;
  }
  return {
    async beforeExecute(context) {
      if (enforceMutating && isMutatingToolContext(context)) {
        return {
          allow: false,
          reason: `Mutating tool "${context.toolName}" is not allowed`,
        } satisfies ToolPolicyDecision;
      }
      if (enforceDangerous && isDangerousToolContext(context)) {
        return {
          allow: false,
          reason: `Dangerous tool "${context.toolName}" is not allowed`,
        } satisfies ToolPolicyDecision;
      }
      const registryDecision = await resolvePolicyDecision(
        registryPolicy?.beforeExecute,
        context,
      );
      if (registryDecision?.allow === false) {
        return registryDecision;
      }
      const toolDecision = await resolvePolicyDecision(
        toolPolicy?.beforeExecute,
        context,
      );
      if (toolDecision?.allow === false) {
        return toolDecision;
      }
      return { allow: true } satisfies ToolPolicyDecision;
    },
    async afterExecute(context) {
      if (toolPolicy?.afterExecute) {
        await toolPolicy.afterExecute(context);
      }
      if (registryPolicy?.afterExecute) {
        await registryPolicy.afterExecute(context);
      }
    },
  };
}

async function resolvePolicyDecision(
  hook: ToolPolicyHooks['beforeExecute'] | undefined,
  context: ToolPolicyContext,
): Promise<ToolPolicyDecision | undefined> {
  if (!hook) {
    return undefined;
  }
  const decision = await hook(context);
  if (decision === undefined) {
    return undefined;
  }
  if (typeof decision === 'boolean') {
    return { allow: decision };
  }
  return decision;
}

function isMutatingToolContext(context: ToolPolicyContext): boolean {
  const tags = context.tags?.map((tag) => tag.toLowerCase()) ?? [];
  const tagSet = new Set(tags);
  const metadata = context.metadata;
  if (metadata?.mutates === true) {
    return true;
  }
  if (metadata?.readOnly === true) {
    return false;
  }
  if (tagSet.has('mutating')) {
    return true;
  }
  if (tagSet.has('readonly') || tagSet.has('read-only')) {
    return false;
  }
  return false;
}

function isDangerousToolContext(context: ToolPolicyContext): boolean {
  const tags = context.tags?.map((tag) => tag.toLowerCase()) ?? [];
  const tagSet = new Set(tags);
  const metadata = context.metadata;
  if (metadata?.dangerous === true) {
    return true;
  }
  if (tagSet.has('dangerous')) {
    return true;
  }
  return false;
}

function normalizeToolSchema(schema: unknown): ToolParametersSchema {
  if (schema === undefined) {
    return z.object({});
  }
  if (isZodObjectSchema(schema)) {
    return schema;
  }
  if (isZodSchema(schema)) {
    throw new Error('Tool input must be a Zod object schema');
  }
  if (schema && typeof schema === 'object') {
    return z.object(schema as Record<string, z.ZodTypeAny>);
  }
  throw new Error('Tool input must be a Zod object schema or an object of Zod schemas');
}

function checkBudget(
  budget: ToolboxOptions['budget'] | undefined,
  startedAt: number,
  calls: number,
): string | undefined {
  if (!budget) return undefined;
  if (typeof budget.maxCalls === 'number' && calls >= budget.maxCalls) {
    return `Budget exceeded: max calls ${budget.maxCalls}`;
  }
  if (typeof budget.maxDurationMs !== 'number') {
    return undefined;
  }
  const elapsed = Date.now() - startedAt;
  return elapsed >= budget.maxDurationMs ? `Budget exceeded: max duration ${budget.maxDurationMs}ms` : undefined;
}

function createLazyExecuteResolver(
  execute: ToolConfiguration['execute'],
  toolName: string,
): () => Promise<(params: unknown, context?: unknown) => Promise<unknown>> {
  if (typeof execute === 'function') {
    const fn = execute;
    return () => Promise.resolve(fn);
  }
  let resolved: ((params: unknown, context?: unknown) => Promise<unknown>) | undefined;
  let pending:
    | Promise<(params: unknown, context?: unknown) => Promise<unknown>>
    | undefined;

  return async () => {
    if (resolved) return resolved;
    if (!pending) {
      pending = Promise.resolve(execute)
        .then((value) => {
          if (typeof value !== 'function') {
            throw new TypeError(
              `Tool "${toolName}" has invalid execute. Expected a function or a promise that resolves to a function. If deserializing, ensure createToolbox({ getTool }) returns a function.`,
            );
          }
          resolved = value;
          return value;
        })
        .catch((error) => {
          pending = undefined;
          throw error;
        });
    }
    return pending;
  };
}

function isPromise<T>(value: unknown): value is PromiseLike<T> {
  if (!value || typeof value !== 'object') return false;
  if (!('then' in value)) return false;
  const candidate = value as PromiseLike<unknown>;
  return typeof candidate.then === 'function';
}

function deriveRiskFromMetadata(metadata: ToolMetadata | undefined) {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const risk: ToolRisk = {};
  if (typeof metadata.mutates === 'boolean') {
    risk.mutates = metadata.mutates;
  }
  if (typeof metadata.readOnly === 'boolean') {
    risk.readOnly = metadata.readOnly;
  }
  if (typeof metadata.dangerous === 'boolean') {
    risk.dangerous = metadata.dangerous;
  }
  return Object.keys(risk).length ? risk : undefined;
}

function createToolError(
  category: ToolErrorCategory,
  message: string,
  code: string,
  retryable: boolean,
): ToolError {
  return { code, category, retryable, message };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  return Symbol.asyncIterator in value;
}

function extractErrorCode(error: unknown): string | undefined {
  const code = getStringProperty(error, 'code');
  if (code) return code;
  const name = getStringProperty(error, 'name');
  if (name && name !== 'Error') return name;
  return undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return typeof record[key] === 'string' ? record[key] : undefined;
}

const embedderCache = new WeakMap<
  Embedder,
  Map<string, EmbeddingVector[] | Promise<EmbeddingVector[]>>
>();

function createCachedEmbedder(embedder: Embedder): Embedder {
  return (texts: string[]): EmbeddingVector[] | Promise<EmbeddingVector[]> => {
    // Create a cache key from the texts array
    const cacheKey = JSON.stringify(texts);

    // Get or create cache for this embedder
    let cache = embedderCache.get(embedder);
    if (!cache) {
      cache = new Map();
      embedderCache.set(embedder, cache);
    }

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Call embedder and cache result
    const result = embedder(texts);
    cache.set(cacheKey, result);

    // If result is a promise, handle rejection to avoid caching errors
    if (isPromise(result)) {
      result.catch(() => {
        // Remove from cache on error so we can retry
        cache.delete(cacheKey);
      });
    }

    return result;
  };
}

/**
 * Type guard to check if a value is a Toolbox instance.
 */
export function isToolbox(value: unknown): value is Toolbox<any> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Toolbox<any>).tools === 'function' &&
    typeof (value as Toolbox<any>).getTool === 'function' &&
    typeof (value as Toolbox<any>).execute === 'function' &&
    typeof (value as Toolbox<any>).toJSON === 'function'
  );
}

function isTestRuntime(): boolean {
  const nodeEnvIsTest = process.env.NODE_ENV === 'test';
  const entry = process.argv[1] ?? '';
  const testEntrypoint = /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry);
  return nodeEnvIsTest || testEntrypoint;
}

export const internalToolboxTestUtilities = {
  checkBudget,
  createCachedEmbedder,
  createImportedExecute,
  createImportedToolbox,
  createLazyExecuteResolver,
  deriveRiskFromMetadata,
  isDangerousToolContext,
  isMutatingToolContext,
  materializeImportedToolConfiguration,
  mergePolicies,
  normalizeToolCallArguments,
  normalizeToolSchema,
  resolvePolicyDecision,
  toPolicyContextProvider,
};
