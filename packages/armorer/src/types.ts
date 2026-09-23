import type {
  JSONValue as SharedJSONValue,
  ToolAction as SharedToolAction,
  ToolActionInput as SharedToolActionInput,
  ToolApprovalAction as SharedToolApprovalAction,
  ToolApprovalOperation as SharedToolApprovalOperation,
  ToolApprovalResolution as SharedToolApprovalResolution,
  ToolApprovalRisk as SharedToolApprovalRisk,
  ToolApprovalSandbox as SharedToolApprovalSandbox,
  ToolCall as SharedToolCall,
  ToolCallInput as SharedToolCallInput,
  ToolError as SharedToolError,
  ToolErrorCategory as SharedToolErrorCategory,
  ToolErrorInput as SharedToolErrorInput,
  ToolResult as SharedToolResult,
  ToolResultInput as SharedToolResultInput,
} from '@lostgradient/tool-protocol';

import type { ApprovalBindingPayload } from './approval-binding';

export type JSONValue = SharedJSONValue;
export type ToolProvider = 'openai' | 'anthropic' | 'gemini';
export type ToolError = SharedToolError;
export type ToolErrorCategory = SharedToolErrorCategory;
export type ToolErrorInput = SharedToolErrorInput;
export type ToolAction = SharedToolAction;
export type ToolActionInput = SharedToolActionInput;
export type ToolApprovalAction = SharedToolApprovalAction;
export type ToolApprovalOperation = SharedToolApprovalOperation;
export type ToolApprovalResolution = SharedToolApprovalResolution;
export type ToolApprovalRisk = SharedToolApprovalRisk;
export type ToolApprovalSandbox = SharedToolApprovalSandbox;
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

/** The value returned by the public parsed-parameter execution path. */
export type ToolExecutionValue<TReturn> =
  | { kind: 'callback'; value: TReturn }
  | { kind: 'collected-stream'; value: unknown[] }
  | { kind: 'live-stream'; value: AsyncIterable<unknown> }
  | { kind: 'authorization-only'; value: undefined };

/** Parsed execution can return the callback value, a collected stream, a live stream, or no value. */
export type ToolCallReturn<TReturn> = TReturn | unknown[] | AsyncIterable<unknown> | undefined;

/** Internal typed handoff from the execution pipeline to the factory surface. */
export const toolExecutionValue = Symbol('armorer.toolExecutionValue');

export type TypedToolExecutionResult<TReturn> = ToolExecutionResult & {
  [toolExecutionValue]?: ToolExecutionValue<TReturn>;
};

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
