import type { StandardSchemaV1 } from 'interoperability';
import { z } from 'zod';

import { normalizeSchema } from '../utilities/schema-normalization';
import { formatToolId, normalizeIdentity, type ToolId, type ToolIdentity } from './identity';
import { buildTagsFromRisk, type ToolRisk } from './risk';
import type { JsonObject } from './serialization/json';
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

export type ToolDefinition<TInput extends object = Record<string, unknown>, TOutput = unknown> = {
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
  input: z.ZodTypeAny;
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

export type AnyToolDefinition = ToolDefinition<Record<string, unknown>, unknown>;

export type DefineToolOptions<
  TInput extends object = Record<string, unknown>,
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
  input?: z.ZodType<TInput> | z.ZodRawShape | z.ZodTypeAny | StandardSchemaV1;
  inputJsonSchema?: JsonObject;
};

export function defineTool<
  TInput extends object = Record<string, unknown>,
  TOutput = unknown,
  Tags extends readonly string[] = readonly string[],
>(options: DefineToolOptions<TInput, Tags>): ToolDefinition<TInput, TOutput> {
  const {
    name,
    description,
    namespace,
    version,
    title,
    examples,
    tags,
    metadata,
    risk,
    lifecycle,
    availability,
    input,
    inputJsonSchema,
  } = options;

  const normalizedIdentity = normalizeIdentity({
    name,
    ...(namespace !== undefined ? { namespace } : {}),
    ...(version !== undefined ? { version } : {}),
  });
  const normalizedInput = normalizeSchema(input);
  const resolvedTags = buildTagsFromRisk(normalizeTags(tags, name), risk);
  const display: ToolDisplay = {
    title: title ?? name,
    description,
    ...(examples?.length ? { examples: [...examples] } : {}),
  };

  const id = formatToolId(normalizedIdentity);

  return {
    identity: normalizedIdentity,
    id,
    display,
    name: normalizedIdentity.name,
    description,
    ...(resolvedTags.length ? { tags: resolvedTags } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(risk !== undefined ? { risk } : {}),
    ...(lifecycle !== undefined ? { lifecycle } : {}),
    ...(availability !== undefined ? { availability } : {}),
    input: normalizedInput as z.ZodType<TInput>,
    ...(inputJsonSchema !== undefined ? { inputJsonSchema } : {}),
  };
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
