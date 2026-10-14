import type { ExecutionHandle } from '../execution-lifecycle';
import type { ApprovalAdmissionRollback, ApprovalResumeState } from '../internal/approval-resume';
import {
  approvalConsumeSymbol,
  approvalResumeSymbol,
  executionCallbackStartSymbol,
  policyAuthorizationOnlySymbol,
  policyAuthorizationResultSymbol,
} from '../internal/approval-resume';
import type { ToolExecuteOptions } from '../is-tool';

export type InternalToolExecuteOptions = ToolExecuteOptions & {
  [approvalConsumeSymbol]?: () => Promise<ApprovalAdmissionRollback>;
  [approvalResumeSymbol]?: ApprovalResumeState;
  [policyAuthorizationOnlySymbol]?: boolean;
  [policyAuthorizationResultSymbol]?: unknown;
  executionHandle?: ExecutionHandle;
  privilegedContextMirrorHandle?: ExecutionHandle;
  parentCompletionHandle?: ExecutionHandle;
  /**
   * Reports whether the tool's own callback is still in flight on behalf of a
   * parent execution (`parentCompletionHandle` for a single toolbox call, or
   * the batch parent for a multi-call batch). The parent's owner must not
   * settle it while this reports `true`: the callback may ignore cancellation
   * and keep running long after the raced execution promise has rejected.
   */
  onParentCompletionPending?: (pending: boolean) => void;
  [executionCallbackStartSymbol]?: () => void;
  /**
   * Set once the tool's own callback has started, and cleared once it
   * settles. Only an unfinished callback can own later completion via
   * `executionHandle.cleanupPending()` — pre-execution cancellation (a
   * deadline or abort firing before the callback starts, e.g. while an
   * async schema parse or policy hook is pending) must instead let the
   * outer invocation settle its handle through the ordinary error/
   * cancellation path.
   */
  callbackPending?: boolean;
};

export function resolveSuppliedOwnerId(options: ToolExecuteOptions): string | undefined {
  return options.ownerId ?? options.requestContext?.authority.ownerId;
}

/**
 * Structural check for an `AbortSignal`. A signal created in another
 * JavaScript realm (an iframe, a worker, or a `node:vm` context) fails
 * `instanceof AbortSignal` against this realm's constructor while remaining
 * fully usable, so cancellation forwarding must not rely on `instanceof`.
 */
export function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<
    Record<'aborted' | 'addEventListener' | 'removeEventListener', unknown>
  >;
  return (
    typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  );
}
