/**
 * JSON Schema property definition.
 */
export interface JSONSchemaProperty {
  type?: string | string[];
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JSONSchemaProperty;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  [key: string]: unknown;
}

/**
 * Anthropic input schema format.
 * Must be a valid JSON Schema object type.
 */
export interface AnthropicInputSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Anthropic tool definition for Messages API.
 * @see https://docs.anthropic.com/en/docs/build-with-claude/tool-use
 */
export interface AnthropicTool {
  /** The name of the tool. */
  name: string;
  /** A description of what the tool does. */
  description: string;
  /** The JSON Schema describing the tool's input parameters. */
  input_schema: AnthropicInputSchema;
}
