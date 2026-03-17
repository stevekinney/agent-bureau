import {
  type Attributes,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';

import type { Toolbox } from '../create-toolbox';

type InstrumentableToolbox = {
  addEventListener: Toolbox['addEventListener'];
};

export type InstrumentationOptions = {
  tracer?: Tracer;
  tracerName?: string;
  tracerVersion?: string;
};

/**
 * Instruments a Toolbox instance with OpenTelemetry tracing.
 *
 * Automatically creates spans for tool executions and events.
 *
 * @param toolbox - The Toolbox instance to instrument.
 * @param options - Configuration options.
 * @returns A function to unregister the instrumentation.
 */
export function instrument(
  toolbox: InstrumentableToolbox,
  options: InstrumentationOptions = {},
): () => void {
  const tracer =
    options.tracer ??
    trace.getTracer(options.tracerName ?? 'toolbox', options.tracerVersion ?? '0.0.0');

  const activeSpans = new Map<string, Span>();

  const subscriptions: (() => void)[] = [];

  // Helper to safely stringify values for attributes
  const safeStringify = (value: unknown): string => {
    try {
      return typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  subscriptions.push(
    toolbox.addEventListener('call', (event) => {
      const { tool, call } = event.detail;
      const span = tracer.startSpan(`tool ${tool.identity.name}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.system': 'toolbox',
          'gen_ai.tool.name': tool.identity.name,
          'gen_ai.tool.id': call.id,
          'gen_ai.tool.arguments': safeStringify(call.arguments),
        },
      });
      activeSpans.set(call.id, span);
    }),
  );

  subscriptions.push(
    toolbox.addEventListener('tool.started', (event) => {
      const { toolCall, params } = event.detail;
      const span = activeSpans.get(toolCall.id);
      if (span) {
        span.addEvent('tool.started', {
          'gen_ai.tool.arguments': safeStringify(params),
        });
      }
    }),
  );

  subscriptions.push(
    toolbox.addEventListener('tool.finished', (event) => {
      const { toolCall, status, result, error, durationMs, inputDigest, outputDigest } =
        event.detail;
      const span = activeSpans.get(toolCall.id);
      if (span) {
        const attributes: Attributes = {
          'gen_ai.tool.duration_ms': durationMs,
          'gen_ai.tool.status': status,
        };

        if (inputDigest) {
          attributes['gen_ai.tool.input_digest'] = inputDigest;
        }
        if (outputDigest) {
          attributes['gen_ai.tool.output_digest'] = outputDigest;
        }

        switch (status as string) {
          case 'success': {
            attributes['gen_ai.tool.result'] = safeStringify(result);
            span.setStatus({ code: SpanStatusCode.OK });
            break;
          }
          case 'cancelled': {
            span.setStatus({ code: SpanStatusCode.UNSET, message: 'Cancelled' });
            attributes['gen_ai.tool.cancellation_reason'] = safeStringify(error);

            break;
          }
          case 'paused': {
            span.setStatus({
              code: SpanStatusCode.OK,
              message: 'Paused (Action Required)',
            });
            attributes['gen_ai.tool.status'] = 'paused';

            break;
          }
          default: {
            // error or denied
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
            if (error instanceof Error) {
              span.recordException(error);
            } else {
              attributes['gen_ai.tool.error'] = safeStringify(error);
            }
          }
        }

        span.setAttributes(attributes);
        span.end();
        activeSpans.delete(toolCall.id);
      }
    }),
  );

  // Fallback for 'complete' event if tool.finished didn't fire (should be redundant but safe)
  subscriptions.push(
    toolbox.addEventListener('complete', (event) => {
      const { result } = event.detail;
      const span = activeSpans.get(result.callId);
      if (span && result.outcome === 'success') {
        span.end();
        activeSpans.delete(result.callId);
      }
    }),
  );

  // Fallback for 'error' event
  subscriptions.push(
    toolbox.addEventListener('error', (event) => {
      const { result } = event.detail;
      const span = activeSpans.get(result.callId);
      if (span) {
        if (!span.isRecording()) {
          activeSpans.delete(result.callId);
          return;
        }
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error?.message ?? 'Unknown error',
        });
        if (result.error) {
          span.setAttribute('error.type', result.error.code);
        }
        span.end();
        activeSpans.delete(result.callId);
      }
    }),
  );

  return () => {
    subscriptions.forEach((unsubscribe) => unsubscribe());
    activeSpans.clear();
  };
}
