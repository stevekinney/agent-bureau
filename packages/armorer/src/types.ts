import type {
  JSONValue as SharedJSONValue,
  ToolAction as SharedToolAction,
  ToolActionInput as SharedToolActionInput,
  ToolCall as SharedToolCall,
  ToolCallInput as SharedToolCallInput,
  ToolError as SharedToolError,
  ToolErrorCategory as SharedToolErrorCategory,
  ToolErrorInput as SharedToolErrorInput,
  ToolResult as SharedToolResult,
  ToolResultInput as SharedToolResultInput,
} from 'interoperability';

export type JSONValue = SharedJSONValue;
export type ToolProvider = 'openai' | 'anthropic' | 'gemini';
export type ToolError = SharedToolError;
export type ToolErrorCategory = SharedToolErrorCategory;
export type ToolErrorInput = SharedToolErrorInput;
export type ToolAction = SharedToolAction;
export type ToolActionInput = SharedToolActionInput;
export type ToolCall = SharedToolCall;
export type ToolCallInput = SharedToolCallInput;
export type ToolResult = SharedToolResult;
export type ToolResultInput = SharedToolResultInput;

/**
 * Runtime tool execution result with additional non-persisted execution data.
 */
export interface ToolExecutionResult extends ToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  pendingApproval?: SignedPendingToolApproval;
  executedArgumentsEdited?: boolean;
  idempotency?: ToolExecutionIdempotency;
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

export type ToolResultLike = ToolResultInput | ToolExecutionResult;

export type PendingToolApproval = {
  callId: string;
  toolName: string;
  arguments: JSONValue;
  action: ToolAction;
  reason?: string;
  metadata?: JSONValue;
  approvalToken?: string;
};

export type SignedPendingToolApproval = PendingToolApproval & {
  approvalToken: string;
};

export type ToolExecutionIdempotency = {
  key: string;
  outcome: 'fresh' | 'deduped' | 'unknown-outcome';
};

/**
 * Minimal tool configuration for JSON schema output.
 */
export type MinimalToolConfiguration<Schema = unknown> = {
  name: string;
  description: string;
  input: Schema;
};
