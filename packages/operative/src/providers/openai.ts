import { parseOpenAIToolCalls } from 'armorer/adapters/openai';
import { toOpenAIMessagesGrouped } from 'conversationalist/adapters/openai';
import type { ToolCallInput } from 'interoperability';

import { ProviderError } from './errors.ts';
import { resolveOpenAIEffort } from './shared/effort.ts';
import { resolveOpenAIModel } from './shared/model-registry.ts';
import { resolveCommonParameters } from './shared/resolve-common-parameters.ts';
import { toOpenAIResponseFormat } from './structured-output/response-format-adapters.ts';
import { toOpenAIToolChoice } from './structured-output/tool-choice-adapters.ts';
import type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  OpenAIChatCompletion,
  OpenAIClient,
  OpenAIProviderOptions,
  OpenAIStreamingClient,
  StreamingGenerateFunction,
  StreamingHandle,
} from './types.ts';

/**
 * Build a provider-neutral {@link TokenUsage} from an OpenAI `usage` payload.
 *
 * OpenAI's `prompt_tokens` INCLUDES cached tokens — `prompt_tokens_details.
 * cached_tokens` is a subset of it, not a disjoint bucket like Anthropic's
 * cache fields. To keep `TokenUsage.prompt` meaning "fresh, non-cached input"
 * across providers, cached tokens are subtracted out of `prompt` here.
 * `cacheReadTokens` is only set when the API actually reported the field —
 * never fabricated as `0`. OpenAI has no cache-write counterpart, so
 * `cacheCreationTokens` is always absent for this provider.
 *
 * `prompt` is clamped at `0`: a malformed or inconsistent response (e.g.
 * `cached_tokens` exceeding `prompt_tokens`, or `prompt_tokens` missing while
 * `cached_tokens` is present) must never surface as a negative prompt count,
 * which would violate `TokenUsage`'s non-negative contract and corrupt any
 * downstream cost estimate.
 */
function buildOpenAIUsage(
  usage: NonNullable<OpenAIChatCompletion['usage']>,
): GenerateResponse['usage'] {
  const promptTokens = usage.prompt_tokens ?? 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  return {
    prompt: cachedTokens !== undefined ? Math.max(promptTokens - cachedTokens, 0) : promptTokens,
    completion: usage.completion_tokens ?? 0,
    total: usage.total_tokens ?? promptTokens + (usage.completion_tokens ?? 0),
    ...(cachedTokens !== undefined ? { cacheReadTokens: cachedTokens } : {}),
  };
}

/**
 * Creates a GenerateFunction backed by the OpenAI Chat Completions API.
 *
 * When no `client` is provided, dynamically imports `openai`
 * and constructs one using `apiKey` or the `OPENAI_API_KEY` env var.
 * The optional `baseURL` enables LM Studio, Ollama, Groq, etc.
 *
 * Note: "Provider" here is distinct from the Vercel AI SDK's concept of
 * "provider". This factory returns a `GenerateFunction` — a plain async
 * function that produces a `GenerateResponse` — not an SDK provider object.
 */
export function createOpenAIProvider(options: OpenAIProviderOptions): GenerateFunction {
  const { baseURL } = options;
  const resolvedModel = resolveOpenAIModel(options.model);
  const resolvedEffort = options.effort
    ? resolveOpenAIEffort(options.effort, resolvedModel)
    : undefined;
  const common = resolveCommonParameters(options);
  let clientPromise: Promise<OpenAIClient> | undefined;

  function getClient(): Promise<OpenAIClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = import('openai').then((module) => {
        const OpenAI = module.default ?? module.OpenAI;
        const clientOptions: Record<string, unknown> = {};
        if (options.apiKey) clientOptions['apiKey'] = options.apiKey;
        if (baseURL) clientOptions['baseURL'] = baseURL;
        return new OpenAI(clientOptions) as unknown as OpenAIClient;
      });
    }
    return clientPromise;
  }

  return async (context: GenerateContext): Promise<GenerateResponse> => {
    const client = await getClient();
    const messages = toOpenAIMessagesGrouped(context.conversation.current);
    const tools = await context.toolbox.toOpenAITools();
    const hasTools = tools.length > 0;

    const params: Record<string, unknown> = {
      model: resolvedModel,
      messages,
    };

    const effectiveMaxTokens = context.maximumTokens ?? common.maximumTokens;
    if (effectiveMaxTokens !== undefined) params['max_tokens'] = effectiveMaxTokens;
    if (resolvedEffort !== undefined) params['reasoning_effort'] = resolvedEffort;
    if (hasTools && options.toolChoice !== 'none') params['tools'] = tools;
    if (hasTools && options.toolChoice && options.toolChoice !== 'none')
      params['tool_choice'] = toOpenAIToolChoice(options.toolChoice);
    if (options.responseFormat) {
      const adapted = toOpenAIResponseFormat(options.responseFormat);
      if (adapted !== undefined) params['response_format'] = adapted;
    }
    if (common.temperature !== undefined) params['temperature'] = common.temperature;
    if (common.topP !== undefined) params['top_p'] = common.topP;
    if (common.stopSequences) params['stop'] = common.stopSequences;
    if (context.signal) params['signal'] = context.signal;

    try {
      const response = await client.chat.completions.create(params);

      const choice = response.choices[0];
      const content = choice?.message.content ?? '';
      const toolCalls = parseOpenAIToolCalls(choice?.message.tool_calls);

      const usage = response.usage ? buildOpenAIUsage(response.usage) : undefined;

      return {
        content,
        toolCalls,
        usage,
        metadata: {
          effectiveModel: resolvedModel,
          effectiveEffort: resolvedEffort ?? 'none',
        },
      };
    } catch (error) {
      throw new ProviderError({ provider: 'openai', cause: error });
    }
  };
}

/**
 * Creates a StreamingGenerateFunction backed by the OpenAI Chat Completions API.
 *
 * Streams chunks from the API, progressively calling `streaming.update`
 * with accumulated text and collecting tool call fragments into complete
 * ToolCallInput objects.
 *
 * When no `client` is provided, dynamically imports `openai`
 * and constructs one using `apiKey` or the `OPENAI_API_KEY` env var.
 * The optional `baseURL` enables LM Studio, Ollama, Groq, etc.
 */
export function createOpenAIProviderStream(
  options: Omit<OpenAIProviderOptions, 'client'> & { client?: OpenAIStreamingClient },
): StreamingGenerateFunction {
  const { baseURL } = options;
  const resolvedModel = resolveOpenAIModel(options.model);
  const resolvedEffort = options.effort
    ? resolveOpenAIEffort(options.effort, resolvedModel)
    : undefined;
  const common = resolveCommonParameters(options);
  let clientPromise: Promise<OpenAIStreamingClient> | undefined;

  function getClient(): Promise<OpenAIStreamingClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = import('openai').then((module) => {
        const OpenAI = module.default ?? module.OpenAI;
        const clientOptions: Record<string, unknown> = {};
        if (options.apiKey) clientOptions['apiKey'] = options.apiKey;
        if (baseURL) clientOptions['baseURL'] = baseURL;
        return new OpenAI(clientOptions) as unknown as OpenAIStreamingClient;
      });
    }
    return clientPromise;
  }

  return async (
    context: GenerateContext & { streaming: StreamingHandle },
  ): Promise<GenerateResponse> => {
    const client = await getClient();
    const { streaming } = context;
    const messages = toOpenAIMessagesGrouped(context.conversation.current);
    const tools = await context.toolbox.toOpenAITools();
    const hasTools = tools.length > 0;

    const params: Record<string, unknown> = {
      model: resolvedModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    const effectiveMaxTokensStream = context.maximumTokens ?? common.maximumTokens;
    if (effectiveMaxTokensStream !== undefined) params['max_tokens'] = effectiveMaxTokensStream;
    if (resolvedEffort !== undefined) params['reasoning_effort'] = resolvedEffort;
    if (hasTools && options.toolChoice !== 'none') params['tools'] = tools;
    if (hasTools && options.toolChoice && options.toolChoice !== 'none')
      params['tool_choice'] = toOpenAIToolChoice(options.toolChoice);
    if (options.responseFormat) {
      const adapted = toOpenAIResponseFormat(options.responseFormat);
      if (adapted !== undefined) params['response_format'] = adapted;
    }
    if (common.temperature !== undefined) params['temperature'] = common.temperature;
    if (common.topP !== undefined) params['top_p'] = common.topP;
    if (common.stopSequences) params['stop'] = common.stopSequences;
    if (context.signal) params['signal'] = context.signal;

    try {
      // Await handles both sync (mock) and async (real SDK APIPromise) returns
      const stream = await Promise.resolve(client.chat.completions.create(params));

      let accumulatedText = '';
      let usage: GenerateResponse['usage'] | undefined;

      // Track in-progress tool calls by index
      const pendingToolCalls: Map<number, { id?: string; name: string; arguments: string }> =
        new Map();

      for await (const chunk of stream) {
        if (context.signal?.aborted) break;
        const choice = chunk.choices[0];

        if (choice) {
          // Accumulate text content
          if (choice.delta.content != null) {
            accumulatedText += choice.delta.content;
            streaming.update(accumulatedText);
          }

          // Accumulate tool calls
          if (choice.delta.tool_calls) {
            for (const toolCallDelta of choice.delta.tool_calls) {
              const existing = pendingToolCalls.get(toolCallDelta.index);
              if (existing) {
                // Append arguments fragment
                if (toolCallDelta.function?.arguments) {
                  existing.arguments += toolCallDelta.function.arguments;
                }
              } else {
                // First chunk for this tool call index
                pendingToolCalls.set(toolCallDelta.index, {
                  id: toolCallDelta.id,
                  name: toolCallDelta.function?.name ?? '',
                  arguments: toolCallDelta.function?.arguments ?? '',
                });
              }
            }
          }
        }

        // Extract usage from the final chunk
        if (chunk.usage) {
          usage = buildOpenAIUsage(chunk.usage);
        }
      }

      // Build completed tool calls
      const toolCalls: ToolCallInput[] = [];
      for (const pending of pendingToolCalls.values()) {
        const parsedArguments = pending.arguments
          ? (JSON.parse(pending.arguments) as unknown)
          : undefined;
        toolCalls.push({
          id: pending.id,
          name: pending.name,
          arguments: parsedArguments,
        });
      }

      return {
        content: accumulatedText,
        toolCalls,
        usage,
        metadata: {
          effectiveModel: resolvedModel,
          effectiveEffort: resolvedEffort ?? 'none',
        },
      };
    } catch (error) {
      throw new ProviderError({ provider: 'openai', cause: error });
    }
  };
}
