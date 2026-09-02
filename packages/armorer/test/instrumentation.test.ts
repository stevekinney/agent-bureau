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
    expect(startedSpans[0]?.name).toBe('execute_tool lookup');
    expect(startedSpans[0]?.context).toBe(parentContext);
    expect(startedSpans[0]?.options?.kind).toBe(SpanKind.INTERNAL);
    expect(startedSpans[0]?.options?.links).toBe(spanLinks);
    expect(startedSpans[0]?.options?.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'lookup',
      'gen_ai.tool.call.id': 'call-1',
      'gen_ai.tool.description': 'Lookup a value',
    });
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

  it('records started and successful finished tool events without attaching tool arguments or the tool result', () => {
    const manualToolbox = createManualToolbox();
    const span = createSpan();
    const tracer = {
      startSpan() {
        return span;
      },
    } as Tracer;

    const stop = instrument(manualToolbox as never, { tracer });
    const toolArguments = { secret: 'do-not-leak' };
    manualToolbox.dispatch('call', {
      tool: { identity: { name: 'lookup' } },
      call: { id: 'call-1', arguments: toolArguments },
    });
    manualToolbox.dispatch('tool.started', {
      toolCall: { id: 'call-1' },
      params: toolArguments,
    });
    manualToolbox.dispatch('tool.finished', {
      toolCall: { id: 'call-1' },
      status: 'success',
      result: { ok: true, secret: 'do-not-leak-either' },
      durationMs: 12,
      inputDigest: 'input',
      outputDigest: 'output',
    });
    stop();

    // The `tool.started` marker fires with no attributes — the arguments it
    // used to carry are privileged (AB-230).
    expect(span.events).toEqual([{ name: 'tool.started', attributes: undefined }]);
    expect(span.status).toEqual({ code: SpanStatusCode.OK });
    expect(span.attributes).toMatchObject({
      'armorer.tool.duration_ms': 12,
      'armorer.tool.input_digest': 'input',
      'armorer.tool.output_digest': 'output',
      'armorer.tool.status': 'success',
    });
    // Privileged: never attached, on success or otherwise.
    expect(span.attributes).not.toHaveProperty('gen_ai.tool.call.arguments');
    expect(span.attributes).not.toHaveProperty('gen_ai.tool.call.result');
    expect(span.ended).toBe(true);
  });

  it('records cancelled, paused, and error tool finish statuses', () => {
    const manualToolbox = createManualToolbox();
    const recordedSpans = [createSpan(), createSpan(), createSpan(), createSpan(), createSpan()];
    const spanQueue = [...recordedSpans];
    const tracer = {
      startSpan() {
        return spanQueue.shift()!;
      },
    } as Tracer;
    const stop = instrument(manualToolbox as never, { tracer });

    for (const callId of [
      'cancelled',
      'cancelled-error-instance',
      'paused',
      'error-instance',
      'error-value',
    ]) {
      manualToolbox.dispatch('call', {
        tool: { identity: { name: callId } },
        call: { id: callId, arguments: {} },
      });
    }
    manualToolbox.dispatch('tool.finished', {
      toolCall: { id: 'cancelled' },
      status: 'cancelled',
      error: { reason: 'abort', secret: 'do-not-leak' },
      durationMs: 1,
    });
    const cancelledError = new Error('deadline exceeded');
    manualToolbox.dispatch('tool.finished', {
      toolCall: { id: 'cancelled-error-instance' },
      status: 'cancelled',
      error: cancelledError,
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
      error: { code: 'DENIED', secret: 'do-not-leak' },
      durationMs: 4,
    });
    stop();

    expect(recordedSpans[0]?.status).toEqual({ code: SpanStatusCode.UNSET, message: 'Cancelled' });
    // Privileged: the cancellation error is derived from a caller-supplied
    // reason and is never serialized onto an attribute (AB-230).
    expect(recordedSpans[0]?.attributes).not.toHaveProperty('armorer.tool.cancellation_reason');
    expect(recordedSpans[0]?.attributes['error.type']).toBe('cancelled');
    expect(recordedSpans[0]?.attributes['armorer.tool.cancellation_category']).toBe('cancelled');
    expect(recordedSpans[0]?.exceptions).toEqual([]);
    // A genuine Error is NEVER recorded via recordException on the
    // cancelled path (AB-237) — OTel would serialize its `message` (and
    // stack) verbatim onto the exception event's `exception.message`/
    // `exception.stacktrace` attributes, leaking the caller-supplied
    // abort reason. Only the non-privileged category is reported.
    expect(recordedSpans[1]?.status).toEqual({ code: SpanStatusCode.UNSET, message: 'Cancelled' });
    expect(recordedSpans[1]?.attributes).not.toHaveProperty('armorer.tool.cancellation_reason');
    expect(recordedSpans[1]?.attributes['error.type']).toBe('cancelled');
    expect(recordedSpans[1]?.attributes['armorer.tool.cancellation_category']).toBe('cancelled');
    expect(recordedSpans[1]?.exceptions).toEqual([]);
    expect(recordedSpans[2]?.status).toEqual({
      code: SpanStatusCode.OK,
      message: 'Paused (Action Required)',
    });
    expect(recordedSpans[2]?.attributes['armorer.tool.status']).toBe('paused');
    expect(recordedSpans[3]?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'failed' });
    expect(recordedSpans[3]?.exceptions).toEqual([thrown]);
    expect(recordedSpans[3]?.attributes['error.type']).toBe('error');
    expect(recordedSpans[4]?.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: '[object Object]',
    });
    // Privileged: a non-`Error` error value (denied/error status) is never
    // serialized onto an attribute (AB-230) — only its non-privileged
    // category survives.
    expect(recordedSpans[4]?.attributes).not.toHaveProperty('armorer.tool.error');
    expect(recordedSpans[4]?.attributes['error.type']).toBe('denied');
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

  it('sanitizes a cancellation reaching the error fallback the same way as tool.finished (AB-237)', () => {
    // A tool created without `telemetry: true` never emits `tool.finished`
    // (armorer/src/create-tool.ts's `finishTelemetry` returns early), so a
    // cancellation on such a tool reaches only the toolbox-level `error`
    // fallback below — the primary `tool.finished` listener above never
    // runs for it. That fallback previously copied `result.error.message`
    // straight onto `span.status.message`, which is the caller-supplied
    // abort reason on a cancellation.
    const manualToolbox = createManualToolbox();
    const span = createSpan();
    const tracer = {
      startSpan() {
        return span;
      },
    } as Tracer;
    const stop = instrument(manualToolbox as never, { tracer });

    manualToolbox.dispatch('call', {
      tool: { identity: { name: 'lookup-cancelled-no-telemetry' } },
      call: { id: 'call-1', arguments: {} },
    });
    manualToolbox.dispatch('error', {
      result: {
        callId: 'call-1',
        error: { code: 'CANCELLED', category: 'cancelled', message: 'aborted: do-not-leak' },
      },
    });
    stop();

    expect(span.status).toEqual({ code: SpanStatusCode.UNSET, message: 'Cancelled' });
    expect(span.attributes['error.type']).toBe('cancelled');
    expect(span.attributes['armorer.tool.cancellation_category']).toBe('cancelled');
    expect(JSON.stringify(span.attributes)).not.toContain('do-not-leak');
    expect(JSON.stringify(span.status)).not.toContain('do-not-leak');
    expect(span.ended).toBe(true);
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
    // Single cast (matching the existing supplied-parent test above): we only
    // need a distinct reference to assert forwarding by identity via `toBe`.
    const sentinelParent = { __sentinel: 'parent' } as Context;
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

// AB-230 attribute-classification table.
//
// Every `span.setAttribute`/`span.setAttributes`/`span.addEvent(name, attrs)`
// call site in `packages/armorer/src/instrumentation/index.ts`, classified
// as privileged (tool arguments, tool results, provider request/response
// content, conversation content) or non-privileged (model/provider
// identity, timing, counts, event type names).
//
// `packages/armorer/src/core/context.ts` also declares `Tracer`/`Span`
// types with `startSpan`/`setAttribute`/`addEvent` shapes — verified (grep)
// to be caller-supplied hook types that armorer's own `src/` never invokes
// (no `.startSpan(`/`.setAttribute(`/`.addEvent(` call site outside
// `instrumentation/`), so there is no emission site there to audit.
//
// Every privileged row's `treatment` is `omitted` — none is attached with a
// placeholder — because `gen_ai.tool.call.arguments`/`gen_ai.tool.call.result` are Opt-In under
// the OTel GenAI semantic conventions specifically to keep this content out
// of default telemetry, and a placeholder string risks being parsed by a
// backend as if it were real content.
type AttributeClassificationRow = {
  callSite: string;
  attributeKey: string;
  sourceValue: string;
  privileged: boolean;
  treatment: 'emitted' | 'omitted';
};

const ARMORER_ATTRIBUTE_CLASSIFICATION_TABLE: AttributeClassificationRow[] = [
  {
    callSite: "'call' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'gen_ai.operation.name',
    sourceValue: "literal 'execute_tool'",
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'call' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'gen_ai.tool.name',
    sourceValue: 'tool.identity.name',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'call' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'gen_ai.tool.call.id',
    sourceValue: 'call.id',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'call' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'gen_ai.tool.description',
    sourceValue: 'tool.description (when set)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'call' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'gen_ai.tool.call.arguments',
    sourceValue: 'call.arguments — tool arguments',
    privileged: true,
    treatment: 'omitted',
  },
  {
    callSite: "'tool.started' listener → span.addEvent('tool.started', attrs)",
    attributeKey: 'gen_ai.tool.call.arguments',
    sourceValue: 'params — tool arguments',
    privileged: true,
    treatment: 'omitted',
  },
  {
    callSite: "'tool.finished' listener → span.setAttributes(attributes)",
    attributeKey: 'armorer.tool.duration_ms',
    sourceValue: 'durationMs (timing)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'tool.finished' listener → span.setAttributes(attributes)",
    attributeKey: 'armorer.tool.status',
    sourceValue: 'status (event type name)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'tool.finished' listener → span.setAttributes(attributes)",
    attributeKey: 'armorer.tool.input_digest',
    sourceValue: 'inputDigest — a digest, not the argument content',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'tool.finished' listener → span.setAttributes(attributes)",
    attributeKey: 'armorer.tool.output_digest',
    sourceValue: 'outputDigest — a digest, not the result content',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'tool.finished' listener, success case → span.setAttributes(attributes)",
    attributeKey: 'gen_ai.tool.call.result',
    sourceValue: 'result — the tool result',
    privileged: true,
    treatment: 'omitted',
  },
  {
    callSite: "'tool.finished' listener, cancelled case → span.setAttributes(attributes)",
    attributeKey: 'armorer.tool.cancellation_reason',
    sourceValue: 'error — derived from a caller-supplied abort reason, may carry argument content',
    privileged: true,
    treatment: 'omitted',
  },
  {
    callSite:
      "'tool.finished' listener, cancelled case → span.recordException(error) [AB-237: never called]",
    attributeKey: 'exception.message / exception.stacktrace',
    sourceValue:
      'error — a caller-supplied abort reason (possibly an Error instance); recordException is never invoked for the cancelled status, on any error shape',
    privileged: true,
    treatment: 'omitted',
  },
  {
    callSite: "'tool.finished' listener, cancelled case → span.setAttributes(attributes)",
    attributeKey: 'armorer.tool.cancellation_category',
    sourceValue: 'errorCategory ?? status (a category name, not error content)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite:
      "'tool.finished' listener, cancelled/error/denied cases → span.setAttributes(attributes)",
    attributeKey: 'error.type',
    sourceValue: 'errorCategory ?? status (a category name, not error content)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite:
      "'tool.finished' listener, error/denied default case → span.setAttributes(attributes)",
    attributeKey: 'armorer.tool.error',
    sourceValue: 'error — a thrown/returned non-Error value, may carry argument or result content',
    privileged: true,
    treatment: 'omitted',
  },
  {
    callSite: "'error' fallback listener, non-cancelled case → span.setAttribute(key, value)",
    attributeKey: 'error.type',
    sourceValue: 'result.error.code (a category code, not error content)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite:
      "'error' fallback listener, cancelled case → span.setStatus [AB-237: message replaced]",
    attributeKey: 'status.message',
    sourceValue:
      'result.error.message — a caller-supplied abort reason; reached only when a tool omits `telemetry: true`, so `tool.finished` never fires and this fallback is the sole emission site. Replaced with the fixed string "Cancelled" rather than omitted, since `setStatus` always requires a message.',
    privileged: true,
    treatment: 'omitted',
  },
  {
    callSite: "'error' fallback listener, cancelled case → span.setAttribute(key, value)",
    attributeKey: 'error.type / armorer.tool.cancellation_category',
    sourceValue: "literal 'cancelled' (a category name, not error content)",
    privileged: false,
    treatment: 'emitted',
  },
];

describe('AB-230 armorer attribute-classification table', () => {
  it('omits every privileged row and emits every non-privileged row', () => {
    const privilegedRows = ARMORER_ATTRIBUTE_CLASSIFICATION_TABLE.filter((row) => row.privileged);
    const nonPrivilegedRows = ARMORER_ATTRIBUTE_CLASSIFICATION_TABLE.filter(
      (row) => !row.privileged,
    );
    expect(privilegedRows.every((row) => row.treatment === 'omitted')).toBe(true);
    expect(nonPrivilegedRows.every((row) => row.treatment === 'emitted')).toBe(true);
  });
});

describe('AB-230 regression: privileged fixture values never reach a span attribute', () => {
  const MARKER = 'PRIVILEGED-MARKER-3f9c1e';

  function containsMarker(value: unknown): boolean {
    if (typeof value === 'string') return value.includes(MARKER);
    if (Array.isArray(value)) return value.some(containsMarker);
    if (value && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).some(containsMarker);
    }
    return false;
  }

  it('never attaches a fixture privileged marker to any tool-call span attribute or event', () => {
    const manualToolbox = createManualToolbox();
    const startedSpans: Array<{ options?: SpanOptions; span: RecordingSpan }> = [];
    const tracer = {
      startSpan(_name: string, options?: SpanOptions) {
        const span = createSpan();
        startedSpans.push({ options, span });
        return span;
      },
    } as Tracer;

    const stop = instrument(manualToolbox as never, { tracer });
    const toolArguments = { query: MARKER, nested: { value: MARKER } };
    const toolResult = { answer: MARKER };
    const toolError = { message: `tool failed on input: ${MARKER}` };
    // A genuine `Error` instance — the shape that reaches `recordException`
    // when a caller's abort reason gets wrapped/formatted as an `Error`
    // (AB-237). A plain object like `toolError` above never triggered
    // `recordException` in the first place (it fails `instanceof Error`),
    // so it alone would not have caught this regression.
    const cancellationError = new Error(`aborted: ${MARKER}`);

    manualToolbox.dispatch('call', {
      tool: { identity: { name: 'lookup' } },
      call: { id: 'call-1', arguments: toolArguments },
    });
    manualToolbox.dispatch('tool.started', {
      toolCall: { id: 'call-1' },
      params: toolArguments,
    });
    manualToolbox.dispatch('tool.finished', {
      toolCall: { id: 'call-1' },
      status: 'success',
      result: toolResult,
      durationMs: 5,
    });

    manualToolbox.dispatch('call', {
      tool: { identity: { name: 'lookup-denied' } },
      call: { id: 'call-2', arguments: toolArguments },
    });
    manualToolbox.dispatch('tool.finished', {
      toolCall: { id: 'call-2' },
      status: 'denied',
      error: toolError,
      durationMs: 5,
    });

    manualToolbox.dispatch('call', {
      tool: { identity: { name: 'lookup-cancelled' } },
      call: { id: 'call-3', arguments: toolArguments },
    });
    manualToolbox.dispatch('tool.finished', {
      toolCall: { id: 'call-3' },
      status: 'cancelled',
      error: toolError,
      durationMs: 5,
    });

    // AB-237: a cancellation whose abort reason is a genuine `Error`
    // instance carrying the fixture marker. Before the fix,
    // `span.recordException(error)` on this path serialized the marker
    // onto the exception event's `exception.message` attribute.
    manualToolbox.dispatch('call', {
      tool: { identity: { name: 'lookup-cancelled-error-instance' } },
      call: { id: 'call-4', arguments: {} },
    });
    manualToolbox.dispatch('tool.finished', {
      toolCall: { id: 'call-4' },
      status: 'cancelled',
      error: cancellationError,
      errorCategory: 'cancelled',
      durationMs: 5,
    });
    stop();

    expect(startedSpans).toHaveLength(4);
    for (const { options, span } of startedSpans) {
      // Scan every surface a span can expose content through: the
      // attributes passed to startSpan, the attributes set later via
      // setAttribute(s), any addEvent attributes, and (AB-237) any
      // recorded exception — recordException serializes an Error's
      // `message`/stack onto exception.message/exception.stacktrace event
      // attributes, so a fixture marker embedded in an Error's message
      // must never reach it either.
      expect(containsMarker(options?.attributes)).toBe(false);
      expect(containsMarker(span.attributes)).toBe(false);
      expect(span.events.every((event) => !containsMarker(event.attributes))).toBe(true);
      expect(span.exceptions.some((exception) => containsMarker(exception))).toBe(false);
      expect(
        span.exceptions.some(
          (exception) => exception instanceof Error && containsMarker(exception.message),
        ),
      ).toBe(false);
    }

    // AC #4: this scenario does not over-redact — every non-privileged
    // attribute the classification table above claims is still emitted
    // survives, for every one of the four call outcomes it exercises.
    const [success, denied, cancelled, cancelledErrorInstance] = startedSpans;
    expect(success?.options?.attributes).toMatchObject({
      'gen_ai.tool.name': 'lookup',
      'gen_ai.tool.call.id': 'call-1',
    });
    expect(success?.span.attributes).toMatchObject({
      'armorer.tool.duration_ms': 5,
      'armorer.tool.status': 'success',
    });
    expect(denied?.span.attributes['error.type']).toBe('denied');
    expect(cancelled?.span.attributes['error.type']).toBe('cancelled');
    expect(cancelled?.span.attributes['armorer.tool.cancellation_category']).toBe('cancelled');
    // The Error instance never reaches recordException on the cancelled
    // path — the exception list is empty even though a genuine Error was
    // supplied.
    expect(cancelledErrorInstance?.span.exceptions).toEqual([]);
    expect(cancelledErrorInstance?.span.attributes['error.type']).toBe('cancelled');
    expect(cancelledErrorInstance?.span.attributes['armorer.tool.cancellation_category']).toBe(
      'cancelled',
    );
  });
});
