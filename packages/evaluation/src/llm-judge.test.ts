import { describe, expect, it } from 'bun:test';
import type { GenerateFunction } from 'operative';

import { createLLMJudge } from './llm-judge';

/**
 * Creates a mock generate function that returns a fixed response containing
 * a JSON block with `score` and `reasoning` fields, simulating an LLM judge.
 */
function createMockJudgeGenerate(score: number, reasoning: string): GenerateFunction {
  return async () => ({
    content: JSON.stringify({ score, reasoning }),
    toolCalls: [],
    usage: { prompt: 50, completion: 20, total: 70 },
  });
}

describe('createLLMJudge', () => {
  it('returns a score and reasoning from the judge', async () => {
    const judge = createLLMJudge({
      judge: createMockJudgeGenerate(4, 'Good answer with relevant details'),
      rubric: 'Rate accuracy and completeness',
    });

    const result = await judge(
      'What is TypeScript?',
      'TypeScript is a typed superset of JavaScript',
    );

    expect(result.score).toBe(4);
    expect(result.reasoning).toBe('Good answer with relevant details');
  });

  it('normalizes the score to the configured scale', async () => {
    const judge = createLLMJudge({
      judge: createMockJudgeGenerate(8, 'Very good'),
      rubric: 'Rate quality',
      scale: { min: 1, max: 10 },
    });

    const result = await judge('question', 'answer');

    expect(result.score).toBe(8);
  });

  it('uses default 1-5 scale when none is provided', async () => {
    const judge = createLLMJudge({
      judge: createMockJudgeGenerate(3, 'Average'),
      rubric: 'Rate quality',
    });

    const result = await judge('question', 'answer');

    expect(result.score).toBe(3);
  });

  it('includes the rubric in the prompt sent to the judge', async () => {
    let capturedPrompt = '';
    const mockGenerate: GenerateFunction = async (context) => {
      const messages = context.conversation.getMessages();
      for (const message of messages) {
        if (message.role === 'system' || message.role === 'user') {
          capturedPrompt +=
            (typeof message.content === 'string'
              ? message.content
              : JSON.stringify(message.content)) + '\n';
        }
      }
      return {
        content: JSON.stringify({ score: 3, reasoning: 'ok' }),
        toolCalls: [],
      };
    };

    const judge = createLLMJudge({
      judge: mockGenerate,
      rubric: 'Evaluate for factual accuracy and completeness',
    });

    await judge('question', 'answer');

    expect(capturedPrompt).toContain('Evaluate for factual accuracy and completeness');
  });

  it('includes the reference answer in the prompt when provided', async () => {
    let capturedPrompt = '';
    const mockGenerate: GenerateFunction = async (context) => {
      const messages = context.conversation.getMessages();
      for (const message of messages) {
        if (message.role === 'system' || message.role === 'user') {
          capturedPrompt +=
            (typeof message.content === 'string'
              ? message.content
              : JSON.stringify(message.content)) + '\n';
        }
      }
      return {
        content: JSON.stringify({ score: 4, reasoning: 'matches reference' }),
        toolCalls: [],
      };
    };

    const judge = createLLMJudge({
      judge: mockGenerate,
      rubric: 'Rate accuracy',
    });

    await judge('What is 2+2?', 'The answer is 4', 'The answer is 4');

    expect(capturedPrompt).toContain('The answer is 4');
  });

  it('returns score 0 with error message when the judge throws', async () => {
    const failingGenerate: GenerateFunction = async () => {
      throw new Error('LLM service unavailable');
    };

    const judge = createLLMJudge({
      judge: failingGenerate,
      rubric: 'Rate quality',
    });

    const result = await judge('question', 'answer');

    expect(result.score).toBe(0);
    expect(result.reasoning).toContain('LLM service unavailable');
  });

  it('returns score 0 when the judge returns unparseable output', async () => {
    const badOutputGenerate: GenerateFunction = async () => ({
      content: 'This is not JSON at all',
      toolCalls: [],
    });

    const judge = createLLMJudge({
      judge: badOutputGenerate,
      rubric: 'Rate quality',
    });

    const result = await judge('question', 'answer');

    expect(result.score).toBe(0);
    expect(result.reasoning).toContain('parse');
  });

  it('clamps scores that exceed the scale maximum', async () => {
    const judge = createLLMJudge({
      judge: createMockJudgeGenerate(10, 'Overscored'),
      rubric: 'Rate quality',
      scale: { min: 1, max: 5 },
    });

    const result = await judge('question', 'answer');

    expect(result.score).toBe(5);
  });

  it('clamps scores that fall below the scale minimum', async () => {
    const judge = createLLMJudge({
      judge: createMockJudgeGenerate(-1, 'Underscored'),
      rubric: 'Rate quality',
      scale: { min: 1, max: 5 },
    });

    const result = await judge('question', 'answer');

    expect(result.score).toBe(1);
  });
});
