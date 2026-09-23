export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = ReadonlyArray<JsonValue>;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export function assertJsonValue(
  value: unknown,
  path: string = 'metadata',
): asserts value is JsonValue {
  validateJsonValue(value, path, new WeakSet<object>());
}

function validateJsonValue(value: unknown, path: string, stack: WeakSet<object>): void {
  if (isJsonPrimitive(value)) return;
  if (Array.isArray(value)) {
    validateJsonArray(value, path, stack);
    return;
  }
  validateJsonObjectLike(value, path, stack);
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  return false;
}

function validateJsonArray(value: readonly unknown[], path: string, stack: WeakSet<object>): void {
  assertNotCircular(value, path, stack);
  for (let index = 0; index < value.length; index += 1) {
    validateJsonValue(value[index], `${path}[${index}]`, stack);
  }
  stack.delete(value);
}

function validateJsonObjectLike(value: unknown, path: string, stack: WeakSet<object>): void {
  rejectInvalidJsonType(value, path);
  if (!isPlainObject(value)) throw new TypeError(`Non-plain object is not valid JSON at ${path}`);
  assertNotCircular(value, path, stack);
  for (const key of Object.keys(value)) validateJsonValue(value[key], `${path}.${key}`, stack);
  stack.delete(value);
}

function rejectInvalidJsonType(value: unknown, path: string): void {
  const type = typeof value;
  if (type === 'number') throw new TypeError(`Non-finite number at ${path}`);
  if (type === 'undefined') throw new TypeError(`Undefined is not valid JSON at ${path}`);
  if (type === 'bigint') throw new TypeError(`BigInt is not valid JSON at ${path}`);
  if (type === 'function') throw new TypeError(`Function is not valid JSON at ${path}`);
  if (type === 'symbol') throw new TypeError(`Symbol is not valid JSON at ${path}`);
}

function assertNotCircular(value: object, path: string, stack: WeakSet<object>): void {
  if (stack.has(value)) throw new TypeError(`Circular reference detected at ${path}`);
  stack.add(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Reflect.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => sortJsonValue(entry));
  if (isJsonObject(value)) return sortJsonObject(value);
  return value;
}

function sortJsonObject(value: JsonObject): JsonObject {
  const sorted: JsonObject = {};
  for (const key of Object.keys(value).toSorted((a, b) => a.localeCompare(b))) {
    const entry = value[key];
    if (entry !== undefined) {
      Object.defineProperty(sorted, key, {
        value: sortJsonValue(entry),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return sorted;
}

export function stableStringifyJson(value: JsonValue): string {
  return JSON.stringify(sortJsonValue(value));
}
