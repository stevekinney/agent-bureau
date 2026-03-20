import type { AnthropicContentBlock } from 'armorer/adapters/anthropic';
import { parseAnthropicToolCalls, toAnthropicTools } from 'armorer/adapters/anthropic';
import { toAnthropicMessages } from 'conversationalist/adapters/anthropic';

import { HeraldError } from './errors.ts';
import type {
  AnthropicClient,
  AnthropicProviderOptions,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
} from './types.ts';

/**
 * Creates a GenerateFunction backed by the Anthropic Messages API.
 *
 * When no `client` is provided, dynamically imports `@anthropic-ai/sdk`
 * and constructs one using `apiKey` or the `ANTHROPIC_API_KEY` env var.
 */
export function createAnthropicGenerate(options: AnthropicProviderOptions): GenerateFunction {
  const { model, maximumTokens = 4096, temperature, topP, stopSequences } = options;
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
    if (hasTools) params['tools'] = Array.isArray(tools) ? tools : [tools];
    if (temperature !== undefined) params['temperature'] = temperature;
    if (topP !== undefined) params['top_p'] = topP;
    if (stopSequences !== undefined && stopSequences.length > 0) {
      params['stop_sequences'] = stopSequences;
    }
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
