import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';
import { z } from 'zod';

import type { ToolRisk } from '../core/risk';
import { isStandardSchema, isZodSchema } from '../core/schema-utilities';
import { assertJsonValue } from '../core/serialization/json';
import type { DefineToolOptions, ToolDefinition } from '../core/tool-definition';
import { defineTool } from '../core/tool-definition';
import type { Tool, ToolConfiguration, ToolContext, ToolEventsMap, ToolMetadata } from '../is-tool';
import { isPromise } from '../type-guards';
import { createConcurrencyLimiter, normalizeConcurrency } from '../utilities/concurrency';
import { normalizeToolSchema } from '../utilities/schema-normalization';
import { normalizeDigestOptions, stableStringify } from './content';
import { createExecuteInner } from './execution-inner';
import { createToolExecutors, type ToolExecutors } from './factory-execution';
import { buildToolPolicyContext } from './factory-policy-context';
import { createCallableTool, createToolEventSurface } from './factory-surface';
import { createLazyExecuteResolver } from './lazy-execute';
import { mergeRisk, normalizeTagsWithRisk, resolveMetadataInput } from './metadata';
import type {
  CreateToolOptions,
  NamedTool,
  NormalizeToolName,
  SchemaInput,
  ToolFactoryImplementationOptions,
} from './options';
import {
  resolvePolicyDecision as resolveAdmissionPolicyDecision,
  runPolicyAfter as runAdmissionPolicyAfter,
} from './policy-hooks';

export function createToolFactory(options: ToolFactoryImplementationOptions): Tool | Promise<Tool> {
  const resolvedMetadata = resolveMetadataInput(options.metadata);
  if (isPromise<ToolMetadata | undefined>(resolvedMetadata)) {
    return Promise.resolve(resolvedMetadata).then((metadata) =>
      createToolFromResolvedMetadata(options, metadata),
    );
  }
  return createToolFromResolvedMetadata(options, resolvedMetadata ?? undefined);
}

function createToolFromResolvedMetadata(
  options: ToolFactoryImplementationOptions,
  metadata: ToolMetadata | undefined,
): Tool {
  if (options.input === undefined) {
    return createToolFromValidatedInput(options, metadata, normalizeToolSchema(undefined));
  }
  return createToolFromValidatedInput(options, metadata, normalizeToolSchema(options.input));
}

function createToolFromValidatedInput<
  TInput,
  TOutput,
  E extends ToolEventsMap,
  Tags extends readonly string[],
  M extends ToolMetadata | undefined,
  TReturn,
  TName extends string,
>(
  options: ResolvedCreateToolOptions<TInput, TOutput, E, Tags, M, TReturn, TName> & {
    input?: SchemaInput | undefined;
  },
  metadataValue: M | undefined,
  typedSchema: z.ZodType<TInput>,
): NamedTool<NormalizeToolName<TName>, z.ZodType<TInput>, E, TReturn, M | undefined, Tags> {
  validateInputSchemaExport(options.name, options.input, options.inputSchema);
  const runtime: RuntimeServices = options.runtime ?? createDefaultRuntimeServices();
  const normalizedTags = normalizeTagsWithRisk(
    options.tags,
    mergeRisk(metadataValue, options.risk),
    options.name,
  );
  const definition = createDefinition(options, metadataValue, normalizedTags, typedSchema);
  const surface = createToolEventSurface(runtime);
  let executors!: ToolExecutors<TReturn>;
  const configuration = createConfiguration({
    definition,
    typedSchema,
    execute: (params) => executors.executeParams(params),
    rawExecute: options.execute,
    options,
  });
  const digestOptions = normalizeDigestOptions(options.digests);
  const resolveExecute = createLazyExecuteResolver<TInput, TReturn, ToolContext<E>>(
    options.execute,
  );
  const executeInner = createExecuteInner({
    name: options.name,
    configuration,
    runtime,
    digestOptions,
    typedSchema,
    schema: definition.input,
    fn: options.execute,
    resolveExecute,
    ...(options.policyContext !== undefined
      ? { policyContextProvider: options.policyContext }
      : {}),
    ...(options.policy !== undefined ? { policyHooks: options.policy } : {}),
    buildPolicyContext: (toolCall, params, inputDigest) =>
      buildToolPolicyContext({
        configuration,
        inputDigest,
        metadataValue,
        name: options.name,
        normalizedTags,
        params,
        toolCall,
      }),
    resolvePolicyDecision: (context, signal) =>
      resolveAdmissionPolicyDecision(options.policy?.beforeExecute, context, signal),
    runPolicyAfter: (context, signal, identity) =>
      runAdmissionPolicyAfter(
        options.policy?.afterExecute,
        context,
        signal,
        identity,
        surface.emit,
      ),
    emit: surface.emit,
    dispatch: surface.dispatch,
    ...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
    telemetryEnabled: options.telemetry === true,
  });
  const concurrencyLimit = normalizeConcurrency(
    typeof metadataValue?.concurrency === 'number'
      ? metadataValue.concurrency
      : options.concurrency,
  );
  const limiter = createConcurrencyLimiter(concurrencyLimit);
  executors = createToolExecutors({
    name: options.name,
    timeout: options.timeout,
    runtime,
    executionLifecycle: surface.executionLifecycle,
    capacity: limiter?.capacity,
    runWithConcurrency: (task, runOptions) => (limiter ? limiter.run(task, runOptions) : task()),
    executeInner,
  });
  const callable = async (params: unknown) => executors.executeParams(params);
  const normalizedName = normalizeToolName(options.name);
  return createCallableTool<TInput, E, TReturn, M | undefined, NormalizeToolName<TName>, Tags>({
    name: normalizedName,
    metadata: metadataValue,
    callable,
    configuration,
    typedSchema,
    emitter: surface.emitter,
    executionLifecycle: surface.executionLifecycle,
    execute: executors.execute,
    executeWith: executors.executeWith,
    emit: surface.emit,
    ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    rawExecute: async (params, context) => (await resolveExecute())(params, context),
  });
}

function normalizeToolName<TName extends string>(name: TName): NormalizeToolName<TName>;
function normalizeToolName(name: string): string {
  return name.trim();
}

type ResolvedCreateToolOptions<
  TInput,
  TOutput,
  E extends ToolEventsMap,
  Tags extends readonly string[],
  M extends ToolMetadata | undefined,
  TReturn,
  TName extends string,
> = Omit<CreateToolOptions<TInput, TOutput, E, Tags, M, TReturn>, 'metadata' | 'name' | 'input'> & {
  name: TName;
  metadata?: unknown;
};

function validateInputSchemaExport(
  name: string,
  input: CreateToolOptions['input'],
  inputSchema: CreateToolOptions['inputSchema'],
): void {
  if (
    input !== undefined &&
    !isZodSchema(input) &&
    isStandardSchema(input) &&
    inputSchema === undefined
  ) {
    throw new Error(
      `Tool "${name}": a non-Zod Standard Schema \`input\` requires an explicit \`inputSchema\` ` +
        '(JSON Schema) so the tool can be serialized for providers.',
    );
  }
  if (inputSchema !== undefined) assertJsonValue(inputSchema, `Tool "${name}": inputSchema`);
}

function createDefinition<
  TInput,
  TOutput,
  E extends ToolEventsMap,
  Tags extends readonly string[],
  M extends ToolMetadata | undefined,
  TReturn,
  TName extends string,
>(
  options: ResolvedCreateToolOptions<TInput, TOutput, E, Tags, M, TReturn, TName>,
  metadataValue: M | undefined,
  normalizedTags: readonly string[],
  input: z.ZodType<TInput>,
): ToolDefinition<TInput, TOutput> {
  const resolvedRisk = mergeRisk(metadataValue, options.risk);
  return defineTool<TInput, TOutput>({
    name: options.name,
    description: options.description,
    ...definitionDisplayOptions(options),
    ...definitionMetadataOptions(metadataValue, normalizedTags, resolvedRisk),
    ...definitionRuntimeOptions(options),
    input,
    ...(options.inputSchema !== undefined ? { inputJsonSchema: options.inputSchema } : {}),
  });
}

function definitionDisplayOptions(
  options: Pick<CreateToolOptions, 'namespace' | 'version' | 'title' | 'examples'>,
): Partial<DefineToolOptions> {
  return {
    ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.examples !== undefined ? { examples: options.examples } : {}),
  };
}

function definitionMetadataOptions(
  metadataValue: ToolMetadata | undefined,
  normalizedTags: readonly string[],
  resolvedRisk: ToolRisk | undefined,
): Partial<DefineToolOptions> {
  return {
    ...(normalizedTags.length ? { tags: normalizedTags } : {}),
    ...(metadataValue !== undefined ? { metadata: metadataValue } : {}),
    ...(resolvedRisk !== undefined ? { risk: resolvedRisk } : {}),
  };
}

function definitionRuntimeOptions(
  options: Pick<CreateToolOptions, 'lifecycle' | 'availability'>,
): Partial<DefineToolOptions> {
  return {
    ...(options.lifecycle !== undefined ? { lifecycle: options.lifecycle } : {}),
    ...(options.availability !== undefined ? { availability: options.availability } : {}),
  };
}

function createConfiguration<
  TInput,
  TOutput,
  E extends ToolEventsMap,
  Tags extends readonly string[],
  M extends ToolMetadata | undefined,
  TReturn,
  TName extends string,
>(input: {
  definition: ToolDefinition<TInput, TOutput>;
  typedSchema: z.ZodType<TInput>;
  execute: (params: unknown) => Promise<import('../types').ToolCallReturn<TReturn>>;
  rawExecute: CreateToolOptions<TInput, TOutput, E, Tags, M, TReturn>['execute'];
  options: ResolvedCreateToolOptions<TInput, TOutput, E, Tags, M, TReturn, TName>;
}): ToolConfiguration {
  const configuration: ToolConfiguration = {
    ...input.definition,
    input: input.typedSchema,
    execute: input.execute,
    rawExecute: input.rawExecute,
  };
  if (input.options.policy) configuration.policy = input.options.policy;
  if (input.options.policyContext) configuration.policyContext = input.options.policyContext;
  if (input.options.digests !== undefined) configuration.digests = input.options.digests;
  const metadataConcurrency = input.definition.metadata?.['concurrency'];
  const concurrencyLimit = normalizeConcurrency(
    typeof metadataConcurrency === 'number' ? metadataConcurrency : input.options.concurrency,
  );
  if (concurrencyLimit !== undefined) configuration.concurrency = concurrencyLimit;
  if (input.options.idempotencyKey !== undefined) {
    configuration.idempotencyKey = input.options.idempotencyKey;
  }
  return configuration;
}

export const internalToolFactoryUtilities = {
  createLazyExecuteResolver,
  stableStringify,
};
