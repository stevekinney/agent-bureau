import type { StepResult, StopCondition, ToolCall, ToolExecutionResult } from '../types';

/**
 * Stops when the model returns no tool calls (text-only response).
 */
export function noToolCalls(): StopCondition {
  return (context: StepResult) => context.toolCalls.length === 0;
}

/**
 * Stops when a specific tool is called by name.
 */
export function toolCalled(name: string): StopCondition {
  return (context: StepResult) => context.toolCalls.some((call) => call.name === name);
}

/**
 * Stops when the step count reaches the given limit.
 */
export function maximumSteps(limit: number): StopCondition {
  return (context: StepResult) => context.step >= limit - 1;
}

/**
 * Stops when any tool result has the specified outcome.
 */
export function toolOutcome(outcome: 'error' | 'action_required'): StopCondition {
  return (context: StepResult) => context.results.some((result) => result.outcome === outcome);
}

/**
 * Stops when the assistant content matches the given predicate.
 */
export function contentMatches(predicate: (content: string) => boolean): StopCondition {
  return (context: StepResult) => predicate(context.content);
}

/**
 * Stops when the just-completed step produced any tool result carrying a
 * `pendingApproval` (armorer's `needs_approval` outcome). Use this to park an
 * interactive run cleanly after the step: no further generate call occurs, and
 * the pending approval stays reachable on the final `RunResult`'s last step —
 * so a host can round-trip it to a human and resume with
 * `toolbox.resumeApproval(signedApproval)` on a fresh run started from the
 * updated conversation history.
 */
export function pendingApproval(): StopCondition {
  return (context: StepResult) => context.results.some((result) => result.pendingApproval);
}

/**
 * Stops only when all conditions are met.
 */
export function every(...conditions: StopCondition[]): StopCondition {
  return async (context: StepResult) => {
    for (const condition of conditions) {
      const result = await condition(context);
      if (!result) return false;
    }
    return true;
  };
}

/**
 * Stops when any condition is met.
 */
export function some(...conditions: StopCondition[]): StopCondition {
  return async (context: StepResult) => {
    for (const condition of conditions) {
      const result = await condition(context);
      if (result) return true;
    }
    return false;
  };
}

/**
 * Inverts a condition.
 */
export function not(condition: StopCondition): StopCondition {
  return async (context: StepResult) => {
    const result = await condition(context);
    return !result;
  };
}

/**
 * Stops when the elapsed wall-clock time since creation exceeds the threshold.
 * Unlike `AbortSignal.timeout()`, this lets the current step finish and
 * produces `finishReason: 'stop-condition'` instead of `'aborted'`.
 */
export function wallClockTimeout(
  milliseconds: number,
  options: { now?: () => number } = {},
): StopCondition {
  const now = options.now ?? Date.now;
  const start = now();
  return () => now() - start >= milliseconds;
}

/**
 * Options for the repeating tool calls stop condition.
 */
export interface RepeatingToolCallsOptions {
  /** Consecutive identical steps required to trigger. Default: 3 */
  windowSize?: number;
  /** Custom fingerprint function. Default: hash of sorted (name, arguments) tuples. */
  fingerprint?: (toolCalls: readonly ToolCall[], results: readonly ToolExecutionResult[]) => string;
  /**
   * When true, the default fingerprint includes a truncated preview of each
   * tool result (first 100 characters). This catches agents stuck retrying the
   * same call that keeps returning the same error. Default: false.
   */
  includeResults?: boolean;
}

function defaultFingerprint(
  toolCalls: readonly ToolCall[],
  results: readonly ToolExecutionResult[],
  includeResults: boolean,
): string {
  const sorted = [...toolCalls]
    .map((call) => {
      let fp = `${call.name}:${JSON.stringify(call.arguments)}`;
      if (includeResults) {
        const result = results.find((r) => r.callId === call.id);
        if (result) {
          const raw =
            typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
          const preview = raw.slice(0, 100);
          fp += `:${preview}`;
        }
      }
      return fp;
    })
    .sort();
  return sorted.join('|');
}

/**
 * Stops when the agent makes identical tool calls for N consecutive steps,
 * indicating a stuck/looping agent. Text-only steps never trigger this condition.
 */
export function repeatingToolCalls(options?: RepeatingToolCallsOptions): StopCondition {
  const windowSize = options?.windowSize ?? 3;
  const fingerprintFunction = options?.fingerprint;
  const includeResults = options?.includeResults ?? false;

  // Fixed-size circular buffer: only the last `windowSize` entries are retained.
  const buffer: string[] = new Array<string>(windowSize);
  let writeIndex = 0;
  let filled = 0;
  let sentinel = 0;

  return (context: StepResult) => {
    if (context.toolCalls.length === 0) {
      buffer[writeIndex] = `__no_tools_${sentinel++}__`;
      writeIndex = (writeIndex + 1) % windowSize;
      if (filled < windowSize) filled++;
      return false;
    }

    const fp = fingerprintFunction
      ? fingerprintFunction(context.toolCalls, context.results)
      : defaultFingerprint(context.toolCalls, context.results, includeResults);

    buffer[writeIndex] = fp;
    writeIndex = (writeIndex + 1) % windowSize;
    if (filled < windowSize) filled++;

    if (filled < windowSize) return false;

    // Check if all entries in the buffer are identical
    const reference = buffer[0]!;
    for (let i = 1; i < windowSize; i++) {
      if (buffer[i] !== reference) return false;
    }
    return true;
  };
}

/**
 * Options for the token budget stop condition.
 */
export interface TokenBudgetOptions {
  /** Which counter to check. Default: 'total' */
  counter?: 'prompt' | 'completion' | 'total';
}

/**
 * Stops when cumulative token usage reaches or exceeds the given threshold.
 */
export function tokenBudget(maxTokens: number, options?: TokenBudgetOptions): StopCondition {
  const counter = options?.counter ?? 'total';
  let accumulated = 0;

  return (context: StepResult) => {
    if (context.usage) {
      accumulated += context.usage[counter];
    }
    return accumulated >= maxTokens;
  };
}

/**
 * Stops when the conversation emits a `session.forked` event.
 * The listener is registered once on the first evaluation and remains
 * active for the lifetime of the condition instance.
 */
export function forked(): StopCondition {
  let listening = false;
  let detected = false;

  return (context: StepResult) => {
    if (!listening) {
      context.conversation.addEventListener(
        'session.forked',
        () => {
          detected = true;
        },
        { once: true },
      );
      listening = true;
    }
    return detected;
  };
}
