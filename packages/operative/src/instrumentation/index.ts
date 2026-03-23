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

  const subscriptions: (() => void)[] = [];

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

  subscriptions.push(
    activeRun.addEventListener('run.started', () => {
      runSpan = tracer.startSpan('operative.run');
      runContext = trace.setSpan(context.active(), runSpan);
    }),
  );

  subscriptions.push(
    activeRun.addEventListener('step.started', (event) => {
      const { step } = event.detail;
      const stepSpan = tracer.startSpan(`operative.step.${step}`, {}, runContext);
      stepSpans.set(step, stepSpan);
      const stepContext = trace.setSpan(context.active(), stepSpan);
      stepContexts.set(step, stepContext);

      const generateSpan = tracer.startSpan('operative.generate', {}, stepContext);
      generateSpans.set(step, generateSpan);
    }),
  );

  subscriptions.push(
    activeRun.addEventListener('tools.executing', (event) => {
      const { step, toolCalls } = event.detail;

      // End the generate span — LLM generation is complete
      const generateSpan = generateSpans.get(step);
      if (generateSpan?.isRecording()) {
        generateSpan.end();
      }
      generateSpans.delete(step);

      // Start the tools span
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
    }),
  );

  subscriptions.push(
    activeRun.addEventListener('tools.executed', (event) => {
      const { step, results } = event.detail;
      const toolsSpan = toolsSpans.get(step);
      if (toolsSpan) {
        toolsSpan.setAttribute('operative.tools.results_count', results.length);
        toolsSpan.end();
        toolsSpans.delete(step);
      }
    }),
  );

  subscriptions.push(
    activeRun.addEventListener('step.generated', (event) => {
      const { step, usage } = event.detail;

      // For text-only steps the generate span is still open here.
      // For tool steps it was already ended by tools.executing.
      const generateSpan = generateSpans.get(step);
      if (generateSpan?.isRecording()) {
        if (usage) {
          setUsageAttributes(generateSpan, usage);
        }
        generateSpan.end();
        generateSpans.delete(step);
      }
    }),
  );

  subscriptions.push(
    activeRun.addEventListener('step.completed', (event) => {
      const { step } = event.detail;
      const stepSpan = stepSpans.get(step);
      if (stepSpan?.isRecording()) {
        stepSpan.end();
      }
      stepSpans.delete(step);
      stepContexts.delete(step);
    }),
  );

  subscriptions.push(
    activeRun.addEventListener('run.completed', (event) => {
      const result = event.detail;
      if (runSpan) {
        runSpan.setAttributes({
          'operative.finish_reason': result.finishReason,
          'operative.total_steps': result.steps.length,
          'operative.usage.prompt_tokens': result.usage.prompt,
          'operative.usage.completion_tokens': result.usage.completion,
          'operative.usage.total_tokens': result.usage.total,
        });
        runSpan.setStatus({ code: SpanStatusCode.OK });
        runSpan.end();
      }
    }),
  );

  subscriptions.push(
    activeRun.addEventListener('run.error', (event) => {
      const { error } = event.detail;
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
    }),
  );

  subscriptions.push(
    activeRun.addEventListener('run.aborted', (event) => {
      const { reason } = event.detail;
      if (runSpan) {
        runSpan.setAttribute('operative.abort_reason', reason ?? 'unknown');
        runSpan.setStatus({ code: SpanStatusCode.OK, message: 'Aborted' });
      }
      endAllOpenSpans();
    }),
  );

  subscriptions.push(
    activeRun.addEventListener('generate.retry', (event) => {
      const { step, attempt } = event.detail;
      const generateSpan = generateSpans.get(step);
      if (generateSpan) {
        generateSpan.addEvent('generate.retry', { 'retry.attempt': attempt });
      }
    }),
  );

  return () => {
    for (const unsubscribe of subscriptions) {
      unsubscribe();
    }
    endAllOpenSpans();
  };
}
