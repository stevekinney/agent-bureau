import type { RunResult, TokenUsage } from 'operative';

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

/** Type guard that narrows an unknown value to a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

/**
 * Checks whether actual tool calls match expected tool calls in exact order
 * (using the `index` property of each expected call). Expected calls without
 * an explicit `index` are matched at any position (unordered), consistent with
 * the `ExpectedToolCall` documentation that "undefined means any position."
 */
function matchToolCallsOrdered(result: RunResult, expected: ExpectedToolCall[]): boolean {
  if (expected.length === 0) return true;

  const actualCalls = flattenToolCalls(result);
  const consumed = new Set<number>();

  // First pass: match expected calls that have an explicit index
  for (const exp of expected) {
    if (exp.index === undefined) continue;

    // Each actual call can only satisfy one expected call
    if (consumed.has(exp.index)) return false;

    const actual = actualCalls[exp.index];
    if (!actual) return false;
    if (actual.name !== exp.name) return false;
    if (exp.arguments && !deepEqual(actual.arguments, exp.arguments)) return false;

    consumed.add(exp.index);
  }

  // Second pass: match expected calls without an index at any unconsumed position
  for (const exp of expected) {
    if (exp.index !== undefined) continue;

    const foundIndex = actualCalls.findIndex((actual, i) => {
      if (consumed.has(i)) return false;
      if (actual.name !== exp.name) return false;
      if (exp.arguments && !deepEqual(actual.arguments, exp.arguments)) return false;
      return true;
    });

    if (foundIndex === -1) return false;
    consumed.add(foundIndex);
  }

  return true;
}

/**
 * Checks whether all expected tool calls appear somewhere in the actual calls
 * (unordered set membership). Each actual call can only satisfy one expected call.
 */
function matchToolCallsUnordered(result: RunResult, expected: ExpectedToolCall[]): boolean {
  if (expected.length === 0) return true;

  const actualCalls = flattenToolCalls(result);
  const consumed = new Set<number>();

  for (const exp of expected) {
    const foundIndex = actualCalls.findIndex((actual, index) => {
      if (consumed.has(index)) return false;
      if (actual.name !== exp.name) return false;
      if (exp.arguments && !deepEqual(actual.arguments, exp.arguments)) return false;
      return true;
    });

    if (foundIndex === -1) return false;
    consumed.add(foundIndex);
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
