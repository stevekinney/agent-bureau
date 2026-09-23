import { z } from 'zod';

import type { DefaultToolEvents, Tool, ToolContext, ToolEventsMap, ToolMetadata } from '../is-tool';
import { stableStringify } from './content';
import { classifyErrorCategory, defaultErrorCode, formatNonStringReason } from './errors';
import { createToolFactory } from './factory-core';
import { createLazyExecuteResolver } from './lazy-execute';
import type {
  AnyToolWithContextOptions,
  AsyncToolMetadataInput,
  CreateToolOptions,
  CreateToolReturn,
  CreateToolWithContextOptions,
  InferSchemaInput,
  NamedTool,
  NormalizeToolName,
  ResolvedMetadata,
  SchemaInput,
  SyncToolMetadataInput,
  ToolFactoryImplementationOptions,
  ToolInputOption,
  ToolMetadataInput,
} from './options';

export { lazy } from './lazy-execute';
export type {
  AnyToolWithContextOptions,
  AsyncToolMetadataInput,
  CreateToolOptions,
  CreateToolReturn,
  CreateToolWithContextOptions,
  InferSchemaInput,
  NamedTool,
  NormalizeToolName,
  SchemaInput,
  ToolMetadataInput,
  WithContext,
} from './options';
export { createToolCall } from './tool-call';

/**
 * Creates a validated, executable AI tool with input schema, metadata, and lifecycle hooks.
 */

type ContextualToolBuilder<Ctx extends Record<string, unknown>> = {
  <
    TSchema extends SchemaInput | undefined = undefined,
    TOutput = unknown,
    E extends ToolEventsMap = DefaultToolEvents,
    Tags extends readonly string[] = readonly string[],
    M extends ToolMetadata | undefined = ToolMetadata | undefined,
  >(
    options: Omit<
      CreateToolWithContextOptions<Ctx, InferSchemaInput<TSchema>, TOutput, E, Tags, M>,
      'metadata' | 'name' | 'input'
    > & {
      name: string;
      metadata?: M;
    } & ToolInputOption<TSchema>,
  ): Tool<z.ZodType<InferSchemaInput<TSchema>>, E, TOutput, M>;
};

export function createTool<
  TSchema extends SchemaInput | undefined = undefined,
  TOutput = unknown,
  E extends ToolEventsMap = DefaultToolEvents,
  Tags extends readonly string[] = readonly string[],
  M extends ToolMetadata | undefined = ToolMetadata | undefined,
  TReturn = TOutput,
  TName extends string = string,
>(
  options: Omit<
    CreateToolOptions<InferSchemaInput<TSchema>, TOutput, E, Tags, M, TReturn>,
    'metadata' | 'name' | 'input'
  > & {
    name: TName;
    metadata: M;
  } & ToolInputOption<TSchema>,
): NamedTool<NormalizeToolName<TName>, z.ZodType<InferSchemaInput<TSchema>>, E, TReturn, M, Tags>;
export function createTool<
  TSchema extends SchemaInput | undefined = undefined,
  TOutput = unknown,
  E extends ToolEventsMap = DefaultToolEvents,
  Tags extends readonly string[] = readonly string[],
  M extends ToolMetadata | undefined = ToolMetadata | undefined,
  TReturn = TOutput,
  TMetadataInput extends SyncToolMetadataInput<M> | undefined =
    SyncToolMetadataInput<M> | undefined,
  TName extends string = string,
>(
  options: Omit<
    CreateToolOptions<InferSchemaInput<TSchema>, TOutput, E, Tags, M, TReturn>,
    'metadata' | 'name' | 'input'
  > & {
    name: TName;
    metadata?: TMetadataInput;
  } & ToolInputOption<TSchema>,
): NamedTool<
  NormalizeToolName<TName>,
  z.ZodType<InferSchemaInput<TSchema>>,
  E,
  TReturn,
  ResolvedMetadata<M, TMetadataInput>,
  Tags
>;
export function createTool<
  TSchema extends SchemaInput | undefined = undefined,
  TOutput = unknown,
  E extends ToolEventsMap = DefaultToolEvents,
  Tags extends readonly string[] = readonly string[],
  M extends ToolMetadata | undefined = ToolMetadata | undefined,
  TReturn = TOutput,
  TMetadataInput extends AsyncToolMetadataInput<M> = AsyncToolMetadataInput<M>,
  TName extends string = string,
>(
  options: Omit<
    CreateToolOptions<InferSchemaInput<TSchema>, TOutput, E, Tags, M, TReturn>,
    'metadata' | 'name' | 'input'
  > & {
    name: TName;
    metadata: TMetadataInput;
  } & ToolInputOption<TSchema>,
): Promise<
  NamedTool<
    NormalizeToolName<TName>,
    z.ZodType<InferSchemaInput<TSchema>>,
    E,
    TReturn,
    ResolvedMetadata<M, TMetadataInput>,
    Tags
  >
>;
export function createTool<
  TSchema extends SchemaInput | undefined = undefined,
  TOutput = unknown,
  E extends ToolEventsMap = DefaultToolEvents,
  Tags extends readonly string[] = readonly string[],
  M extends ToolMetadata | undefined = ToolMetadata | undefined,
  TReturn = TOutput,
  TMetadataInput extends ToolMetadataInput<M> | undefined = ToolMetadataInput<M> | undefined,
  TName extends string = string,
>(
  options: Omit<
    CreateToolOptions<InferSchemaInput<TSchema>, TOutput, E, Tags, M, TReturn>,
    'metadata' | 'name' | 'input'
  > & {
    name: TName;
    metadata?: TMetadataInput;
  } & ToolInputOption<TSchema>,
): CreateToolReturn<
  TName,
  z.ZodType<InferSchemaInput<TSchema>>,
  E,
  TReturn,
  M,
  Tags,
  TMetadataInput
>;
export function createTool(options: ToolFactoryImplementationOptions): Tool | Promise<Tool> {
  return createToolFactory(options);
}

/**
 * Creates a tool with additional context automatically injected into the execute function.
 */
export function withContext<Ctx extends Record<string, unknown>>(
  context: Ctx,
): ContextualToolBuilder<Ctx>;
export function withContext<
  Ctx extends Record<string, unknown>,
  TSchema extends SchemaInput | undefined = undefined,
  TOutput = unknown,
  E extends ToolEventsMap = DefaultToolEvents,
  Tags extends readonly string[] = readonly string[],
  M extends ToolMetadata | undefined = ToolMetadata | undefined,
>(
  context: Ctx,
  contextOptions: Omit<
    CreateToolWithContextOptions<Ctx, InferSchemaInput<TSchema>, TOutput, E, Tags, M>,
    'metadata' | 'name' | 'input'
  > & {
    name: string;
    metadata?: M;
  } & ToolInputOption<TSchema>,
): Tool<z.ZodType<InferSchemaInput<TSchema>>, E, TOutput, M>;
export function withContext<Ctx extends Record<string, unknown>>(
  context: Ctx,
  contextOptions?: AnyToolWithContextOptions<Ctx>,
): Tool | ContextualToolBuilder<Ctx> {
  function build<
    TSchema extends SchemaInput | undefined = undefined,
    TOutput = unknown,
    E extends ToolEventsMap = DefaultToolEvents,
    Tags extends readonly string[] = readonly string[],
    M extends ToolMetadata | undefined = ToolMetadata | undefined,
  >(
    options: Omit<
      CreateToolWithContextOptions<Ctx, InferSchemaInput<TSchema>, TOutput, E, Tags, M>,
      'metadata' | 'name' | 'input'
    > & {
      name: string;
      metadata?: M;
    } & ToolInputOption<TSchema>,
  ): Tool<z.ZodType<InferSchemaInput<TSchema>>, E, TOutput, M>;
  function build(toolOptions: AnyToolWithContextOptions<Ctx>): Tool {
    if (toolOptions.input === undefined) {
      return createTool({ ...toolOptions, execute: contextualExecute(toolOptions.execute) });
    }
    return createTool({ ...toolOptions, execute: contextualExecute(toolOptions.execute) });
  }

  function contextualExecute<TInput>(
    execute: CreateToolWithContextOptions<
      Ctx,
      TInput,
      unknown,
      DefaultToolEvents,
      readonly string[],
      ToolMetadata | undefined
    >['execute'],
  ): (params: TInput, toolContext: ToolContext) => Promise<unknown> {
    const resolveExecute = createLazyExecuteResolver<TInput, unknown, ToolContext & Ctx>(execute);
    return async (params, toolContext) => {
      const resolved = await resolveExecute();
      return resolved(params, { ...toolContext, ...context });
    };
  }
  if (contextOptions === undefined) return build;
  if (contextOptions.input === undefined) return build(contextOptions);
  return build(contextOptions);
}

export const internalToolTestUtilities = {
  classifyErrorCategory,
  createLazyExecuteResolver,
  defaultErrorCode,
  formatNonStringReason,
  stableStringify,
};
