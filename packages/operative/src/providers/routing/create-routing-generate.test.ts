import { describe, expect, it } from 'bun:test';

import type { GenerateContext, GenerateFunction, GenerateResponse } from '../types.ts';
import { createRoutingGenerate } from './create-routing-generate.ts';
import type { ModelRoute, RoutingEvent } from './types.ts';

function makeContext(overrides?: Partial<GenerateContext>): GenerateContext {
  return {
    conversation: {
      current: { ids: [], messages: {} },
    } as unknown as GenerateContext['conversation'],
    step: 0,
    toolbox: { tools: () => [] } as unknown as GenerateContext['toolbox'],
    ...overrides,
  };
}

function makeResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function makeGenerate(content: string): GenerateFunction {
  return async () => makeResponse(content);
}

function makeRoute(name: string, content: string): ModelRoute {
  return { name, generate: makeGenerate(content) };
}

describe('createRoutingGenerate', () => {
  it('calls the strategy and routes to the selected model', async () => {
    const generate = createRoutingGenerate({
      routes: [makeRoute('fast', 'fast-response'), makeRoute('smart', 'smart-response')],
      strategy: () => ({ route: 'smart', reason: 'test' }),
      fallback: 'fast',
    });

    const result = await generate(makeContext());
    expect(result.content).toBe('smart-response');
  });

  it('uses fallback route when strategy returns unknown route', async () => {
    const generate = createRoutingGenerate({
      routes: [makeRoute('fast', 'fast-response'), makeRoute('smart', 'smart-response')],
      strategy: () => ({ route: 'nonexistent', reason: 'miss' }),
      fallback: 'fast',
    });

    const result = await generate(makeContext());
    expect(result.content).toBe('fast-response');
  });

  it('passes context through to the selected generate function', async () => {
    let capturedContext: GenerateContext | undefined;

    const routes: ModelRoute[] = [
      {
        name: 'fast',
        generate: async (ctx) => {
          capturedContext = ctx;
          return makeResponse('ok');
        },
      },
    ];

    const generate = createRoutingGenerate({
      routes,
      strategy: () => ({ route: 'fast', reason: 'test' }),
      fallback: 'fast',
    });

    const context = makeContext({ step: 42 });
    await generate(context);

    expect(capturedContext).toBeDefined();
    expect(capturedContext!.step).toBe(42);
  });

  it('calls onRoute callback when provided', async () => {
    const events: RoutingEvent[] = [];

    const generate = createRoutingGenerate({
      routes: [makeRoute('fast', 'fast-response')],
      strategy: () => ({ route: 'fast', reason: 'simple task' }),
      fallback: 'fast',
      onRoute: (event) => events.push(event),
    });

    const context = makeContext({ step: 3 });
    await generate(context);

    expect(events).toHaveLength(1);
    expect(events[0]!.selectedRoute).toBe('fast');
    expect(events[0]!.reason).toBe('simple task');
    expect(events[0]!.step).toBe(3);
  });

  it('returns the response unchanged from the selected route', async () => {
    const routes: ModelRoute[] = [
      {
        name: 'smart',
        generate: async () => ({
          content: 'detailed answer',
          toolCalls: [{ name: 'tool1', arguments: { key: 'value' } }],
          usage: { prompt: 100, completion: 50, total: 150 },
        }),
      },
    ];

    const generate = createRoutingGenerate({
      routes,
      strategy: () => ({ route: 'smart', reason: 'test' }),
      fallback: 'smart',
    });

    const result = await generate(makeContext());
    expect(result.content).toBe('detailed answer');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('tool1');
    expect(result.usage).toEqual({ prompt: 100, completion: 50, total: 150 });
  });

  it('throws when fallback route does not exist', async () => {
    const generate = createRoutingGenerate({
      routes: [makeRoute('fast', 'fast-response')],
      strategy: () => ({ route: 'nonexistent', reason: 'miss' }),
      fallback: 'also-nonexistent',
    });

    try {
      await generate(makeContext());
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('also-nonexistent');
    }
  });

  it('passes routes to the strategy function', async () => {
    let routeNames: string[] = [];

    const generate = createRoutingGenerate({
      routes: [makeRoute('fast', 'fast'), makeRoute('smart', 'smart')],
      strategy: (_ctx, routes) => {
        routeNames = routes.map((r) => r.name);
        return { route: 'fast', reason: 'test' };
      },
      fallback: 'fast',
    });

    await generate(makeContext());
    expect(routeNames).toEqual(['fast', 'smart']);
  });

  it('propagates errors from the selected generate function', async () => {
    const routes: ModelRoute[] = [
      {
        name: 'failing',
        generate: async () => {
          throw new Error('LLM API failed');
        },
      },
    ];

    const generate = createRoutingGenerate({
      routes,
      strategy: () => ({ route: 'failing', reason: 'test' }),
      fallback: 'failing',
    });

    try {
      await generate(makeContext());
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('LLM API failed');
    }
  });
});
