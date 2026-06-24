import type {
  Context as OpenTelemetryContext,
  Link as OpenTelemetrySpanLink,
  Span,
  SpanOptions,
  Tracer,
} from '@opentelemetry/api';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createToolbox } from '../src/create-toolbox';
import { instrument } from '../src/instrumentation';

function createMockSpan(): Span & {
  attributes: Record<string, unknown>;
  ended: boolean;
  events: Array<{ name: string; attributes?: Record<string, unknown> }>;
  status: { code: SpanStatusCode; message?: string };
} {
  const span = {
    attributes: {} as Record<string, unknown>,
    ended: false,
    events: [] as Array<{ name: string; attributes?: Record<string, unknown> }>,
    status: { code: SpanStatusCode.UNSET } as { code: SpanStatusCode; message?: string },
    addEvent(name: string, attributes?: Record<string, unknown>) {
      this.events.push({ name, attributes });
      return this;
    },
    addLink() {
      return this;
    },
    addLinks() {
      return this;
    },
    end() {
      this.ended = true;
    },
    isRecording() {
      return true;
    },
    recordException() {
      return undefined;
    },
    setAttribute(key: string, value: unknown) {
      this.attributes[key] = value;
      return this;
    },
    setAttributes(attributes: Record<string, unknown>) {
      Object.assign(this.attributes, attributes);
      return this;
    },
    setStatus(status: { code: SpanStatusCode; message?: string }) {
      this.status = status;
      return this;
    },
    spanContext() {
      return {
        spanId: 'tool-span',
        traceFlags: 1,
        traceId: 'trace-id',
      };
    },
    updateName() {
      return this;
    },
  };
  return span as Span & typeof span;
}

function createMockTracer(): Tracer & {
  spans: Array<{
    name: string;
    options?: SpanOptions;
    parentContext?: OpenTelemetryContext;
    span: ReturnType<typeof createMockSpan>;
  }>;
} {
  const spans: Array<{
    name: string;
    options?: SpanOptions;
    parentContext?: OpenTelemetryContext;
    span: ReturnType<typeof createMockSpan>;
  }> = [];
  return {
    spans,
    startActiveSpan: (() => undefined) as Tracer['startActiveSpan'],
    startSpan(name, options, parentContext) {
      const span = createMockSpan();
      spans.push({ name, options, parentContext, span });
      return span;
    },
  };
}

function createTraceInputs(): {
  parentContext: OpenTelemetryContext;
  spanLinks: OpenTelemetrySpanLink[];
} {
  return {
    parentContext: {
      deleteValue() {
        return this;
      },
      getValue() {
        return undefined;
      },
      setValue() {
        return this;
      },
    } as OpenTelemetryContext,
    spanLinks: [
      {
        context: {
          spanId: 'linked-span',
          traceFlags: 1,
          traceId: 'linked-trace',
        },
      },
    ],
  };
}

describe('instrument', () => {
  it('starts tool spans under the parent OpenTelemetry context and forwards span links', async () => {
    const toolbox = createToolbox([
      {
        name: 'lookup',
        description: 'lookup a value',
        input: z.object({ key: z.string() }),
        async execute({ key }: { key: string }) {
          return { value: key };
        },
      },
    ]);
    const tracer = createMockTracer();
    const unregister = instrument(toolbox, { tracer });
    const { parentContext, spanLinks } = createTraceInputs();

    await toolbox.execute(
      { id: 'call-1', name: 'lookup', arguments: { key: 'account' } },
      { parentContext, spanLinks },
    );
    unregister();

    expect(tracer.spans).toHaveLength(1);
    expect(tracer.spans[0]?.name).toBe('tool lookup');
    expect(tracer.spans[0]?.options?.kind).toBe(SpanKind.CLIENT);
    expect(tracer.spans[0]?.options?.links).toBe(spanLinks);
    expect(tracer.spans[0]?.parentContext).toBe(parentContext);
    expect(tracer.spans[0]?.span.ended).toBe(true);
  });

  it('keeps the supplied parent context and span links when a tool fails', async () => {
    const toolbox = createToolbox([
      {
        name: 'fail',
        description: 'fail a value',
        input: z.object({ key: z.string() }),
        async execute() {
          throw new Error('lookup failed');
        },
      },
    ]);
    const tracer = createMockTracer();
    const unregister = instrument(toolbox, { tracer });
    const { parentContext, spanLinks } = createTraceInputs();

    await toolbox.execute(
      { id: 'call-2', name: 'fail', arguments: { key: 'account' } },
      { parentContext, spanLinks },
    );
    unregister();

    expect(tracer.spans).toHaveLength(1);
    expect(tracer.spans[0]?.options?.links).toBe(spanLinks);
    expect(tracer.spans[0]?.parentContext).toBe(parentContext);
    expect(tracer.spans[0]?.span.status.code).toBe(SpanStatusCode.ERROR);
    expect(tracer.spans[0]?.span.ended).toBe(true);
  });
});
