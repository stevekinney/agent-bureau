import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { ToolError, ToolErrorCategory } from './core/errors';
import type { ToolParametersSchema } from './is-tool';
import type { ResumeApprovalValidationResult, ToolboxExecuteOptions } from './toolbox-contracts';
import type { SignedPendingToolApproval, ToolExecutionResult } from './types';

const maximumTimerDelay = 2_147_483_647;

export async function validateResumedApprovalArguments(
  approval: SignedPendingToolApproval,
  validation: Promise<Awaited<ReturnType<ToolParametersSchema['safeParseAsync']>>>,
  options: ToolboxExecuteOptions,
  runtime: RuntimeServices,
  createInterruptedResult: InterruptedResult,
): Promise<ResumeApprovalValidationResult> {
  const signal = options.signal;
  const deadline = options.requestContext?.deadline;
  const now = options.now ?? runtime.clock.now;
  const cancelled = () =>
    createInterruptedResult(
      approval,
      'cancelled',
      formatCancellationReason(signal?.reason),
      'CANCELLED',
    );
  const timedOut = () =>
    createInterruptedResult(approval, 'timeout', 'Execution deadline exceeded', 'TIMEOUT');

  if (signal?.aborted) return { outcome: 'interrupted', result: cancelled() };
  if (deadline !== undefined && deadline <= now())
    return { outcome: 'interrupted', result: timedOut() };
  if (!signal && deadline === undefined) {
    return { outcome: 'parsed', parsedArguments: await validation };
  }

  return new Promise<ResumeApprovalValidationResult>((resolve, reject) => {
    const setTimeoutFunction = options.setTimeoutFunction ?? runtime.timers.setTimeout;
    const clearTimeoutFunction = options.clearTimeoutFunction ?? runtime.timers.clearTimeout;
    let deadlineTimer: unknown;
    let deadlineTimerScheduled = false;
    let settled = false;

    const clearDeadline = () => {
      if (!deadlineTimerScheduled) return;
      deadlineTimerScheduled = false;
      clearTimeoutFunction(deadlineTimer);
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      clearDeadline();
    };
    const resolveOnce = (result: ResumeApprovalValidationResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const scheduleDeadline = () => {
      if (deadline === undefined) return;
      const remaining = deadline - now();
      const delay = remaining <= 0 ? 0 : Math.min(remaining, maximumTimerDelay);
      deadlineTimerScheduled = true;
      deadlineTimer = setTimeoutFunction(() => {
        deadlineTimerScheduled = false;
        if (settled) return;
        if (deadline <= now()) {
          resolveOnce({ outcome: 'interrupted', result: timedOut() });
          return;
        }
        scheduleDeadline();
      }, delay);
    };
    function onAbort() {
      resolveOnce({ outcome: 'interrupted', result: cancelled() });
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    scheduleDeadline();
    void validation.then(
      (parsedArguments) => resolveOnce({ outcome: 'parsed', parsedArguments }),
      rejectOnce,
    );
  });
}

export type InterruptedResult = (
  approval: SignedPendingToolApproval,
  category: ToolErrorCategory,
  message: string,
  code: string,
) => ToolExecutionResult;

export function createInterruptedResumeApprovalValidationResult(
  approval: SignedPendingToolApproval,
  category: ToolErrorCategory,
  message: string,
  code: string,
): ToolExecutionResult {
  const toolError: ToolError = { category, message, code, retryable: false };
  return {
    callId: approval.callId,
    outcome: 'error',
    content: toolError.message,
    toolCallId: approval.callId,
    toolName: approval.toolName,
    result: undefined,
    error: toolError,
    errorMessage: toolError.message,
    errorCategory: toolError.category,
  };
}

function formatCancellationReason(reason: unknown): string {
  if (typeof reason === 'string' && reason.length > 0) return reason;
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  return 'Cancelled';
}
