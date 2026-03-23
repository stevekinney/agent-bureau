import { describe, expect, it } from 'bun:test';

import { repeatingToolCalls } from '../src/conditions/predicates';
import type { StepResult, ToolExecutionResult } from '../src/types';

const makeStepResult = (overrides: Partial<StepResult> = {}): StepResult => ({
  step: 0,
  conversation: {} as any,
  content: '',
  toolCalls: [],
  results: [],
  final: false,
  ...overrides,
});

function makeResult(callId: string, content: string): ToolExecutionResult {
  return {
    callId,
    toolCallId: callId,
    toolName: 'fetch_data',
    outcome: 'error',
    content,
    result: undefined,
  };
}

describe('repeatingToolCalls with includeResults', () => {
  it('triggers when calls and results are identical', () => {
    const condition = repeatingToolCalls({ windowSize: 2, includeResults: true });

    condition(
      makeStepResult({
        toolCalls: [{ id: 'c1', name: 'fetch_data', arguments: { url: '/api' } }],
        results: [makeResult('c1', 'Error: timeout')],
      }),
    );

    const result = condition(
      makeStepResult({
        toolCalls: [{ id: 'c2', name: 'fetch_data', arguments: { url: '/api' } }],
        results: [makeResult('c2', 'Error: timeout')],
      }),
    );

    expect(result).toBe(true);
  });

  it('does not trigger when calls match but results differ', () => {
    const condition = repeatingToolCalls({ windowSize: 2, includeResults: true });

    condition(
      makeStepResult({
        toolCalls: [{ id: 'c1', name: 'fetch_data', arguments: { url: '/api' } }],
        results: [makeResult('c1', 'Error: timeout')],
      }),
    );

    const result = condition(
      makeStepResult({
        toolCalls: [{ id: 'c2', name: 'fetch_data', arguments: { url: '/api' } }],
        results: [makeResult('c2', 'Error: connection refused')],
      }),
    );

    expect(result).toBe(false);
  });

  it('does not trigger without includeResults even when results match', () => {
    // Default: includeResults = false
    const condition = repeatingToolCalls({ windowSize: 2 });

    condition(
      makeStepResult({
        toolCalls: [{ id: 'c1', name: 'fetch_data', arguments: { url: '/api' } }],
        results: [makeResult('c1', 'Error: timeout')],
      }),
    );

    // Same call, different result — but includeResults is false, so only calls matter
    const result = condition(
      makeStepResult({
        toolCalls: [{ id: 'c2', name: 'fetch_data', arguments: { url: '/api' } }],
        results: [makeResult('c2', 'Error: something else')],
      }),
    );

    // Should trigger because the calls match (results are ignored)
    expect(result).toBe(true);
  });

  it('truncates result content to 100 characters', () => {
    const condition = repeatingToolCalls({ windowSize: 2, includeResults: true });
    const longContent = 'A'.repeat(200);
    const differentSuffix = 'A'.repeat(100) + 'B'.repeat(100);

    condition(
      makeStepResult({
        toolCalls: [{ id: 'c1', name: 'fetch_data', arguments: {} }],
        results: [makeResult('c1', longContent)],
      }),
    );

    // First 100 chars are the same ('A' * 100), only the suffix differs
    const result = condition(
      makeStepResult({
        toolCalls: [{ id: 'c2', name: 'fetch_data', arguments: {} }],
        results: [makeResult('c2', differentSuffix)],
      }),
    );

    // Should trigger because only first 100 chars are compared
    expect(result).toBe(true);
  });

  it('handles missing results gracefully', () => {
    const condition = repeatingToolCalls({ windowSize: 2, includeResults: true });

    condition(
      makeStepResult({
        toolCalls: [{ id: 'c1', name: 'fetch_data', arguments: {} }],
        results: [],
      }),
    );

    const result = condition(
      makeStepResult({
        toolCalls: [{ id: 'c2', name: 'fetch_data', arguments: {} }],
        results: [],
      }),
    );

    expect(result).toBe(true);
  });
});
