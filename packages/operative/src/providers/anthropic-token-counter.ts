import { createAnthropicSdkClient, isAnthropicTokenCountingClient } from './anthropic-sdk.ts';
import { ProviderError } from './errors.ts';
import type {
  AnthropicCountTokensRequest,
  AnthropicTokenCountingClient,
  TokenCountResult,
} from './types.ts';

export interface AnthropicTokenCounterOptions {
  client?: AnthropicTokenCountingClient | undefined;
  apiKey?: string | undefined;
  baseURL?: string | undefined;
}

export interface AnthropicTokenCountingOperations {
  countTokens(request: AnthropicCountTokensRequest): Promise<TokenCountResult>;
}

export function createAnthropicTokenCounter(
  options: AnthropicTokenCounterOptions = {},
): AnthropicTokenCountingOperations {
  let clientPromise: Promise<AnthropicTokenCountingClient> | undefined;

  function getClient(): Promise<AnthropicTokenCountingClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = Promise.resolve().then(() => {
        const clientOptions: Record<string, unknown> = {};
        if (options.apiKey) clientOptions['apiKey'] = options.apiKey;
        if (options.baseURL) clientOptions['baseURL'] = options.baseURL;
        return createAnthropicSdkClient<AnthropicTokenCountingClient>(
          clientOptions,
          isAnthropicTokenCountingClient,
        );
      });
    }
    return clientPromise;
  }

  return {
    async countTokens(request: AnthropicCountTokensRequest): Promise<TokenCountResult> {
      try {
        const client = await getClient();
        const response = await client.messages.countTokens(request);
        return {
          totalTokens: response.input_tokens ?? 0,
          provider: 'anthropic',
          model: request.model,
        };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError({ provider: 'anthropic', cause: error });
      }
    },
  };
}
