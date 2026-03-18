import type { JsonValue } from './core/serialization/json';

/**
 * Types for tool calls and results.
 * These are compatible with LLM provider tool call formats.
 */

export type JSONValue = JsonValue;
export type ToolProvider = 'openai' | 'anthropic' | 'gemini';
export type ToolError = import('./core/errors').ToolError;
export type ToolErrorCategory = import('./core/errors').ToolErrorCategory;

export interface ToolAction {
  type: 'approval' | 'input';
  message?: string;
  schema?: JsonValue;
}

/**
 * A tool call from an LLM.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonValue;
}

/**
 * Input shape for tool calls (ID/arguments may be missing and normalized).
 */
export interface ToolCallInput {
  id?: string;
  name: string;
  arguments?: unknown;
}

/**
 * Canonical tool result shape shared with conversationalist.
 */
export interface ToolResult {
  callId: string;
  outcome: 'success' | 'error' | 'action_required';
  content: JsonValue;
  error?: ToolError;
  inputDigest?: string;
  outputDigest?: string;
  action?: ToolAction;
}

/**
 * Runtime tool execution result with additional non-persisted execution data.
 */
export interface ToolExecutionResult extends ToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  /**
   * Optional streaming handle for incremental tool output.
   *
   * When present, `result` may also reference this stream.
   * Consumers that need a non-stream payload can execute without
   * `stream: true` and rely on collect mode fallback.
   */
  stream?: AsyncIterable<unknown>;
  error?: ToolError;
  /** @deprecated Use error.message instead. */
  errorMessage?: string;
  /** @deprecated Use error.category instead. */
  errorCategory?: ToolErrorCategory;
}

export type ToolResultLike = ToolResult | ToolExecutionResult;

/**
 * Minimal tool configuration for JSON schema output.
 */
export type MinimalToolConfiguration<Schema = unknown> = {
  name: string;
  description: string;
  input: Schema;
};
