import type { ApprovalAdmissionRollback } from './internal/approval-resume';
import type { ApprovalContext, ApprovalResumeContext } from './toolbox-approval-resume';
import type { ToolboxExecuteOptions } from './toolbox-contracts';
import type { SignedPendingToolApproval } from './types';

export type ApprovalConsumption = {
  consume: () => Promise<ApprovalAdmissionRollback>;
  error: unknown;
  consumed: boolean;
};

export function throwApprovalConsumptionError(error: unknown): void {
  if (error === undefined) return;
  if (error instanceof Error) throw error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    throw new Error(error.message);
  }
  throw new Error(describeConsumptionError(error));
}

export function createApprovalConsumption(
  approval: SignedPendingToolApproval,
  approvalContext: ApprovalContext | undefined,
  executeOptions: ToolboxExecuteOptions,
  requestDeadline: number | undefined,
  context: ApprovalResumeContext,
): ApprovalConsumption | undefined {
  if (!context.approvalStateStore || !approvalContext) return undefined;
  const consumption = {
    error: undefined as unknown,
    consumed: false,
  };
  const consume = async (): Promise<ApprovalAdmissionRollback> => {
    let reserved = false;
    try {
      await context.approvalStateStore!.reserve(approval.approvalBinding!, approvalContext);
      reserved = true;
      if (executeOptions.signal?.aborted) {
        await context.approvalStateStore!.release(approval.approvalBinding!);
        reserved = false;
        consumption.consumed = false;
        return async () => {};
      }
      rejectExpired(requestDeadline, executeOptions, context);
      await context.approvalStateStore!.commit(approval.approvalBinding!);
      consumption.consumed = true;
      if (executeOptions.signal?.aborted) {
        await context.approvalStateStore!.release(approval.approvalBinding!);
        reserved = false;
        consumption.consumed = false;
        return async () => {};
      }
      rejectExpired(requestDeadline, executeOptions, context);
    } catch (caught) {
      if (reserved) await context.approvalStateStore!.release(approval.approvalBinding!);
      consumption.consumed = false;
      if (!isInterruptionError(caught)) consumption.error = caught;
      throw caught;
    }
    let rolledBack = false;
    return async () => {
      if (rolledBack) return;
      rolledBack = true;
      await context.approvalStateStore!.release(approval.approvalBinding!);
    };
  };
  return {
    consume,
    get error() {
      return consumption.error;
    },
    get consumed() {
      return consumption.consumed;
    },
  };
}

function isInterruptionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'category' in error &&
    (error.category === 'cancelled' || error.category === 'timeout')
  );
}

function describeConsumptionError(
  error: object | string | number | boolean | bigint | symbol | null,
): string {
  if (error === null) return 'null';
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return String(error);
  }
  if (typeof error === 'symbol') return String(error);
  try {
    // Rejections can supply arbitrary getters. Read once and retain the receiver.
    const printable: { toString?: unknown } = error;
    const toString = printable.toString;
    return typeof toString === 'function' ? toString.call(error) : '[object Object]';
  } catch {
    return '[object Object]';
  }
}

function rejectExpired(
  deadline: number | undefined,
  options: ToolboxExecuteOptions,
  context: ApprovalResumeContext,
): void {
  if (deadline !== undefined && deadline <= (options.now ?? context.runtime.clock.now)()) {
    throw context.createToolError('timeout', 'Execution deadline exceeded', 'TIMEOUT', false);
  }
}
