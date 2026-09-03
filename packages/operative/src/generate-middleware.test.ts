/**
 * `createFallbackGenerate` backend-descriptor propagation (AB-64 AC2,
 * AB-245, AB-288): the ordered union of every candidate's attached
 * descriptors, deduplicated by `(provider, endpoint, model)`.
 */
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createAgent } from './create-agent';
import { composeGenerate, createFallbackGenerate } from './generate-middleware';
import { readGenerationProfile } from './generation-profile';
import {
  readBackendDescriptors,
  withBackendDescriptors,
} from './providers/backend-descriptor-attachment';
import type { BackendDescriptor } from './providers/model-catalog';
import { createModelCatalog } from './providers/model-catalog';
import type { GenerateContext, GenerateFunction, GenerateMiddleware } from './types';

const FIXED_NOW = () => '2026-09-02T12:00:00.000Z';

function descriptorFor(provider: 'anthropic' | 'openai' | 'gemini'): BackendDescriptor {
  const descriptor = createModelCatalog({ now: FIXED_NOW }).descriptors.find(
    (row) => row.provider === provider,
  );
  if (!descriptor)
    throw new Error(`expected at least one ${provider} descriptor in the seed catalog`);
  return descriptor;
}

function makeContext(): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createTestToolbox([]),
  };
}

function generateWith(
  content: string,
  descriptors: readonly BackendDescriptor[] = [],
): GenerateFunction {
  return withBackendDescriptors(async () => ({ content, toolCalls: [] }), descriptors);
}

describe('composeGenerate', () => {
  it('applies middleware right-to-left, first in the list wrapping outermost', async () => {
    const order: string[] = [];
    const outer: GenerateMiddleware = (next) => async (context) => {
      order.push('outer-before');
      const result = await next(context);
      order.push('outer-after');
      return result;
    };
    const inner: GenerateMiddleware = (next) => async (context) => {
      order.push('inner-before');
      const result = await next(context);
      order.push('inner-after');
      return result;
    };

    const generate = composeGenerate(generateWith('base'), outer, inner);
    const result = await generate(makeContext());

    expect(result.content).toBe('base');
    expect(order).toEqual(['outer-before', 'inner-before', 'inner-after', 'outer-after']);
  });

  it('returns the base function unchanged when no middleware is given', async () => {
    const base = generateWith('base');
    const generate = composeGenerate(base);

    expect(await generate(makeContext())).toEqual(await base(makeContext()));
  });
});

describe('createFallbackGenerate — error handling', () => {
  it('requires at least one provider', () => {
    expect(() => createFallbackGenerate({ providers: [] })).toThrow(
      'createFallbackGenerate requires at least one provider',
    );
  });

  it('falls back to the next provider when shouldFallback allows it', async () => {
    const failing = withBackendDescriptors(async () => {
      throw new Error('boom');
    }, []);
    const generate = createFallbackGenerate({ providers: [failing, generateWith('secondary')] });

    const result = await generate(makeContext());

    expect(result.content).toBe('secondary');
  });

  it('rethrows immediately when shouldFallback returns false', async () => {
    const failing: GenerateFunction = async () => {
      throw new Error('boom');
    };
    const generate = createFallbackGenerate({
      providers: [failing, generateWith('secondary')],
      shouldFallback: () => false,
    });

    expect(generate(makeContext())).rejects.toThrow('boom');
  });

  it('throws the last error when every provider is exhausted', async () => {
    const failingA: GenerateFunction = async () => {
      throw new Error('boom-a');
    };
    const failingB: GenerateFunction = async () => {
      throw new Error('boom-b');
    };
    const generate = createFallbackGenerate({ providers: [failingA, failingB] });

    expect(generate(makeContext())).rejects.toThrow('boom-b');
  });
});

describe('createFallbackGenerate — backend-descriptor propagation', () => {
  it('attaches no descriptors when no provider carries any', () => {
    const generate = createFallbackGenerate({ providers: [generateWith('a'), generateWith('b')] });

    expect(readBackendDescriptors(generate)).toEqual([]);
  });

  it("attaches the ordered union of every provider's descriptors, deduplicated by (provider, endpoint, model)", () => {
    const anthropic = descriptorFor('anthropic');
    const openai = descriptorFor('openai');

    const generate = createFallbackGenerate({
      providers: [generateWith('a', [anthropic]), generateWith('b', [anthropic, openai])],
    });

    const attached = readBackendDescriptors(generate);
    expect(attached).toHaveLength(2);
    expect([...attached].sort((x, y) => (x.provider < y.provider ? -1 : 1))).toEqual(
      [anthropic, openai].sort((x, y) => (x.provider < y.provider ? -1 : 1)),
    );
  });

  it("reports a routed generation profile, not opaque, for an Agent whose generate is the wrapper's output", () => {
    const anthropic = descriptorFor('anthropic');
    const openai = descriptorFor('openai');

    const wrapped = createFallbackGenerate({
      providers: [generateWith('a', [anthropic]), generateWith('b', [openai])],
    });

    const agent = createAgent({ generate: wrapped });

    expect(readGenerationProfile(agent).mode).toBe('routed');
  });

  it('still dispatches to providers in order after wrapping', async () => {
    const generate = createFallbackGenerate({
      providers: [generateWith('primary'), generateWith('secondary')],
    });

    const result = await generate(makeContext());

    expect(result.content).toBe('primary');
  });
});
