import { describe, expect, it } from 'bun:test';

import { HeraldError } from '../errors.ts';
import type { GenerateContext, GenerateResponse } from '../types.ts';
import { createFalloverGenerate } from './create-fallover-generate.ts';
import { FalloverExhaustedError } from './errors.ts';
import type { FalloverEvent, FalloverProvider } from './types.ts';

function makeContext(overrides?: Partial<GenerateContext>): GenerateContext {
  return {
    conversation: { current: [] } as unknown as GenerateContext['conversation'],
    step: 1,
    toolbox: { tools: [], execute: async () => [] } as unknown as GenerateContext['toolbox'],
    ...overrides,
  };
}

function makeResponse(content = 'OK'): GenerateResponse {
  return { content, toolCalls: [] };
}

function makeProvider(
  name: string,
  generate: GenerateContext['signal'] extends never ? never : (...args: unknown[]) => unknown,
): FalloverProvider {
  return { name, generate: generate as unknown as FalloverProvider['generate'] };
}

describe('createFalloverGenerate', () => {
  it('returns response from primary provider when it succeeds', async () => {
    const primary = makeProvider('anthropic', async () => makeResponse('from anthropic'));
    const secondary = makeProvider('openai', async () => makeResponse('from openai'));

    const generate = createFalloverGenerate({ providers: [primary, secondary] });
    const result = await generate(makeContext());

    expect(result.content).toBe('from anthropic');
  });

  it('cascades to secondary on auth error (401)', async () => {
    const primary = makeProvider('anthropic', async () => {
      throw new HeraldError({
        provider: 'anthropic',
        cause: new Error('Unauthorized'),
        statusCode: 401,
      });
    });
    const secondary = makeProvider('openai', async () => makeResponse('from openai'));

    const generate = createFalloverGenerate({ providers: [primary, secondary] });
    const result = await generate(makeContext());

    expect(result.content).toBe('from openai');
  });

  it('cascades to secondary immediately on rate-limit error (429)', async () => {
    const primary = makeProvider('anthropic', async () => {
      throw new HeraldError({
        provider: 'anthropic',
        cause: new Error('Rate limited'),
        statusCode: 429,
      });
    });
    const secondary = makeProvider('openai', async () => makeResponse('from openai'));

    const generate = createFalloverGenerate({ providers: [primary, secondary] });
    const result = await generate(makeContext());

    expect(result.content).toBe('from openai');
  });

  it('retries on server error then cascades', async () => {
    let callCount = 0;
    const primary = makeProvider('anthropic', async () => {
      callCount++;
      throw new HeraldError({
        provider: 'anthropic',
        cause: new Error('Internal'),
        statusCode: 500,
      });
    });
    const secondary = makeProvider('openai', async () => makeResponse('from openai'));

    const generate = createFalloverGenerate({
      providers: [primary, secondary],
      retriesPerProvider: 2,
      retryDelay: 0,
    });
    const result = await generate(makeContext());

    // Primary called: 1 initial + 2 retries = 3
    expect(callCount).toBe(3);
    expect(result.content).toBe('from openai');
  });

  it('throws immediately on overflow error without cascading', async () => {
    const primary = makeProvider('anthropic', async () => {
      throw new Error('context_length_exceeded: too many tokens');
    });
    const secondary = makeProvider('openai', async () => makeResponse('from openai'));

    const generate = createFalloverGenerate({ providers: [primary, secondary] });

    try {
      await generate(makeContext());
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('context_length_exceeded');
    }
  });

  it('throws FalloverExhaustedError when all providers fail', async () => {
    const primary = makeProvider('anthropic', async () => {
      throw new HeraldError({ provider: 'anthropic', cause: new Error('Auth'), statusCode: 401 });
    });
    const secondary = makeProvider('openai', async () => {
      throw new HeraldError({ provider: 'openai', cause: new Error('Auth'), statusCode: 401 });
    });

    const generate = createFalloverGenerate({ providers: [primary, secondary] });

    try {
      await generate(makeContext());
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FalloverExhaustedError);
      const exhausted = error as FalloverExhaustedError;
      expect(exhausted.errors).toHaveLength(2);
      expect(exhausted.errors[0]!.provider).toBe('anthropic');
      expect(exhausted.errors[1]!.provider).toBe('openai');
    }
  });

  it('skips provider on cooldown', async () => {
    const primaryCalls: number[] = [];
    const primary = makeProvider('anthropic', async () => {
      primaryCalls.push(1);
      throw new HeraldError({ provider: 'anthropic', cause: new Error('Auth'), statusCode: 401 });
    });
    const secondary = makeProvider('openai', async () => makeResponse('from openai'));

    const generate = createFalloverGenerate({
      providers: [primary, secondary],
      cooldownDuration: 60_000,
    });

    // First call: primary fails with auth → cooldown → cascade to secondary
    const result1 = await generate(makeContext());
    expect(result1.content).toBe('from openai');
    expect(primaryCalls).toHaveLength(1);

    // Second call: primary on cooldown → skip directly to secondary
    const result2 = await generate(makeContext());
    expect(result2.content).toBe('from openai');
    // Primary was NOT called again because it's on cooldown
    expect(primaryCalls).toHaveLength(1);
  });

  it('fires onFallover callback when cascading', async () => {
    const events: FalloverEvent[] = [];
    const primary = makeProvider('anthropic', async () => {
      throw new HeraldError({ provider: 'anthropic', cause: new Error('Auth'), statusCode: 401 });
    });
    const secondary = makeProvider('openai', async () => makeResponse('from openai'));

    const generate = createFalloverGenerate({
      providers: [primary, secondary],
      onFallover: (event) => events.push(event),
    });

    await generate(makeContext());

    expect(events).toHaveLength(1);
    expect(events[0]!.failedProvider).toBe('anthropic');
    expect(events[0]!.nextProvider).toBe('openai');
    expect(events[0]!.errorType).toBe('auth');
  });

  it('fires onRecovery when a provider succeeds after cooldown expires', async () => {
    const recoveries: string[] = [];
    let primaryCallCount = 0;

    const primary = makeProvider('anthropic', async () => {
      primaryCallCount++;
      if (primaryCallCount === 1) {
        throw new HeraldError({
          provider: 'anthropic',
          cause: new Error('Rate limit'),
          statusCode: 429,
        });
      }
      return makeResponse('from anthropic');
    });
    const secondary = makeProvider('openai', async () => makeResponse('from openai'));

    const generate = createFalloverGenerate({
      providers: [primary, secondary],
      cooldownDuration: 1, // 1ms cooldown for testing
      onRecovery: (provider) => recoveries.push(provider),
    });

    // First call: primary fails → cooldown → cascade
    await generate(makeContext());

    // Wait for cooldown to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Second call: primary is back, succeeds
    const result = await generate(makeContext());
    expect(result.content).toBe('from anthropic');
    expect(recoveries).toContain('anthropic');
  });

  it('uses custom classifyError when provided', async () => {
    const primary = makeProvider('anthropic', async () => {
      throw new Error('custom billing error');
    });
    const secondary = makeProvider('openai', async () => makeResponse('from openai'));

    const generate = createFalloverGenerate({
      providers: [primary, secondary],
      classifyError: (error) => {
        if (error instanceof Error && error.message.includes('billing')) return 'auth';
        return 'unknown';
      },
    });

    const result = await generate(makeContext());
    expect(result.content).toBe('from openai');
  });

  it('respects AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');

    const primary = makeProvider('anthropic', async () => makeResponse('should not reach'));

    const generate = createFalloverGenerate({ providers: [primary] });

    try {
      await generate(makeContext({ signal: controller.signal }));
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it('throws AbortError before a retry attempt when the signal aborts between attempts', async () => {
    const controller = new AbortController();
    let callCount = 0;
    const primary = makeProvider('anthropic', async () => {
      callCount++;
      controller.abort();
      throw new HeraldError({
        provider: 'anthropic',
        cause: new Error('Internal'),
        statusCode: 500,
      });
    });

    const generate = createFalloverGenerate({
      providers: [primary],
      retriesPerProvider: 1,
      retryDelay: 0,
    });

    try {
      await generate(makeContext({ signal: controller.signal }));
      expect.unreachable('Expected generate() to abort');
    } catch (error) {
      expect(error).toMatchObject({ name: 'AbortError' });
    }
    expect(callCount).toBe(1);
  });

  it('rejects retry sleep immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    const primary = makeProvider('anthropic', async () => {
      controller.abort();
      throw new HeraldError({
        provider: 'anthropic',
        cause: new Error('Internal'),
        statusCode: 500,
      });
    });

    const generate = createFalloverGenerate({
      providers: [primary],
      retriesPerProvider: 1,
      retryDelay: 1,
    });

    try {
      await generate(makeContext({ signal: controller.signal }));
      expect.unreachable('Expected generate() to abort');
    } catch (error) {
      expect(error).toMatchObject({ name: 'AbortError' });
    }
  });

  it('aborts while sleeping between retries', async () => {
    const controller = new AbortController();
    const primary = makeProvider('anthropic', async () => {
      setTimeout(() => controller.abort(), 5);
      throw new HeraldError({
        provider: 'anthropic',
        cause: new Error('Internal'),
        statusCode: 500,
      });
    });

    const generate = createFalloverGenerate({
      providers: [primary],
      retriesPerProvider: 1,
      retryDelay: 50,
    });

    try {
      await generate(makeContext({ signal: controller.signal }));
      expect.unreachable('Expected generate() to abort');
    } catch (error) {
      expect(error).toMatchObject({ name: 'AbortError' });
    }
  });

  it('does not fire onFallover when no next provider is available', async () => {
    const events: FalloverEvent[] = [];
    const primary = makeProvider('anthropic', async () => {
      throw new HeraldError({ provider: 'anthropic', cause: new Error('Auth'), statusCode: 401 });
    });

    const generate = createFalloverGenerate({
      providers: [primary],
      onFallover: (event) => events.push(event),
    });

    try {
      await generate(makeContext());
      expect.unreachable('Expected generate() to exhaust all providers');
    } catch (error) {
      expect(error).toBeInstanceOf(FalloverExhaustedError);
    }
    expect(events).toEqual([]);
  });

  it('skips unavailable providers when searching for the next fallback', async () => {
    let secondaryCalls = 0;
    const primary = makeProvider('anthropic', async () => {
      throw new HeraldError({
        provider: 'anthropic',
        cause: new Error('Internal'),
        statusCode: 500,
      });
    });
    const secondary = makeProvider('openai', async () => {
      secondaryCalls++;
      throw new HeraldError({ provider: 'openai', cause: new Error('Auth'), statusCode: 401 });
    });
    const tertiary = makeProvider('gemini', async () => makeResponse('from gemini'));
    const events: FalloverEvent[] = [];

    const generate = createFalloverGenerate({
      providers: [primary, secondary, tertiary],
      retriesPerProvider: 0,
      cooldownDuration: 60_000,
      onFallover: (event) => events.push(event),
    });

    await generate(makeContext());
    const result = await generate(makeContext());

    expect(result.content).toBe('from gemini');
    expect(secondaryCalls).toBe(1);
    expect(events.at(-1)?.nextProvider).toBe('gemini');
  });

  it('retries once for network errors then cascades', async () => {
    let callCount = 0;
    const primary = makeProvider('anthropic', async () => {
      callCount++;
      throw new TypeError('fetch failed');
    });
    const secondary = makeProvider('openai', async () => makeResponse('from openai'));

    const generate = createFalloverGenerate({
      providers: [primary, secondary],
      retriesPerProvider: 1,
      retryDelay: 0,
    });

    const result = await generate(makeContext());

    // 1 initial + 1 retry = 2 calls
    expect(callCount).toBe(2);
    expect(result.content).toBe('from openai');
  });

  it('cascades immediately on unknown errors', async () => {
    let primaryCalls = 0;
    const primary = makeProvider('anthropic', async () => {
      primaryCalls++;
      throw new Error('something unexpected');
    });
    const secondary = makeProvider('openai', async () => makeResponse('from openai'));

    const generate = createFalloverGenerate({
      providers: [primary, secondary],
      retriesPerProvider: 3,
      retryDelay: 0,
    });

    const result = await generate(makeContext());

    // Unknown errors skip to next immediately — no retries
    expect(primaryCalls).toBe(1);
    expect(result.content).toBe('from openai');
  });
});
