import { parseOpenAIToolCalls, toOpenAITools } from 'armorer/adapters/openai';
import { toOpenAIMessagesGrouped } from 'conversationalist/adapters/openai';

import { HeraldError } from './errors.ts';
import type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  OpenAIClient,
  OpenAIProviderOptions,
} from './types.ts';

/**
 * Creates a GenerateFunction backed by the OpenAI Chat Completions API.
 *
 * When no `client` is provided, dynamically imports `openai`
 * and constructs one using `apiKey` or the `OPENAI_API_KEY` env var.
 * The optional `baseURL` enables LM Studio, Ollama, Groq, etc.
 */
export function createOpenAIGenerate(options: OpenAIProviderOptions): GenerateFunction {
  const { model, maximumTokens, temperature, topP, stopSequences, baseURL } = options;
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

    if (maximumTokens !== undefined) params['max_tokens'] = maximumTokens;
    if (hasTools) params['tools'] = Array.isArray(tools) ? tools : [tools];
    if (temperature !== undefined) params['temperature'] = temperature;
    if (topP !== undefined) params['top_p'] = topP;
    if (stopSequences !== undefined && stopSequences.length > 0) {
      params['stop'] = stopSequences;
    }
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
