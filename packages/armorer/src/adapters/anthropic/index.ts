import type { SerializedToolDefinition } from '../../core/serialization';
import type { AnyToolDefinition } from '../../core/tool-definition';
import type { ImportedToolConfiguration } from '../../create-toolbox';
import type { ToolCallInput, ToolResultLike } from '../../types';
import { isAsyncIterable } from '../../utilities/type-guards';
import { importToolSchema } from '../imported-schema';
import {
  type AdapterInput,
  isSingleInput,
  normalizeToSerializedDefinitions,
  type ToolRegistryLike,
} from '../shared';
import type {
  AnthropicContentBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from './types';

export type {
  AnthropicContentBlock,
  AnthropicInputSchema,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  JSONSchemaProperty,
} from './types';

type AnthropicToolCallSource =
  | AnthropicContentBlock[]
  | { content?: AnthropicContentBlock[] | undefined | null }
  | {
      message?: { content?: AnthropicContentBlock[] | undefined | null } | undefined | null;
    }
  | undefined
  | null;

/**
 * Converts Toolbox tools to Anthropic Messages API format.
 *
 * @example
 * ```ts
 * import { toAnthropicTools } from 'armorer/adapters/anthropic';
 *
 * // Single tool
 * const tool = toAnthropicTools(myTool);
 *
 * // Multiple tools
 * const tools = toAnthropicTools([tool1, tool2]);
 *
 * // From registry
 * const tools = toAnthropicTools(toolbox);
 *
 * // Use with Anthropic SDK
 * const response = await anthropic.messages.create({
 *   model: 'claude-sonnet-4-20250514',
 *   messages,
 *   tools: toAnthropicTools(toolbox),
 * });
 * ```
 */
export function toAnthropicTools(tool: SerializedToolDefinition | AnyToolDefinition): AnthropicTool;
export function toAnthropicTools(
  tools: (SerializedToolDefinition | AnyToolDefinition)[],
): AnthropicTool[];
export function toAnthropicTools(registry: ToolRegistryLike): AnthropicTool[];
export function toAnthropicTools(input: AdapterInput): AnthropicTool | AnthropicTool[];
export function toAnthropicTools(input: AdapterInput): AnthropicTool | AnthropicTool[] {
  const definitions = normalizeToSerializedDefinitions(input);
  const converted = definitions.map(convertToAnthropic);

  return isSingleInput(input) ? converted[0]! : converted;
}

export function fromAnthropicTools(tool: AnthropicTool): ImportedToolConfiguration;
export function fromAnthropicTools(tools: readonly AnthropicTool[]): ImportedToolConfiguration[];
export function fromAnthropicTools(
  input: AnthropicTool | readonly AnthropicTool[],
): ImportedToolConfiguration | ImportedToolConfiguration[] {
  const tools = Array.isArray(input) ? input : [input];
  const converted = tools.map(convertFromAnthropic);
  return Array.isArray(input) ? converted : converted[0]!;
}

export function parseAnthropicToolCalls(contentBlocks: AnthropicToolCallSource): ToolCallInput[] {
  const resolvedContentBlocks = extractAnthropicContentBlocks(contentBlocks);
  if (!resolvedContentBlocks || !Array.isArray(resolvedContentBlocks)) {
    return [];
  }

  return resolvedContentBlocks.flatMap((contentBlock) =>
    contentBlock.type === 'tool_use' ? [convertToolUseBlock(contentBlock)] : [],
  );
}

export function formatAnthropicToolResults(
  results: ToolResultLike | ToolResultLike[],
): AnthropicToolResultBlock[] {
  const resultList = Array.isArray(results) ? results : [results];

  for (const result of resultList) {
    if (getStreamingPayload(result)) {
      throw new Error(
        'formatAnthropicToolResults does not support streaming results. Persist or collect the stream before formatting Anthropic tool results.',
      );
    }
  }

  return resultList.map((result) => convertToolResult(result, result.content));
}

export async function formatAnthropicToolResultsAsync(
  results: ToolResultLike | ToolResultLike[],
): Promise<AnthropicToolResultBlock[]> {
  const resultList = Array.isArray(results) ? results : [results];
  return Promise.all(
    resultList.map(async (result) => {
      const stream =
        'stream' in result && isAsyncIterable(result.stream)
          ? result.stream
          : 'result' in result && isAsyncIterable(result.result)
            ? result.result
            : null;
      const content = stream === null ? result.content : await collectAsyncIterable(stream);
      return convertToolResult(result, content);
    }),
  );
}

function convertToAnthropic(tool: SerializedToolDefinition): AnthropicTool {
  const params = tool.input as Record<string, unknown>;

  const inputSchema: AnthropicTool['input_schema'] = {
    type: 'object',
    properties: (params['properties'] ?? {}) as AnthropicTool['input_schema']['properties'],
  };

  if (params['required']) {
    inputSchema.required = params['required'] as string[];
  }

  if (params['additionalProperties'] !== undefined) {
    inputSchema.additionalProperties = params['additionalProperties'] as boolean;
  }

  return {
    name: tool.identity.name,
    description: tool.display.description,
    input_schema: inputSchema,
  };
}

function convertFromAnthropic(tool: AnthropicTool): ImportedToolConfiguration {
  return {
    name: tool.name,
    description: tool.description,
    input: importToolSchema(tool.input_schema),
  };
}

function convertToolUseBlock(contentBlock: AnthropicToolUseBlock): ToolCallInput {
  return {
    id: contentBlock.id,
    name: contentBlock.name,
    arguments: normalizeToolArguments(contentBlock.input),
  };
}

function convertToolResult(result: ToolResultLike, content: unknown): AnthropicToolResultBlock {
  const toolResult: AnthropicToolResultBlock = {
    type: 'tool_result',
    tool_use_id: getToolCallId(result),
    content: stringifyToolContent(content),
  };

  if (result.outcome !== 'success') {
    toolResult.is_error = true;
  }

  return toolResult;
}

export const anthropicToolAdapter = {
  export: toAnthropicTools,
  import: fromAnthropicTools,
  parseCalls: parseAnthropicToolCalls,
  formatResults: formatAnthropicToolResults,
  formatResultsAsync: formatAnthropicToolResultsAsync,
} as const;

function normalizeToolArguments(argumentsValue: unknown): unknown {
  return argumentsValue === undefined ? {} : argumentsValue;
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content === undefined || content === null) {
    return 'null';
  }
  if (typeof content === 'symbol') {
    return content.description ? `Symbol(${content.description})` : 'Symbol()';
  }
  if (typeof content === 'function') {
    return '[function]';
  }
  if (typeof content === 'number' || typeof content === 'boolean' || typeof content === 'bigint') {
    return String(content);
  }
  try {
    return JSON.stringify(content);
  } catch {
    return '[unserializable object]';
  }
}

async function collectAsyncIterable(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function extractAnthropicContentBlocks(
  input: AnthropicToolCallSource,
): AnthropicContentBlock[] | undefined | null {
  if (!input) {
    return input;
  }
  if (Array.isArray(input)) {
    return input;
  }
  if ('content' in input) {
    return input.content;
  }
  if ('message' in input) {
    return input.message?.content;
  }
  return undefined;
}

function getToolCallId(result: ToolResultLike): string {
  return 'toolCallId' in result ? result.toolCallId : result.callId;
}

function getStreamingPayload(result: ToolResultLike): AsyncIterable<unknown> | undefined {
  if ('stream' in result && isAsyncIterable(result.stream)) {
    return result.stream;
  }
  if ('result' in result && isAsyncIterable(result.result)) {
    return result.result;
  }
  return undefined;
}
