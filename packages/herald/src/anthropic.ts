import type { AnthropicContentBlock } from 'armorer/adapters/anthropic';
import { parseAnthropicToolCalls, toAnthropicTools } from 'armorer/adapters/anthropic';
import { toAnthropicMessages } from 'conversationalist/adapters/anthropic';
import type { ToolCallInput } from 'interoperability';

import { HeraldError } from './errors.ts';
import { resolveCommonParameters } from './resolve-common-parameters.ts';
import { toAnthropicToolChoice } from './structured-output/tool-choice-adapters.ts';
import type {
  AnthropicClient,
  AnthropicProviderOptions,
  AnthropicStreamingClient,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
} from './types.ts';

/**
 * Creates a GenerateFunction backed by the Anthropic Messages API.
 *
 * When no `client` is provided, dynamically imports `@anthropic-ai/sdk`
 * and constructs one using `apiKey` or the `ANTHROPIC_API_KEY` env var.
 */
export function createAnthropicGenerate(options: AnthropicProviderOptions): GenerateFunction {
  const { model, maximumTokens = 4096 } = options;
  const common = resolveCommonParameters(options);
  let clientPromise: Promise<AnthropicClient> | undefined;

  function getClient(): Promise<AnthropicClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = import('@anthropic-ai/sdk').then((module) => {
        const Anthropic = module.default ?? module.Anthropic;
        return new Anthropic({ apiKey: options.apiKey }) as unknown as AnthropicClient;
      });
    }
    return clientPromise;
  }

  return async (context: GenerateContext): Promise<GenerateResponse> => {
    const client = await getClient();
    const { system, messages } = toAnthropicMessages(context.conversation.current);
    const tools = toAnthropicTools(context.toolbox);
    const hasTools = Array.isArray(tools) ? tools.length > 0 : true;

    const params: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maximumTokens,
    };

    if (system !== undefined) params['system'] = system;

    // Tool choice: when 'none', omit tools entirely; otherwise set tool_choice
    if (options.toolChoice === 'none') {
      // Anthropic has no tool_choice 'none' — omit tools to prevent calls
    } else if (hasTools) {
      params['tools'] = Array.isArray(tools) ? tools : [tools];
      if (options.toolChoice) {
        const adapted = toAnthropicToolChoice(options.toolChoice);
        if (adapted !== undefined) {
          params['tool_choice'] = adapted;
        }
      }
    }

    if (common.temperature !== undefined) params['temperature'] = common.temperature;
    if (common.topP !== undefined) params['top_p'] = common.topP;
    if (common.stopSequences) params['stop_sequences'] = common.stopSequences;
    if (context.signal) params['signal'] = context.signal;

    try {
      const response = await client.messages.create(params);

      const textParts: string[] = [];
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        }
      }

      const toolCalls = parseAnthropicToolCalls(
        response.content as unknown as AnthropicContentBlock[],
      );

      const usage = response.usage
        ? {
            prompt: response.usage.input_tokens ?? 0,
            completion: response.usage.output_tokens ?? 0,
            total: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
          }
        : undefined;

      return {
        content: textParts.join(''),
        toolCalls,
        usage,
      };
    } catch (error) {
      throw new HeraldError({ provider: 'anthropic', cause: error });
    }
  };
}

/**
 * Creates a StreamingGenerateFunction backed by the Anthropic Messages API.
 *
 * Streams events from the API, progressively calling `streaming.update`
 * with accumulated text and collecting tool call fragments into complete
 * ToolCallInput objects.
 *
 * When no `client` is provided, dynamically imports `@anthropic-ai/sdk`
 * and constructs one using `apiKey` or the `ANTHROPIC_API_KEY` env var.
 */
export function createAnthropicGenerateStream(
  options: Omit<AnthropicProviderOptions, 'client'> & { client?: AnthropicStreamingClient },
): StreamingGenerateFunction {
  const { model, maximumTokens = 4096 } = options;
  const common = resolveCommonParameters(options);
  let clientPromise: Promise<AnthropicStreamingClient> | undefined;

  function getClient(): Promise<AnthropicStreamingClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = import('@anthropic-ai/sdk').then((module) => {
        const Anthropic = module.default ?? module.Anthropic;
        return new Anthropic({ apiKey: options.apiKey }) as unknown as AnthropicStreamingClient;
      });
    }
    return clientPromise;
  }

  return async (
    context: GenerateContext & { streaming: StreamingHandle },
  ): Promise<GenerateResponse> => {
    const client = await getClient();
    const { streaming } = context;
    const { system, messages } = toAnthropicMessages(context.conversation.current);
    const tools = toAnthropicTools(context.toolbox);
    const hasTools = Array.isArray(tools) ? tools.length > 0 : true;

    const params: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maximumTokens,
      stream: true,
    };

    if (system !== undefined) params['system'] = system;

    // Tool choice: when 'none', omit tools entirely; otherwise set tool_choice
    if (options.toolChoice === 'none') {
      // Anthropic has no tool_choice 'none' — omit tools to prevent calls
    } else if (hasTools) {
      params['tools'] = Array.isArray(tools) ? tools : [tools];
      if (options.toolChoice) {
        const adapted = toAnthropicToolChoice(options.toolChoice);
        if (adapted !== undefined) {
          params['tool_choice'] = adapted;
        }
      }
    }

    if (common.temperature !== undefined) params['temperature'] = common.temperature;
    if (common.topP !== undefined) params['top_p'] = common.topP;
    if (common.stopSequences) params['stop_sequences'] = common.stopSequences;
    if (context.signal) params['signal'] = context.signal;

    try {
      // Await handles both sync (mock) and async (real SDK APIPromise) returns
      const stream = await Promise.resolve(client.messages.create(params));

      let accumulatedText = '';
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;

      // Track in-progress tool calls by content block index
      const pendingToolCalls: Map<number, { id?: string; name: string; partialJson: string }> =
        new Map();

      for await (const event of stream) {
        if (context.signal?.aborted) break;
        switch (event.type) {
          case 'message_start': {
            inputTokens = event.message?.usage?.input_tokens;
            break;
          }

          case 'content_block_start': {
            if (event.content_block?.type === 'tool_use' && event.index !== undefined) {
              pendingToolCalls.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name!,
                partialJson: '',
              });
            }
            break;
          }

          case 'content_block_delta': {
            if (event.delta?.type === 'text_delta' && event.delta.text) {
              accumulatedText += event.delta.text;
              streaming.update(accumulatedText);
            } else if (
              event.delta?.type === 'input_json_delta' &&
              event.delta.partial_json !== undefined &&
              event.index !== undefined
            ) {
              const pending = pendingToolCalls.get(event.index);
              if (pending) {
                pending.partialJson += event.delta.partial_json;
              }
            }
            break;
          }

          case 'message_delta': {
            outputTokens = event.usage?.output_tokens;
            break;
          }
        }
      }

      // Build completed tool calls
      const toolCalls: ToolCallInput[] = [];
      for (const pending of pendingToolCalls.values()) {
        const parsedArguments = pending.partialJson
          ? (JSON.parse(pending.partialJson) as unknown)
          : undefined;
        toolCalls.push({
          id: pending.id,
          name: pending.name,
          arguments: parsedArguments,
        });
      }

      // Build usage
      const usage =
        inputTokens !== undefined || outputTokens !== undefined
          ? {
              prompt: inputTokens ?? 0,
              completion: outputTokens ?? 0,
              total: (inputTokens ?? 0) + (outputTokens ?? 0),
            }
          : undefined;

      return {
        content: accumulatedText,
        toolCalls,
        usage,
      };
    } catch (error) {
      throw new HeraldError({ provider: 'anthropic', cause: error });
    }
  };
}
