import { describe, expect, it } from 'bun:test';
import type { JSONValue, RunResult, StepResult, TokenUsage } from 'operative';

import { extractStepCount, extractTokenUsage, matchToolCalls } from './metrics';
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

describe('matchToolCalls', () => {
  it('returns true for empty expected calls', () => {
    const result = createMockRunResult();
    expect(matchToolCalls(result, [])).toBe(true);
  });

  it('returns true when no expected calls are provided', () => {
    const result = createMockRunResult();
    expect(matchToolCalls(result, undefined)).toBe(true);
  });

  it('uses ordered matching when any expected call has an index', () => {
    const steps = [createMockStep([{ name: 'search' }, { name: 'summarize' }])];
    const expected: ExpectedToolCall[] = [{ name: 'search', index: 0 }];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(true);
  });

  it('returns false when ordered tool call is at wrong index', () => {
    const steps = [createMockStep([{ name: 'summarize' }, { name: 'search' }])];
    const expected: ExpectedToolCall[] = [{ name: 'search', index: 0 }];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(false);
  });

  it('matches arguments when provided in ordered mode', () => {
    const steps = [createMockStep([{ name: 'search', arguments: { query: 'test' } }])];
    const expected: ExpectedToolCall[] = [
      { name: 'search', index: 0, arguments: { query: 'test' } },
    ];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(true);
  });

  it('returns false when ordered arguments do not match', () => {
    const steps = [createMockStep([{ name: 'search', arguments: { query: 'other' } }])];
    const expected: ExpectedToolCall[] = [
      { name: 'search', index: 0, arguments: { query: 'test' } },
    ];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(false);
  });

  it('matches deeply nested ordered arguments', () => {
    const steps = [
      createMockStep([
        {
          name: 'search',
          arguments: {
            query: 'test',
            filters: {
              tags: ['alpha', 'beta'],
              range: { minimum: 1, maximum: 3 },
            },
          },
        },
      ]),
    ];
    const expected: ExpectedToolCall[] = [
      {
        name: 'search',
        index: 0,
        arguments: {
          query: 'test',
          filters: {
            tags: ['alpha', 'beta'],
            range: { minimum: 1, maximum: 3 },
          },
        },
      },
    ];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(true);
  });

  it('uses unordered matching when no expected call has an index', () => {
    const steps = [createMockStep([{ name: 'summarize' }, { name: 'search' }])];
    const expected: ExpectedToolCall[] = [{ name: 'search' }, { name: 'summarize' }];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(true);
  });

  it('returns false when an expected tool was not called', () => {
    const steps = [createMockStep([{ name: 'search' }])];
    const expected: ExpectedToolCall[] = [{ name: 'search' }, { name: 'summarize' }];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(false);
  });

  it('matches unordered arguments when provided', () => {
    const steps = [createMockStep([{ name: 'search', arguments: { query: 'hello' } }])];
    const expected: ExpectedToolCall[] = [{ name: 'search', arguments: { query: 'hello' } }];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(true);
  });

  it('returns false when nested unordered arguments differ', () => {
    const steps = [
      createMockStep([
        {
          name: 'search',
          arguments: {
            query: 'hello',
            filters: { tags: ['alpha', 'beta'] },
          },
        },
      ]),
    ];
    const expected: ExpectedToolCall[] = [
      {
        name: 'search',
        arguments: {
          query: 'hello',
          filters: { tags: ['alpha', 'gamma'] },
        },
      },
    ];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(false);
  });

  it('does not allow one actual call to satisfy multiple expected calls', () => {
    const steps = [createMockStep([{ name: 'search' }])];
    const expected: ExpectedToolCall[] = [{ name: 'search' }, { name: 'search' }];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(false);
  });

  it('allows duplicate expected calls when enough actual calls exist', () => {
    const steps = [createMockStep([{ name: 'search' }, { name: 'search' }])];
    const expected: ExpectedToolCall[] = [{ name: 'search' }, { name: 'search' }];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(true);
  });

  it('matches expected calls without index at any position in ordered mode', () => {
    const steps = [createMockStep([{ name: 'search' }, { name: 'summarize' }, { name: 'save' }])];
    // One call pinned to index 0, another has no index (should match anywhere)
    const expected: ExpectedToolCall[] = [{ name: 'search', index: 0 }, { name: 'save' }];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(true);
  });

  it('does not pin unindexed calls to position 0 in ordered mode', () => {
    const steps = [createMockStep([{ name: 'search' }, { name: 'summarize' }])];
    // Two unindexed calls in ordered mode (triggered because at least one has an index)
    const expected: ExpectedToolCall[] = [{ name: 'summarize', index: 1 }, { name: 'search' }];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(true);
  });

  it('returns false when two expected calls share the same index', () => {
    const steps = [createMockStep([{ name: 'search' }, { name: 'search' }])];
    // Both expected calls point to index 0 — the second one should fail
    // because the actual call at index 0 was already consumed by the first
    const expected: ExpectedToolCall[] = [
      { name: 'search', index: 0 },
      { name: 'search', index: 0 },
    ];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(false);
  });

  it('returns false when unindexed call cannot be found at any position', () => {
    const steps = [createMockStep([{ name: 'search' }, { name: 'summarize' }])];
    const expected: ExpectedToolCall[] = [{ name: 'search', index: 0 }, { name: 'missing-tool' }];
    const result = createMockRunResult({ steps });
    expect(matchToolCalls(result, expected)).toBe(false);
  });
});
