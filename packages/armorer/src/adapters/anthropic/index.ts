import type { SerializedToolDefinition } from '../../core/serialization';
import type { AnyToolDefinition } from '../../core/tool-definition';
import type { ToolCallInput, ToolResult } from '../../types';
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
export function toAnthropicTools(
  tool: SerializedToolDefinition | AnyToolDefinition,
): AnthropicTool;
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

export function parseAnthropicToolCalls(
  contentBlocks: AnthropicContentBlock[] | undefined | null,
): ToolCallInput[] {
  if (!contentBlocks || !Array.isArray(contentBlocks)) {
    return [];
  }

  return contentBlocks.flatMap((contentBlock) =>
    contentBlock.type === 'tool_use' ? [convertToolUseBlock(contentBlock)] : [],
  );
}

export function formatAnthropicToolResults(
  results: ToolResult | ToolResult[],
): AnthropicToolResultBlock[] {
  const resultList = Array.isArray(results) ? results : [results];

  for (const result of resultList) {
    if (result.stream || isAsyncIterable(result.result)) {
      throw new Error(
        'formatAnthropicToolResults does not support streaming results. Persist or collect the stream before formatting Anthropic tool results.',
      );
    }
  }

  return resultList.map((result) => convertToolResult(result, result.content));
}

function convertToAnthropic(tool: SerializedToolDefinition): AnthropicTool {
  const params = tool.input as Record<string, unknown>;

  const inputSchema: AnthropicTool['input_schema'] = {
    type: 'object',
    properties: (params['properties'] ??
      {}) as AnthropicTool['input_schema']['properties'],
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

function convertToolUseBlock(contentBlock: AnthropicToolUseBlock): ToolCallInput {
  return {
    id: contentBlock.id,
    name: contentBlock.name,
    arguments: normalizeToolArguments(contentBlock.input),
  };
}

function convertToolResult(
  result: ToolResult,
  content: unknown,
): AnthropicToolResultBlock {
  const toolResult: AnthropicToolResultBlock = {
    type: 'tool_result',
    tool_use_id: result.toolCallId,
    content: stringifyToolContent(content),
  };

  if (result.outcome !== 'success') {
    toolResult.is_error = true;
  }

  return toolResult;
}

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
  if (
    typeof content === 'number' ||
    typeof content === 'boolean' ||
    typeof content === 'bigint'
  ) {
    return String(content);
  }
  try {
    return JSON.stringify(content);
  } catch {
    return '[unserializable object]';
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }

  return Symbol.asyncIterator in value;
}
