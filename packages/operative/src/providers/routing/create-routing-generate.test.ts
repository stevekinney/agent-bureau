import { describe, expect, it } from 'bun:test';

import {
  readBackendDescriptors,
  withBackendDescriptors,
} from '../backend-descriptor-attachment.ts';
import type { BackendDescriptor } from '../model-catalog.ts';
import { createModelCatalog } from '../model-catalog.ts';
import type { GenerateContext, GenerateFunction, GenerateResponse } from '../types.ts';
import { createRoutingGenerate } from './create-routing-generate.ts';
import { makeContext } from './strategies/test-helpers.ts';
import type { ModelRoute, RoutingEvent } from './types.ts';

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

  it('AB-67: a steering route override wins over the strategy without calling it', async () => {
    let strategyCalled = false;

    const generate = createRoutingGenerate({
      routes: [makeRoute('fast', 'fast-response'), makeRoute('smart', 'smart-response')],
      strategy: () => {
        strategyCalled = true;
        return { route: 'fast', reason: 'test' };
      },
      fallback: 'fast',
    });

    const context = makeContext({
      steering: { paused: false, configVersion: 1, route: 'smart' },
    });
    const result = await generate(context);

    expect(result.content).toBe('smart-response');
    expect(strategyCalled).toBe(false);
  });

  it('AB-67: a steering route override that names no configured route falls back, like an unknown strategy route', async () => {
    const generate = createRoutingGenerate({
      routes: [makeRoute('fast', 'fast-response')],
      strategy: () => ({ route: 'fast', reason: 'test' }),
      fallback: 'fast',
    });

    const context = makeContext({
      steering: { paused: false, configVersion: 1, route: 'nonexistent' },
    });
    const result = await generate(context);

    expect(result.content).toBe('fast-response');
  });

  it('AB-67: onRoute reports the steering-overridden route with a steering-attributed reason', async () => {
    const events: RoutingEvent[] = [];

    const generate = createRoutingGenerate({
      routes: [makeRoute('fast', 'fast-response'), makeRoute('smart', 'smart-response')],
      strategy: () => ({ route: 'fast', reason: 'strategy pick' }),
      fallback: 'fast',
      onRoute: (event) => events.push(event),
    });

    await generate(makeContext({ steering: { paused: false, configVersion: 1, route: 'smart' } }));

    expect(events).toHaveLength(1);
    expect(events[0]!.selectedRoute).toBe('smart');
    expect(events[0]!.reason).toContain('steering');
  });

  it('AB-67: an empty-string steering route override is honored, not treated as absent', async () => {
    let strategyCalled = false;

    const generate = createRoutingGenerate({
      routes: [makeRoute('', 'empty-name-route-response'), makeRoute('fast', 'fast-response')],
      strategy: () => {
        strategyCalled = true;
        return { route: 'fast', reason: 'test' };
      },
      fallback: 'fast',
    });

    const context = makeContext({ steering: { paused: false, configVersion: 1, route: '' } });
    const result = await generate(context);

    expect(result.content).toBe('empty-name-route-response');
    expect(strategyCalled).toBe(false);
  });

  it('no steering field on the context is a no-op: the strategy decides exactly as it does today', async () => {
    const generate = createRoutingGenerate({
      routes: [makeRoute('fast', 'fast-response'), makeRoute('smart', 'smart-response')],
      strategy: () => ({ route: 'smart', reason: 'test' }),
      fallback: 'fast',
    });

    const result = await generate(makeContext());
    expect(result.content).toBe('smart-response');
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

describe('createRoutingGenerate — descriptor union (AB-64 AC2, AB-245)', () => {
  const FIXED_NOW = () => '2026-09-02T12:00:00.000Z';

  function descriptorsFor(
    provider: 'anthropic' | 'openai' | 'gemini',
  ): readonly BackendDescriptor[] {
    return createModelCatalog({ now: FIXED_NOW }).descriptors.filter(
      (descriptor) => descriptor.provider === provider,
    );
  }

  function routeWithDescriptors(
    name: string,
    content: string,
    descriptors: readonly BackendDescriptor[],
  ): ModelRoute {
    return { name, generate: withBackendDescriptors(makeGenerate(content), descriptors) };
  }

  it('attaches no descriptors when no route carries any', () => {
    const generate = createRoutingGenerate({
      routes: [makeRoute('fast', 'fast-response')],
      strategy: () => ({ route: 'fast', reason: 'test' }),
      fallback: 'fast',
    });

    expect(readBackendDescriptors(generate)).toEqual([]);
  });

  it('attaches the union of every route’s descriptors', () => {
    const anthropic = descriptorsFor('anthropic')[0];
    const openai = descriptorsFor('openai')[0];
    if (!anthropic || !openai)
      throw new Error('expected seed descriptors for anthropic and openai');

    const generate = createRoutingGenerate({
      routes: [
        routeWithDescriptors('fast', 'fast-response', [openai]),
        routeWithDescriptors('smart', 'smart-response', [anthropic]),
      ],
      strategy: () => ({ route: 'smart', reason: 'test' }),
      fallback: 'fast',
    });

    const attached = readBackendDescriptors(generate);
    expect(attached).toHaveLength(2);
    expect(attached).toContainEqual(anthropic);
    expect(attached).toContainEqual(openai);
  });

  it('deduplicates by (provider, endpoint, model) across routes sharing the same descriptor', () => {
    const anthropic = descriptorsFor('anthropic')[0];
    if (!anthropic) throw new Error('expected at least one anthropic seed descriptor');

    const generate = createRoutingGenerate({
      routes: [
        routeWithDescriptors('a', 'a-response', [anthropic]),
        routeWithDescriptors('b', 'b-response', [anthropic]),
      ],
      strategy: () => ({ route: 'a', reason: 'test' }),
      fallback: 'a',
    });

    expect(readBackendDescriptors(generate)).toEqual([anthropic]);
  });

  it('orders the union deterministically by (provider, endpoint, model) regardless of route declaration order', () => {
    const anthropic = descriptorsFor('anthropic')[0];
    const gemini = descriptorsFor('gemini')[0];
    if (!anthropic || !gemini)
      throw new Error('expected seed descriptors for anthropic and gemini');

    const forward = createRoutingGenerate({
      routes: [
        routeWithDescriptors('a', 'a-response', [gemini]),
        routeWithDescriptors('b', 'b-response', [anthropic]),
      ],
      strategy: () => ({ route: 'a', reason: 'test' }),
      fallback: 'a',
    });
    const reversed = createRoutingGenerate({
      routes: [
        routeWithDescriptors('b', 'b-response', [anthropic]),
        routeWithDescriptors('a', 'a-response', [gemini]),
      ],
      strategy: () => ({ route: 'a', reason: 'test' }),
      fallback: 'a',
    });

    expect(readBackendDescriptors(forward)).toEqual(readBackendDescriptors(reversed));
    expect(readBackendDescriptors(forward)[0]?.provider).toBe('anthropic');
  });

  it('resolves a same-triple collision to the same, conservative descriptor regardless of route order', () => {
    // Two OpenAI routes for the identical model, one constructed with a
    // proxying baseURL — same (provider, endpoint, model) triple, different
    // endpointAmbiguous/capability content. The union must pick the same
    // (ambiguous, conservative) descriptor no matter which route is declared
    // first — never the one that merely happened to be inserted first.
    const catalog = createModelCatalog({ now: FIXED_NOW });
    const official = catalog.descriptors.find((d) => d.provider === 'openai');
    if (!official) throw new Error('expected at least one openai seed descriptor');
    const ambiguousCatalog = createModelCatalog({
      now: FIXED_NOW,
      openAIBaseURL: 'https://proxy.internal.example/v1',
    });
    const ambiguous = ambiguousCatalog.descriptors.find(
      (d) => d.provider === 'openai' && d.model === official.model,
    );
    if (!ambiguous) throw new Error('expected a matching ambiguous openai descriptor');
    expect(ambiguous.endpointAmbiguous).toBe(true);
    expect(official.endpointAmbiguous).not.toBe(true);

    const officialFirst = createRoutingGenerate({
      routes: [
        routeWithDescriptors('official', 'official-response', [official]),
        routeWithDescriptors('proxy', 'proxy-response', [ambiguous]),
      ],
      strategy: () => ({ route: 'official', reason: 'test' }),
      fallback: 'official',
    });
    const ambiguousFirst = createRoutingGenerate({
      routes: [
        routeWithDescriptors('proxy', 'proxy-response', [ambiguous]),
        routeWithDescriptors('official', 'official-response', [official]),
      ],
      strategy: () => ({ route: 'official', reason: 'test' }),
      fallback: 'official',
    });

    const officialFirstDescriptors = readBackendDescriptors(officialFirst);
    const ambiguousFirstDescriptors = readBackendDescriptors(ambiguousFirst);
    expect(officialFirstDescriptors).toEqual(ambiguousFirstDescriptors);
    expect(officialFirstDescriptors).toHaveLength(1);
    expect(officialFirstDescriptors[0]?.endpointAmbiguous).toBe(true);
  });
});
