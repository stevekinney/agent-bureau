import { assertJsonValue, type JsonValue } from './core/serialization/json';

function formatFallback(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return value.toString();
  }
  return Object.prototype.toString.call(value);
}

export function normalizeToolCallArguments(argumentsValue: unknown): JsonValue {
  if (argumentsValue === undefined) {
    return {};
  }

  try {
    assertJsonValue(argumentsValue, 'tool call arguments');
    return argumentsValue;
  } catch {
    try {
      const serialized = JSON.stringify(argumentsValue);
      if (serialized === undefined) return formatFallback(argumentsValue);
      const parsed: unknown = JSON.parse(serialized);
      assertJsonValue(parsed, 'normalized tool call arguments');
      return parsed;
    } catch {
      return formatFallback(argumentsValue);
    }
  }
}
