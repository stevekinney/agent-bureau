import type { RunResult } from '@lostgradient/operative';

import { extractToolCallSequence } from './metrics';
import type { EvaluationCase, ExpectedToolCall, PromoteRunToCaseOptions } from './types';

/** Narrows a `ToolCall.arguments` (JSONValue) to a plain object, or undefined. */
function toArgumentsRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Snapshots a run's actual tool-call sequence as ordered `ExpectedToolCall`s
 * (each pinned to its `index`), so the promoted case reproduces the exact
 * golden trajectory rather than just the set of tools called.
 */
function toExpectedToolCalls(runResult: RunResult): ExpectedToolCall[] {
  return extractToolCallSequence(runResult).map((call, index) => {
    const args = toArgumentsRecord(call.arguments);
    return args === undefined
      ? { name: call.name, index }
      : { name: call.name, index, arguments: args };
  });
}

/**
 * Turns a recorded run into a runnable regression case — the dataset
 * lifecycle's promotion path. Snapshots the run's actual output and
 * tool-call trajectory as the case's golden expectations (characterization
 * testing: "this is what it did, keep doing this"), and records `provenance`
 * — which run produced it, and from where.
 *
 * When promoting a *failure*, pass `expectedOutput` to set the desired
 * (fixed) output instead of snapshotting the buggy `runResult.content` —
 * otherwise the bug would be locked in as the expectation.
 *
 * @example
 * ```ts
 * const report = await evaluation.run();
 * const failed = report.cases.find((c) => c.name === 'checkout-flow' && !c.pass);
 * // ...re-run the case to capture its RunResult, or capture it inline during the run...
 * const promoted = promoteRunToCase({
 *   sourceCase: originalCase,
 *   runResult,
 *   origin: 'production-failure',
 *   runId: `${report.timestamp}:${originalCase.name}`,
 *   expectedOutput: 'The corrected response text.',
 * });
 * await saveDataset('datasets/regressions.json', [...existingCases, promoted]);
 * ```
 */
export function promoteRunToCase(options: PromoteRunToCaseOptions): EvaluationCase {
  const { sourceCase, runResult, origin, runId } = options;
  const expectedToolCalls = toExpectedToolCalls(runResult);

  return {
    name: options.name ?? `${sourceCase.name} (promoted)`,
    input: sourceCase.input,
    systemPrompt: sourceCase.systemPrompt,
    expectedOutput: options.expectedOutput ?? runResult.content,
    expectedToolCalls,
    // Locks the trajectory length so a later run that performs every
    // expected call PLUS an extra, unlisted one still fails — otherwise
    // `matchToolCallsOrdered` only checks the positions it was told about
    // and silently accepts extras (see `expectedToolCallCount`'s doc).
    expectedToolCallCount: expectedToolCalls.length,
    maxSteps: sourceCase.maxSteps,
    tags: [...(sourceCase.tags ?? []), 'promoted'],
    timeout: sourceCase.timeout,
    provenance: {
      origin,
      runId,
      sourceCaseName: sourceCase.name,
      promotedAt: new Date().toISOString(),
      finishReason: runResult.finishReason,
    },
  };
}
