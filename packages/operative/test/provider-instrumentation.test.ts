/**
 * OTel GenAI conventions coverage for `operative/providers/instrumentation`.
 *
 * Spec: the wrapped GenerateFunction emits a single CLIENT span per call,
 * following the OTel GenAI "Inference" span shape — span name
 * `{gen_ai.operation.name} {gen_ai.request.model}`, `gen_ai.operation.name`
 * = `chat`, `gen_ai.provider.name` mapped from operative's internal
 * ProviderName, and `gen_ai.usage.*` token attributes (including the
 * provider cache fields). See the mapping table in the package README
 * (`operative/instrumentation` section) for the pinned conventions version.
 */
import type { Context, Span, SpanOptions, Tracer } from '@opentelemetry/api';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { instrument } from '../src/providers/instrumentation/index.ts';
import type { ProviderName } from '../src/providers/types.ts';
import type { GenerateContext, GenerateFunction, TokenUsage } from '../src/types.ts';

function createMockSpan(
  name: string,
  options?: SpanOptions,
): Span & {
  name: string;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  ended: boolean;
  exceptions: unknown[];
} {
  const span: any = {
    name,
    attributes: { ...(options?.attributes ?? {}) } as Record<string, unknown>,
    kind: options?.kind,
    status: { code: SpanStatusCode.UNSET },
    ended: false,
    exceptions: [] as unknown[],
    setAttribute(key: string, value: unknown) {
      span.attributes[key] = value;
      return span;
    },
    setAttributes(attrs: Record<string, unknown>) {
      Object.assign(span.attributes, attrs);
      return span;
    },
    setStatus(s: { code: number; message?: string }) {
      span.status = s;
      return span;
    },
    recordException(error: unknown) {
      span.exceptions.push(error);
    },
    end() {
      span.ended = true;
    },
    isRecording() {
      return !span.ended;
    },
    spanContext() {
      return { traceId: 'test-trace', spanId: `span-${name}`, traceFlags: 1 };
    },
    addEvent() {
      return span;
    },
    updateName() {
      return span;
    },
  };
  return span;
}

function createMockTracer(): Tracer & { spans: Array<ReturnType<typeof createMockSpan>> } {
  const spans: Array<ReturnType<typeof createMockSpan>> = [];
  const tracer: any = {
    spans,
    startSpan(name: string, options?: SpanOptions, _parentContext?: Context) {
      const span = createMockSpan(name, options);
      spans.push(span);
      return span;
    },
    startActiveSpan: (() => {}) as any,
  };
  return tracer;
}

function makeContext(): GenerateContext {
  return { conversation: new Conversation(), step: 0, toolbox: createToolbox([]) };
}

describe('providers/instrumentation instrument', () => {
  it('names the span "chat {model}" and sets the required gen_ai attributes', async () => {
    const tracer = createMockTracer();
    const generate: GenerateFunction = async () => ({ content: 'hi', toolCalls: [] });
    const wrapped = instrument(generate, {
      tracer,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });

    await wrapped(makeContext());

    expect(tracer.spans).toHaveLength(1);
    const span = tracer.spans[0]!;
    expect(span.name).toBe('chat claude-sonnet-5');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes['gen_ai.operation.name']).toBe('chat');
    expect(span.attributes['gen_ai.provider.name']).toBe('anthropic');
    expect(span.attributes['gen_ai.request.model']).toBe('claude-sonnet-5');
    expect(span.ended).toBe(true);
  });

  it('maps the gemini provider to the gcp.gemini well-known value', async () => {
    const tracer = createMockTracer();
    const generate: GenerateFunction = async () => ({ content: 'hi', toolCalls: [] });
    const wrapped = instrument(generate, { tracer, provider: 'gemini', model: 'gemini-2.5-pro' });

    await wrapped(makeContext());

    expect(tracer.spans[0]?.attributes['gen_ai.provider.name']).toBe('gcp.gemini');
  });

  it('uses generate_content as the operation name and span prefix for gemini', async () => {
    const tracer = createMockTracer();
    const generate: GenerateFunction = async () => ({ content: 'hi', toolCalls: [] });
    const wrapped = instrument(generate, { tracer, provider: 'gemini', model: 'gemini-2.5-pro' });

    await wrapped(makeContext());

    const span = tracer.spans[0]!;
    expect(span.name).toBe('generate_content gemini-2.5-pro');
    expect(span.attributes['gen_ai.operation.name']).toBe('generate_content');
  });

  it.each([
    ['openai', 'openai'],
    ['voyage', 'voyage'],
    ['ollama', 'ollama'],
  ] as const)('passes %s through as a custom provider.name value', async (provider, expected) => {
    const tracer = createMockTracer();
    const generate: GenerateFunction = async () => ({ content: 'hi', toolCalls: [] });
    const wrapped = instrument(generate, {
      tracer,
      provider: provider as ProviderName,
      model: 'test-model',
    });

    await wrapped(makeContext());

    expect(tracer.spans[0]?.attributes['gen_ai.provider.name']).toBe(expected);
  });

  it('sets gen_ai.request.max_tokens only when provided', async () => {
    const tracer = createMockTracer();
    const generate: GenerateFunction = async () => ({ content: 'hi', toolCalls: [] });

    const withMax = instrument(generate, {
      tracer,
      provider: 'anthropic',
      model: 'm',
      maximumTokens: 512,
    });
    await withMax(makeContext());
    expect(tracer.spans[0]?.attributes['gen_ai.request.max_tokens']).toBe(512);

    const withoutMax = instrument(generate, { tracer, provider: 'anthropic', model: 'm' });
    await withoutMax(makeContext());
    expect('gen_ai.request.max_tokens' in tracer.spans[1]!.attributes).toBe(false);
  });

  it('reports gen_ai.usage.input_tokens and output_tokens from the response usage', async () => {
    const tracer = createMockTracer();
    const usage: TokenUsage = { prompt: 12, completion: 34, total: 46 };
    const generate: GenerateFunction = async () => ({ content: 'hi', toolCalls: [], usage });
    const wrapped = instrument(generate, { tracer, provider: 'anthropic', model: 'm' });

    await wrapped(makeContext());

    const span = tracer.spans[0]!;
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(12);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(34);
    // total_tokens is not a defined gen_ai.usage.* attribute — backends sum
    // input + output themselves, so it is intentionally not emitted.
    expect('gen_ai.usage.total_tokens' in span.attributes).toBe(false);
  });

  it('reports cache token usage when present on the response', async () => {
    const tracer = createMockTracer();
    const usage: TokenUsage = {
      prompt: 12,
      completion: 34,
      total: 46,
      cacheCreationTokens: 5,
      cacheReadTokens: 7,
    };
    const generate: GenerateFunction = async () => ({ content: 'hi', toolCalls: [], usage });
    const wrapped = instrument(generate, { tracer, provider: 'anthropic', model: 'm' });

    await wrapped(makeContext());

    const span = tracer.spans[0]!;
    expect(span.attributes['gen_ai.usage.cache_creation.input_tokens']).toBe(5);
    expect(span.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(7);
  });

  it('does not report cache token attributes when absent from the response', async () => {
    const tracer = createMockTracer();
    const usage: TokenUsage = { prompt: 12, completion: 34, total: 46 };
    const generate: GenerateFunction = async () => ({ content: 'hi', toolCalls: [], usage });
    const wrapped = instrument(generate, { tracer, provider: 'anthropic', model: 'm' });

    await wrapped(makeContext());

    const span = tracer.spans[0]!;
    expect('gen_ai.usage.cache_creation.input_tokens' in span.attributes).toBe(false);
    expect('gen_ai.usage.cache_read.input_tokens' in span.attributes).toBe(false);
  });

  it('sets ERROR status, error.type, and records the exception on failure', async () => {
    const tracer = createMockTracer();
    const generate: GenerateFunction = async () => {
      throw new TypeError('boom');
    };
    const wrapped = instrument(generate, { tracer, provider: 'anthropic', model: 'm' });

    let caught: unknown;
    try {
      await wrapped(makeContext());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);

    const span = tracer.spans[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('boom');
    expect(span.attributes['error.type']).toBe('TypeError');
    expect(span.exceptions).toHaveLength(1);
    expect(span.ended).toBe(true);
  });

  it('rethrows the original error after recording it on the span', async () => {
    const tracer = createMockTracer();
    const original = new Error('provider unavailable');
    const generate: GenerateFunction = async () => {
      throw original;
    };
    const wrapped = instrument(generate, { tracer, provider: 'anthropic', model: 'm' });

    let caught: unknown;
    try {
      await wrapped(makeContext());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(original);
  });
});
