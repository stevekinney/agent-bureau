import { describe, expect, it } from 'bun:test';
import type { RunResult } from 'operative';

import {
  matchCustomAssertion,
  matchExact,
  matchOutput,
  matchRegex,
  matchSemantic,
  matchSubstring,
} from './matchers';
import type { EvaluationAssertion, EvaluationCase, SemanticMatcher } from './types';

function createMockRunResult(content: string): RunResult {
  return {
    content,
    conversation: {} as RunResult['conversation'],
    steps: [],
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: 'stop-condition',
  };
}

describe('matchExact', () => {
  it('returns pass when content matches exactly', () => {
    const result = matchExact('Hello, world!', 'Hello, world!');
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it('returns fail when content does not match', () => {
    const result = matchExact('Hello, world!', 'Goodbye, world!');
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
  });

  it('is case-sensitive', () => {
    const result = matchExact('Hello', 'hello');
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
  });

  it('includes a descriptive message on failure', () => {
    const result = matchExact('actual', 'expected');
    expect(result.message).toContain('expected');
    expect(result.message).toContain('actual');
  });
});

describe('matchRegex', () => {
  it('returns pass when content matches the regex', () => {
    const result = matchRegex('The answer is 42', /answer is \d+/);
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it('returns fail when content does not match the regex', () => {
    const result = matchRegex('No numbers here', /\d+/);
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
  });

  it('supports regex flags', () => {
    const result = matchRegex('HELLO', /hello/i);
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it('includes the regex pattern in the message', () => {
    const result = matchRegex('no match', /foo/);
    expect(result.message).toContain('foo');
  });
});

describe('matchSubstring', () => {
  it('returns pass when content contains the substring', () => {
    const result = matchSubstring('The quick brown fox', 'brown');
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it('returns fail when content does not contain the substring', () => {
    const result = matchSubstring('The quick brown fox', 'purple');
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
  });

  it('is case-sensitive', () => {
    const result = matchSubstring('Hello World', 'hello');
    expect(result.pass).toBe(false);
  });
});

describe('matchSemantic', () => {
  const mockEmbedder = async (text: string): Promise<number[]> => {
    if (text === 'The capital of France is Paris') {
      return [1, 0, 0];
    }
    if (text === 'Paris is the capital of France') {
      return [0.98, 0.1, 0.1];
    }
    if (text === 'I like pizza') {
      return [0, 1, 0];
    }
    return [0, 0, 1];
  };

  it('returns pass when similarity exceeds threshold', async () => {
    const matcher: SemanticMatcher = {
      type: 'semantic',
      reference: 'Paris is the capital of France',
      threshold: 0.8,
    };
    const result = await matchSemantic('The capital of France is Paris', matcher, mockEmbedder);
    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThan(0.8);
  });

  it('returns fail when similarity is below threshold', async () => {
    const matcher: SemanticMatcher = {
      type: 'semantic',
      reference: 'The capital of France is Paris',
      threshold: 0.9,
    };
    const result = await matchSemantic('I like pizza', matcher, mockEmbedder);
    expect(result.pass).toBe(false);
    expect(result.score).toBeLessThan(0.9);
  });

  it('returns fail with message when no embedder is provided', async () => {
    const matcher: SemanticMatcher = {
      type: 'semantic',
      reference: 'test',
      threshold: 0.8,
    };
    const result = await matchSemantic('test', matcher, undefined);
    expect(result.pass).toBe(false);
    expect(result.message).toContain('embedder');
  });
});

describe('matchCustomAssertion', () => {
  it('returns the assertion result directly', () => {
    const assertFn = (_result: RunResult): EvaluationAssertion => ({
      pass: true,
      message: 'Custom pass',
      score: 0.9,
    });
    const runResult = createMockRunResult('anything');
    const result = matchCustomAssertion(runResult, assertFn);
    expect(result.pass).toBe(true);
    expect(result.score).toBe(0.9);
    expect(result.message).toBe('Custom pass');
  });

  it('defaults score to 1 when pass is true and no score provided', () => {
    const assertFn = (): EvaluationAssertion => ({ pass: true });
    const runResult = createMockRunResult('anything');
    const result = matchCustomAssertion(runResult, assertFn);
    expect(result.score).toBe(1);
  });

  it('defaults score to 0 when pass is false and no score provided', () => {
    const assertFn = (): EvaluationAssertion => ({ pass: false });
    const runResult = createMockRunResult('anything');
    const result = matchCustomAssertion(runResult, assertFn);
    expect(result.score).toBe(0);
  });

  it('captures errors thrown by the assertion function', () => {
    const assertFn = (): EvaluationAssertion => {
      throw new Error('assertion boom');
    };
    const runResult = createMockRunResult('anything');
    const result = matchCustomAssertion(runResult, assertFn);
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    expect(result.message).toContain('assertion boom');
  });
});

describe('matchOutput', () => {
  it('uses exact match for string expectedOutput', async () => {
    const evaluationCase: EvaluationCase = {
      name: 'test',
      input: 'test',
      expectedOutput: 'exact match',
    };
    const runResult = createMockRunResult('exact match');
    const result = await matchOutput(runResult, evaluationCase);
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it('uses regex match for RegExp expectedOutput', async () => {
    const evaluationCase: EvaluationCase = {
      name: 'test',
      input: 'test',
      expectedOutput: /\d{3}/,
    };
    const runResult = createMockRunResult('code 123 here');
    const result = await matchOutput(runResult, evaluationCase);
    expect(result.pass).toBe(true);
  });

  it('uses semantic match for SemanticMatcher expectedOutput', async () => {
    const mockEmbedder = async (_text: string): Promise<number[]> => [1, 0, 0];
    const evaluationCase: EvaluationCase = {
      name: 'test',
      input: 'test',
      expectedOutput: { type: 'semantic', reference: 'ref', threshold: 0.8 },
    };
    const runResult = createMockRunResult('content');
    const result = await matchOutput(runResult, evaluationCase, mockEmbedder);
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it('applies custom assert function when no expectedOutput', async () => {
    const evaluationCase: EvaluationCase = {
      name: 'test',
      input: 'test',
      assert: (result) => ({ pass: result.content === 'good', score: 1 }),
    };
    const runResult = createMockRunResult('good');
    const result = await matchOutput(runResult, evaluationCase);
    expect(result.pass).toBe(true);
  });

  it('returns pass with score 1 when no expectedOutput and no assert', async () => {
    const evaluationCase: EvaluationCase = {
      name: 'test',
      input: 'test',
    };
    const runResult = createMockRunResult('anything');
    const result = await matchOutput(runResult, evaluationCase);
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });
});
