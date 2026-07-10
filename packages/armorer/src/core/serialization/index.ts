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
  const metadata = definition.metadata;
  if (metadata !== undefined) {
    assertJsonValue(metadata, 'metadata');
  }
  const normalizedMetadata =
    metadata !== undefined ? (sortJsonValue(metadata) as JsonObject) : undefined;
  const normalizedRisk = definition.risk
    ? (sortJsonValue(definition.risk) as JsonObject)
    : undefined;
  const normalizedLifecycle = definition.lifecycle
    ? (sortJsonValue(definition.lifecycle) as JsonObject)
    : undefined;

  const input = definition.inputJsonSchema
    ? (sortJsonValue(definition.inputJsonSchema) as JsonSchema)
    : toJsonSchema(definition.input);

  return {
    schemaVersion: '2020-12',
    id: definition.id,
    identity: {
      namespace: definition.identity.namespace,
      name: definition.identity.name,
      ...(definition.identity.version ? { version: definition.identity.version } : {}),
    },
    display: {
      ...(definition.display.title ? { title: definition.display.title } : {}),
      description: definition.display.description,
      ...(definition.display.examples?.length
        ? { examples: [...definition.display.examples] }
        : {}),
    },
    name: definition.identity.name,
    description: definition.display.description,
    ...(definition.tags?.length ? { tags: [...definition.tags] } : {}),
    ...(normalizedMetadata ? { metadata: normalizedMetadata } : {}),
    ...(normalizedRisk ? { risk: normalizedRisk as ToolRisk } : {}),
    ...(normalizedLifecycle ? { lifecycle: normalizedLifecycle as ToolLifecycle } : {}),
    aliases: options?.aliases ? [...options.aliases].sort() : [],
    input,
  };
}

export function serializeRegistry(registry: ToolRegistry): SerializedToolDefinition[] {
  return registry
    .list()
    .map((tool) => serializeToolDefinition(tool, { aliases: registry.aliases(tool.id) }));
}

function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    io: 'input',
  }) as JsonValue;

  return sortJsonValue(json) as JsonSchema;
}
