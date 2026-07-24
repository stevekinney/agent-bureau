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
 * Maps operative's internal {@link ProviderName} to the OTel GenAI
 * `gen_ai.provider.name` well-known value. Providers without a registered
 * well-known value pass through unchanged — the conventions explicitly
 * allow a custom value when none of the predefined ones applies.
 *
 * See the mapping table in the package README (`@lostgradient/operative/instrumentation`
 * section) for the pinned conventions version.
 */
function toGenAiProviderName(provider: ProviderName): string {
  switch (provider) {
    case 'gemini':
      // operative's `gemini` provider talks to the AI Studio endpoint
      // (generativelanguage.googleapis.com) via @google/generative-ai,
      // which the conventions register as `gcp.gemini`.
      return 'gcp.gemini';
    case 'anthropic':
    case 'openai':
      return provider;
    case 'voyage':
    case 'ollama':
      // No well-known value is registered for these providers; a custom
      // value is explicitly permitted by the conventions.
      return provider;
  }
}

/**
 * Maps operative's internal {@link ProviderName} to the OTel GenAI
 * `gen_ai.operation.name` well-known value. Gemini's native surface is the
 * `generateContent` API, which the conventions register as
 * `generate_content` (not `chat`); every other shipped provider is a
 * turn-based chat completion API and maps to `chat`.
 */
function toGenAiOperationName(provider: ProviderName): 'chat' | 'generate_content' {
  return provider === 'gemini' ? 'generate_content' : 'chat';
}

/**
 * Wraps a GenerateFunction with OpenTelemetry tracing following the OTel
 * GenAI "Inference" span conventions. `gen_ai.operation.name` is `chat` for
 * turn-based chat completion providers and `generate_content` for Gemini's
 * native `generateContent` surface — see {@link toGenAiOperationName}.
 *
 * Each call creates a CLIENT span named `{operation} {model}` tracking the
 * LLM request lifecycle, including provider, model, and token usage.
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
    const operationName = toGenAiOperationName(options.provider);
    const span = tracer.startSpan(`${operationName} ${options.model}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.operation.name': operationName,
        'gen_ai.provider.name': toGenAiProviderName(options.provider),
        'gen_ai.request.model': options.model,
        ...(options.maximumTokens !== undefined && {
          'gen_ai.request.max_tokens': options.maximumTokens,
        }),
      },
    });

    try {
      const response: GenerateResponse = await generateFunction(context);

      if (response.usage) {
        const { prompt, completion, cacheCreationTokens, cacheReadTokens } = response.usage;
        span.setAttributes({
          'gen_ai.usage.input_tokens': prompt,
          'gen_ai.usage.output_tokens': completion,
          ...(cacheCreationTokens !== undefined && {
            'gen_ai.usage.cache_creation.input_tokens': cacheCreationTokens,
          }),
          ...(cacheReadTokens !== undefined && {
            'gen_ai.usage.cache_read.input_tokens': cacheReadTokens,
          }),
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
      span.setAttribute('error.type', error instanceof Error ? error.name : '_OTHER');
      if (error instanceof Error) {
        span.recordException(error);
      }
      span.end();
      throw error;
    }
  };
}
