import type {
  Attributes,
  Context,
  Link,
  Span,
  SpanOptions,
  SpanStatus,
  Tracer,
} from '@opentelemetry/api';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool, createToolbox } from '../src';
import { instrument } from '../src/instrumentation';

type RecordingSpan = Span & {
  attributes: Attributes;
  ended: boolean;
  events: Array<{ name: string; attributes?: Attributes }>;
  exceptions: unknown[];
  recording: boolean;
  status?: SpanStatus;
};

function createSpan(recording = true): RecordingSpan {
  const span = {
    attributes: {},
    ended: false,
    events: [],
    exceptions: [],
    recording,
    addEvent: (name: string, attributes?: Attributes) => {
      span.events.push({ name, attributes });
      return span;
    },
    addLink: () => undefined,
    addLinks: () => undefined,
    end: () => {
      span.ended = true;
    },
    isRecording: () => span.recording,
    recordException: (exception: unknown) => {
      span.exceptions.push(exception);
    },
    setAttribute: (key: string, value: unknown) => {
      span.attributes[key] = value as never;
      return span;
    },
    setAttributes: (attributes: Attributes) => {
      Object.assign(span.attributes, attributes);
      return span;
    },
    setStatus: (status: SpanStatus) => {
      span.status = status;
      return span;
    },
    spanContext: () => ({
      traceId: 'trace',
      spanId: 'span',
      traceFlags: 1,
    }),
    updateName: () => span,
  } satisfies Partial<RecordingSpan> as RecordingSpan;

  return span;
}

function createManualToolbox() {
  const listeners = new Map<string, Array<(event: any) => void>>();

  return {
    addEventListener(type: string, listener: (event: any) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      return () => {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
        );
      };
    },
    dispatch(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
  };
}

describe('instrument', () => {
  it('starts tool spans under the parent OpenTelemetry context and forwards span links', async () => {
    const parentContext = {} as Context;
    const spanLinks: Link[] = [
      {
        context: {
          traceId: 'linked-trace',
          spanId: 'linked-span',
          traceFlags: 1,
        },
      },
    ];
    const startedSpans: Array<{
      name: string;
      options?: SpanOptions;
      context?: Context;
      span: RecordingSpan;
    }> = [];
    const tracer = {
      startSpan(name: string, options?: SpanOptions, context?: Context) {
        const span = createSpan();
        startedSpans.push({ name, options, context, span });
        return span;
      },
    } as Tracer;
    const toolbox = createToolbox([
      createTool({
        name: 'lookup',
        description: 'Lookup a value',
        input: z.object({ value: z.string() }),
        async execute({ value }) {
          return value;
        },
      }),
    ]);

    const stop = instrument(toolbox, { tracer });
    await toolbox.execute(
      {
        id: 'call-1',
        name: 'lookup',
        arguments: { value: 'alpha' },
      },
      { parentContext, spanLinks },
    );
    stop();

    expect(startedSpans).toHaveLength(1);
    expect(startedSpans[0]?.name).toBe('tool lookup');
    expect(startedSpans[0]?.context).toBe(parentContext);
    expect(startedSpans[0]?.options?.kind).toBe(SpanKind.CLIENT);
    expect(startedSpans[0]?.options?.links).toBe(spanLinks);
    expect(startedSpans[0]?.span.ended).toBe(true);
  });

  it('keeps the supplied parent context and span links when a tool fails', async () => {
    const parentContext = {} as Context;
    const spanLinks: Link[] = [
      {
        context: {
          traceId: 'linked-trace',
          spanId: 'linked-span',
          traceFlags: 1,
        },
      },
    ];
    const startedSpans: Array<{
      name: string;
      options?: SpanOptions;
      context?: Context;
      span: RecordingSpan;
    }> = [];
    const tracer = {
      startSpan(name: string, options?: SpanOptions, context?: Context) {
        const span = createSpan();
        startedSpans.push({ name, options, context, span });
        return span;
      },
    } as Tracer;
    const toolbox = createToolbox([
      createTool({
        name: 'fail',
        description: 'Fail a value',
        input: z.object({ value: z.string() }),
        async execute() {
          throw new Error('lookup failed');
        },
      }),
    ]);

    const stop = instrument(toolbox, { tracer });
    await toolbox.execute(
      {
        id: 'call-2',
        name: 'fail',
        arguments: { value: 'alpha' },
      },
      { parentContext, spanLinks },
    );
    stop();

    expect(startedSpans).toHaveLength(1);
    expect(startedSpans[0]?.context).toBe(parentContext);
    expect(startedSpans[0]?.options?.links).toBe(spanLinks);
    expect(startedSpans[0]?.span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'lookup failed',
    });
    expect(startedSpans[0]?.span.ended).toBe(true);
  });

  it('records started and successful finished tool events', () => {
    const manualToolbox = createManualToolbox();
    const span = createSpan();
    const tracer = {
      startSpan() {
        return span;
      },
    } as Tracer;

    const stop = instrument(manualToolbox as never, { tracer });
    const circularArguments: Record<string, unknown> = {};
    circularArguments['self'] = circularArguments;
    manualToolbox.dispatch('call', {
      tool: { identity: { name: 'lookup' } },
      call: { id: 'call-1', arguments: circularArguments },
    });
    manualToolbox.dispatch('tool.started', {
      toolCall: { id: 'call-1' },
      params: circularArguments,
    });
    manualToolbox.dispatch('tool.finished', {
      toolCall: { id: 'call-1' },
      status: 'success',
      result: { ok: true },
      durationMs: 12,
      inputDigest: 'input',
      outputDigest: 'output',
    });
    stop();

    expect(span.events).toEqual([
      {
        name: 'tool.started',
        attributes: {
          'gen_ai.tool.arguments': '[object Object]',
        },
      },
    ]);
    expect(span.status).toEqual({ code: SpanStatusCode.OK });
    expect(span.attributes).toMatchObject({
      'gen_ai.tool.duration_ms': 12,
      'gen_ai.tool.input_digest': 'input',
      'gen_ai.tool.output_digest': 'output',
      'gen_ai.tool.result': '{"ok":true}',
      'gen_ai.tool.status': 'success',
    });
    expect(span.ended).toBe(true);
  });

  it('records cancelled, paused, and error tool finish statuses', () => {
    const manualToolbox = createManualToolbox();
    const recordedSpans = [createSpan(), createSpan(), createSpan(), createSpan()];
    const spanQueue = [...recordedSpans];
    const tracer = {
      startSpan() {
        return spanQueue.shift()!;
      },
    } as Tracer;
    const stop = instrument(manualToolbox as never, { tracer });

    for (const callId of ['cancelled', 'paused', 'error-instance', 'error-value']) {
      manualToolbox.dispatch('call', {
        tool: { identity: { name: callId } },
        call: { id: callId, arguments: {} },
      });
    }
    manualToolbox.dispatch('tool.finished', {
      toolCall: { id: 'cancelled' },
      status: 'cancelled',
      error: { reason: 'abort' },
      durationMs: 1,
    });
    manualToolbox.dispatch('tool.finished', {
      toolCall: { id: 'paused' },
      status: 'paused',
      durationMs: 2,
    });
    const thrown = new Error('failed');
    manualToolbox.dispatch('tool.finished', {
      toolCall: { id: 'error-instance' },
      status: 'error',
      error: thrown,
      durationMs: 3,
    });
    manualToolbox.dispatch('tool.finished', {
      toolCall: { id: 'error-value' },
      status: 'denied',
      error: { code: 'DENIED' },
      durationMs: 4,
    });
    stop();

    expect(recordedSpans[0]?.status).toEqual({ code: SpanStatusCode.UNSET, message: 'Cancelled' });
    expect(recordedSpans[0]?.attributes['gen_ai.tool.cancellation_reason']).toBe(
      '{"reason":"abort"}',
    );
    expect(recordedSpans[1]?.status).toEqual({
      code: SpanStatusCode.OK,
      message: 'Paused (Action Required)',
    });
    expect(recordedSpans[1]?.attributes['gen_ai.tool.status']).toBe('paused');
    expect(recordedSpans[2]?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'failed' });
    expect(recordedSpans[2]?.exceptions).toEqual([thrown]);
    expect(recordedSpans[3]?.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: '[object Object]',
    });
    expect(recordedSpans[3]?.attributes['gen_ai.tool.error']).toBe('{"code":"DENIED"}');
  });

  it('covers complete and error fallback events', () => {
    const manualToolbox = createManualToolbox();
    const successSpan = createSpan();
    const errorSpan = createSpan();
    const nonRecordingSpan = createSpan(false);
    const spans = [successSpan, errorSpan, nonRecordingSpan];
    const tracer = {
      startSpan() {
        return spans.shift()!;
      },
    } as Tracer;
    const stop = instrument(manualToolbox as never, { tracer });

    for (const callId of ['success', 'error', 'not-recording']) {
      manualToolbox.dispatch('call', {
        tool: { identity: { name: callId } },
        call: { id: callId, arguments: {} },
      });
    }
    manualToolbox.dispatch('complete', {
      result: { callId: 'success', outcome: 'success' },
    });
    manualToolbox.dispatch('error', {
      result: {
        callId: 'error',
        error: { code: 'BROKEN', message: 'broken' },
      },
    });
    manualToolbox.dispatch('error', {
      result: {
        callId: 'not-recording',
        error: { code: 'IGNORED', message: 'ignored' },
      },
    });
    stop();

    expect(successSpan.ended).toBe(true);
    expect(errorSpan.status).toEqual({ code: SpanStatusCode.ERROR, message: 'broken' });
    expect(errorSpan.attributes['error.type']).toBe('BROKEN');
    expect(errorSpan.ended).toBe(true);
    expect(nonRecordingSpan.ended).toBe(false);
  });

  it('forwards no parent context to startSpan when none is supplied, but forwards the exact parent when one is', async () => {
    // Regression for A4. instrument() is responsible for ONE thing here: passing
    // the caller-supplied parentContext through to tracer.startSpan(name, options,
    // context) as its third argument — and passing nothing (undefined) when the
    // caller supplies nothing, so the OpenTelemetry SDK applies its own ambient
    // (root) context rather than a parent we fabricated.
    //
    // Asserting `context === undefined` alone would be tautological against a
    // shallow fake (it could pass even if instrument always passed undefined and
    // ignored parentContext entirely). So this test pins BOTH halves with the same
    // tracer: a no-parent call must forward `undefined`, and a sibling call WITH a
    // distinct sentinel parent must forward THAT EXACT parent by identity. Together
    // these prove the `undefined` is a real "no parent" decision, not a coincidence.
    const sentinelParent = { __sentinel: 'parent' } as unknown as Context;
    const startedSpans: Array<{
      name: string;
      options?: SpanOptions;
      context?: Context;
    }> = [];
    const tracer = {
      startSpan(name: string, options?: SpanOptions, context?: Context) {
        const span = createSpan();
        startedSpans.push({ name, options, context });
        return span;
      },
    } as Tracer;
    const toolbox = createToolbox([
      createTool({
        name: 'noop',
        description: 'Does nothing',
        input: z.object({}),
        async execute() {
          return null;
        },
      }),
    ]);

    const stop = instrument(toolbox, { tracer });
    // Call 1: no parentContext, no spanLinks → must forward undefined context.
    await toolbox.execute({ id: 'root-call', name: 'noop', arguments: {} });
    // Call 2: an explicit sentinel parentContext → must forward that exact value.
    await toolbox.execute(
      { id: 'child-call', name: 'noop', arguments: {} },
      { parentContext: sentinelParent },
    );
    stop();

    expect(startedSpans).toHaveLength(2);
    // No parent supplied → context argument is strictly undefined (OTel uses
    // its ambient/root context), and no span links are fabricated.
    expect(startedSpans[0]?.context).toBeUndefined();
    expect(startedSpans[0]?.options?.links).toBeUndefined();
    // Parent supplied → the exact sentinel is forwarded by identity, proving the
    // undefined above is a genuine "no parent" path and not a shallow default.
    expect(startedSpans[1]?.context).toBe(sentinelParent);
  });
});
