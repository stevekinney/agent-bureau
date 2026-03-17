/**
 * JSON Schema type used by OpenAI.
 * OpenAI supports a subset of JSON Schema draft-2020-12.
 */
export interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JSONSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  [key: string]: unknown;
}

/**
 * OpenAI function definition.
 * @see https://platform.openai.com/docs/api-reference/chat/create#chat-create-tools
 */
export interface OpenAIFunction {
  /** The name of the function to be called. */
  name: string;
  /** A description of what the function does. */
  description: string;
  /** The parameters the function accepts, described as a JSON Schema object. */
  parameters: JSONSchema;
  /** Whether to enable strict schema adherence. Defaults to true. */
  strict?: boolean;
}

/**
 * OpenAI tool definition for Chat Completions API.
 * @see https://platform.openai.com/docs/api-reference/chat/create#chat-create-tools
 */
export interface OpenAITool {
  /** The type of the tool. Currently, only "function" is supported. */
  type: 'function';
  /** The function definition. */
  function: OpenAIFunction;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string | null;
}
