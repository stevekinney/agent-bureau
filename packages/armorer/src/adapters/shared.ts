import type { SerializedToolDefinition } from '../core/serialization';
import { serializeToolDefinition } from '../core/serialization';
import type { AnyToolDefinition } from '../core/tool-definition';

/**
 * Type guard to check if input is a serialized tool definition.
 */
export function isSerializedToolDefinition(input: unknown): input is SerializedToolDefinition {
  return (
    input !== null &&
    typeof input === 'object' &&
    'schemaVersion' in input &&
    (input as SerializedToolDefinition).schemaVersion === '2020-12'
  );
}

export function isToolDefinition(input: unknown): input is AnyToolDefinition {
  return (
    input !== null &&
    (typeof input === 'object' || typeof input === 'function') &&
    'id' in input &&
    'identity' in input &&
    'input' in input &&
    !('schemaVersion' in input)
  );
}

/**
 * Normalizes various input types to an array of SerializedToolDefinition objects.
 */
export function normalizeToSerializedDefinitions(
  input:
    | SerializedToolDefinition
    | AnyToolDefinition
    | readonly (SerializedToolDefinition | AnyToolDefinition)[]
    | ToolRegistryLike,
): SerializedToolDefinition[] {
  const toSerialized = (item: SerializedToolDefinition | AnyToolDefinition) => {
    if (isSerializedToolDefinition(item)) return item;
    if (isToolDefinition(item)) return serializeToolDefinition(item);
    throw new TypeError('Invalid tool input: expected ToolDefinition or SerializedToolDefinition');
  };

  if (isToolRegistryLike(input)) {
    const tools = input.tools ? input.tools() : input.list?.();
    if (!Array.isArray(tools)) {
      throw new Error('Registry tools() must return an array.');
    }
    const registryTools: readonly (SerializedToolDefinition | AnyToolDefinition)[] = tools;
    return registryTools.map((tool) => toSerialized(tool));
  }

  if (Array.isArray(input)) {
    const items: readonly (SerializedToolDefinition | AnyToolDefinition)[] = input;
    return items.map((item) => toSerialized(item));
  }

  return [toSerialized(input as SerializedToolDefinition | AnyToolDefinition)];
}

/**
 * Determines if the input was a single item (returns true) or array/registry (returns false).
 */
export function isSingleInput(
  input:
    | SerializedToolDefinition
    | AnyToolDefinition
    | readonly (SerializedToolDefinition | AnyToolDefinition)[]
    | ToolRegistryLike,
): boolean {
  return !Array.isArray(input) && !isToolRegistryLike(input);
}

/**
 * Union type for adapter input.
 */
export type AdapterInput =
  | SerializedToolDefinition
  | AnyToolDefinition
  | readonly (SerializedToolDefinition | AnyToolDefinition)[]
  | ToolRegistryLike;

export type ToolRegistryLike = {
  tools?: () => readonly AnyToolDefinition[] | readonly SerializedToolDefinition[];
  list?: () => readonly AnyToolDefinition[] | readonly SerializedToolDefinition[];
};

function isToolRegistryLike(value: unknown): value is ToolRegistryLike {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as ToolRegistryLike;
  return typeof candidate.tools === 'function' || typeof candidate.list === 'function';
}
