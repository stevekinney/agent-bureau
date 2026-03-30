import { describe, expect, it } from 'bun:test';
import type { JSONValue, RunResult, StepResult, TokenUsage } from 'operative';

import {
  computeCost,
  extractDuration,
  extractStepCount,
  extractTokenUsage,
  matchToolCalls,
  matchToolCallsOrdered,
  matchToolCallsUnordered,
} from './metrics';
import type { ExpectedToolCall } from './types';

function createMockRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    content: '',
    conversation: {} as RunResult['conversation'],
    steps: [],
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: 'stop-condition',
    ...overrides,
  };
}

function createMockStep(
  toolCalls: Array<{ name: string; arguments?: Record<string, JSONValue> }> = [],
): StepResult {
  return {
    step: 1,
    conversation: {} as StepResult['conversation'],
    content: '',
    toolCalls: toolCalls.map((tc) => ({
      id: `call-${tc.name}`,
      name: tc.name,
      arguments: (tc.arguments ?? {}) as JSONValue,
    })),
    results: [],
    final: false,
  };
}

describe('extractStepCount', () => {
  it('returns 0 for empty steps', () => {
    const result = createMockRunResult({ steps: [] });
    expect(extractStepCount(result)).toBe(0);
  });

  it('returns the correct number of steps', () => {
    const steps = [createMockStep(), createMockStep(), createMockStep()];
    const result = createMockRunResult({ steps });
    expect(extractStepCount(result)).toBe(3);
  });
});

describe('extractTokenUsage', () => {
  it('returns the usage from RunResult', () => {
    const usage: TokenUsage = { prompt: 100, completion: 50, total: 150 };
    const result = createMockRunResult({ usage });
    expect(extractTokenUsage(result)).toEqual(usage);
  });

  it('returns zero usage when missing', () => {
    const result = createMockRunResult();
    expect(extractTokenUsage(result)).toEqual({ prompt: 0, completion: 0, total: 0 });
  });
});

describe('computeCost', () => {
  it('returns 0 when no model is provided', () => {
    const usage: TokenUsage = { prompt: 1000, completion: 500, total: 1500 };
    expect(computeCost(usage)).toBe(0);
  });

  it('computes cost for a known model', () => {
    const usage: TokenUsage = { prompt: 1_000_000, completion: 1_000_000, total: 2_000_000 };
    const cost = computeCost(usage, 'gpt-4o');
    // gpt-4o: prompt $2.5/M, completion $10/M
    expect(cost).toBeCloseTo(12.5, 2);
  });

  it('returns 0 for an unknown model', () => {
    const usage: TokenUsage = { prompt: 1000, completion: 500, total: 1500 };
    expect(computeCost(usage, 'unknown-model')).toBe(0);
  });

  it('returns 0 for zero usage', () => {
    const usage: TokenUsage = { prompt: 0, completion: 0, total: 0 };
    expect(computeCost(usage, 'gpt-4o')).toBe(0);
  });
});

describe('matchToolCallsOrdered', () => {
  it('returns true when all expected tool calls match in order', () => {
    const steps = [createMockStep([{ name: 'search' }, { name: 'summarize' }])];
    const expected: ExpectedToolCall[] = [
      { name: 'search', index: 0 },
      { name: 'summarize', index: 1 },
    ];
    const result = createMockRunResult({ steps });
    expect(matchToolCallsOrdered(result, expected)).toBe(true);
  });

  it('returns false when tool call is at wrong index', () => {
    const steps = [createMockStep([{ name: 'summarize' }, { name: 'search' }])];
    const expected: ExpectedToolCall[] = [{ name: 'search', index: 0 }];
    const result = createMockRunResult({ steps });
    expect(matchToolCallsOrdered(result, expected)).toBe(false);
  });

  it('matches arguments when provided', () => {
    const steps = [createMockStep([{ name: 'search', arguments: { query: 'test' } }])];
    const expected: ExpectedToolCall[] = [
      { name: 'search', index: 0, arguments: { query: 'test' } },
    ];
    const result = createMockRunResult({ steps });
    expect(matchToolCallsOrdered(result, expected)).toBe(true);
  });

  it('returns false when arguments do not match', () => {
    const steps = [createMockStep([{ name: 'search', arguments: { query: 'other' } }])];
    const expected: ExpectedToolCall[] = [
      { name: 'search', index: 0, arguments: { query: 'test' } },
    ];
    const result = createMockRunResult({ steps });
    expect(matchToolCallsOrdered(result, expected)).toBe(false);
  });

  it('returns true for empty expected calls', () => {
    const result = createMockRunResult();
    expect(matchToolCallsOrdered(result, [])).toBe(true);
  });
});

describe('matchToolCallsUnordered', () => {
  it('returns true when all expected tools were called regardless of order', () => {
    const steps = [createMockStep([{ name: 'summarize' }, { name: 'search' }])];
    const expected: ExpectedToolCall[] = [{ name: 'search' }, { name: 'summarize' }];
    const result = createMockRunResult({ steps });
    expect(matchToolCallsUnordered(result, expected)).toBe(true);
  });

  it('returns false when an expected tool was not called', () => {
    const steps = [createMockStep([{ name: 'search' }])];
    const expected: ExpectedToolCall[] = [{ name: 'search' }, { name: 'summarize' }];
    const result = createMockRunResult({ steps });
    expect(matchToolCallsUnordered(result, expected)).toBe(false);
  });

  it('matches arguments when provided', () => {
    const steps = [createMockStep([{ name: 'search', arguments: { query: 'hello' } }])];
    const expected: ExpectedToolCall[] = [{ name: 'search', arguments: { query: 'hello' } }];
    const result = createMockRunResult({ steps });
    expect(matchToolCallsUnordered(result, expected)).toBe(true);
  });

  it('returns true for empty expected calls', () => {
    const result = createMockRunResult();
    expect(matchToolCallsUnordered(result, [])).toBe(true);
  });
});

describe('matchToolCalls', () => {
  it('uses ordered matching when any expected call has an index', () => {
    const steps = [createMockStep([{ name: 'search' }, { name: 'summarize' }])];
    const expected: ExpectedToolCall[] = [{ name: 'search', index: 0 }];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(true);
  });

  it('uses unordered matching when no expected call has an index', () => {
    const steps = [createMockStep([{ name: 'summarize' }, { name: 'search' }])];
    const expected: ExpectedToolCall[] = [{ name: 'search' }, { name: 'summarize' }];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(true);
  });

  it('returns true for empty expected calls', () => {
    const result = createMockRunResult();
    expect(matchToolCalls(result, [])).toBe(true);
  });

  it('returns true when no expected calls are provided', () => {
    const result = createMockRunResult();
    expect(matchToolCalls(result, undefined)).toBe(true);
  });
});

describe('extractDuration', () => {
  it('returns the provided duration value', () => {
    expect(extractDuration(1500)).toBe(1500);
  });

  it('returns 0 for undefined duration', () => {
    expect(extractDuration(undefined)).toBe(0);
  });

  it('returns 0 for zero duration', () => {
    expect(extractDuration(0)).toBe(0);
  });
});
