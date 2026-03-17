import type { SerializedToolDefinition } from '../../core/serialization';
import type { AnyToolDefinition } from '../../core/tool-definition';
import {
  type AdapterInput,
  isSingleInput,
  normalizeToSerializedDefinitions,
  type ToolRegistryLike,
} from '../shared';
import type { GeminiFunctionDeclaration, GeminiSchema } from './types';

export type { GeminiFunctionDeclaration, GeminiSchema, GeminiTool } from './types';

/**
 * Converts Toolbox tools to Google Gemini API format.
 *
 * Returns function declarations that should be wrapped in a tool object:
 * `{ functionDeclarations: toGemini(tools) }`
 *
 * @example
 * ```ts
 * import { toGemini } from 'armorer/adapters/gemini';
 *
 * // Single tool
 * const declaration = toGemini(myTool);
 *
 * // Multiple tools
 * const declarations = toGemini([tool1, tool2]);
 *
 * // From registry
 * const declarations = toGemini(toolbox);
 *
 * // Use with Gemini SDK
 * const model = genAI.getGenerativeModel({
 *   model: 'gemini-pro',
 *   tools: [{ functionDeclarations: toGemini(toolbox) }],
 * });
 * ```
 */
export function toGemini(
  tool: SerializedToolDefinition | AnyToolDefinition,
): GeminiFunctionDeclaration;
export function toGemini(
  tools: (SerializedToolDefinition | AnyToolDefinition)[],
): GeminiFunctionDeclaration[];
export function toGemini(registry: ToolRegistryLike): GeminiFunctionDeclaration[];
export function toGemini(
  input: AdapterInput,
): GeminiFunctionDeclaration | GeminiFunctionDeclaration[];
export function toGemini(
  input: AdapterInput,
): GeminiFunctionDeclaration | GeminiFunctionDeclaration[] {
  const definitions = normalizeToSerializedDefinitions(input);
  const converted = definitions.map(convertToGemini);

  return isSingleInput(input) ? converted[0]! : converted;
}

function convertToGemini(tool: SerializedToolDefinition): GeminiFunctionDeclaration {
  return {
    name: tool.identity.name,
    description: tool.display.description,
    parameters: transformToGeminiSchema(tool.input as Record<string, unknown>),
  };
}

/**
 * Transforms JSON Schema to Gemini-compatible schema format.
 * Gemini uses OpenAPI 3.0 style schemas.
 */
function transformToGeminiSchema(schema: Record<string, unknown>): GeminiSchema {
  // Remove $schema if present to keep Gemini schema clean.
  const { $schema, ...rest } = schema;

  return rest as GeminiSchema;
}
