import { assertJsonValue } from './core/serialization/json';
import type { JSONValue, ToolCall, ToolCallInput, ToolResult, ToolResultLike } from './types';

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

export function materializeToolResult(result: ToolResultLike): ToolResult {
  const stream = getStreamingPayload(result);
  if (stream) {
    throw new Error(
      'materializeToolResult does not support streaming tool results. Use materializeToolResultAsync or materializeToolResultsAsync.',
    );
  }

  return {
    callId: result.callId,
    outcome: result.outcome,
    content: normalizeJSONValue(result.content),
    ...(result.error
      ? {
          error: {
            code: result.error.code,
            category: result.error.category,
            retryable: result.error.retryable,
            message: result.error.message,
            ...(result.error.details !== undefined
              ? { details: normalizeJSONValue(result.error.details) }
              : {}),
          },
        }
      : {}),
    ...(result.inputDigest ? { inputDigest: result.inputDigest } : {}),
    ...(result.outputDigest ? { outputDigest: result.outputDigest } : {}),
    ...(result.action ? { action: normalizeToolAction(result.action) } : {}),
  };
}

export function materializeToolResults(
  results: ReadonlyArray<ToolResultLike>,
): ToolResult[] {
  return results.map((result) => materializeToolResult(result));
}

export async function materializeToolResultAsync(
  result: ToolResultLike,
): Promise<ToolResult> {
  const stream = getStreamingPayload(result);
  const content =
    stream === undefined ? normalizeJSONValue(result.content) : normalizeJSONValue(await collectAsyncIterable(stream));

  return {
    callId: result.callId,
    outcome: result.outcome,
    content,
    ...(result.error
      ? {
          error: {
            code: result.error.code,
            category: result.error.category,
            retryable: result.error.retryable,
            message: result.error.message,
            ...(result.error.details !== undefined
              ? { details: normalizeJSONValue(result.error.details) }
              : {}),
          },
        }
      : {}),
    ...(result.inputDigest ? { inputDigest: result.inputDigest } : {}),
    ...(result.outputDigest ? { outputDigest: result.outputDigest } : {}),
    ...(result.action ? { action: normalizeToolAction(result.action) } : {}),
  };
}

export async function materializeToolResultsAsync(
  results: ReadonlyArray<ToolResultLike>,
): Promise<ToolResult[]> {
  return Promise.all(results.map((result) => materializeToolResultAsync(result)));
}

function getStreamingPayload(result: ToolResultLike): AsyncIterable<unknown> | undefined {
  if ('stream' in result && result.stream) {
    return result.stream;
  }

  if ('result' in result && isAsyncIterable(result.result)) {
    return result.result;
  }

  return undefined;
}

function normalizeToolAction(action: NonNullable<ToolResultLike['action']>): NonNullable<ToolResult['action']> {
  return {
    type: action.type,
    ...(action.message ? { message: action.message } : {}),
    ...(action.schema !== undefined
      ? { schema: normalizeJSONValue(action.schema) }
      : {}),
  };
}

function normalizeJSONValue(value: unknown): JSONValue {
  if (value === undefined) {
    return null;
  }

  try {
    assertJsonValue(value, 'tool materialization');
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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  return Symbol.asyncIterator in value;
}

async function collectAsyncIterable(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}
