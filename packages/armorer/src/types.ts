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

import type { ApprovalBindingPayload } from './approval-binding';

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
  pendingApproval?: PendingToolApproval;
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
  /** Whether a resumed approval crossed the execution-admission boundary. */
  approvalBindingConsumed?: boolean;
  /** @deprecated Use error.message instead. */
  errorMessage?: string;
  /** @deprecated Use error.category instead. */
  errorCategory?: ToolErrorCategory;
}

export type ToolResultLike = ToolResultInput | ToolExecutionResult;

export type PolicyPauseTier = 'capability' | 'registry' | 'tool';

export type SatisfiedPolicyPause = {
  action: ToolAction;
  reason?: string;
  tier?: PolicyPauseTier;
};

export type PendingToolApproval = {
  callId: string;
  toolName: string;
  arguments: JSONValue;
  action: ToolAction;
  reason?: string;
  metadata?: JSONValue;
  policyPauseTier?: PolicyPauseTier;
  satisfiedPolicyPauses?: readonly SatisfiedPolicyPause[];
  approvalToken?: string;
  approvalBinding?: ApprovalBindingPayload;
};

export type SignedPendingToolApproval = PendingToolApproval & {
  approvalToken: string;
};

export type ToolExecutionIdempotency = {
  key: string;
  outcome: 'fresh' | 'deduped' | 'unknown-outcome' | 'authorization-required';
  /** Fencing token for an unknown started attempt. Present when the durable cache recorded one. */
  attemptId?: string;
  /** Stable digest of the original input bound to an unknown started attempt. */
  inputDigest?: string;
  /** Started timestamp for an unknown legacy attempt that predates fencing. */
  legacyStartedAt?: number;
  resolutionReceipt?: {
    key: string;
    attemptId: string;
    authorizedAt: number;
    authorizedBy?: string;
  };
};

/**
 * Minimal tool configuration for JSON schema output.
 */
export type MinimalToolConfiguration<Schema = unknown> = {
  name: string;
  description: string;
  input: Schema;
};
