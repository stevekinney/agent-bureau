import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { ApprovalState, ApprovalStateStore } from './approval-binding';
import type { ToolboxExecuteOptions } from './toolbox-contracts';
import type { SignedPendingToolApproval, ToolExecutionResult } from './types';

const maximumTimerDelay = 2_147_483_647;

type InterruptedResult = (
  approval: SignedPendingToolApproval,
  category: 'cancelled' | 'timeout',
  message: string,
  code: string,
) => ToolExecutionResult;

export async function readApprovalStateWithInterruption(
  store: ApprovalStateStore,
  binding: NonNullable<SignedPendingToolApproval['approvalBinding']>,
  approval: SignedPendingToolApproval,
  options: ToolboxExecuteOptions,
  runtime: RuntimeServices,
  createInterruptedResult: InterruptedResult,
): Promise<
  | { outcome: 'read'; state: ApprovalState | undefined }
  | { outcome: 'interrupted'; result: ToolExecutionResult }
> {
  const now = options.now ?? runtime.clock.now;
  const deadline = options.requestContext?.deadline;
  const cancelled = () => createInterruptedResult(approval, 'cancelled', 'Cancelled', 'CANCELLED');
  const timedOut = () =>
    createInterruptedResult(approval, 'timeout', 'Execution deadline exceeded', 'TIMEOUT');
  if (options.signal?.aborted) return { outcome: 'interrupted', result: cancelled() };
  if (deadline !== undefined && deadline <= now()) {
    return { outcome: 'interrupted', result: timedOut() };
  }
  if (!options.signal && deadline === undefined) {
    return { outcome: 'read', state: await store.state(binding) };
  }
  return waitForState(store, binding, options, now, deadline, cancelled, timedOut, runtime);
}

function waitForState(
  store: ApprovalStateStore,
  binding: NonNullable<SignedPendingToolApproval['approvalBinding']>,
  options: ToolboxExecuteOptions,
  now: () => number,
  deadline: number | undefined,
  cancelled: () => ToolExecutionResult,
  timedOut: () => ToolExecutionResult,
  runtime: RuntimeServices,
): Promise<
  | { outcome: 'read'; state: ApprovalState | undefined }
  | { outcome: 'interrupted'; result: ToolExecutionResult }
> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const setTimer = options.setTimeoutFunction ?? runtime.timers.setTimeout;
    const clearTimer = options.clearTimeoutFunction ?? runtime.timers.clearTimeout;
    let timer: unknown;
    let timerScheduled = false;
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
      if (!timerScheduled) return;
      timerScheduled = false;
      clearTimer(timer);
    };
    const finish = (
      value:
        | { outcome: 'read'; state: ApprovalState | undefined }
        | { outcome: 'interrupted'; result: ToolExecutionResult },
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const scheduleDeadline = () => {
      if (deadline === undefined) return;
      const remaining = deadline - now();
      timerScheduled = true;
      timer = setTimer(
        () => {
          timerScheduled = false;
          if (settled) return;
          if (deadline <= now()) {
            finish({ outcome: 'interrupted', result: timedOut() });
            return;
          }
          scheduleDeadline();
        },
        remaining <= 0 ? 0 : Math.min(remaining, maximumTimerDelay),
      );
    };
    const onAbort = () => finish({ outcome: 'interrupted', result: cancelled() });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    scheduleDeadline();
    void store.state(binding).then((state) => finish({ outcome: 'read', state }), fail);
  });
}

export async function issueApprovalStateWithInterruption(
  store: ApprovalStateStore,
  approval: SignedPendingToolApproval,
  options: ToolboxExecuteOptions,
  runtime: RuntimeServices,
  createInterruptedResult: InterruptedResult,
): Promise<ToolExecutionResult | undefined> {
  const binding = approval.approvalBinding;
  if (!binding) return undefined;
  const now = options.now ?? runtime.clock.now;
  const deadline = options.requestContext?.deadline;
  const cancelled = () =>
    createInterruptedResult(
      approval,
      'cancelled',
      formatCancellationReason(options.signal?.reason),
      'CANCELLED',
    );
  const timedOut = () =>
    createInterruptedResult(approval, 'timeout', 'Execution deadline exceeded', 'TIMEOUT');
  if (options.signal?.aborted) return cancelled();
  if (deadline !== undefined && deadline <= now()) return timedOut();
  const issuance = store.issue(binding);
  return waitForIssuance(
    store,
    binding,
    issuance,
    options,
    now,
    deadline,
    cancelled,
    timedOut,
    runtime,
  );
}

function waitForIssuance(
  store: ApprovalStateStore,
  binding: NonNullable<SignedPendingToolApproval['approvalBinding']>,
  issuance: Promise<void>,
  options: ToolboxExecuteOptions,
  now: () => number,
  deadline: number | undefined,
  cancelled: () => ToolExecutionResult,
  timedOut: () => ToolExecutionResult,
  runtime: RuntimeServices,
): Promise<ToolExecutionResult | undefined> {
  const revokeLateIssuance = async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await store.revoke(binding);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await Promise.resolve();
      }
    }
    throw lastError;
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const setTimer = options.setTimeoutFunction ?? runtime.timers.setTimeout;
    const clearTimer = options.clearTimeoutFunction ?? runtime.timers.clearTimeout;
    let timer: unknown;
    let timerScheduled = false;
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
      if (!timerScheduled) return;
      timerScheduled = false;
      clearTimer(timer);
    };
    const finish = (result: ToolExecutionResult | undefined) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const interrupt = (result: ToolExecutionResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      void issuance.then(revokeLateIssuance, () => undefined).catch(() => undefined);
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const scheduleDeadline = () => {
      if (deadline === undefined) return;
      const remaining = deadline - now();
      timerScheduled = true;
      timer = setTimer(
        () => {
          timerScheduled = false;
          if (settled) return;
          if (deadline <= now()) {
            interrupt(timedOut());
            return;
          }
          scheduleDeadline();
        },
        remaining <= 0 ? 0 : Math.min(remaining, maximumTimerDelay),
      );
    };
    const onAbort = () => interrupt(cancelled());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    scheduleDeadline();
    void issuance.then(() => finish(undefined), fail);
  });
}

function formatCancellationReason(reason: unknown): string {
  if (typeof reason === 'string' && reason.length > 0) return reason;
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  return 'Cancelled';
}
