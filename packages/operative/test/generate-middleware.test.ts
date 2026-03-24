import { describe, expect, it } from 'bun:test';

import { composeGenerate, createFallbackGenerate } from '../src/generate-middleware';
import type {
  GenerateContext,
  GenerateFunction,
  GenerateMiddleware,
  GenerateResponse,
} from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function createMockContext(overrides: Partial<GenerateContext> = {}): GenerateContext {
  return {
    conversation: {} as never,
    step: 0,
    toolbox: {} as never,
    ...overrides,
  };
}

describe('composeGenerate', () => {
  it('with zero middleware returns base unchanged', async () => {
    const base: GenerateFunction = async () => textResponse('base');
    const composed = composeGenerate(base);

    const result = await composed(createMockContext());
    expect(result.content).toBe('base');
  });

  it('with two middleware applies correct order (outermost first)', async () => {
    const log: string[] = [];

    const base: GenerateFunction = async () => {
      log.push('base');
      return textResponse('base');
    };

    const outer: GenerateMiddleware = (next) => async (context) => {
      log.push('outer-before');
      const result = await next(context);
      log.push('outer-after');
      return { ...result, content: `outer(${result.content})` };
    };

    const inner: GenerateMiddleware = (next) => async (context) => {
      log.push('inner-before');
      const result = await next(context);
      log.push('inner-after');
      return { ...result, content: `inner(${result.content})` };
    };

    const composed = composeGenerate(base, outer, inner);
    const result = await composed(createMockContext());

    expect(result.content).toBe('outer(inner(base))');
    expect(log).toEqual(['outer-before', 'inner-before', 'base', 'inner-after', 'outer-after']);
  });

  it('middleware can short-circuit (return without calling next)', async () => {
    const base: GenerateFunction = async () => textResponse('should not reach');

    const shortCircuit: GenerateMiddleware = (_next) => async () => {
      return textResponse('short-circuited');
    };

    const composed = composeGenerate(base, shortCircuit);
    const result = await composed(createMockContext());
    expect(result.content).toBe('short-circuited');
  });

  it('middleware can transform context before and response after next', async () => {
    const base: GenerateFunction = async (context) => {
      return textResponse(`step-${context.step}`);
    };

    const transform: GenerateMiddleware = (next) => async (context) => {
      const modified = { ...context, step: context.step + 10 };
      const result = await next(modified);
      return { ...result, content: result.content.toUpperCase() };
    };

    const composed = composeGenerate(base, transform);
    const result = await composed(createMockContext({ step: 5 }));
    expect(result.content).toBe('STEP-15');
  });
});

describe('createFallbackGenerate', () => {
  it('uses primary when it succeeds', async () => {
    const primary: GenerateFunction = async () => textResponse('primary');
    const fallback: GenerateFunction = async () => textResponse('fallback');

    const generate = createFallbackGenerate({ providers: [primary, fallback] });
    const result = await generate(createMockContext());
    expect(result.content).toBe('primary');
  });

  it('falls back on error', async () => {
    const primary: GenerateFunction = async () => {
      throw new Error('primary failed');
    };
    const fallback: GenerateFunction = async () => textResponse('fallback');

    const generate = createFallbackGenerate({ providers: [primary, fallback] });
    const result = await generate(createMockContext());
    expect(result.content).toBe('fallback');
  });

  it('shouldFallback predicate returning false skips fallback', async () => {
    const primary: GenerateFunction = async () => {
      throw new Error('auth error');
    };
    const fallback: GenerateFunction = async () => textResponse('fallback');

    const generate = createFallbackGenerate({
      providers: [primary, fallback],
      shouldFallback: (error) => {
        return !(error instanceof Error && error.message === 'auth error');
      },
    });

    await expect(generate(createMockContext())).rejects.toThrow('auth error');
  });

  it('throws last error when all providers fail', async () => {
    const first: GenerateFunction = async () => {
      throw new Error('first failed');
    };
    const second: GenerateFunction = async () => {
      throw new Error('second failed');
    };

    const generate = createFallbackGenerate({ providers: [first, second] });
    await expect(generate(createMockContext())).rejects.toThrow('second failed');
  });

  it('empty providers array throws immediately', () => {
    expect(() => createFallbackGenerate({ providers: [] })).toThrow(
      'createFallbackGenerate requires at least one provider',
    );
  });
});
