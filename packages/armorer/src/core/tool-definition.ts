import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

import { normalizeSchema } from '../utilities/schema-normalization';
import { formatToolId, normalizeIdentity, type ToolId, type ToolIdentity } from './identity';
import { buildTagsFromRisk, type ToolRisk } from './risk';
import { isStandardSchema, isZodSchema } from './schema-utilities';
import { assertJsonValue, type JsonObject } from './serialization/json';
import { assertKebabCaseTag, type NormalizeTagsOption, uniqTags } from './tag-utilities';

export type ToolDisplay = {
  title?: string;
  description: string;
  examples?: readonly string[];
};

export type ToolLifecycle = {
  deprecated?: boolean | string;
  message?: string;
  replacedBy?: ToolId;
};

export type ToolAvailabilityContext = Record<string, unknown>;

export type ToolAvailabilityHook<
  TContext extends ToolAvailabilityContext = ToolAvailabilityContext,
> = (context: TContext) => boolean | Promise<boolean>;

export type ToolDefinition<TInput = Record<string, unknown>, TOutput = unknown> = {
  identity: ToolIdentity;
  id: ToolId;
  display: ToolDisplay;
  name: string;
  description: string;
  tags?: readonly string[] | undefined;
  metadata?: JsonObject | undefined;
  risk?: ToolRisk | undefined;
  lifecycle?: ToolLifecycle | undefined;
  availability?: ToolAvailabilityHook | undefined;
  input: z.ZodType;
  /**
   * Caller-supplied JSON Schema for `input`, required when `input` is a
   * non-Zod Standard Schema validator (Zod's own JSON Schema generation only
   * covers Zod schemas — see `CreateToolOptions.inputSchema`). When present,
   * serialization prefers this over deriving one from `input`.
   */
  inputJsonSchema?: JsonObject | undefined;
  /** @internal Type marker for inference. */
  __types?: { input: TInput; output: TOutput } | undefined;
};

export type AnyToolDefinition = ToolDefinition;

export type DefineToolOptions<
  TInput = Record<string, unknown>,
  Tags extends readonly string[] = readonly string[],
> = {
  name: string;
  description: string;
  namespace?: string;
  version?: string;
  title?: string;
  examples?: readonly string[];
  tags?: NormalizeTagsOption<Tags>;
  metadata?: JsonObject;
  risk?: ToolRisk;
  lifecycle?: ToolLifecycle;
  availability?: ToolAvailabilityHook;
  input?: z.ZodType<TInput> | z.ZodRawShape | z.ZodType | StandardSchemaV1;
  inputJsonSchema?: JsonObject;
};

export function defineTool<
  TInput = Record<string, unknown>,
  TOutput = unknown,
  Tags extends readonly string[] = readonly string[],
>(options: DefineToolOptions<TInput, Tags>): ToolDefinition<TInput, TOutput> {
  validateInputJsonSchemaRequirement(options);

  const normalizedIdentity = normalizeIdentity(createIdentityInput(options));
  const resolvedTags = buildTagsFromRisk(normalizeTags(options.tags, options.name), options.risk);
  const id = formatToolId(normalizedIdentity);

  return {
    identity: normalizedIdentity,
    id,
    display: createDisplay(options),
    name: normalizedIdentity.name,
    description: options.description,
    ...optionalTags(resolvedTags),
    ...optionalMetadata(options.metadata),
    ...optionalRisk(options.risk),
    ...optionalLifecycle(options.lifecycle),
    ...optionalAvailability(options.availability),
    input: normalizeSchema(options.input),
    ...optionalInputJsonSchema(options.inputJsonSchema),
  };
}

function validateInputJsonSchemaRequirement(options: DefineToolOptions): void {
  const { input, inputJsonSchema, name } = options;
  if (requiresInputJsonSchema(input) && inputJsonSchema === undefined) {
    throw new Error(
      `Tool "${name}": a non-Zod Standard Schema \`input\` requires an explicit \`inputJsonSchema\` ` +
        '(JSON Schema) so the tool can be serialized for providers.',
    );
  }
  if (inputJsonSchema !== undefined)
    assertJsonValue(inputJsonSchema, `Tool "${name}": inputJsonSchema`);
}

function requiresInputJsonSchema(input: DefineToolOptions['input']): boolean {
  return input !== undefined && !isZodSchema(input) && isStandardSchema(input);
}

function createIdentityInput(options: DefineToolOptions): Parameters<typeof normalizeIdentity>[0] {
  return {
    name: options.name,
    ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
    ...(options.version !== undefined ? { version: options.version } : {}),
  };
}

function createDisplay(options: DefineToolOptions): ToolDisplay {
  return {
    title: options.title ?? options.name,
    description: options.description,
    ...(options.examples?.length ? { examples: [...options.examples] } : {}),
  };
}

function optionalTags(tags: string[]): Pick<ToolDefinition, 'tags'> | {} {
  return tags.length ? { tags } : {};
}

function optionalMetadata(metadata: JsonObject | undefined): Pick<ToolDefinition, 'metadata'> | {} {
  return metadata !== undefined ? { metadata } : {};
}

function optionalRisk(risk: ToolRisk | undefined): Pick<ToolDefinition, 'risk'> | {} {
  return risk !== undefined ? { risk } : {};
}

function optionalLifecycle(
  lifecycle: ToolLifecycle | undefined,
): Pick<ToolDefinition, 'lifecycle'> | {} {
  return lifecycle !== undefined ? { lifecycle } : {};
}

function optionalAvailability(
  availability: ToolAvailabilityHook | undefined,
): Pick<ToolDefinition, 'availability'> | {} {
  return availability !== undefined ? { availability } : {};
}

function optionalInputJsonSchema(
  inputJsonSchema: JsonObject | undefined,
): Pick<ToolDefinition, 'inputJsonSchema'> | {} {
  return inputJsonSchema !== undefined ? { inputJsonSchema } : {};
}

function normalizeTags(
  tags: NormalizeTagsOption<readonly string[]> | undefined,
  toolName: string,
): string[] {
  if (!Array.isArray(tags)) return [];
  if (!isStringArray(tags)) {
    throw new Error(`Tool "${toolName}": tag must be a string`);
  }
  return uniqTags(tags.map((tag) => assertKebabCaseTag(tag, `Tool "${toolName}"`)));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
