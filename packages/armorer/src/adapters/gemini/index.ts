import type { SerializedToolDefinition } from '../../core/serialization';
import type { AnyToolDefinition } from '../../core/tool-definition';
import type { ImportedToolConfiguration } from '../../create-toolbox';
import type { ToolCallInput, ToolResult } from '../../types';
import { importToolSchema } from '../imported-schema';
import { normalizeToSerializedDefinitions, type ToolRegistryLike } from '../shared';
import type {
  GeminiFunctionCallPart,
  GeminiFunctionDeclaration,
  GeminiFunctionResponsePart,
  GeminiPart,
  GeminiSchema,
  GeminiTool,
} from './types';

export type {
  GeminiFileDataPart,
  GeminiFunctionCallPart,
  GeminiFunctionDeclaration,
  GeminiFunctionResponsePart,
  GeminiInlineDataPart,
  GeminiPart,
  GeminiSchema,
  GeminiTextPart,
  GeminiTool,
} from './types';

/**
 * Converts Toolbox tools to Google Gemini API format.
 *
 * @example
 * ```ts
 * import { toGeminiTools } from 'armorer/adapters/gemini';
 *
 * const tools = toGeminiTools(toolbox);
 *
 * // Use with Gemini SDK
 * const model = genAI.getGenerativeModel({
 *   model: 'gemini-pro',
 *   tools: toGeminiTools(toolbox),
 * });
 * ```
 */
export function toGeminiTools(
  input:
    | SerializedToolDefinition
    | AnyToolDefinition
    | readonly (SerializedToolDefinition | AnyToolDefinition)[]
    | ToolRegistryLike,
): GeminiTool[] {
  const definitions = normalizeToSerializedDefinitions(input);
  const converted = definitions.map(convertToGeminiFunctionDeclaration);

  return converted.length === 0 ? [] : [{ functionDeclarations: converted }];
}

export function fromGeminiTools(
  input:
    | GeminiFunctionDeclaration
    | readonly GeminiFunctionDeclaration[]
    | GeminiTool
    | readonly GeminiTool[],
): ImportedToolConfiguration[] {
  const declarations = normalizeGeminiDeclarations(input);
  return declarations.map(convertFromGeminiDeclaration);
}

export function parseGeminiToolCalls(
  parts: GeminiPart[] | undefined | null,
): ToolCallInput[] {
  if (!parts || !Array.isArray(parts)) {
    return [];
  }

  return parts.flatMap((part) =>
    'functionCall' in part ? [convertFunctionCallPart(part)] : [],
  );
}

export function formatGeminiToolResults(
  results: ToolResult | ToolResult[],
): GeminiFunctionResponsePart[] {
  const resultList = Array.isArray(results) ? results : [results];

  for (const result of resultList) {
    if (result.stream || isAsyncIterable(result.result)) {
      throw new Error(
        'formatGeminiToolResults does not support streaming results. Persist or collect the stream before formatting Gemini tool results.',
      );
    }
  }

  return resultList.map((result) => ({
    functionResponse: {
      name: result.toolName,
      response: normalizeGeminiResponse(result),
    },
  }));
}

function convertToGeminiFunctionDeclaration(
  tool: SerializedToolDefinition,
): GeminiFunctionDeclaration {
  return {
    name: tool.identity.name,
    description: tool.display.description,
    parameters: transformToGeminiSchema(tool.input as Record<string, unknown>),
  };
}

function convertFromGeminiDeclaration(
  declaration: GeminiFunctionDeclaration,
): ImportedToolConfiguration {
  return {
    name: declaration.name,
    description: declaration.description,
    input: importToolSchema(declaration.parameters),
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

function convertFunctionCallPart(part: GeminiFunctionCallPart): ToolCallInput {
  return {
    name: part.functionCall.name,
    arguments: part.functionCall.args,
  };
}

function normalizeGeminiResponse(result: ToolResult): Record<string, unknown> {
  if (result.outcome === 'success') {
    return normalizeGeminiPayload(result.content);
  }

  return {
    outcome: result.outcome,
    content: result.content,
    ...(result.error ? { error: result.error } : {}),
    ...(result.action ? { action: result.action } : {}),
  };
}

function normalizeGeminiDeclarations(
  input:
    | GeminiFunctionDeclaration
    | readonly GeminiFunctionDeclaration[]
    | GeminiTool
    | readonly GeminiTool[],
): GeminiFunctionDeclaration[] {
  if (Array.isArray(input)) {
    return input.flatMap((value) =>
      isGeminiTool(value)
        ? [...value.functionDeclarations]
        : [value as GeminiFunctionDeclaration],
    );
  }

  if (isGeminiTool(input)) {
    return [...input.functionDeclarations];
  }

  return [input as GeminiFunctionDeclaration];
}

function normalizeGeminiPayload(content: unknown): Record<string, unknown> {
  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }

  return { result: content };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }

  return Symbol.asyncIterator in value;
}

function isGeminiTool(value: unknown): value is GeminiTool {
  return (
    value !== null &&
    typeof value === 'object' &&
    'functionDeclarations' in value &&
    Array.isArray((value as GeminiTool).functionDeclarations)
  );
}
