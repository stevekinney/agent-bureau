export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = ReadonlyArray<JsonValue>;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export function assertJsonValue(
  value: unknown,
  path: string = 'metadata',
): asserts value is JsonValue {
  const stack = new WeakSet<object>();
  const walk = (current: unknown, currentPath: string) => {
    if (current === null) return;
    const type = typeof current;
    if (type === 'string' || type === 'boolean') return;
    if (type === 'number') {
      if (Number.isFinite(current)) return;
      throw new TypeError(`Non-finite number at ${currentPath}`);
    }
    if (type === 'undefined') {
      throw new TypeError(`Undefined is not valid JSON at ${currentPath}`);
    }
    if (type === 'bigint') {
      throw new TypeError(`BigInt is not valid JSON at ${currentPath}`);
    }
    if (type === 'function') {
      throw new TypeError(`Function is not valid JSON at ${currentPath}`);
    }
    if (type === 'symbol') {
      throw new TypeError(`Symbol is not valid JSON at ${currentPath}`);
    }
    if (Array.isArray(current)) {
      if (stack.has(current)) {
        throw new TypeError(`Circular reference detected at ${currentPath}`);
      }
      stack.add(current);
      for (let index = 0; index < current.length; index += 1) {
        walk(current[index], `${currentPath}[${index}]`);
      }
      stack.delete(current);
      return;
    }
    if (type === 'object') {
      if (!isPlainObject(current)) {
        throw new TypeError(`Non-plain object is not valid JSON at ${currentPath}`);
      }
      const record = current;
      if (stack.has(record)) {
        throw new TypeError(`Circular reference detected at ${currentPath}`);
      }
      stack.add(record);
      for (const key of Object.keys(record)) {
        walk(record[key], `${currentPath}.${key}`);
      }
      stack.delete(record);
      return;
    }
    throw new TypeError(`Unsupported JSON value at ${currentPath}`);
  };

  walk(value, path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Reflect.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    const array = value as JsonArray;
    return array.map((entry) => sortJsonValue(entry));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as JsonObject;
    const sorted: JsonObject = {};
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      const entry = record[key];
      if (entry !== undefined) {
        sorted[key] = sortJsonValue(entry);
      }
    }
    return sorted;
  }
  return value;
}

export function stableStringifyJson(value: JsonValue): string {
  return JSON.stringify(sortJsonValue(value));
}
