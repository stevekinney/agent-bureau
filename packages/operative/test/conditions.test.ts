import { describe, expect, it } from 'bun:test';

import {
  contentMatches,
  every,
  maximumSteps,
  not,
  noToolCalls,
  some,
  toolCalled,
  toolOutcome,
} from '../src/conditions/predicates';
import type { StepResult } from '../src/types';

const makeStepResult = (overrides: Partial<StepResult> = {}): StepResult => ({
  step: 0,
  conversation: {} as any,
  content: '',
  toolCalls: [],
  results: [],
  final: false,
  ...overrides,
});

describe('noToolCalls', () => {
  it('stops on a text-only response', () => {
    const condition = noToolCalls();
    const result = condition(makeStepResult({ toolCalls: [] }));
    expect(result).toBe(true);
  });

  it('continues when toolCalls has entries', () => {
    const condition = noToolCalls();
    const result = condition(
      makeStepResult({
        toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );
    expect(result).toBe(false);
  });
});

describe('toolCalled', () => {
  it('stops when the specific tool is called', () => {
    const condition = toolCalled('get_weather');
    const result = condition(
      makeStepResult({
        toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );
    expect(result).toBe(true);
  });

  it('continues when a different tool is called', () => {
    const condition = toolCalled('get_weather');
    const result = condition(
      makeStepResult({
        toolCalls: [{ id: 'call-1', name: 'search', arguments: { query: 'hello' } }],
      }),
    );
    expect(result).toBe(false);
  });

  it('continues when no tools are called', () => {
    const condition = toolCalled('get_weather');
    const result = condition(makeStepResult({ toolCalls: [] }));
    expect(result).toBe(false);
  });
});

describe('maximumSteps', () => {
  it('stops at step n-1 (0-indexed)', () => {
    const condition = maximumSteps(3);
    const result = condition(makeStepResult({ step: 2 }));
    expect(result).toBe(true);
  });

  it('continues before reaching the limit', () => {
    const condition = maximumSteps(3);
    const result = condition(makeStepResult({ step: 1 }));
    expect(result).toBe(false);
  });
});

describe('toolOutcome("error")', () => {
  it('stops when a result has outcome error', () => {
    const condition = toolOutcome('error');
    const result = condition(
      makeStepResult({
        results: [
          {
            callId: 'call-1',
            toolCallId: 'call-1',
            toolName: 'get_weather',
            outcome: 'error',
            content: 'failed',
            result: undefined,
          },
        ],
      }),
    );
    expect(result).toBe(true);
  });

  it('continues on success', () => {
    const condition = toolOutcome('error');
    const result = condition(
      makeStepResult({
        results: [
          {
            callId: 'call-1',
            toolCallId: 'call-1',
            toolName: 'get_weather',
            outcome: 'success',
            content: 'sunny',
            result: undefined,
          },
        ],
      }),
    );
    expect(result).toBe(false);
  });
});

describe('toolOutcome("action_required")', () => {
  it('stops on action_required', () => {
    const condition = toolOutcome('action_required');
    const result = condition(
      makeStepResult({
        results: [
          {
            callId: 'call-1',
            toolCallId: 'call-1',
            toolName: 'get_weather',
            outcome: 'action_required',
            content: 'needs approval',
            result: undefined,
          },
        ],
      }),
    );
    expect(result).toBe(true);
  });
});

describe('contentMatches', () => {
  it('stops when the predicate returns true', () => {
    const condition = contentMatches((content) => content.includes('DONE'));
    const result = condition(makeStepResult({ content: 'Task is DONE' }));
    expect(result).toBe(true);
  });

  it('continues when the predicate returns false', () => {
    const condition = contentMatches((content) => content.includes('DONE'));
    const result = condition(makeStepResult({ content: 'Still working' }));
    expect(result).toBe(false);
  });
});

describe('every', () => {
  it('stops only when both conditions are true', async () => {
    const condition = every(
      noToolCalls(),
      contentMatches((c) => c.includes('DONE')),
    );
    const result = await condition(makeStepResult({ toolCalls: [], content: 'DONE' }));
    expect(result).toBe(true);
  });

  it('continues when the first condition is false', async () => {
    const condition = every(
      noToolCalls(),
      contentMatches((c) => c.includes('DONE')),
    );
    const result = await condition(
      makeStepResult({
        toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Denver' } }],
        content: 'DONE',
      }),
    );
    expect(result).toBe(false);
  });

  it('continues when the second condition is false', async () => {
    const condition = every(
      noToolCalls(),
      contentMatches((c) => c.includes('DONE')),
    );
    const result = await condition(makeStepResult({ toolCalls: [], content: 'Still working' }));
    expect(result).toBe(false);
  });
});

describe('some', () => {
  it('stops when either condition is true', async () => {
    const condition = some(
      noToolCalls(),
      contentMatches((c) => c.includes('DONE')),
    );
    const result = await condition(
      makeStepResult({
        toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Denver' } }],
        content: 'DONE',
      }),
    );
    expect(result).toBe(true);
  });

  it('continues when both conditions are false', async () => {
    const condition = some(
      noToolCalls(),
      contentMatches((c) => c.includes('DONE')),
    );
    const result = await condition(
      makeStepResult({
        toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Denver' } }],
        content: 'Still working',
      }),
    );
    expect(result).toBe(false);
  });
});

describe('not', () => {
  it('inverts a true condition to false', async () => {
    const condition = not(noToolCalls());
    const result = await condition(makeStepResult({ toolCalls: [] }));
    expect(result).toBe(false);
  });

  it('inverts a false condition to true', async () => {
    const condition = not(noToolCalls());
    const result = await condition(
      makeStepResult({
        toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Denver' } }],
      }),
    );
    expect(result).toBe(true);
  });
});

describe('custom async condition', () => {
  it('works as a StopCondition when returning a Promise<boolean>', async () => {
    const asyncCondition = async (context: StepResult): Promise<boolean> => {
      return context.content.includes('STOP');
    };

    expect(await asyncCondition(makeStepResult({ content: 'Please STOP now' }))).toBe(true);
    expect(await asyncCondition(makeStepResult({ content: 'Keep going' }))).toBe(false);
  });
});
