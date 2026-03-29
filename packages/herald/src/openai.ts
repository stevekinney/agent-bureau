import { parseOpenAIToolCalls, toOpenAITools } from 'armorer/adapters/openai';
import { toOpenAIMessagesGrouped } from 'conversationalist/adapters/openai';
import type { ToolCallInput } from 'interoperability';

import { HeraldError } from './errors.ts';
import { resolveCommonParameters } from './resolve-common-parameters.ts';
import { toOpenAIResponseFormat } from './structured-output/response-format-adapters.ts';
import { toOpenAIToolChoice } from './structured-output/tool-choice-adapters.ts';
import type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  OpenAIClient,
  OpenAIProviderOptions,
  OpenAIStreamingClient,
  StreamingGenerateFunction,
  StreamingHandle,
} from './types.ts';

/**
 * Creates a GenerateFunction backed by the OpenAI Chat Completions API.
 *
 * When no `client` is provided, dynamically imports `openai`
 * and constructs one using `apiKey` or the `OPENAI_API_KEY` env var.
 * The optional `baseURL` enables LM Studio, Ollama, Groq, etc.
 */
export function createOpenAIGenerate(options: OpenAIProviderOptions): GenerateFunction {
  const { model, baseURL } = options;
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
    const tools = toOpenAITools(context.toolbox);
    const hasTools = Array.isArray(tools) ? tools.length > 0 : true;

    const params: Record<string, unknown> = {
      model,
      messages,
    };

    if (common.maximumTokens !== undefined) params['max_tokens'] = common.maximumTokens;
    if (hasTools) params['tools'] = Array.isArray(tools) ? tools : [tools];
    if (options.toolChoice) params['tool_choice'] = toOpenAIToolChoice(options.toolChoice);
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

      const usage = response.usage
        ? {
            prompt: response.usage.prompt_tokens ?? 0,
            completion: response.usage.completion_tokens ?? 0,
            total:
              response.usage.total_tokens ??
              (response.usage.prompt_tokens ?? 0) + (response.usage.completion_tokens ?? 0),
          }
        : undefined;

      return {
        content,
        toolCalls,
        usage,
      };
    } catch (error) {
      throw new HeraldError({ provider: 'openai', cause: error });
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
export function createOpenAIGenerateStream(
  options: Omit<OpenAIProviderOptions, 'client'> & { client?: OpenAIStreamingClient },
): StreamingGenerateFunction {
  const { model, baseURL } = options;
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
    const tools = toOpenAITools(context.toolbox);
    const hasTools = Array.isArray(tools) ? tools.length > 0 : true;

    const params: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (common.maximumTokens !== undefined) params['max_tokens'] = common.maximumTokens;
    if (hasTools) params['tools'] = Array.isArray(tools) ? tools : [tools];
    if (options.toolChoice) params['tool_choice'] = toOpenAIToolChoice(options.toolChoice);
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
          usage = {
            prompt: chunk.usage.prompt_tokens ?? 0,
            completion: chunk.usage.completion_tokens ?? 0,
            total:
              chunk.usage.total_tokens ??
              (chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0),
          };
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
      };
    } catch (error) {
      throw new HeraldError({ provider: 'openai', cause: error });
    }
  };
}
