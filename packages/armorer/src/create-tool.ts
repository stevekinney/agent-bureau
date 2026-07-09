import { createIncrementalHash, sha256HexSync } from 'interoperability';
import { CompletableEventTarget } from 'lifecycle';
import { z } from 'zod';

import type { ToolError, ToolErrorCategory } from './core/errors';
import { buildTagsFromRisk, type ToolRisk } from './core/risk';
import { serializeToolDefinition } from './core/serialization';
import { assertJsonValue, type JsonValue, stableStringifyJson } from './core/serialization/json';
import { assertKebabCaseTag, type NormalizeTagsOption, uniqTags } from './core/tag-utilities';
import type {
  AnyToolDefinition,
  ToolAvailabilityHook,
  ToolLifecycle,
} from './core/tool-definition';
import { defineTool } from './core/tool-definition';
import { errorString, normalizeError } from './errors';
import {
  ToolCancelledEvent,
  type ToolEventMap,
  ToolExecuteErrorEvent,
  ToolExecuteStartEvent,
  ToolExecuteSuccessEvent,
  ToolFinishedEvent,
  ToolLogEvent,
  ToolOutputChunkEvent,
  ToolPolicyActionRequiredEvent,
  ToolPolicyDeniedEvent,
  ToolProgressEvent,
  ToolSettledEvent,
  ToolStartedEvent,
  ToolStatusUpdateEvent,
  ToolStreamChunkEvent,
  ToolStreamEndEvent,
  ToolStreamErrorEvent,
  ToolStreamStartEvent,
  ToolValidateErrorEvent,
  ToolValidateSuccessEvent,
} from './events';
import { type ApprovalResumeState, approvalResumeSymbol } from './internal/approval-resume';
import type {
  DefaultToolEvents,
  MinimalAbortSignal,
  Tool,
  ToolCallWithArguments,
  ToolConfiguration,
  ToolContext,
  ToolDiagnostics,
  ToolDigestOptions,
  ToolEventsMap,
  ToolExecuteOptions,
  ToolExecuteWithOptions,
  ToolMetadata,
  ToolParametersSchema,
  ToolPolicyAfterContext,
  ToolPolicyContext,
  ToolPolicyContextProvider,
  ToolPolicyDecision,
  ToolPolicyHooks,
  ToolRepairHint,
  ToolValidationReport,
} from './is-tool';
import { isAsyncIterable, isPromise, isTestRuntime } from './type-guards';
import type { ToolAction, ToolCall, ToolExecutionResult } from './types';
import { createConcurrencyLimiter, normalizeConcurrency } from './utilities/concurrency';
import { normalizeSchema } from './utilities/schema-normalization';

type InternalToolExecuteOptions = ToolExecuteOptions & {
  [approvalResumeSymbol]?: ApprovalResumeState;
};

// Map from event type strings to their Event subclass constructors.
// Used by the `emit(type, detail)` helper to construct the correct Event.

const toolEventClassMap: Record<string, new (detail: any) => Event> = {
  [ToolStatusUpdateEvent.type]: ToolStatusUpdateEvent,
  [ToolExecuteStartEvent.type]: ToolExecuteStartEvent,
  [ToolValidateSuccessEvent.type]: ToolValidateSuccessEvent,
  [ToolValidateErrorEvent.type]: ToolValidateErrorEvent,
  [ToolExecuteSuccessEvent.type]: ToolExecuteSuccessEvent,
  [ToolExecuteErrorEvent.type]: ToolExecuteErrorEvent,
  [ToolSettledEvent.type]: ToolSettledEvent,
  [ToolPolicyDeniedEvent.type]: ToolPolicyDeniedEvent,
  [ToolPolicyActionRequiredEvent.type]: ToolPolicyActionRequiredEvent,
  [ToolStartedEvent.type]: ToolStartedEvent,
  [ToolFinishedEvent.type]: ToolFinishedEvent,
  [ToolProgressEvent.type]: ToolProgressEvent,
  [ToolStreamStartEvent.type]: ToolStreamStartEvent,
  [ToolStreamChunkEvent.type]: ToolStreamChunkEvent,
  [ToolStreamEndEvent.type]: ToolStreamEndEvent,
  [ToolStreamErrorEvent.type]: ToolStreamErrorEvent,
  [ToolOutputChunkEvent.type]: ToolOutputChunkEvent,
  [ToolLogEvent.type]: ToolLogEvent,
  [ToolCancelledEvent.type]: ToolCancelledEvent,
};

/**
 * Options for creating a tool.
 *
 * TInput is inferred from the input schema. To minimize type computation:
 * - ToolContext and related types use type-erasure (unknown) for params
 * - Runtime schema validation provides actual type safety
 * - Only the execute function receives typed params
 */
export interface CreateToolOptions<
  TInput extends object = Record<string, unknown>,
  TOutput = unknown,
  E extends ToolEventsMap = DefaultToolEvents,
  Tags extends readonly string[] = readonly string[],
  M extends ToolMetadata | undefined = ToolMetadata | undefined,
  TContext extends ToolContext<E> = ToolContext<E>,
  TReturn = TOutput,
> {
  name: string;
  description: string;
  namespace?: string;
  version?: string;
  title?: string;
  examples?: readonly string[];
  risk?: ToolRisk;
  lifecycle?: ToolLifecycle;
  availability?: ToolAvailabilityHook;
  input?: z.ZodType<TInput> | z.ZodRawShape | z.ZodTypeAny;
  execute:
    | ((params: TInput, context: TContext) => Promise<TReturn>)
    | Promise<(params: TInput, context: TContext) => Promise<TReturn>>;
  /** Default execution timeout in milliseconds. */
  timeout?: number;
  tags?: NormalizeTagsOption<Tags>;
  metadata?: ToolMetadataInput<M>;
  policy?: ToolPolicyHooks;
  policyContext?: ToolPolicyContextProvider;
  digests?: ToolDigestOptions;
  concurrency?: number;
  telemetry?: boolean;
  diagnostics?: ToolDiagnostics;
  /**
   * Generates an idempotency key from the tool input. When set, the tool
   * can be wrapped with `withIdempotency()` to deduplicate executions.
   */
  idempotencyKey?: (input: unknown) => string;
}

export type SyncToolMetadataInput<M extends ToolMetadata | undefined> = M | (() => M);

export type AsyncToolMetadataInput<M extends ToolMetadata | undefined> =
  | Promise<M>
  | (() => Promise<M>);

export type ToolMetadataInput<M extends ToolMetadata | undefined> =
  | SyncToolMetadataInput<M>
  | AsyncToolMetadataInput<M>;

type SchemaInput = z.ZodTypeAny | z.ZodRawShape;

type InferSchemaInput<TSchema extends SchemaInput> = TSchema extends z.ZodRawShape
  ? z.infer<z.ZodObject<TSchema>>
  : TSchema extends z.ZodType<infer T>
    ? T extends object
      ? T
      : Record<string, unknown>
    : Record<string, unknown>;

type NamedTool<
  TName extends string,
  TSchema extends z.ZodTypeAny,
  E extends ToolEventsMap,
  TReturn,
  M extends ToolMetadata | undefined,
  Tags extends readonly string[],
> = Tool<TSchema, E, TReturn, M> & {
  name: TName;
  /** @internal Type marker used by query helpers for typed tag IntelliSense. */
  __tags?: Tags;
};

type CreateToolReturn<
  TName extends string,
  TSchema extends z.ZodTypeAny,
  E extends ToolEventsMap,
  TReturn,
  M extends ToolMetadata | undefined,
  Tags extends readonly string[],
  TMetadataInput extends ToolMetadataInput<M> | undefined,
> =
  TMetadataInput extends AsyncToolMetadataInput<M>
    ? Promise<NamedTool<TName, TSchema, E, TReturn, M, Tags>>
    : NamedTool<TName, TSchema, E, TReturn, M, Tags>;

export type WithContext<
  T extends object = Record<string, unknown>,
  E extends ToolEventsMap = DefaultToolEvents,
> = ToolContext<E> & T;

/**
 * Creates a lazy-loaded function that defers execution until first call.
 *
 * Useful for tool execute functions that require expensive imports or async initialization.
 * The loader is called once on first invocation, then cached for subsequent calls.
 *
 * @param loader - Function that returns or resolves to the actual execute function
 * @returns A proxy function that loads and caches the real function on first call
 *
 * @example
 * ```typescript
 * import { createTool, lazy } from 'armorer';
 * import { z } from 'zod';
 *
 * const tool = createTool({
 *   name: 'expensive-operation',
 *   description: 'Tool with heavy dependencies',
 *   input: z.object({ data: z.string() }),
 *   execute: lazy(async () => {
 *     // Heavy import only loaded when tool is first executed
 *     const { processData } = await import('./heavy-module');
 *     return async ({ data }) => processData(data);
 *   }),
 * });
 * ```
 */
export function lazy<TExecute extends (...args: unknown[]) => Promise<unknown>>(
  loader: () => PromiseLike<TExecute> | TExecute,
): TExecute {
  let resolved: TExecute | undefined;
  let pending: Promise<TExecute> | undefined;

  const load = async () => {
    if (resolved) return resolved;
    if (!pending) {
      pending = Promise.resolve()
        .then(() => loader())
        .then((value) => {
          if (typeof value !== 'function') {
            throw new TypeError('lazy loader must resolve to a function');
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

  return (async (...args: Parameters<TExecute>) => {
    const execute = await load();
    return execute(...args);
  }) as TExecute;
}

function formatNonStringReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined;
  if (typeof reason === 'number' || typeof reason === 'boolean' || typeof reason === 'bigint') {
    return String(reason);
  }
  if (typeof reason === 'symbol') {
    return reason.description ?? 'Symbol';
  }
  if (typeof reason !== 'object') return undefined;
  try {
    return JSON.stringify(reason);
  } catch {
    return undefined;
  }
}

/**
 * Creates a validated, executable AI tool with input schema, metadata, and lifecycle hooks.
 *
 * Tools define their input schema using Zod, execute logic, and optional features like
 * policies and event handlers. Tools can be
 * used standalone or provided to `createToolbox(...)`.
 *
 * @param options - Tool configuration object
 * @param options.name - Unique tool name (alphanumeric, hyphens, underscores)
 * @param options.description - Human-readable description of what the tool does
 * @param options.input - Zod schema defining the tool's input
 * @param options.execute - Async function that implements the tool's logic
 * @param options.tags - Array of string tags for categorization and search
 * @param options.metadata - Custom metadata (risk level, category, version, etc.)
 * @param options.policy - Policy hooks for access control and validation
 * @param options.timeout - Hard execution timeout in milliseconds
 * @param options.namespace - Optional namespace for organizing tools
 * @param options.version - Semantic version string
 *
 * @returns A Tool that can be executed directly or provided to `createToolbox(...)`
 *
 * @example Basic tool
 * ```typescript
 * import { createTool } from 'armorer';
 * import { z } from 'zod';
 *
 * const addNumbers = createTool({
 *   name: 'add',
 *   description: 'Add two numbers together',
 *   input: z.object({
 *     a: z.number().describe('First number'),
 *     b: z.number().describe('Second number'),
 *   }),
 *   async execute({ a, b }) {
 *     return a + b;
 *   },
 * });
 *
 * const result = await addNumbers({ a: 5, b: 3 });
 * console.log(result); // 8
 * ```
 *
 * @example With explicit types
 * ```typescript
 * interface MyInput { foo: string; bar: number; }
 * interface MyOutput { result: string; }
 *
 * const tool = createTool<MyInput, MyOutput>({
 *   name: 'myTool',
 *   input: z.object({ foo: z.string(), bar: z.number() }),
 *   async execute(params) {
 *     // params is MyInput - properly typed!
 *     return { result: params.foo };
 *   }
 * });
 * ```
 *
 * @example With metadata
 * ```typescript
 * const deleteFile = createTool({
 *   name: 'delete-file',
 *   description: 'Delete a file from disk',
 *   input: z.object({ path: z.string() }),
 *   metadata: {
 *     risk: 'high',
 *     category: 'file-system',
 *   },
 *   async execute({ path }) {
 *     await fs.promises.unlink(path);
 *     return { deleted: path };
 *   },
 * });
 * ```
 */
export function createTool<
  TSchema extends SchemaInput,
  TOutput = unknown,
  E extends ToolEventsMap = DefaultToolEvents,
  Tags extends readonly string[] = readonly string[],
  M extends ToolMetadata | undefined = ToolMetadata | undefined,
  TContext extends ToolContext<E> = ToolContext<E>,
  TReturn = TOutput,
  TMetadataInput extends ToolMetadataInput<M> | undefined = SyncToolMetadataInput<M> | undefined,
  TName extends string = string,
>(
  options: Omit<
    CreateToolOptions<InferSchemaInput<TSchema>, TOutput, E, Tags, M, TContext, TReturn>,
    'metadata' | 'name'
  > & {
    name: TName;
    metadata?: TMetadataInput;
    input: TSchema;
  },
): CreateToolReturn<
  TName,
  z.ZodType<InferSchemaInput<TSchema>>,
  E,
  TReturn,
  M,
  Tags,
  TMetadataInput
>;

export function createTool<
  TInput extends object = Record<string, unknown>,
  TOutput = unknown,
  E extends ToolEventsMap = DefaultToolEvents,
  Tags extends readonly string[] = readonly string[],
  M extends ToolMetadata | undefined = ToolMetadata | undefined,
  TContext extends ToolContext<E> = ToolContext<E>,
  TReturn = TOutput,
  TMetadataInput extends ToolMetadataInput<M> | undefined = SyncToolMetadataInput<M> | undefined,
  TName extends string = string,
>(
  options: Omit<
    CreateToolOptions<TInput, TOutput, E, Tags, M, TContext, TReturn>,
    'metadata' | 'name'
  > & {
    name: TName;
    metadata?: TMetadataInput;
  },
): CreateToolReturn<TName, z.ZodType<TInput>, E, TReturn, M, Tags, TMetadataInput>;
export function createTool<
  TInput extends object = Record<string, unknown>,
  TOutput = unknown,
  E extends ToolEventsMap = DefaultToolEvents,
  Tags extends readonly string[] = readonly string[],
  M extends ToolMetadata | undefined = ToolMetadata | undefined,
  TContext extends ToolContext<E> = ToolContext<E>,
  TReturn = TOutput,
  TMetadataInput extends ToolMetadataInput<M> | undefined = ToolMetadataInput<M> | undefined,
  TName extends string = string,
>(
  options: Omit<
    CreateToolOptions<TInput, TOutput, E, Tags, M, TContext, TReturn>,
    'metadata' | 'name'
  > & {
    name: TName;
    metadata?: TMetadataInput;
  },
  legacyToolbox?: unknown,
): CreateToolReturn<TName, z.ZodType<TInput>, E, TReturn, M, Tags, TMetadataInput> {
  const metadataInput = options.metadata as ToolMetadataInput<M> | undefined;
  const resolvedMetadata = resolveMetadataInput(metadataInput);
  if (isPromise<M>(resolvedMetadata)) {
    const recreateWithLegacy = createTool as unknown as (
      nextOptions: Omit<
        CreateToolOptions<TInput, TOutput, E, Tags, M, TContext, TReturn>,
        'metadata'
      > & {
        metadata: M;
      },
      nextLegacyToolbox?: unknown,
    ) => CreateToolReturn<TName, z.ZodType<TInput>, E, TReturn, M, Tags, TMetadataInput>;
    return Promise.resolve(resolvedMetadata).then((metadata) =>
      recreateWithLegacy(
        {
          ...options,
          metadata: metadata as M,
        },
        legacyToolbox,
      ),
    ) as CreateToolReturn<TName, z.ZodType<TInput>, E, TReturn, M, Tags, TMetadataInput>;
  }

  const {
    name,
    description,
    namespace,
    version,
    title,
    examples,
    risk,
    lifecycle,
    availability,
    input: toolInput,
    execute: fn,
    timeout,
    tags,
    policy,
    policyContext,
    digests,
    concurrency,
    telemetry,
    diagnostics,
    idempotencyKey,
  } = options as CreateToolOptions<TInput, TOutput, E, Tags, M, TContext, TReturn>;

  const customMetadata = resolvedMetadata ?? (undefined as M);
  const normalizedInput = normalizeSchema(toolInput);

  const emitter = new CompletableEventTarget<ToolEventMap>();

  // Convenience wrapper to dispatch a pre-constructed Event.
  const dispatch = (event: Event) => emitter.dispatchEvent(event);

  // Legacy emit helper: constructs the correct Event subclass from a type
  // string and detail bag.  Used by legacy callsites and user-space dispatch.
  const emit = (type: string, detail: unknown) => {
    const cls = toolEventClassMap[type];
    if (cls) {
      return emitter.dispatchEvent(new (cls as unknown as new (d: unknown) => Event)(detail));
    }
    // For custom / unknown event types, dispatch a plain Event so listeners
    // that registered for arbitrary type strings still fire.
    const event = new Event(type);
    if (detail !== null && detail !== undefined && typeof detail === 'object') {
      Object.assign(event, detail);
    } else if (detail !== undefined) {
      Object.defineProperty(event, 'detail', { value: detail, enumerable: true });
    }
    return emitter.dispatchEvent(event);
  };

  const metadataValue = customMetadata ?? (undefined as M);
  const resolvedRisk = mergeRisk(metadataValue, risk);
  const normalizedTags = normalizeTagsWithRisk(tags, resolvedRisk, name);
  const telemetryEnabled = telemetry === true;
  const digestOptions = normalizeDigestOptions(digests);
  const concurrencyLimit = normalizeConcurrency(
    typeof metadataValue?.concurrency === 'number' ? metadataValue.concurrency : concurrency,
  );
  const limiter = createConcurrencyLimiter(concurrencyLimit);
  const runWithConcurrency = <T>(task: () => Promise<T>) => (limiter ? limiter.run(task) : task());

  const resolveExecute = createLazyExecuteResolver(fn);
  const policyHooks = policy;
  const policyContextProvider = policyContext;

  const definition = defineTool({
    name,
    description,
    ...(namespace !== undefined ? { namespace } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(examples !== undefined ? { examples } : {}),
    ...(normalizedTags.length ? { tags: normalizedTags } : {}),
    ...(metadataValue !== undefined ? { metadata: metadataValue } : {}),
    ...(resolvedRisk !== undefined ? { risk: resolvedRisk } : {}),
    ...(lifecycle !== undefined ? { lifecycle } : {}),
    ...(availability !== undefined ? { availability } : {}),
    input: normalizedInput,
  }) as AnyToolDefinition;

  const inputSchema = definition.input as unknown as ToolParametersSchema;
  const schema = inputSchema;
  const typedSchema = inputSchema as unknown as z.ZodType<TInput>;

  const buildPolicyContext = (
    toolCall: ToolCall,
    params: unknown,
    inputDigest?: string,
  ): ToolPolicyContext => {
    const context: ToolPolicyContext = {
      toolName: name,
      toolCall,
      params,
      configuration,
    };
    if (inputDigest !== undefined) {
      context.inputDigest = inputDigest;
    }
    if (normalizedTags.length) {
      context.tags = normalizedTags;
    }
    if (metadataValue !== undefined) {
      context.metadata = metadataValue;
    }
    return context;
  };

  const resolvePolicyDecision = async (
    context: ToolPolicyContext,
  ): Promise<ToolPolicyDecision | undefined> => {
    if (!policyHooks?.beforeExecute) {
      return undefined;
    }
    const decision = await policyHooks.beforeExecute(context);
    if (decision === undefined) {
      return undefined;
    }
    if (typeof decision === 'boolean') {
      return { allow: decision };
    }
    return decision;
  };

  const runPolicyAfter = async (context: ToolPolicyAfterContext): Promise<void> => {
    if (!policyHooks?.afterExecute) {
      return;
    }
    try {
      await policyHooks.afterExecute(context);
    } catch (error) {
      emit('log', {
        level: 'warn',
        message: 'policy afterExecute failed',
        data: error,
      });
    }
  };

  const executeCall = async (
    toolCall: ToolCallWithArguments,
    options?: InternalToolExecuteOptions,
  ): Promise<ToolExecutionResult> => {
    const resolvedTimeout = options?.timeout ?? timeout;
    const executeOptions: InternalToolExecuteOptions = {
      ...options,
      ...(resolvedTimeout !== undefined ? { timeout: resolvedTimeout } : {}),
    };
    return runWithConcurrency(() => executeInner(normalizeToolCall(toolCall), executeOptions));
  };

  const executeParams = async (params: TInput, options?: ToolExecuteOptions): Promise<TReturn> => {
    const toolCall = createToolCall(name, normalizeToolContent(params)) as ToolCallWithArguments;
    const result = await executeCall(toolCall, options);
    const errorMessage = result.error?.message ?? result.errorMessage;
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    return result.result as TReturn;
  };

  const execute = (
    input: ToolCallWithArguments | TInput,
    options?: ToolExecuteOptions,
  ): Promise<ToolExecutionResult | TReturn> => {
    if (looksLikeToolCall(input, name)) {
      return executeCall(input, options);
    }
    return executeParams(input, options);
  };

  const executeInner = async (
    toolCall: ToolCall & { arguments: unknown },
    options: InternalToolExecuteOptions = {},
  ): Promise<ToolExecutionResult> => {
    const baseDetail = { toolCall, configuration };
    const nowFunction = options.now ?? Date.now;
    const startedAt = telemetryEnabled ? nowFunction() : 0;
    const inputDigest = digestOptions.input
      ? computeDigest(toolCall.arguments, digestOptions.algorithm)
      : undefined;

    const finishTelemetry = (
      status: 'success' | 'error' | 'denied' | 'cancelled' | 'paused',
      details: {
        result?: unknown;
        error?: unknown;
        reason?: string;
        errorCategory?: ToolErrorCategory;
        inputDigest?: string;
        outputDigest?: string;
      } = {},
    ) => {
      if (!telemetryEnabled) return;
      const finishedAt = nowFunction();
      emit('tool.finished', {
        ...baseDetail,
        status,
        durationMs: finishedAt - startedAt,
        startedAt,
        finishedAt,
        ...details,
      });
    };

    if (telemetryEnabled) {
      emit('tool.started', {
        ...baseDetail,
        params: toolCall.arguments,
        startedAt,
        inputDigest,
      });
    }

    const handleCancellation = (reason?: unknown): ToolExecutionResult => {
      let message = 'Cancelled';
      if (typeof reason === 'string') {
        message = reason || 'Cancelled';
      } else if (reason instanceof Error) {
        message = reason.message || 'Cancelled';
      } else {
        const formatted = formatNonStringReason(reason);
        if (formatted) {
          message = `Cancelled: ${formatted}`;
        }
      }
      const errorObj = new Error(message);
      const toolError = createToolError('cancelled', message, {
        code: 'CANCELLED',
        retryable: false,
      });
      emit('execute-error', { ...baseDetail, error: errorObj });
      emit('settled', { ...baseDetail, error: errorObj });
      const cancelledDetails: {
        error?: unknown;
        errorCategory?: ToolErrorCategory;
        inputDigest?: string;
      } = { error: errorObj, errorCategory: toolError.category };
      if (inputDigest !== undefined) {
        cancelledDetails.inputDigest = inputDigest;
      }
      finishTelemetry('cancelled', cancelledDetails);
      const callId = toolCall.id;
      return {
        callId,
        outcome: 'error',
        content: message,
        toolCallId: callId,
        toolName: name,
        result: undefined,
        error: toolError,
        errorMessage: toolError.message,
        errorCategory: toolError.category,
        inputDigest,
      } as ToolExecutionResult;
    };

    if (options.signal?.aborted) {
      return handleCancellation(options.signal.reason);
    }

    try {
      emit('execute-start', {
        ...baseDetail,
        params: toolCall.arguments,
      });
      if (options.signal?.aborted) {
        return handleCancellation(options.signal.reason);
      }
      const parsed = schema.parse(toolCall.arguments) as TInput;
      const typedToolCall = { ...toolCall, arguments: parsed } as ToolCallWithArguments;
      const parsedDetail = { toolCall: typedToolCall, configuration };
      emit('validate-success', { ...parsedDetail, params: toolCall.arguments, parsed });
      if (options.signal?.aborted) {
        return handleCancellation(options.signal.reason);
      }
      const policyContext = buildPolicyContext(typedToolCall, parsed, inputDigest);
      if (policyContextProvider) {
        const injected = await policyContextProvider(policyContext);
        if (injected && typeof injected === 'object' && !Array.isArray(injected)) {
          policyContext.policyContext = injected;
        }
      }
      const approvalResume = options[approvalResumeSymbol];
      const decision = await resolvePolicyDecision(policyContext);
      const parsedArgumentsDigest = stableStringifyJson(normalizeToolContent(parsed));
      const proposedArgumentsDigest =
        approvalResume === undefined
          ? undefined
          : stableStringifyJson(normalizeToolContent(approvalResume.proposedArguments));
      const executedArgumentsEdited =
        approvalResume !== undefined && proposedArgumentsDigest !== parsedArgumentsDigest;

      let resumedApprovalIsSatisfied = false;
      if (decision?.status === 'needs_approval' || decision?.status === 'needs_input') {
        const type = decision.status === 'needs_approval' ? 'approval' : 'input';
        const reason = decision.reason ?? `Tool execution requires ${type}`;
        const action = createToolAction(type, decision, reason);
        const resumedArgumentsMatchApproval = proposedArgumentsDigest === parsedArgumentsDigest;
        resumedApprovalIsSatisfied =
          approvalResume !== undefined &&
          approvalResume.approvedAction.type === type &&
          resumedArgumentsMatchApproval &&
          approvalResume.reason === reason &&
          stableStringifyJson(normalizeToolContent(approvalResume.approvedAction)) ===
            stableStringifyJson(normalizeToolContent(action));

        if (!resumedApprovalIsSatisfied) {
          emit('policy-action-required', { ...parsedDetail, params: parsed, reason });

          await runPolicyAfter({
            ...policyContext,
            outcome: 'action_required',
            reason,
          });

          finishTelemetry('paused', { reason });

          const callId = typedToolCall.id;
          return {
            callId,
            outcome: 'action_required',
            content: reason,
            toolCallId: callId,
            toolName: name,
            result: undefined,
            action,
            pendingApproval: {
              callId,
              toolName: name,
              arguments: normalizeToolContent(parsed),
              action,
              reason,
              metadata: normalizeToolContent(configuration.metadata ?? {}),
            },
            inputDigest,
          } as ToolExecutionResult;
        }
      }

      if (decision?.allow === false && !resumedApprovalIsSatisfied) {
        const reason = decision.reason ?? 'Policy denied';
        emit('policy-denied', { ...parsedDetail, params: parsed, reason });
        const errorObj = new Error(reason);
        const toolError = createToolError('permission', reason, {
          code: 'POLICY_DENIED',
          retryable: false,
        });
        emit('execute-error', { ...parsedDetail, error: errorObj });
        emit('settled', { ...parsedDetail, error: errorObj });
        await runPolicyAfter({
          ...policyContext,
          outcome: 'denied',
          errorCategory: toolError.category,
          reason,
        });
        const deniedDetails: {
          reason?: string;
          errorCategory?: ToolErrorCategory;
          inputDigest?: string;
        } = { reason, errorCategory: toolError.category };
        if (inputDigest !== undefined) {
          deniedDetails.inputDigest = inputDigest;
        }
        finishTelemetry('denied', deniedDetails);
        const callId = typedToolCall.id;
        return {
          callId,
          outcome: 'error',
          content: reason,
          toolCallId: callId,
          toolName: name,
          result: undefined,
          error: toolError,
          errorMessage: toolError.message,
          errorCategory: toolError.category,
          inputDigest,
        } as ToolExecutionResult;
      }
      const meta: { toolName: string; callId?: string } = { toolName: name };
      if (typedToolCall.id) {
        meta.callId = typedToolCall.id;
      }

      const resolvedExecute = await resolveExecute();

      if (options.signal?.aborted) {
        return handleCancellation(options.signal.reason);
      }
      const toolContext: ToolContext<E> = {
        dispatch,
        meta,
        toolCall: typedToolCall,
        configuration,
        ...(options.durableOperationKey !== undefined
          ? { durableOperationKey: options.durableOperationKey }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options.stream !== undefined ? { stream: options.stream } : {}),
      };

      // `TContext` may be a subtype of `ToolContext<E>` (e.g. with extra fields).
      // At runtime we can only guarantee the base ToolContext shape, so we cast to
      // avoid `exactOptionalPropertyTypes` assignability issues.

      const runner = resolvedExecute(parsed, toolContext as unknown as TContext);

      const timed =
        typeof options.timeout === 'number'
          ? withTimeout(runner, options.timeout, options)
          : runner;

      let value: unknown = await raceWithSignal(timed, options.signal);
      let outputDigest: string | undefined;
      const streamDeadline =
        typeof options.timeout === 'number' ? nowFunction() + options.timeout : undefined;

      const assertStreamingWindow = () => {
        if (options.signal?.aborted) {
          throw createAbortRejection(options.signal.reason);
        }
        if (streamDeadline !== undefined && nowFunction() > streamDeadline) {
          throw new Error('TIMEOUT');
        }
      };

      const createStreamingAccumulator = () => ({
        chunks: [] as unknown[],
        index: 0,
        completed: false,
        digest: digestOptions.output ? createIncrementalHash(digestOptions.algorithm) : undefined,
      });

      const processStreamingChunk = (
        chunk: unknown,
        accumulator: ReturnType<typeof createStreamingAccumulator>,
      ) => {
        emit('stream-chunk', { chunk, index: accumulator.index });
        emit('output-chunk', { chunk });
        accumulator.chunks.push(chunk);
        if (accumulator.digest) {
          accumulator.digest.update(stableStringify(chunk));
        }
        accumulator.index += 1;
      };

      const finalizeStreamingAccumulator = (
        accumulator: ReturnType<typeof createStreamingAccumulator>,
      ): {
        collected: unknown[];
        outputDigest?: string;
      } => {
        const finalizedDigest = accumulator.digest?.digest();
        return {
          collected: accumulator.chunks,
          ...(finalizedDigest !== undefined ? { outputDigest: finalizedDigest } : {}),
        };
      };

      if (isAsyncIterable(value)) {
        if (options.stream === true) {
          emit('stream-start', { mode: 'stream' });
          const streamSource = value;
          const accumulator = createStreamingAccumulator();
          const stream: AsyncIterable<unknown> = {
            async *[Symbol.asyncIterator]() {
              let streamError: unknown;
              try {
                for await (const chunk of streamSource) {
                  assertStreamingWindow();
                  processStreamingChunk(chunk, accumulator);
                  yield chunk;
                }
                accumulator.completed = true;
              } catch (error) {
                streamError = error;
                emit('stream-error', { error, index: accumulator.index });
                throw error;
              } finally {
                const finalized = finalizeStreamingAccumulator(accumulator);
                emit('stream-end', {
                  chunks: accumulator.index,
                  completed: accumulator.completed,
                });
                if (streamError === undefined) {
                  emit('execute-success', {
                    ...parsedDetail,
                    result: finalized.collected,
                  });
                  emit('settled', {
                    ...parsedDetail,
                    result: finalized.collected,
                  });
                  const policyAfter: ToolPolicyAfterContext = {
                    ...policyContext,
                    outcome: 'success',
                    result: finalized.collected,
                  };
                  if (finalized.outputDigest !== undefined) {
                    policyAfter.outputDigest = finalized.outputDigest;
                  }
                  await runPolicyAfter(policyAfter);
                  const successDetails: {
                    result?: unknown;
                    inputDigest?: string;
                    outputDigest?: string;
                  } = { result: finalized.collected };
                  if (inputDigest !== undefined) {
                    successDetails.inputDigest = inputDigest;
                  }
                  if (finalized.outputDigest !== undefined) {
                    successDetails.outputDigest = finalized.outputDigest;
                  }
                  finishTelemetry('success', successDetails);
                } else {
                  emit('execute-error', {
                    ...parsedDetail,
                    error: streamError,
                  });
                  emit('settled', {
                    ...parsedDetail,
                    error: streamError,
                  });
                  const streamErrorCategory = classifyErrorCategory(streamError);
                  await runPolicyAfter({
                    ...policyContext,
                    outcome: 'error',
                    errorCategory: streamErrorCategory,
                    error: streamError,
                  });
                  const errorDetails: {
                    error?: unknown;
                    errorCategory?: ToolErrorCategory;
                    inputDigest?: string;
                  } = {
                    error: streamError,
                    errorCategory: streamErrorCategory,
                  };
                  if (inputDigest !== undefined) {
                    errorDetails.inputDigest = inputDigest;
                  }
                  finishTelemetry('error', errorDetails);
                }
              }
            },
          };
          const callId = typedToolCall.id;
          return {
            callId,
            outcome: 'success',
            content: '[stream]',
            toolCallId: callId,
            toolName: name,
            result: stream,
            stream,
            executedArgumentsEdited,
            inputDigest,
          } as ToolExecutionResult;
        }

        emit('stream-start', { mode: 'collect' });
        const accumulator = createStreamingAccumulator();
        try {
          for await (const chunk of value) {
            assertStreamingWindow();
            processStreamingChunk(chunk, accumulator);
          }
          accumulator.completed = true;
          emit('stream-end', { chunks: accumulator.index, completed: true });
        } catch (error) {
          emit('stream-error', { error, index: accumulator.index });
          throw error;
        }
        const finalized = finalizeStreamingAccumulator(accumulator);
        value = finalized.collected;
        outputDigest = finalized.outputDigest;
      }

      if (outputDigest === undefined && digestOptions.output) {
        outputDigest = computeDigest(value, digestOptions.algorithm);
      }
      emit('execute-success', { ...parsedDetail, result: value });
      emit('settled', { ...parsedDetail, result: value });
      const policyAfter: ToolPolicyAfterContext = {
        ...policyContext,
        outcome: 'success',
        result: value,
      };
      if (outputDigest !== undefined) {
        policyAfter.outputDigest = outputDigest;
      }
      await runPolicyAfter(policyAfter);
      const successDetails: {
        result?: unknown;
        inputDigest?: string;
        outputDigest?: string;
      } = { result: value };
      if (inputDigest !== undefined) {
        successDetails.inputDigest = inputDigest;
      }
      if (outputDigest !== undefined) {
        successDetails.outputDigest = outputDigest;
      }
      finishTelemetry('success', successDetails);
      const callId = typedToolCall.id;
      return {
        callId,
        outcome: 'success',
        content: normalizeToolContent(value),
        toolCallId: callId,
        toolName: name,
        result: value,
        executedArgumentsEdited,
        inputDigest,
        outputDigest,
      } as ToolExecutionResult;
    } catch (error) {
      if (isAbortRejection(error)) {
        return handleCancellation(error.reason);
      }
      const isZod = error instanceof z.ZodError;
      if (isZod) {
        let report: ToolValidationReport | undefined;
        let repairHints: ToolRepairHint[] | undefined;

        if (diagnostics?.safeParseWithReport) {
          try {
            const diagnosticsSchema = getDiagnosticsSchema(schema);
            const diagnosticsResult = diagnostics.safeParseWithReport(
              diagnosticsSchema,
              toolCall.arguments,
            );
            report = diagnosticsResult.report;
            if (diagnostics?.createRepairHints) {
              const hintError = diagnosticsResult.success ? error : diagnosticsResult.error;
              repairHints = diagnostics.createRepairHints(hintError, {
                rootLabel: 'arguments',
              });
            }
          } catch {
            // Ignore diagnostics failures
          }
        }

        if (!repairHints && diagnostics?.createRepairHints) {
          try {
            repairHints = diagnostics.createRepairHints(error, {
              rootLabel: 'arguments',
            });
          } catch {
            // Ignore diagnostics failures
          }
        }

        emit('validate-error', {
          ...baseDetail,
          params: toolCall.arguments,
          error,
          report,
          repairHints,
        });
      } else {
        emit('execute-error', { ...baseDetail, error });
      }
      emit('settled', { ...baseDetail, error });
      const callId = toolCall.id;
      const errorCategory = classifyErrorCategory(error);
      const errorPolicyContext = buildPolicyContext(toolCall, toolCall.arguments, inputDigest);
      if (policyContextProvider) {
        const injected = await policyContextProvider(errorPolicyContext);
        if (injected && typeof injected === 'object' && !Array.isArray(injected)) {
          errorPolicyContext.policyContext = injected;
        }
      }
      await runPolicyAfter({
        ...errorPolicyContext,
        outcome: 'error',
        errorCategory,
        error,
      });
      const errorDetails: {
        error?: unknown;
        errorCategory?: ToolErrorCategory;
        inputDigest?: string;
      } = { error, errorCategory };
      if (inputDigest !== undefined) {
        errorDetails.inputDigest = inputDigest;
      }
      finishTelemetry('error', errorDetails);
      const message = errorString(
        normalizeError(error, isTimeoutError(error) ? { code: 'TIMEOUT' } : undefined),
      );
      const toolError = isZod
        ? createToolError('validation', message, {
            code: 'VALIDATION_ERROR',
            retryable: false,
            details: { issues: serializeZodIssues(error.issues ?? []) },
          })
        : createToolError(errorCategory, message, {
            code: extractErrorCode(error) ?? defaultErrorCode(errorCategory),
            retryable: errorCategory === 'transient' || errorCategory === 'timeout',
          });
      return {
        callId,
        outcome: 'error',
        content: message,
        toolCallId: callId,
        toolName: name,
        result: undefined,
        error: toolError,
        errorMessage: toolError.message,
        errorCategory: toolError.category,
        inputDigest,
      } as ToolExecutionResult;
    }
  };

  const callable = async (params: unknown) => executeParams(params as TInput);

  const configuration = {
    ...definition,
    input: typedSchema,
    execute: async (params: unknown) => executeParams(params as TInput),
    // Store the original user execute function so that `buildDefaultTool` in
    // `createToolbox` can call it directly with toolbox context (baseContext).
    // Without this, `configuration.execute` is a self-contained wrapper that
    // ignores the context argument, causing toolbox baseContext to be dropped.
    rawExecute: fn,
  } as unknown as ToolConfiguration;
  if (policyHooks) {
    configuration.policy = policyHooks;
  }
  if (policyContextProvider) {
    configuration.policyContext = policyContextProvider;
  }
  if (digests !== undefined) {
    configuration.digests = digests;
  }
  if (concurrencyLimit !== undefined) {
    configuration.concurrency = concurrencyLimit;
  }
  if (idempotencyKey !== undefined) {
    (configuration as Record<string, unknown>)['idempotencyKey'] = idempotencyKey;
  }

  const toJSON = (() => {
    const serializableConfiguration = {
      ...configuration,
      input: configuration.input ?? typedSchema,
    } as AnyToolDefinition;
    const json = serializeToolDefinition(serializableConfiguration);
    return () => json;
  })();

  // Build metadata bag for proxy lookup
  const bag: Record<PropertyKey, unknown> = {
    id: configuration.id,
    identity: configuration.identity,
    display: configuration.display,
    name: configuration.identity.name,
    description: configuration.display.description,
    input: configuration.input ?? typedSchema,
    execute,
    run: async (params: unknown, context: TContext) => {
      const resolved = await resolveExecute();
      return resolved(params as TInput, context);
    },
    rawExecute: async (params: unknown, context: TContext) => {
      const resolved = await resolveExecute();
      return resolved(params as TInput, context);
    },
    configuration,
    // Event listener methods — return an unsubscribe function for compat.
    addEventListener: (
      type: string,
      listener: EventListener,
      options?: AddEventListenerOptions,
    ) => {
      // Merge the emitter's signal so listeners auto-cleanup on complete().
      const mergedOptions: AddEventListenerOptions = {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([options.signal, emitter.signal])
          : emitter.signal,
      };
      emitter.addEventListener(type, listener, mergedOptions);
      return () => emitter.removeEventListener(type, listener, options);
    },
    dispatchEvent: (event: Event) => emitter.dispatchEvent(event),
    emit,
    // Observable-based event methods
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    subscribe: emitter.subscribe.bind(emitter),
    toObservable: emitter.toObservable.bind(emitter),
    // Async iteration
    events: emitter.events.bind(emitter),
    // Lifecycle methods
    complete: emitter.complete.bind(emitter),
    get completed() {
      return emitter.completed;
    },
    toJSON,
    toString: () => `**${configuration.identity.name}**: ${configuration.display.description}`,
    [Symbol.toPrimitive]: () => configuration.identity.name,
    tags: configuration.tags,
    metadata: configuration.metadata,
    risk: configuration.risk,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };

  const tool = new Proxy(callable as unknown as Tool<z.ZodType<TInput>, E, TReturn, M>, {
    get(target, prop, receiver) {
      if (Object.prototype.hasOwnProperty.call(bag, prop)) {
        return bag[prop];
      }
      return Reflect.get(target as object, prop, receiver as unknown as object) as unknown;
    },
    has(_target, prop) {
      if (Object.prototype.hasOwnProperty.call(bag, prop)) return true;
      return Reflect.has(callable as unknown as object, prop);
    },
    apply(_target, _thisArg, argArray) {
      return callable(argArray[0]);
    },
    // Optional: cleanup on dispose
    getOwnPropertyDescriptor(_target, prop) {
      if (Object.prototype.hasOwnProperty.call(bag, prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: bag[prop],
        };
      }
      return Object.getOwnPropertyDescriptor(callable, prop);
    },
  });

  // Provide [Symbol.dispose] to complete the event target (clears listeners and marks complete)
  bag[Symbol.dispose] = () => {
    emitter.complete();
  };

  bag['executeWith'] = (options: ToolExecuteWithOptions) => {
    const toolCall = createToolCall(
      name,
      normalizeToolContent(options.params),
      options.callId,
    ) as ToolCallWithArguments;
    const resolvedTimeout = options.timeout ?? timeout;
    const executeOptions: ToolExecuteOptions = {
      ...options,
      ...(resolvedTimeout !== undefined ? { timeout: resolvedTimeout } : {}),
    };
    return runWithConcurrency(() => executeInner(toolCall, executeOptions));
  };

  const finalTool = tool as unknown as Tool<z.ZodType<TInput>, E, TReturn, M>;

  if (isTestRuntime() && hasLegacyRegister(legacyToolbox)) {
    legacyToolbox.register(finalTool as unknown as Tool);
  }

  return finalTool as CreateToolReturn<
    TName,
    z.ZodType<TInput>,
    E,
    TReturn,
    M,
    Tags,
    TMetadataInput
  >;

  function asError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(errorString(normalizeError(error)));
  }

  function withTimeout<TP>(
    promise: Promise<TP>,
    timeout: number,
    options: ToolExecuteOptions,
  ): Promise<TP> {
    return new Promise<TP>((resolve, reject) => {
      const setTimeoutFunction =
        options.setTimeoutFunction ??
        ((callback, milliseconds) => setTimeout(callback, milliseconds));
      const clearTimeoutFunction =
        options.clearTimeoutFunction ??
        ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
      const id = setTimeoutFunction(() => reject(new Error('TIMEOUT')), timeout);
      void promise.then(
        (v) => {
          clearTimeoutFunction(id);
          resolve(v);
        },
        (e) => {
          clearTimeoutFunction(id);
          reject(asError(e));
        },
      );
    });
  }

  function raceWithSignal<TP>(promise: Promise<TP>, signal?: MinimalAbortSignal): Promise<TP> {
    if (!signal) return promise;
    if (signal.aborted) {
      return Promise.reject(createAbortRejection(signal.reason));
    }
    return new Promise<TP>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(createAbortRejection(signal.reason));
      };
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort);
      void promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(asError(error));
        },
      );
    });
  }

  type AbortRejection = Error & { [ABORT_REJECTION_SYMBOL]: true; reason?: unknown };

  function createAbortRejection(reason?: unknown): AbortRejection {
    const error = new Error('Aborted') as AbortRejection;
    error[ABORT_REJECTION_SYMBOL] = true;
    error.reason = reason;
    return error;
  }

  function isAbortRejection(error: unknown): error is AbortRejection {
    if (!error || typeof error !== 'object') return false;
    const record = error as Record<PropertyKey, unknown>;
    return record[ABORT_REJECTION_SYMBOL] === true;
  }
}

function hasLegacyRegister(
  value: unknown,
): value is { register: (...entries: unknown[]) => unknown } {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { register?: unknown };
  return typeof candidate.register === 'function';
}

/**
 * Options for creating a tool with additional context.
 * TInput is the input interface type - the input schema validates it at runtime.
 */
type CreateToolWithContextOptions<
  Ctx extends Record<string, unknown>,
  TInput extends object,
  TOutput,
  E extends ToolEventsMap,
  Tags extends readonly string[],
  M extends ToolMetadata | undefined,
> = Omit<CreateToolOptions<TInput, TOutput, E, Tags, M>, 'execute' | 'metadata'> & {
  metadata?: M;
  execute:
    | ((params: TInput, context: ToolContext<E> & Ctx) => Promise<TOutput>)
    | Promise<(params: TInput, context: ToolContext<E> & Ctx) => Promise<TOutput>>;
};

type AnyToolWithContextOptions<Ctx extends Record<string, unknown>> = CreateToolWithContextOptions<
  Ctx,
  Record<string, unknown>,
  unknown,
  DefaultToolEvents,
  readonly string[],
  ToolMetadata | undefined
>;

/**
 * Creates a tool with additional context automatically injected into the execute function.
 *
 * Allows you to pre-bind context values (like database connections, API clients, etc.)
 * that will be merged into the tool context on every execution.
 *
 * @param context - Context object to inject into tool executions
 * @param options - Optional tool configuration (can be provided later)
 * @returns If options provided, returns the tool; otherwise returns a builder function
 *
 * @example
 * ```typescript
 * import { withContext } from 'armorer';
 * import { z } from 'zod';
 *
 * // Pre-bind database connection
 * const createDbTool = withContext({ db: myDatabase });
 *
 * const userTool = createDbTool({
 *   name: 'get-user',
 *   description: 'Get user by ID',
 *   input: z.object({ userId: z.string() }),
 *   async execute({ userId }, context) {
 *     // context.db is automatically available
 *     return context.db.users.findById(userId);
 *   },
 * });
 * ```
 *
 * @example With immediate tool creation
 * ```typescript
 * const tool = withContext({ apiKey: 'secret' }, {
 *   name: 'api-call',
 *   input: z.object({ endpoint: z.string() }),
 *   async execute({ endpoint }, context) {
 *     return fetch(endpoint, {
 *       headers: { 'Authorization': `Bearer ${context.apiKey}` }
 *     });
 *   },
 * });
 * ```
 */
export function withContext<Ctx extends Record<string, unknown>>(
  context: Ctx,
  options?: AnyToolWithContextOptions<Ctx>,
): Tool | ((options: AnyToolWithContextOptions<Ctx>) => Tool) {
  const build = (opts: AnyToolWithContextOptions<Ctx>) => {
    const { execute, ...rest } = opts;
    const resolveExecute = createLazyExecuteResolver(execute);
    return createTool({
      ...rest,
      async execute(params, toolContext) {
        const extended = Object.assign({}, toolContext, context);
        const resolved = await resolveExecute();
        return resolved(params, extended);
      },
    });
  };
  if (options) {
    return build(options);
  }
  return build;
}

const ABORT_REJECTION_SYMBOL = Symbol('toolbox.abort');

/**
 * Creates a tool call object for executing a tool.
 *
 * Helper function to construct properly-typed tool call objects that can be
 * passed to `toolbox.execute()`. Automatically generates a unique ID if not provided.
 *
 * @param toolName - Name of the tool to call
 * @param args - Arguments object matching the tool's input schema
 * @param id - Optional unique identifier for this call (auto-generated if omitted)
 * @returns A ToolCall object with id, name, and arguments
 *
 * @example
 * ```typescript
 * import { createToolbox, createTool, createToolCall } from 'armorer';
 * import { z } from 'zod';
 *
 * const toolbox = createToolbox([
 *   createTool({
 *     name: 'add',
 *     input: z.object({ a: z.number(), b: z.number() }),
 *     execute: async ({ a, b }) => a + b,
 *   }),
 * ]);
 *
 * // Create a tool call
 * const call = createToolCall('add', { a: 5, b: 3 });
 * // { id: 'uuid...', name: 'add', arguments: { a: 5, b: 3 } }
 *
 * const result = await toolbox.execute(call);
 * ```
 */
export function createToolCall<Args extends JsonValue>(
  toolName: string,
  args: Args,
  id?: string,
): ToolCall & { arguments: Args } {
  return {
    id: id ?? crypto.randomUUID(),
    name: toolName,
    arguments: args,
  };
}

const TOOL_CALL_KEYS = new Set(['id', 'name', 'arguments']);

function normalizeToolCall<T extends ToolCallWithArguments>(toolCall: T): T {
  if (toolCall.id) return toolCall;
  return { ...toolCall, id: crypto.randomUUID() };
}

function looksLikeToolCall(value: unknown, toolName: string): value is ToolCallWithArguments {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['name'] !== 'string') return false;
  if (candidate['name'] !== toolName) return false;
  if (typeof candidate['id'] !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(candidate, 'arguments')) return false;
  return Object.keys(candidate).every((key) => TOOL_CALL_KEYS.has(key));
}

function getDiagnosticsSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const candidate = schema as { _def?: { out?: unknown; schema?: unknown } };
  return candidate._def?.out ?? candidate._def?.schema ?? schema;
}

function normalizeDigestOptions(input?: ToolDigestOptions): {
  input: boolean;
  output: boolean;
  algorithm: 'sha256';
} {
  if (!input) {
    return { input: false, output: false, algorithm: 'sha256' };
  }
  if (input === true) {
    return { input: true, output: true, algorithm: 'sha256' };
  }
  return {
    input: input.input !== false,
    output: input.output !== false,
    algorithm: input.algorithm ?? 'sha256',
  };
}

function computeDigest(value: unknown, _algorithm: 'sha256'): string {
  const serialized = stableStringify(value);
  return sha256HexSync(serialized);
}

function normalizeToolContent(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  try {
    assertJsonValue(value, 'tool result');
    return value;
  } catch {
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        return String(value);
      }
      return JSON.parse(serialized) as JsonValue;
    } catch {
      return stableStringify(value);
    }
  }
}

function createToolAction(
  type: 'approval' | 'input',
  decision: ToolPolicyDecision,
  reason: string,
): ToolAction {
  const action = {
    type,
    message: decision.action?.message ?? reason,
  } as ToolAction;

  if (decision.action?.schema !== undefined) {
    action.schema = normalizeToolContent(decision.action.schema);
  }

  return action;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack,
    });
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function classifyErrorCategory(error: unknown): ToolErrorCategory {
  if (isTimeoutError(error)) return 'timeout';
  if (isTransientError(error)) return 'transient';
  return 'internal';
}

function isTimeoutError(error: unknown): boolean {
  const code = extractErrorCode(error);
  if (code === 'TIMEOUT') return true;
  const message = getStringProperty(error, 'message')?.toLowerCase() ?? '';
  return message.includes('timeout');
}

function isTransientError(error: unknown): boolean {
  const code = getStringProperty(error, 'code');
  const message = getStringProperty(error, 'message')?.toLowerCase() ?? '';
  const transientCodes = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ENETDOWN',
    'ENETUNREACH',
    'EHOSTUNREACH',
  ]);
  if (code && transientCodes.has(code)) {
    return true;
  }
  if (message.includes('timeout') || message.includes('rate limit')) {
    return true;
  }
  return false;
}

function defaultErrorCode(category: ToolErrorCategory): string {
  switch (category) {
    case 'validation':
      return 'VALIDATION_ERROR';
    case 'permission':
      return 'PERMISSION_DENIED';
    case 'not_found':
      return 'NOT_FOUND';
    case 'unavailable':
      return 'TOOL_UNAVAILABLE';
    case 'conflict':
      return 'CONFLICT';
    case 'transient':
      return 'TRANSIENT_ERROR';
    case 'timeout':
      return 'TIMEOUT';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return 'INTERNAL_ERROR';
  }
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

function createToolError(
  category: ToolErrorCategory,
  message: string,
  options: { code?: string; retryable?: boolean; details?: JsonValue } = {},
): ToolError {
  return {
    code: options.code ?? defaultErrorCode(category),
    category,
    retryable: (options.retryable ?? category === 'transient') || category === 'timeout',
    message,
    ...(options.details !== undefined ? { details: options.details } : {}),
  };
}

function serializeZodIssues(issues: z.ZodIssue[]): JsonValue {
  return issues.map((issue) => ({
    code: issue.code,
    path: issue.path.map((segment) =>
      typeof segment === 'symbol' ? (segment.description ?? 'symbol') : segment,
    ),
    message: issue.message,
  }));
}

function normalizeTagsWithRisk(
  tags: NormalizeTagsOption<readonly string[]> | undefined,
  risk: ToolRisk | undefined,
  toolName: string,
): string[] {
  if (!Array.isArray(tags)) {
    return buildTagsFromRisk([], risk);
  }
  if (!isStringArray(tags)) {
    throw new Error(`Tool "${toolName}": tag must be a string`);
  }
  const baseTags = uniqTags(tags.map((tag) => assertKebabCaseTag(tag, `Tool "${toolName}"`)));
  return buildTagsFromRisk(baseTags, risk);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function mergeRisk(
  metadata: ToolMetadata | undefined,
  risk: ToolRisk | undefined,
): ToolRisk | undefined {
  const derived: ToolRisk = {};
  if (metadata && typeof metadata === 'object') {
    if (typeof metadata.mutates === 'boolean') derived.mutates = metadata.mutates;
    if (typeof metadata.readOnly === 'boolean') derived.readOnly = metadata.readOnly;
    if (typeof metadata.dangerous === 'boolean') derived.dangerous = metadata.dangerous;
  }
  const merged: ToolRisk = { ...derived, ...(risk ?? {}) };
  const hasValue = Object.values(merged).some((value) => value !== undefined);
  return hasValue ? merged : undefined;
}

function resolveMetadataInput<M extends ToolMetadata | undefined>(
  metadata: ToolMetadataInput<M> | undefined,
): M | Promise<M> | undefined {
  if (typeof metadata === 'function') {
    return metadata();
  }
  return metadata;
}

type ToolExecute<TInput, TOutput, TContext> = (
  params: TInput,
  context: TContext,
) => Promise<TOutput>;

type LazyToolExecute<TInput, TOutput, TContext> =
  | ToolExecute<TInput, TOutput, TContext>
  | Promise<ToolExecute<TInput, TOutput, TContext>>;

function createLazyExecuteResolver<TInput, TOutput, TContext>(
  execute: LazyToolExecute<TInput, TOutput, TContext>,
): () => Promise<ToolExecute<TInput, TOutput, TContext>> {
  if (!isExecutable(execute)) {
    throw new TypeError('execute must be a function or a promise that resolves to a function');
  }
  if (typeof execute === 'function') {
    const fn = execute;
    return () => Promise.resolve(fn);
  }
  let resolved: ToolExecute<TInput, TOutput, TContext> | undefined;
  let pending: Promise<ToolExecute<TInput, TOutput, TContext>> | undefined;

  return async () => {
    if (resolved) return resolved;
    if (!pending) {
      pending = Promise.resolve(execute)
        .then((value) => {
          if (typeof value !== 'function') {
            throw new TypeError(
              'execute must be a function or a promise that resolves to a function',
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

function isExecutable<TInput, TOutput, TContext>(
  execute: LazyToolExecute<TInput, TOutput, TContext>,
): boolean {
  return typeof execute === 'function' || isPromise(execute);
}

export const internalToolTestUtilities = {
  classifyErrorCategory,
  createLazyExecuteResolver,
  defaultErrorCode,
  formatNonStringReason,
  stableStringify,
};
