import type { Span, Tracer } from '@opentelemetry/api';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { instrument } from '../src/instrumentation/index.ts';
import type { GenerateContext, GenerateResponse } from '../src/types.ts';

function createMockSpan(): Span & {
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  events: Array<{ name: string; attributes?: Record<string, unknown> }>;
  ended: boolean;
  exceptions: unknown[];
} {
  const span = {
    attributes: {} as Record<string, unknown>,
    status: { code: SpanStatusCode.UNSET } as { code: number; message?: string },
    events: [] as Array<{ name: string; attributes?: Record<string, unknown> }>,
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
    setStatus(status: { code: number; message?: string }) {
      span.status = status;
      return span;
    },
    addEvent(name: string, attributes?: Record<string, unknown>) {
      span.events.push({ name, attributes });
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
      return { traceId: 'test-trace', spanId: 'test-span', traceFlags: 1 };
    },
    updateName() {
      return span;
    },
  };
  return span as Span & typeof span;
}

function createMockTracer(): Tracer & {
  spans: Array<{ name: string; options: unknown; span: ReturnType<typeof createMockSpan> }>;
} {
  const spans: Array<{
    name: string;
    options: unknown;
    span: ReturnType<typeof createMockSpan>;
  }> = [];
  return {
    spans,
    startSpan(name: string, options?: unknown) {
      const span = createMockSpan();
      spans.push({ name, options, span });
      return span;
    },
    startActiveSpan: (() => {}) as Tracer['startActiveSpan'],
  } as Tracer & { spans: typeof spans };
}

function createTestContext(): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createToolbox([]),
  };
}

function createTestResponse(overrides: Partial<GenerateResponse> = {}): GenerateResponse {
  return {
    content: 'test response',
    toolCalls: [],
    ...overrides,
  };
}

describe('instrument', () => {
  it('creates a span with the correct name, kind, and gen_ai attributes', async () => {
    const tracer = createMockTracer();
    const inner = async () => createTestResponse();

    const wrapped = instrument(inner, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      tracer,
    });

    await wrapped(createTestContext());

    expect(tracer.spans).toHaveLength(1);

    const { name, options, span } = tracer.spans[0];
    expect(name).toBe('gen_ai.generate anthropic');
    expect((options as Record<string, unknown>).kind).toBe(SpanKind.CLIENT);

    const attrs = (options as Record<string, Record<string, unknown>>).attributes;
    expect(attrs['gen_ai.system']).toBe('herald');
    expect(attrs['gen_ai.provider']).toBe('anthropic');
    expect(attrs['gen_ai.request.model']).toBe('claude-sonnet-4-20250514');
  });

  it('sets gen_ai.request.max_tokens when maximumTokens is provided', async () => {
    const tracer = createMockTracer();
    const inner = async () => createTestResponse();

    const wrapped = instrument(inner, {
      provider: 'openai',
      model: 'gpt-4o',
      maximumTokens: 4096,
      tracer,
    });

    await wrapped(createTestContext());

    const attrs = (tracer.spans[0].options as Record<string, Record<string, unknown>>).attributes;
    expect(attrs['gen_ai.request.max_tokens']).toBe(4096);
  });

  it('omits gen_ai.request.max_tokens when maximumTokens is undefined', async () => {
    const tracer = createMockTracer();
    const inner = async () => createTestResponse();

    const wrapped = instrument(inner, {
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      tracer,
    });

    await wrapped(createTestContext());

    const attrs = (tracer.spans[0].options as Record<string, Record<string, unknown>>).attributes;
    expect(attrs['gen_ai.request.max_tokens']).toBeUndefined();
  });

  it('passes the response through unchanged', async () => {
    const tracer = createMockTracer();
    const expectedResponse: GenerateResponse = {
      content: 'hello world',
      toolCalls: [{ id: 'tc-1', name: 'greet', arguments: { who: 'world' } }],
      usage: { prompt: 10, completion: 20, total: 30 },
      metadata: { stopReason: 'end_turn' },
    };
    const inner = async () => expectedResponse;

    const wrapped = instrument(inner, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      tracer,
    });

    const result = await wrapped(createTestContext());

    expect(result).toBe(expectedResponse);
  });

  it('sets usage attributes from GenerateResponse.usage', async () => {
    const tracer = createMockTracer();
    const inner = async () =>
      createTestResponse({
        usage: { prompt: 100, completion: 200, total: 300 },
      });

    const wrapped = instrument(inner, {
      provider: 'openai',
      model: 'gpt-4o',
      tracer,
    });

    await wrapped(createTestContext());

    const { span } = tracer.spans[0];
    expect(span.attributes['gen_ai.response.prompt_tokens']).toBe(100);
    expect(span.attributes['gen_ai.response.completion_tokens']).toBe(200);
    expect(span.attributes['gen_ai.response.total_tokens']).toBe(300);
  });

  it('omits usage attributes when usage is undefined', async () => {
    const tracer = createMockTracer();
    const inner = async () => createTestResponse({ usage: undefined });

    const wrapped = instrument(inner, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      tracer,
    });

    await wrapped(createTestContext());

    const { span } = tracer.spans[0];
    expect(span.attributes['gen_ai.response.prompt_tokens']).toBeUndefined();
    expect(span.attributes['gen_ai.response.completion_tokens']).toBeUndefined();
    expect(span.attributes['gen_ai.response.total_tokens']).toBeUndefined();
  });

  it('sets ERROR status, records exception, ends span, and re-throws on error', async () => {
    const tracer = createMockTracer();
    const thrownError = new Error('LLM call failed');
    const inner = async () => {
      throw thrownError;
    };

    const wrapped = instrument(inner, {
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      tracer,
    });

    let caughtError: unknown;
    try {
      await wrapped(createTestContext());
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(thrownError);

    const { span } = tracer.spans[0];
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('LLM call failed');
    expect(span.exceptions).toHaveLength(1);
    expect(span.exceptions[0]).toBe(thrownError);
    expect(span.ended).toBe(true);
  });

  it('falls back to trace.getTracer() when no tracer option is provided', async () => {
    const inner = async () => createTestResponse();

    // This should not throw — it will use the global no-op tracer
    const wrapped = instrument(inner, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });

    const result = await wrapped(createTestContext());
    expect(result.content).toBe('test response');
  });

  it('passes the identical GenerateContext to the inner function', async () => {
    const tracer = createMockTracer();
    let receivedContext: GenerateContext | undefined;
    const inner = async (context: GenerateContext) => {
      receivedContext = context;
      return createTestResponse();
    };

    const wrapped = instrument(inner, {
      provider: 'openai',
      model: 'gpt-4o',
      tracer,
    });

    const context = createTestContext();
    await wrapped(context);

    expect(receivedContext).toBe(context);
  });

  it('creates independent spans for multiple calls', async () => {
    const tracer = createMockTracer();
    let callCount = 0;
    const inner = async () => {
      callCount++;
      return createTestResponse({ content: `response ${callCount}` });
    };

    const wrapped = instrument(inner, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      tracer,
    });

    const result1 = await wrapped(createTestContext());
    const result2 = await wrapped(createTestContext());

    expect(tracer.spans).toHaveLength(2);
    expect(result1.content).toBe('response 1');
    expect(result2.content).toBe('response 2');

    expect(tracer.spans[0].span.ended).toBe(true);
    expect(tracer.spans[1].span.ended).toBe(true);

    // Spans are distinct objects
    expect(tracer.spans[0].span).not.toBe(tracer.spans[1].span);
  });
});
