import { AgentRunError } from '@lostgradient/operative';

export function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function hasToJson(value: object): value is object & { toJSON(): unknown } {
  return typeof Reflect.get(value, 'toJSON') === 'function';
}

function serializeTrackedObject(
  value: object,
  seen: WeakSet<object>,
  serialize: () => unknown,
): unknown {
  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  try {
    return serialize();
  } finally {
    seen.delete(value);
  }
}

export function serializeAgentRunErrorForBureau(error: AgentRunError): string {
  return safeStringify({
    name: error.name,
    message: error.message,
    kind: error.kind,
    code: error.code,
    ...(error.cause instanceof Error
      ? { cause: { name: error.cause.name, message: error.cause.message } }
      : error.cause !== undefined
        ? { cause: toJsonSafe(error.cause) }
        : {}),
  });
}

export function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  switch (typeof value) {
    case 'bigint':
      return value.toString();
    case 'function':
      return `[Function ${value.name || 'anonymous'}]`;
    case 'object':
      return value === null ? null : serializeObject(value, seen);
    case 'symbol':
      return safeStringify(value);
    default:
      return value;
  }
}

function serializeObject(value: object, seen: WeakSet<object>): unknown {
  if (value instanceof AgentRunError) {
    return serializeAgentRunErrorForBureau(value);
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }

  if (value instanceof Map) {
    return serializeTrackedObject(value, seen, () =>
      Array.from(value.entries(), ([key, entry]) => [
        toJsonSafe(key, seen),
        toJsonSafe(entry, seen),
      ]),
    );
  }

  if (value instanceof Set) {
    return serializeTrackedObject(value, seen, () =>
      Array.from(value.values(), (entry) => toJsonSafe(entry, seen)),
    );
  }

  if (Array.isArray(value)) {
    return serializeTrackedObject(value, seen, () => value.map((entry) => toJsonSafe(entry, seen)));
  }

  return serializeTrackedObject(value, seen, () => {
    if (hasToJson(value)) return toJsonSafe(value.toJSON(), seen);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonSafe(entry, seen)]),
    );
  });
}
