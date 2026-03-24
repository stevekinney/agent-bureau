import { z } from 'zod';

import { normalizeSchema } from '../utilities/schema-normalization';
import { formatToolId, normalizeIdentity, type ToolId, type ToolIdentity } from './identity';
import { type ToolRisk } from './risk';
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
  input: z.ZodTypeAny;
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
  input?: z.ZodType<TInput> | z.ZodRawShape | z.ZodTypeAny;
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
    input,
  } = options;

  const normalizedIdentity = normalizeIdentity({
    name,
    ...(namespace !== undefined ? { namespace } : {}),
    ...(version !== undefined ? { version } : {}),
  });
  const normalizedInput = normalizeSchema(input);
  const resolvedTags = normalizeTags(tags, name);
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
    input: normalizedInput as z.ZodType<TInput>,
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
