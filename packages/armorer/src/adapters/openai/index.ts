import type { SerializedToolDefinition } from '../../core/serialization';
import type { AnyToolDefinition } from '../../core/tool-definition';
import type { ToolCallInput, ToolResult } from '../../types';
import {
  type AdapterInput,
  isSingleInput,
  normalizeToSerializedDefinitions,
  type ToolRegistryLike,
} from '../shared';
import type { JSONSchema, OpenAITool, OpenAIToolCall, OpenAIToolMessage } from './types';

export type {
  JSONSchema,
  OpenAIFunction,
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolMessage,
} from './types';

export interface OpenAIAdapterOptions {
  /**
   * Strategy for naming tools in OpenAI format.
   * - 'default': Use tool name (identity.name).
   * - 'safe-id': Use sanitized tool ID (namespace__name__version).
   */
  naming?: 'default' | 'safe-id';
}

/**
 * Maps a tool ID to an OpenAI-safe name (sanitized).
 */
export function mapToOpenAIName(toolId: string): string {
  return toolId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Creates a mapping function to resolve OpenAI-safe names back to tool IDs.
 */
export function createNameMapper(
  tools: (SerializedToolDefinition | AnyToolDefinition)[],
): (name: string) => string {
  const definitions = normalizeToSerializedDefinitions(tools);
  const map = new Map<string, string>();
  for (const tool of definitions) {
    map.set(mapToOpenAIName(tool.id), tool.id);
  }
  return (name: string) => map.get(name) ?? name;
}

/**
 * Converts Toolbox tools to OpenAI Chat Completions API format.
 *
 * @example
 * ```ts
 * import { toOpenAI } from 'armorer/adapters/openai';
 *
 * // Single tool
 * const tool = toOpenAI(myTool);
 *
 * // Multiple tools
 * const tools = toOpenAI([tool1, tool2]);
 *
 * // From registry
 * const tools = toOpenAI(toolbox);
 *
 * // Use with OpenAI SDK
 * const response = await openai.chat.completions.create({
 *   model: 'gpt-4',
 *   messages,
 *   tools: toOpenAI(toolbox),
 * });
 * ```
 */
export function toOpenAI(
  tool: SerializedToolDefinition | AnyToolDefinition,
  options?: OpenAIAdapterOptions,
): OpenAITool;
export function toOpenAI(
  tools: (SerializedToolDefinition | AnyToolDefinition)[],
  options?: OpenAIAdapterOptions,
): OpenAITool[];
export function toOpenAI(
  registry: ToolRegistryLike,
  options?: OpenAIAdapterOptions,
): OpenAITool[];
export function toOpenAI(
  input: AdapterInput,
  options?: OpenAIAdapterOptions,
): OpenAITool | OpenAITool[];
export function toOpenAI(
  input: AdapterInput,
  options?: OpenAIAdapterOptions,
): OpenAITool | OpenAITool[] {
  const definitions = normalizeToSerializedDefinitions(input);
  const converted = definitions.map((def) => convertToOpenAI(def, options));

  return isSingleInput(input) ? converted[0]! : converted;
}

/**
 * Parses OpenAI tool calls into Toolbox ToolCallInput objects.
 *
 * @example
 * ```ts
 * const completion = await openai.chat.completions.create({...});
 * const toolCalls = parseToolCalls(completion.choices[0].message.tool_calls);
 * const results = await toolbox.execute(toolCalls);
 * ```
 */
export function parseToolCalls(
  toolCalls: OpenAIToolCall[] | undefined | null,
  mapper?: (name: string) => string,
): ToolCallInput[] {
  if (!toolCalls || !Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.map((call) => {
    let args: unknown = {};
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      // Keep empty object if parsing fails
    }

    const name = call.function.name;
    const resolvedName = mapper ? mapper(name) : name;

    return {
      id: call.id,
      name: resolvedName,
      arguments: args,
    };
  });
}

/**
 * Formats Toolbox ToolResults into OpenAI tool messages.
 *
 * @example
 * ```ts
 * const results = await toolbox.execute(toolCalls);
 * const messages = formatToolResults(results);
 * // Add messages to conversation history
 * ```
 */
export function formatToolResults(
  results: ToolResult | ToolResult[],
): OpenAIToolMessage[] {
  const list = Array.isArray(results) ? results : [results];
  return list.map((result) => {
    if (result.stream || isAsyncIterable(result.result)) {
      throw new Error(
        'formatToolResults does not support streaming results. Use formatToolResultsAsync or execute without { stream: true }.',
      );
    }
    const content = stringifyToolContent(result.content);

    return {
      role: 'tool',
      tool_call_id: result.toolCallId,
      content,
    };
  });
}

/**
 * Async variant of `formatToolResults(...)` that supports streaming results.
 * Streaming payloads are collected into arrays before serialization.
 */
export async function formatToolResultsAsync(
  results: ToolResult | ToolResult[],
): Promise<OpenAIToolMessage[]> {
  const list = Array.isArray(results) ? results : [results];
  const messages = await Promise.all(
    list.map(async (result) => {
      const stream =
        result.stream ?? (isAsyncIterable(result.result) ? result.result : null);
      const contentSource =
        stream !== null ? await collectAsyncIterable(stream) : result.content;
      return {
        role: 'tool' as const,
        tool_call_id: result.toolCallId,
        content: stringifyToolContent(contentSource),
      };
    }),
  );
  return messages;
}

function convertToOpenAI(
  tool: SerializedToolDefinition,
  options?: OpenAIAdapterOptions,
): OpenAITool {
  const parameters = stripSchemaId(tool.input as JSONSchema);
  const name =
    options?.naming === 'safe-id' ? mapToOpenAIName(tool.id) : tool.identity.name;
  return {
    type: 'function',
    function: {
      name,
      description: tool.display.description,
      parameters,
      strict: true,
    },
  };
}

function stripSchemaId(schema: JSONSchema): JSONSchema {
  if (!schema || typeof schema !== 'object') return schema;
  const copy = { ...(schema as Record<string, unknown>) } as JSONSchema;
  if ('$schema' in copy) {
    delete (copy as Record<string, unknown>)['$schema'];
  }
  return copy;
}

function stringifyToolContent(content: unknown): string {
  return typeof content === 'string'
    ? content
    : content === undefined || content === null
      ? 'null'
      : (() => {
          try {
            return JSON.stringify(content);
          } catch {
            // eslint-disable-next-line @typescript-eslint/no-base-to-string
            return String(content);
          }
        })();
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
