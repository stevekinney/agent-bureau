import {
  type Context,
  context,
  type Span,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';

import type { ActiveRun } from '../create-run';
import type { TokenUsage } from '../types';

export type InstrumentationOptions = {
  tracer?: Tracer;
  tracerName?: string;
  tracerVersion?: string;
};

type InstrumentableActiveRun = {
  addEventListener: ActiveRun['addEventListener'];
};

/**
 * Subscribes to events on an ActiveRun and creates OpenTelemetry spans
 * that mirror the agent loop lifecycle.
 *
 * Returns an unsubscribe function that removes all listeners and ends
 * any spans still open.
 */
export function instrument(
  activeRun: InstrumentableActiveRun,
  options: InstrumentationOptions = {},
): () => void {
  const tracer =
    options.tracer ??
    trace.getTracer(options.tracerName ?? 'operative', options.tracerVersion ?? '0.0.0');

  let runSpan: Span | undefined;
  let runContext: Context | undefined;

  const stepSpans = new Map<number, Span>();
  const stepContexts = new Map<number, Context>();
  const generateSpans = new Map<number, Span>();
  const toolsSpans = new Map<number, Span>();

  const controller = new AbortController();
  const signal = controller.signal;

  function setUsageAttributes(span: Span, usage: TokenUsage): void {
    span.setAttributes({
      'operative.usage.prompt_tokens': usage.prompt,
      'operative.usage.completion_tokens': usage.completion,
      'operative.usage.total_tokens': usage.total,
    });
  }

  function endAllOpenSpans(): void {
    for (const span of generateSpans.values()) {
      if (span.isRecording()) span.end();
    }
    generateSpans.clear();

    for (const span of toolsSpans.values()) {
      if (span.isRecording()) span.end();
    }
    toolsSpans.clear();

    for (const span of stepSpans.values()) {
      if (span.isRecording()) span.end();
    }
    stepSpans.clear();
    stepContexts.clear();

    if (runSpan?.isRecording()) runSpan.end();
  }

  activeRun.addEventListener(
    'run.started',
    () => {
      runSpan = tracer.startSpan('operative.run');
      runContext = trace.setSpan(context.active(), runSpan);
    },
    { signal },
  );

  activeRun.addEventListener(
    'step.started',
    (event) => {
      const { step } = event;
      const stepSpan = tracer.startSpan(`operative.step.${step}`, {}, runContext);
      stepSpans.set(step, stepSpan);
      const stepContext = trace.setSpan(context.active(), stepSpan);
      stepContexts.set(step, stepContext);
    },
    { signal },
  );

  activeRun.addEventListener(
    'generate.started',
    (event) => {
      const { step } = event;
      const stepContext = stepContexts.get(step);
      const generateSpan = tracer.startSpan('operative.generate', {}, stepContext);
      generateSpans.set(step, generateSpan);
    },
    { signal },
  );

  activeRun.addEventListener(
    'generate.completed',
    (event) => {
      const { step, response, durationMilliseconds } = event;
      const generateSpan = generateSpans.get(step);
      if (generateSpan?.isRecording()) {
        if (response.usage) {
          setUsageAttributes(generateSpan, response.usage);
        }
        generateSpan.setAttribute('operative.generate.duration_ms', durationMilliseconds);
        generateSpan.end();
      }
      generateSpans.delete(step);
    },
    { signal },
  );

  activeRun.addEventListener(
    'generate.error',
    (event) => {
      const { step, error, durationMilliseconds } = event;
      const generateSpan = generateSpans.get(step);
      if (generateSpan?.isRecording()) {
        generateSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Error) {
          generateSpan.recordException(error);
        }
        generateSpan.setAttribute('operative.generate.duration_ms', durationMilliseconds);
        generateSpan.end();
      }
      generateSpans.delete(step);
    },
    { signal },
  );

  activeRun.addEventListener(
    'tools.executing',
    (event) => {
      const { step, toolCalls } = event;
      const stepContext = stepContexts.get(step);
      const toolsSpan = tracer.startSpan(
        'operative.tools',
        {
          attributes: {
            'operative.tools.count': toolCalls.length,
            'operative.tools.names': toolCalls.map((tc) => tc.name).join(', '),
          },
        },
        stepContext,
      );
      toolsSpans.set(step, toolsSpan);
    },
    { signal },
  );

  activeRun.addEventListener(
    'tools.executed',
    (event) => {
      const { step, results } = event;
      const toolsSpan = toolsSpans.get(step);
      if (toolsSpan) {
        toolsSpan.setAttribute('operative.tools.results_count', results.length);
        toolsSpan.end();
        toolsSpans.delete(step);
      }
    },
    { signal },
  );

  activeRun.addEventListener(
    'step.completed',
    (event) => {
      const { step } = event;
      const stepSpan = stepSpans.get(step);
      if (stepSpan?.isRecording()) {
        stepSpan.end();
      }
      stepSpans.delete(step);
      stepContexts.delete(step);
    },
    { signal },
  );

  activeRun.addEventListener(
    'run.completed',
    (event) => {
      if (runSpan) {
        runSpan.setAttributes({
          'operative.finish_reason': event.finishReason,
          'operative.total_steps': event.steps.length,
          'operative.usage.prompt_tokens': event.usage.prompt,
          'operative.usage.completion_tokens': event.usage.completion,
          'operative.usage.total_tokens': event.usage.total,
        });
        // Only set OK if run.error did not already set ERROR status
        if (!event.error) {
          runSpan.setStatus({ code: SpanStatusCode.OK });
        }
        runSpan.end();
      }
    },
    { signal },
  );

  activeRun.addEventListener(
    'run.error',
    (event) => {
      const { error } = event;
      if (runSpan) {
        runSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Error) {
          runSpan.recordException(error);
        }
      }
      endAllOpenSpans();
    },
    { signal },
  );

  activeRun.addEventListener(
    'run.aborted',
    (event) => {
      const { reason } = event;
      if (runSpan) {
        runSpan.setAttribute('operative.abort_reason', reason ?? 'unknown');
        runSpan.setStatus({ code: SpanStatusCode.OK, message: 'Aborted' });
      }
      endAllOpenSpans();
    },
    { signal },
  );

  activeRun.addEventListener(
    'generate.retry',
    (event) => {
      const { step, attempt } = event;
      const generateSpan = generateSpans.get(step);
      if (generateSpan) {
        generateSpan.addEvent('generate.retry', { 'retry.attempt': attempt });
      }
    },
    { signal },
  );

  return () => {
    controller.abort();
    endAllOpenSpans();
  };
}
