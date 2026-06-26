import type { Tracer } from '@opentelemetry/api';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import type { GenerateFunction, GenerateResponse, ProviderName } from '../types';

export type InstrumentationOptions = {
  tracer?: Tracer;
  tracerName?: string;
  tracerVersion?: string;
};

export type InstrumentableGenerateOptions = {
  provider: ProviderName;
  model: string;
  maximumTokens?: number;
};

/**
 * Wraps a GenerateFunction with OpenTelemetry tracing.
 *
 * Each call creates a span tracking the LLM request lifecycle,
 * including provider, model, token usage, and error information.
 *
 * @param generateFunction - The GenerateFunction to instrument.
 * @param options - Provider metadata and optional tracer configuration.
 * @returns A wrapped GenerateFunction with tracing.
 */
export function instrument(
  generateFunction: GenerateFunction,
  options: InstrumentableGenerateOptions & InstrumentationOptions,
): GenerateFunction {
  const tracer =
    options.tracer ??
    trace.getTracer(options.tracerName ?? 'operative', options.tracerVersion ?? '0.0.0');

  return async (context) => {
    const span = tracer.startSpan(`gen_ai.generate ${options.provider}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.system': 'operative',
        'gen_ai.provider': options.provider,
        'gen_ai.request.model': options.model,
        ...(options.maximumTokens !== undefined && {
          'gen_ai.request.max_tokens': options.maximumTokens,
        }),
      },
    });

    try {
      const response: GenerateResponse = await generateFunction(context);

      if (response.usage) {
        span.setAttributes({
          'gen_ai.response.prompt_tokens': response.usage.prompt,
          'gen_ai.response.completion_tokens': response.usage.completion,
          'gen_ai.response.total_tokens': response.usage.total,
        });
      }

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();

      return response;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error) {
        span.recordException(error);
      }
      span.end();
      throw error;
    }
  };
}
