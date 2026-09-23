import type { ToolPolicyContext } from '../is-tool';
import type { ToolExecutionResult } from '../types';
import { isAbortRejection, racePreExecution } from './cancellation';
import type { ErrorInput } from './result-handlers';

export async function injectErrorPolicyContext(
  input: ErrorInput,
  context: ToolPolicyContext,
): Promise<{ result: ToolExecutionResult } | undefined> {
  if (!input.policyContextProvider) return undefined;
  try {
    const injected = await racePreExecution(
      () => input.policyContextProvider?.(context),
      input.options.signal,
    );
    applyInjectedPolicyContext(context, injected);
  } catch (policyContextError) {
    return errorPolicyContextAbort(input, policyContextError);
  }
  return undefined;
}

function applyInjectedPolicyContext(context: ToolPolicyContext, injected: unknown): void {
  if (isRecord(injected)) context.policyContext = injected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorPolicyContextAbort(
  input: ErrorInput,
  error: unknown,
): { result: ToolExecutionResult } | undefined {
  if (!isAbortRejection(error)) throw error;
  if (input.options.executionHandle?.snapshot().abortSource === 'deadline') return undefined;
  const reason =
    error.reason ??
    input.options.executionHandle?.snapshot().abortReason ??
    input.options.signal?.reason;
  return { result: input.handleCancellation(reason) };
}
