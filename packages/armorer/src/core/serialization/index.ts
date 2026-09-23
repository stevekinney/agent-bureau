import { z } from 'zod';

import type { ToolId } from '../identity';
import type { ToolRegistry } from '../registry';
import type { ToolRisk } from '../risk';
import type {
  AnyToolDefinition as ToolDefinition,
  ToolDisplay,
  ToolLifecycle,
} from '../tool-definition';
import { assertJsonValue, type JsonObject, type JsonValue, sortJsonValue } from './json';

export type JsonSchema = JsonObject;

export type SerializedToolDefinition = {
  schemaVersion: '2020-12';
  id: ToolId;
  identity: ToolDefinition['identity'];
  display: ToolDisplay;
  name: string;
  description: string;
  tags?: readonly string[];
  metadata?: JsonObject;
  risk?: ToolRisk;
  lifecycle?: ToolLifecycle;
  aliases: ToolId[];
  input: JsonSchema;
};

export function serializeToolDefinition(
  definition: ToolDefinition,
  options?: { aliases?: ToolId[] },
): SerializedToolDefinition {
  const normalized = normalizeSerializableParts(definition);
  return {
    schemaVersion: '2020-12',
    id: definition.id,
    identity: serializeIdentity(definition),
    display: serializeDisplay(definition),
    name: definition.identity.name,
    description: definition.display.description,
    ...optionalTags(definition.tags),
    ...optionalMetadata(normalized.metadata),
    ...optionalRisk(normalized.risk),
    ...optionalLifecycle(normalized.lifecycle),
    aliases: options?.aliases ? [...options.aliases].toSorted() : [],
    input: normalized.input,
  };
}

type SerializableParts = {
  metadata?: JsonObject;
  risk?: JsonObject;
  lifecycle?: JsonObject;
  input: JsonSchema;
};

function normalizeSerializableParts(definition: ToolDefinition): SerializableParts {
  validateSerializableInputs(definition);
  return {
    ...optionalNormalizedMetadata(definition.metadata),
    ...(definition.risk ? { risk: sortJsonObjectValue(definition.risk) } : {}),
    ...(definition.lifecycle ? { lifecycle: sortJsonObjectValue(definition.lifecycle) } : {}),
    input: definition.inputJsonSchema
      ? sortJsonObjectValue(definition.inputJsonSchema)
      : toJsonSchema(definition.input),
  };
}

function optionalNormalizedMetadata(metadata: unknown): Pick<SerializableParts, 'metadata'> | {} {
  if (!isJsonObjectValue(metadata)) return {};
  return { metadata: sortJsonObjectValue(metadata) };
}

function validateSerializableInputs(definition: ToolDefinition): void {
  if (isJsonObjectValue(definition.metadata)) assertJsonValue(definition.metadata, 'metadata');
  if (definition.inputJsonSchema !== undefined) {
    assertJsonValue(definition.inputJsonSchema, 'inputJsonSchema');
  }
}

function serializeIdentity(definition: ToolDefinition): SerializedToolDefinition['identity'] {
  return {
    namespace: definition.identity.namespace,
    name: definition.identity.name,
    ...(definition.identity.version ? { version: definition.identity.version } : {}),
  };
}

function serializeDisplay(definition: ToolDefinition): SerializedToolDefinition['display'] {
  return {
    ...(definition.display.title ? { title: definition.display.title } : {}),
    description: definition.display.description,
    ...(definition.display.examples?.length ? { examples: [...definition.display.examples] } : {}),
  };
}

function optionalTags(
  tags: readonly string[] | undefined,
): Pick<SerializedToolDefinition, 'tags'> | {} {
  return tags?.length ? { tags: [...tags] } : {};
}

function optionalMetadata(
  metadata: JsonObject | undefined,
): Pick<SerializedToolDefinition, 'metadata'> | {} {
  return metadata ? { metadata } : {};
}

function optionalRisk(risk: JsonObject | undefined): Pick<SerializedToolDefinition, 'risk'> | {} {
  return risk ? { risk } : {};
}

function optionalLifecycle(
  lifecycle: JsonObject | undefined,
): Pick<SerializedToolDefinition, 'lifecycle'> | {} {
  return lifecycle ? { lifecycle } : {};
}

export function serializeRegistry(registry: ToolRegistry): SerializedToolDefinition[] {
  return registry
    .list()
    .map((tool) => serializeToolDefinition(tool, { aliases: registry.aliases(tool.id) }));
}

function toJsonSchema(schema: z.ZodType): JsonSchema {
  const json: unknown = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    io: 'input',
  });
  assertJsonValue(json, 'input');
  return sortJsonObjectValue(json);
}

function sortJsonObjectValue(value: JsonValue): JsonObject {
  const sorted = sortJsonValue(value);
  if (isJsonObjectValue(sorted)) return sorted;
  throw new TypeError('Expected JSON object');
}

function isJsonObjectValue(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
