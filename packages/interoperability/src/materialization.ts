import type {
  JSONValue,
  ToolAction,
  ToolCall,
  ToolCallInput,
  ToolResult,
  ToolResultInput,
} from './types';

export interface MaterializeToolCallOptions {
  generateId?: () => string;
}

export function materializeToolCall(
  toolCall: ToolCallInput,
  options: MaterializeToolCallOptions = {},
): ToolCall {
  return {
    id: toolCall.id ?? options.generateId?.() ?? crypto.randomUUID(),
    name: toolCall.name,
    arguments: normalizeJSONValue(toolCall.arguments ?? {}),
  };
}

export function materializeToolCalls(
  toolCalls: ReadonlyArray<ToolCallInput>,
  options: MaterializeToolCallOptions = {},
): ToolCall[] {
  return toolCalls.map((toolCall) => materializeToolCall(toolCall, options));
}

export function materializeToolResult(toolResult: ToolResultInput): ToolResult {
  if (hasStreamingPayload(toolResult)) {
    throw new Error(
      'materializeToolResult does not support streaming tool results. Use materializeToolResultAsync or materializeToolResultsAsync.',
    );
  }

  return stripRuntimeToolResultFields(toolResult, normalizeJSONValue(toolResult.content));
}

export function materializeToolResults(
  toolResults: ReadonlyArray<ToolResultInput>,
): ToolResult[] {
  return toolResults.map((toolResult) => materializeToolResult(toolResult));
}

export async function materializeToolResultAsync(
  toolResult: ToolResultInput,
): Promise<ToolResult> {
  const streamingPayload = getStreamingPayload(toolResult);
  if (!streamingPayload) {
    return stripRuntimeToolResultFields(
      toolResult,
      normalizeJSONValue(toolResult.content),
    );
  }

  const chunks = await collectAsyncIterable(streamingPayload);
  return stripRuntimeToolResultFields(toolResult, normalizeJSONValue(chunks));
}

export async function materializeToolResultsAsync(
  toolResults: ReadonlyArray<ToolResultInput>,
): Promise<ToolResult[]> {
  return Promise.all(
    toolResults.map((toolResult) => materializeToolResultAsync(toolResult)),
  );
}

function stripRuntimeToolResultFields(
  toolResult: ToolResultInput,
  content: JSONValue,
): ToolResult {
  return {
    callId: toolResult.callId,
    outcome: toolResult.outcome,
    content,
    ...(toolResult.error
      ? {
          error: {
            code: toolResult.error.code,
            category: toolResult.error.category,
            retryable: toolResult.error.retryable,
            message: toolResult.error.message,
            ...(toolResult.error.details !== undefined
              ? { details: normalizeJSONValue(toolResult.error.details) }
              : {}),
          },
        }
      : {}),
    ...(toolResult.action ? { action: normalizeToolAction(toolResult.action) } : {}),
    ...(toolResult.inputDigest ? { inputDigest: toolResult.inputDigest } : {}),
    ...(toolResult.outputDigest ? { outputDigest: toolResult.outputDigest } : {}),
  };
}

function normalizeToolAction(
  action: NonNullable<ToolResultInput['action']>,
): NonNullable<ToolAction> {
  return {
    type: action.type,
    ...(action.message ? { message: action.message } : {}),
    ...(action.schema !== undefined
      ? { schema: normalizeJSONValue(action.schema) }
      : {}),
  };
}

function hasStreamingPayload(toolResult: ToolResultInput): boolean {
  return getStreamingPayload(toolResult) !== undefined;
}

function getStreamingPayload(
  toolResult: ToolResultInput,
): AsyncIterable<unknown> | undefined {
  if (toolResult.stream) {
    return toolResult.stream;
  }

  if (isAsyncIterable(toolResult.result)) {
    return toolResult.result;
  }

  return undefined;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }

  return Symbol.asyncIterator in value;
}

function normalizeJSONValue(value: unknown): JSONValue {
  if (value === undefined) {
    return null;
  }

  try {
    assertJSONValue(value, 'tool materialization');
    return value;
  } catch {
    try {
      const serialized = JSON.stringify(value);
      return serialized === undefined ? String(value) : (JSON.parse(serialized) as JSONValue);
    } catch {
      return String(value);
    }
  }
}

function assertJSONValue(
  value: unknown,
  path: string,
): asserts value is JSONValue {
  const stack = new WeakSet<object>();

  const walk = (current: unknown, currentPath: string) => {
    if (current === null) return;

    const type = typeof current;
    if (type === 'string' || type === 'boolean') return;

    if (type === 'number') {
      if (Number.isFinite(current)) return;
      throw new TypeError(`Non-finite number at ${currentPath}`);
    }

    if (
      type === 'undefined' ||
      type === 'bigint' ||
      type === 'function' ||
      type === 'symbol'
    ) {
      throw new TypeError(`Invalid JSON value at ${currentPath}`);
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

      const record = current as Record<string, unknown>;
      if (stack.has(record)) {
        throw new TypeError(`Circular reference detected at ${currentPath}`);
      }
      stack.add(record);
      for (const key of Object.keys(record)) {
        walk(record[key], `${currentPath}.${key}`);
      }
      stack.delete(record);
    }
  };

  walk(value, path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function collectAsyncIterable(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}
