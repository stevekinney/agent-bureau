import type { RunResult, TokenUsage } from 'operative';
import { estimateCost, getModelPricing } from 'operative';

import type { ExpectedToolCall } from './types';

/**
 * Extracts the number of steps from a RunResult.
 */
export function extractStepCount(result: RunResult): number {
  return result.steps.length;
}

/**
 * Extracts token usage from a RunResult, returning zeros for missing data.
 */
export function extractTokenUsage(result: RunResult): TokenUsage {
  return result.usage ?? { prompt: 0, completion: 0, total: 0 };
}

/**
 * Computes the estimated cost in USD for the given token usage and model.
 * Returns 0 when no model is provided or the model has no known pricing.
 */
export function computeCost(usage: TokenUsage, model?: string): number {
  if (!model) return 0;

  const pricing = getModelPricing(model);
  if (!pricing) return 0;

  try {
    const estimate = estimateCost(usage, model);
    return estimate.totalCost;
  } catch {
    return 0;
  }
}

/**
 * Flattens all tool calls across all steps into a single ordered array.
 */
function flattenToolCalls(result: RunResult): Array<{ name: string; arguments: unknown }> {
  const calls: Array<{ name: string; arguments: unknown }> = [];
  for (const step of result.steps) {
    for (const tc of step.toolCalls) {
      calls.push({
        name: tc.name,
        arguments: tc.arguments ?? {},
      });
    }
  }
  return calls;
}

/**
 * Performs a deep equality check for JSON-serializable values.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;

  return keysA.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * Checks whether actual tool calls match expected tool calls in exact order
 * (using the `index` property of each expected call).
 */
export function matchToolCallsOrdered(result: RunResult, expected: ExpectedToolCall[]): boolean {
  if (expected.length === 0) return true;

  const actualCalls = flattenToolCalls(result);

  for (const exp of expected) {
    const index = exp.index ?? 0;
    const actual = actualCalls[index];

    if (!actual) return false;
    if (actual.name !== exp.name) return false;

    if (exp.arguments && !deepEqual(actual.arguments, exp.arguments)) {
      return false;
    }
  }

  return true;
}

/**
 * Checks whether all expected tool calls appear somewhere in the actual calls
 * (unordered set membership).
 */
export function matchToolCallsUnordered(result: RunResult, expected: ExpectedToolCall[]): boolean {
  if (expected.length === 0) return true;

  const actualCalls = flattenToolCalls(result);

  for (const exp of expected) {
    const found = actualCalls.some((actual) => {
      if (actual.name !== exp.name) return false;
      if (exp.arguments && !deepEqual(actual.arguments, exp.arguments)) return false;
      return true;
    });

    if (!found) return false;
  }

  return true;
}

/**
 * Matches tool calls using ordered matching when any expected call has an `index`
 * property, and unordered set membership otherwise.
 * Returns true when expected is undefined or empty.
 */
export function matchToolCalls(
  result: RunResult,
  expected: ExpectedToolCall[] | undefined,
): boolean {
  if (!expected || expected.length === 0) return true;

  const hasIndexed = expected.some((e) => e.index !== undefined);
  return hasIndexed
    ? matchToolCallsOrdered(result, expected)
    : matchToolCallsUnordered(result, expected);
}

/**
 * Returns the provided duration value, or 0 for undefined/missing duration.
 */
export function extractDuration(duration: number | undefined): number {
  return duration ?? 0;
}
