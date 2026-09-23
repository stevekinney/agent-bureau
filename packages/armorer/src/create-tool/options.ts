import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { z } from 'zod';

import type { ToolRisk } from '../core/risk';
import type { JsonObject } from '../core/serialization/json';
import type { NormalizeTagsOption } from '../core/tag-utilities';
import type { ToolAvailabilityHook, ToolLifecycle } from '../core/tool-definition';
import type {
  DefaultToolEvents,
  Tool,
  ToolContext,
  ToolDiagnostics,
  ToolDigestOptions,
  ToolEventsMap,
  ToolMetadata,
  ToolPolicyContextProvider,
  ToolPolicyHooks,
} from '../is-tool';

/**
 * Options for creating a tool.
 *
 * TInput is inferred from the input schema. To minimize type computation:
 * - ToolContext and related types use type-erasure (unknown) for params
 * - Runtime schema validation provides actual type safety
 * - Only the execute function receives typed params
 */
export interface CreateToolOptions<
  TInput = Record<string, unknown>,
  TOutput = unknown,
  E extends ToolEventsMap = DefaultToolEvents,
  Tags extends readonly string[] = readonly string[],
  M extends ToolMetadata | undefined = ToolMetadata | undefined,
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
  /**
   * The tool's input schema. Accepts:
   * - A Zod schema (object schema, or a `z.ZodRawShape` wrapped with `z.object()`) — the
   *   documented default. JSON Schema for provider tool definitions is derived automatically
   *   via `z.toJSONSchema`.
   * - Any other Standard Schema-conforming validator (Valibot, ArkType, ...) — validated via
   *   its `~standard.validate()`. Since these have no general JSON Schema export, `inputSchema`
   *   MUST also be supplied so the tool can still be serialized for providers.
   */
  input?: z.ZodType<TInput> | z.ZodRawShape | z.ZodType | StandardSchemaV1;
  /**
   * JSON Schema for `input`, required when `input` is a non-Zod Standard Schema validator.
   * When `input` is a Zod schema, `z.toJSONSchema(input)` is used unless `inputSchema` is
   * ALSO explicitly supplied, in which case the caller's `inputSchema` wins.
   */
  inputSchema?: JsonObject;
  execute:
    | ((params: TInput, context: ToolContext<E>) => Promise<TReturn>)
    | Promise<(params: TInput, context: ToolContext<E>) => Promise<TReturn>>;
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
  /**
   * The injectable runtime-service seam (AB-92's `RuntimeServices`, AB-254):
   * wall time, timers, and identifiers for this tool's own `ExecutionLifecycle`
   * and call-identifier generation. `createToolbox` passes its own composed
   * instance here for every tool it builds, so a tool constructed directly
   * (not via a toolbox) resolves `options.runtime ?? createDefaultRuntimeServices()`
   * on its own. A test composes its own from `armorer/test`'s
   * `createManualRuntimeServices()` instead of touching a real timer or a
   * real clock.
   */
  runtime?: RuntimeServices;
}

export type SyncToolMetadataInput<M extends ToolMetadata | undefined> = M | (() => M);

export type AsyncToolMetadataInput<M extends ToolMetadata | undefined> =
  Promise<M> | (() => Promise<M>);

export type ToolMetadataInput<M extends ToolMetadata | undefined> =
  SyncToolMetadataInput<M> | AsyncToolMetadataInput<M>;

export type SchemaInput = z.ZodType | z.ZodRawShape | StandardSchemaV1;

/** The literal type produced by the runtime identity normalizer. */
type ToolNameWhitespace =
  | ' '
  | '\t'
  | '\n'
  | '\r'
  | '\f'
  | '\v'
  | '\u00a0'
  | '\u1680'
  | '\u2000'
  | '\u2001'
  | '\u2002'
  | '\u2003'
  | '\u2004'
  | '\u2005'
  | '\u2006'
  | '\u2007'
  | '\u2008'
  | '\u2009'
  | '\u200a'
  | '\u2028'
  | '\u2029'
  | '\u202f'
  | '\u205f'
  | '\u3000'
  | '\ufeff';

export type NormalizeToolName<TName extends string> =
  TName extends `${ToolNameWhitespace}${infer Rest}`
    ? NormalizeToolName<Rest>
    : TName extends `${infer Rest}${ToolNameWhitespace}`
      ? NormalizeToolName<Rest>
      : TName;

export type ToolInputOption<TSchema extends SchemaInput | undefined> =
  { input: TSchema } | (undefined extends TSchema ? { input?: undefined } : never);

export type InferSchemaInput<TSchema extends SchemaInput | undefined> = TSchema extends undefined
  ? Record<string, unknown>
  : TSchema extends z.ZodRawShape
    ? z.infer<z.ZodObject<TSchema>>
    : TSchema extends z.ZodType<infer T>
      ? T
      : TSchema extends StandardSchemaV1<unknown, infer T>
        ? T
        : Record<string, unknown>;

export type ResolvedMetadata<
  M extends ToolMetadata | undefined,
  TMetadataInput extends ToolMetadataInput<M> | undefined,
> =
  TMetadataInput extends AsyncToolMetadataInput<infer T>
    ? T
    : TMetadataInput extends SyncToolMetadataInput<infer T>
      ? T
      : M;

export type NamedTool<
  TName extends string,
  TSchema extends z.ZodType,
  E extends ToolEventsMap,
  TReturn,
  M extends ToolMetadata | undefined,
  Tags extends readonly string[],
> = Tool<TSchema, E, TReturn, M> & {
  name: TName;
  [Symbol.toPrimitive]: (hint?: string) => TName;
  /** @internal Type marker used by query helpers for typed tag IntelliSense. */
  __tags?: Tags;
};

export type CreateToolReturn<
  TName extends string,
  TSchema extends z.ZodType,
  E extends ToolEventsMap,
  TReturn,
  M extends ToolMetadata | undefined,
  Tags extends readonly string[],
  TMetadataInput extends ToolMetadataInput<M> | undefined,
> =
  TMetadataInput extends AsyncToolMetadataInput<M>
    ? Promise<
        NamedTool<
          NormalizeToolName<TName>,
          TSchema,
          E,
          TReturn,
          ResolvedMetadata<M, TMetadataInput>,
          Tags
        >
      >
    : NamedTool<
        NormalizeToolName<TName>,
        TSchema,
        E,
        TReturn,
        ResolvedMetadata<M, TMetadataInput>,
        Tags
      >;

export type WithContext<
  T extends object = Record<string, unknown>,
  E extends ToolEventsMap = DefaultToolEvents,
> = ToolContext<E> & T;

/**
 * Options for creating a tool with additional context.
 * TInput is the input interface type - the input schema validates it at runtime.
 */
export type CreateToolWithContextOptions<
  Ctx extends Record<string, unknown>,
  TInput,
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

export type AnyToolWithContextOptions<Ctx extends Record<string, unknown>> =
  | (Omit<
      CreateToolWithContextOptions<
        Ctx,
        unknown,
        unknown,
        DefaultToolEvents,
        readonly string[],
        ToolMetadata | undefined
      >,
      'input'
    > & { input: SchemaInput })
  | (Omit<
      CreateToolWithContextOptions<
        Ctx,
        Record<string, unknown>,
        unknown,
        DefaultToolEvents,
        readonly string[],
        ToolMetadata | undefined
      >,
      'input'
    > & { input?: undefined });

/** Runtime factory branches retain schema presence after the public overloads infer it. */
export type ToolFactoryImplementationOptions =
  | (Omit<CreateToolOptions<unknown>, 'input'> & { input: SchemaInput })
  | (Omit<CreateToolOptions, 'input'> & { input?: undefined });
