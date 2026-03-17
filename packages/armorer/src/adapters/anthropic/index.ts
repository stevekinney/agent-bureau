import type { SerializedToolDefinition } from '../../core/serialization';
import type { AnyToolDefinition } from '../../core/tool-definition';
import {
  type AdapterInput,
  isSingleInput,
  normalizeToSerializedDefinitions,
  type ToolRegistryLike,
} from '../shared';
import type { AnthropicTool } from './types';

export type { AnthropicInputSchema, AnthropicTool, JSONSchemaProperty } from './types';

/**
 * Converts Toolbox tools to Anthropic Messages API format.
 *
 * @example
 * ```ts
 * import { toAnthropic } from 'armorer/adapters/anthropic';
 *
 * // Single tool
 * const tool = toAnthropic(myTool);
 *
 * // Multiple tools
 * const tools = toAnthropic([tool1, tool2]);
 *
 * // From registry
 * const tools = toAnthropic(toolbox);
 *
 * // Use with Anthropic SDK
 * const response = await anthropic.messages.create({
 *   model: 'claude-sonnet-4-20250514',
 *   messages,
 *   tools: toAnthropic(toolbox),
 * });
 * ```
 */
export function toAnthropic(
  tool: SerializedToolDefinition | AnyToolDefinition,
): AnthropicTool;
export function toAnthropic(
  tools: (SerializedToolDefinition | AnyToolDefinition)[],
): AnthropicTool[];
export function toAnthropic(registry: ToolRegistryLike): AnthropicTool[];
export function toAnthropic(input: AdapterInput): AnthropicTool | AnthropicTool[];
export function toAnthropic(input: AdapterInput): AnthropicTool | AnthropicTool[] {
  const definitions = normalizeToSerializedDefinitions(input);
  const converted = definitions.map(convertToAnthropic);

  return isSingleInput(input) ? converted[0]! : converted;
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
