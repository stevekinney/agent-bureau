import type { ToolErrorCategory } from '../core/errors';
import type { ToolExecutionIdentity } from '../event-types';
import type { MinimalAbortSignal, ToolConfiguration, ToolPolicyAfterContext } from '../is-tool';
import type { ToolCall } from '../types';

export type ExecutionDetail<TCall extends ToolCall = ToolCall> = {
  toolCall: TCall;
  configuration: ToolConfiguration;
} & ToolExecutionIdentity;

export type BaseDetail = ExecutionDetail<ToolCall & { arguments: unknown }>;

export type Emit = (type: string, detail: unknown) => boolean;

export type RunPolicyAfter = (
  context: ToolPolicyAfterContext,
  signal?: MinimalAbortSignal,
  identity?: ToolExecutionIdentity,
) => Promise<void>;

export type FinishTelemetry = (
  status: 'success' | 'error' | 'denied' | 'cancelled' | 'paused',
  details?: {
    result?: unknown;
    error?: unknown;
    reason?: string;
    errorCategory?: ToolErrorCategory;
    inputDigest?: string;
    outputDigest?: string;
  },
) => void;
