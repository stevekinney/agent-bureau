import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import type { RunResultBase } from './types';
import { toRedactedRunResultSummary } from './types';

/**
 * AB-214 review (PRRT_kwDORvupsc6es7pl): `toRedactedRunResultSummary` is the
 * single place that turns a full `RunResult` into the safe subset a
 * `'redacted'` `LivenessSnapshot` may carry — never the conversation, raw
 * content, tool arguments/results, or the error value itself.
 */
describe('toRedactedRunResultSummary', () => {
  function buildResult(overrides: Partial<RunResultBase> = {}): RunResultBase {
    return {
      conversation: new Conversation(),
      steps: [],
      content: 'the secret is 42',
      usage: { prompt: 0, completion: 0, total: 0 },
      finishReason: 'stop-condition',
      ...overrides,
    };
  }

  it('carries finishReason and hasError: false when there is no error', () => {
    const result = buildResult({ finishReason: 'stop-condition' });

    expect(toRedactedRunResultSummary(result)).toEqual({
      finishReason: 'stop-condition',
      hasError: false,
    });
  });

  it('reports hasError: true without leaking the error value itself', () => {
    const result = buildResult({
      finishReason: 'error',
      error: new Error('secret failure detail'),
    });

    const summary = toRedactedRunResultSummary(result);
    expect(summary).toEqual({ finishReason: 'error', hasError: true });
    expect(JSON.stringify(summary)).not.toContain('secret failure detail');
  });

  it('omits the conversation, content, and steps from the summary', () => {
    const result = buildResult();
    const summary = toRedactedRunResultSummary(result);

    expect(Object.keys(summary).sort()).toEqual(['finishReason', 'hasError']);
  });
});
