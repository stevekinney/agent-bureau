import { parseAnthropicToolCalls } from 'armorer';
import { toAnthropicMessages } from 'conversationalist';

import { createAnthropicSdkClient, isAnthropicClient } from './anthropic-sdk.ts';
import {
  anthropicDescriptorsFor,
  assertThinkingBudgetBelowMaximum,
  assertThinkingBudgetMeetsMinimum,
  assertThinkingParametersCompatible,
  buildAnthropicMessageRequest,
  buildAnthropicUsage,
} from './anthropic-shared.ts';
import { withBackendDescriptors } from './backend-descriptor-attachment.ts';
import { ProviderError } from './errors.ts';
import {
  classifyProviderError,
  extractSamplingParameterFields,
  type SamplingParameterField,
} from './fallover/classify-error.ts';
import { createCacheAwareAssembly } from './shared/cache-aware-assembly.ts';
import { resolveAnthropicEffort } from './shared/effort.ts';
import { resolveAnthropicModel } from './shared/model-registry.ts';
import { resolveCommonParameters } from './shared/resolve-common-parameters.ts';
import type {
  AnthropicClient,
  AnthropicMessageResponse,
  AnthropicProviderOptions,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
} from './types.ts';

export {
  createAnthropicTokenCounter,
  type AnthropicTokenCounterOptions,
  type AnthropicTokenCountingOperations,
} from './anthropic-token-counter.ts';

/**
 * Creates a GenerateFunction backed by the Anthropic Messages API.
 *
 * When no `client` is provided, lazily loads `@anthropic-ai/sdk` in Bun or Node.js
 * and constructs one using `apiKey` or the `ANTHROPIC_API_KEY` env var.
 *
 * Note: "Provider" here is distinct from the Vercel AI SDK's concept of
 * "provider". This factory returns a `GenerateFunction` — a plain async
 * function that produces a `GenerateResponse` — not an SDK provider object.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): GenerateFunction {
  const { maximumTokens = 4096 } = options;
  const resolvedModel = resolveAnthropicModel(options.model);
  const resolvedEffort = options.effort
    ? resolveAnthropicEffort(options.effort, resolvedModel)
    : undefined;
  const common = resolveCommonParameters(options);
  assertThinkingBudgetMeetsMinimum(options.thinking);
  assertThinkingParametersCompatible(options.thinking, options.toolChoice, common);
  let clientPromise: Promise<AnthropicClient> | undefined;
  const cacheAwareAssembly =
    options.assembler && options.contextBudget
      ? createCacheAwareAssembly(options.assembler, options.contextBudget, options.pinnedMessages)
      : undefined;

  function getClient(): Promise<AnthropicClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = Promise.resolve().then(() => {
        const clientOptions: Record<string, unknown> = { apiKey: options.apiKey };
        if (options.baseURL) clientOptions['baseURL'] = options.baseURL;
        return createAnthropicSdkClient<AnthropicClient>(clientOptions, isAnthropicClient);
      });
    }
    return clientPromise;
  }

  const generate: GenerateFunction = async (
    context: GenerateContext,
  ): Promise<GenerateResponse> => {
    const effectiveMaximumTokens = context.maximumTokens ?? maximumTokens;
    assertThinkingBudgetBelowMaximum(options.thinking, effectiveMaximumTokens);
    const client = await getClient();
    const conversationForRequest = cacheAwareAssembly
      ? cacheAwareAssembly(context)
      : context.conversation.current;
    const { system, messages } = toAnthropicMessages(
      conversationForRequest,
      options.extendedCacheTtl ? { extendedCacheTtl: true } : undefined,
    );
    const tools = await context.toolbox.toAnthropicTools();
    const params = buildAnthropicMessageRequest({
      model: resolvedModel,
      messages,
      maxTokens: effectiveMaximumTokens,
      system,
      effort: resolvedEffort,
      thinking: options.thinking,
      metadata: options.requestMetadata,
      tools,
      toolChoice: options.toolChoice,
      common,
    });

    const requestOptions = context.signal ? { signal: context.signal } : undefined;

    try {
      const response = await client.messages.create(params, requestOptions);

      return createAnthropicResponse(response, resolvedModel, resolvedEffort);
    } catch (error) {
      throw (
        samplingParameterRejection(error, resolvedModel) ??
        new ProviderError({ provider: 'anthropic', cause: error })
      );
    }
  };

  return withBackendDescriptors(generate, anthropicDescriptorsFor(resolvedModel));
}

export { createAnthropicProviderStream } from './anthropic-stream.ts';

const SAMPLING_PARAMETER_DESCRIPTIONS: Record<SamplingParameterField, string> = {
  temperature: '`temperature`',
  top_p: '`top_p` (option `topP`)',
  top_k: '`top_k`',
};

/**
 * Turns Anthropic's 400 for a sampling parameter the resolved model no longer
 * accepts into an error naming the rejected fields, the model, and the remedy.
 * Returns `undefined` for any other failure, which keeps its plain wrapping.
 *
 * Recognized after the response rather than checked against a model list,
 * which would go stale with every release. The construction-time thinking
 * guard (`assertThinkingParametersCompatible`) throws before any request is
 * sent, so the two never fire for the same request.
 */
function samplingParameterRejection(
  error: unknown,
  resolvedModel: string,
): ProviderError | undefined {
  if (classifyProviderError(error) !== 'sampling-parameter-unsupported') return undefined;

  const fields = extractSamplingParameterFields(error);
  const described = fields.map((field) => SAMPLING_PARAMETER_DESCRIPTIONS[field]).join(', ');
  const remedy = fields.length === 1 ? 'drop it' : 'drop them';

  return new ProviderError({
    provider: 'anthropic',
    cause: error,
    message:
      `[provider:anthropic] Model ${resolvedModel} rejected ${described}; ${remedy} from the ` +
      `provider options. Provider message: ${providerMessageOf(error)}`,
  });
}

function providerMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return 'Unknown error';
}

function createAnthropicResponse(
  response: AnthropicMessageResponse,
  model: string,
  effort: string | undefined,
): GenerateResponse {
  const text = response.content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('');
  return {
    content: text,
    toolCalls: parseAnthropicToolCalls(response.content),
    usage: response.usage ? buildAnthropicUsage(response.usage) : undefined,
    metadata: { effectiveModel: model, effectiveEffort: effort ?? 'none' },
  };
}
