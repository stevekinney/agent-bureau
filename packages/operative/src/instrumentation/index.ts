import {
  type Context,
  context,
  type Span,
  SpanKind,
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
  /**
   * Human-readable agent name. When supplied, the run span is named
   * `invoke_agent {agentName}` and carries `gen_ai.agent.name`, matching
   * the OTel GenAI "Invoke agent (internal)" span convention. Omitted spans
   * fall back to the bare `invoke_agent` name the conventions specify for
   * unnamed agents.
   */
  agentName?: string;
};

type InstrumentableActiveRun = {
  addEventListener: ActiveRun['addEventListener'];
};

/**
 * Subscribes to events on an ActiveRun and creates OpenTelemetry spans
 * that mirror the agent loop lifecycle.
 *
 * Span shape follows the OTel GenAI semantic conventions where a direct
 * mapping exists (the run span is `invoke_agent`); spans with no spec
 * equivalent (step, generate, tool batch) are kept as documented,
 * non-normative extensions. See the mapping table in the package README
 * (`operative/instrumentation` section) for the full rationale and the
 * pinned conventions version.
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
      'gen_ai.usage.input_tokens': usage.prompt,
      'gen_ai.usage.output_tokens': usage.completion,
      ...(usage.cacheCreationTokens !== undefined && {
        'gen_ai.usage.cache_creation.input_tokens': usage.cacheCreationTokens,
      }),
      ...(usage.cacheReadTokens !== undefined && {
        'gen_ai.usage.cache_read.input_tokens': usage.cacheReadTokens,
      }),
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
      // Normalize once so the span name and the gen_ai.agent.name attribute
      // never disagree — an empty or whitespace-only agentName is treated
      // as "no agent name supplied" for both.
      const agentName = options.agentName?.trim() || undefined;
      const spanName = agentName ? `invoke_agent ${agentName}` : 'invoke_agent';
      runSpan = tracer.startSpan(spanName, {
        kind: SpanKind.INTERNAL,
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          ...(agentName !== undefined && { 'gen_ai.agent.name': agentName }),
        },
      });
      runContext = trace.setSpan(context.active(), runSpan);
    },
    { signal },
  );

  activeRun.addEventListener(
    'step.started',
    (event) => {
      const { step } = event;
      // "step" has no OTel GenAI equivalent — it is operative's own loop
      // iteration boundary, kept as a documented, non-normative extension.
      // The span name is intentionally stable (not `step {n}`) to avoid
      // unbounded cardinality; the step index lives in an attribute.
      const stepSpan = tracer.startSpan(
        'step',
        { attributes: { 'operative.step.index': step } },
        runContext,
      );
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
      // This span observes the agent loop's call boundary around the
      // user-supplied GenerateFunction — it does not know provider/model
      // details. It is intentionally NOT labeled with `gen_ai.operation.name`
      // or a `chat`-style span name: the canonical, spec-compliant chat span
      // (with model, provider, and gen_ai.usage.*) comes from
      // `operative/providers/instrumentation`, wrapped around the same
      // GenerateFunction. Usage here is namespaced under `operative.*` so
      // the two instrumentation points never double-report gen_ai.usage.*
      // for the same call when both are wired up.
      const generateSpan = tracer.startSpan('generate', {}, stepContext);
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
          generateSpan.setAttributes({
            'operative.usage.prompt_tokens': response.usage.prompt,
            'operative.usage.completion_tokens': response.usage.completion,
            'operative.usage.total_tokens': response.usage.total,
          });
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
        generateSpan.setAttribute('error.type', error instanceof Error ? error.name : '_OTHER');
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
      // "tool_calls" has no OTel GenAI equivalent either — the conventions
      // define a per-call `execute_tool` span (emitted by
      // `armorer/instrumentation`), not a batch wrapper. This span groups
      // the calls issued in a single loop step; it is a documented,
      // non-normative extension.
      const toolsSpan = tracer.startSpan(
        'tool_calls',
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
        setUsageAttributes(runSpan, event.usage);
        runSpan.setAttributes({
          'gen_ai.response.finish_reasons': [event.finishReason],
          'operative.total_steps': event.steps.length,
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
        runSpan.setAttribute('error.type', error instanceof Error ? error.name : '_OTHER');
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
