import type { SerializedToolDefinition } from '../../core/serialization';
import type { AnyToolDefinition } from '../../core/tool-definition';
import type { ImportedToolConfiguration } from '../../create-toolbox';
import type { ToolCallInput, ToolResult } from '../../types';
import { importToolSchema } from '../imported-schema';
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
 * import { toOpenAITools } from 'armorer/adapters/openai';
 *
 * // Single tool
 * const tool = toOpenAITools(myTool);
 *
 * // Multiple tools
 * const tools = toOpenAITools([tool1, tool2]);
 *
 * // From registry
 * const tools = toOpenAITools(toolbox);
 *
 * // Use with OpenAI SDK
 * const response = await openai.chat.completions.create({
 *   model: 'gpt-4',
 *   messages,
 *   tools: toOpenAITools(toolbox),
 * });
 * ```
 */
export function toOpenAITools(
  tool: SerializedToolDefinition | AnyToolDefinition,
  options?: OpenAIAdapterOptions,
): OpenAITool;
export function toOpenAITools(
  tools: (SerializedToolDefinition | AnyToolDefinition)[],
  options?: OpenAIAdapterOptions,
): OpenAITool[];
export function toOpenAITools(
  registry: ToolRegistryLike,
  options?: OpenAIAdapterOptions,
): OpenAITool[];
export function toOpenAITools(
  input: AdapterInput,
  options?: OpenAIAdapterOptions,
): OpenAITool | OpenAITool[];
export function toOpenAITools(
  input: AdapterInput,
  options?: OpenAIAdapterOptions,
): OpenAITool | OpenAITool[] {
  const definitions = normalizeToSerializedDefinitions(input);
  const converted = definitions.map((def) => convertToOpenAI(def, options));

  return isSingleInput(input) ? converted[0]! : converted;
}

export function fromOpenAITools(tool: OpenAITool): ImportedToolConfiguration;
export function fromOpenAITools(tools: readonly OpenAITool[]): ImportedToolConfiguration[];
export function fromOpenAITools(
  input: OpenAITool | readonly OpenAITool[],
): ImportedToolConfiguration | ImportedToolConfiguration[] {
  const tools = Array.isArray(input) ? input : [input];
  const converted = tools.map(convertFromOpenAI);
  return Array.isArray(input) ? converted : converted[0]!;
}

/**
 * Parses OpenAI tool calls into Toolbox ToolCallInput objects.
 *
 * @example
 * ```ts
 * const completion = await openai.chat.completions.create({...});
 * const toolCalls = parseOpenAIToolCalls(completion.choices[0].message.tool_calls);
 * const results = await toolbox.execute(toolCalls);
 * ```
 */
export function parseOpenAIToolCalls(
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
 * const messages = formatOpenAIToolResults(results);
 * // Add messages to conversation history
 * ```
 */
export function formatOpenAIToolResults(
  results: ToolResult | ToolResult[],
): OpenAIToolMessage[] {
  const list = Array.isArray(results) ? results : [results];
  return list.map((result) => {
    if (result.stream || isAsyncIterable(result.result)) {
      throw new Error(
        'formatOpenAIToolResults does not support streaming results. Use formatOpenAIToolResultsAsync or execute without { stream: true }.',
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
 * Async variant of `formatOpenAIToolResults(...)` that supports streaming results.
 * Streaming payloads are collected into arrays before serialization.
 */
export async function formatOpenAIToolResultsAsync(
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

function convertFromOpenAI(tool: OpenAITool): ImportedToolConfiguration {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input: importToolSchema(tool.function.parameters),
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
  if (typeof content === 'string') {
    return content;
  }
  if (content === undefined || content === null) {
    return 'null';
  }
  try {
    const serialized = JSON.stringify(content);
    // JSON.stringify(Symbol()) and JSON.stringify(() => {}) return undefined.
    // Fall back to String(...) so provider payloads stay string-typed.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return serialized ?? String(content);
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(content);
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
