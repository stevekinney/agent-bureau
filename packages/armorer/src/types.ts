/**
 * Types for tool calls and results.
 * These are compatible with LLM provider tool call formats.
 */

/**
 * A tool call from an LLM.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
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
 * The result of executing a tool.
 */
export interface ToolResult {
  callId: string;
  outcome: 'success' | 'error' | 'action_required';
  content: unknown;
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
  error?: import('./core/errors').ToolError;
  /** @deprecated Use error.message instead. */
  errorMessage?: string;
  /** @deprecated Use error.category instead. */
  errorCategory?: import('./core/errors').ToolErrorCategory;
  inputDigest?: string;
  outputDigest?: string;
  action?: {
    type: 'approval' | 'input';
    message?: string;
    schema?: unknown;
  };
}

/**
 * Minimal tool configuration for JSON schema output.
 */
export type MinimalToolConfiguration<Schema = unknown> = {
  name: string;
  description: string;
  input: Schema;
};
