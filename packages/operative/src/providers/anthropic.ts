import { parseAnthropicToolCalls } from 'armorer/adapters/anthropic';
import { toAnthropicMessages } from 'conversationalist/adapters/anthropic';
import type { ToolCallInput } from 'interoperability';

import { ProviderError, ToolCallParseError } from './errors.ts';
import { createCacheAwareAssembly } from './shared/cache-aware-assembly.ts';
import { resolveAnthropicEffort } from './shared/effort.ts';
import { resolveAnthropicModel } from './shared/model-registry.ts';
import { resolveCommonParameters } from './shared/resolve-common-parameters.ts';
import { toAnthropicToolChoice } from './structured-output/tool-choice-adapters.ts';
import type {
  AnthropicClient,
  AnthropicMessageResponse,
  AnthropicProviderOptions,
  AnthropicStreamingClient,
  AnthropicThinkingConfig,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
} from './types.ts';

/**
 * Anthropic's floor for an enabled thinking budget, quoted from
 * `ThinkingConfigEnabled` in `@anthropic-ai/sdk`: "Must be ≥1024 and less than
 * `max_tokens`."
 */
const MINIMUM_THINKING_BUDGET_TOKENS = 1024;

/**
 * Rejects an `{ type: 'enabled' }` thinking budget that Anthropic's API cannot
 * accept, naming both numbers involved.
 *
 * Both halves of the SDK's documented constraint are checked. The upper bound
 * is the interesting one: `budget_tokens` must be strictly *less than*
 * `max_tokens`, so a plausible-looking `{ budget_tokens: 4096 }` against this
 * package's default `maximumTokens` of 4096 is invalid by construction and
 * earns a reliable 400 on every request.
 *
 * This throws rather than adjusting either number, deliberately. Quietly
 * raising `max_tokens` would change billing the caller never asked for, and
 * quietly lowering `budget_tokens` would degrade the feature they explicitly
 * requested — both would substitute our guess for their intent. The error is a
 * configuration fault, so it carries no status code and is not retryable.
 *
 * Called at construction against the provider's own `maximumTokens`, and again
 * per request when `GenerateContext.maximumTokens` overrides it — the
 * constraint is against the `max_tokens` actually sent, which the caller can
 * still lower after the provider is built.
 */
function assertThinkingBudgetFits(
  thinking: AnthropicThinkingConfig | undefined,
  maximumTokens: number,
): void {
  if (thinking?.type !== 'enabled') return;

  const budget = thinking.budget_tokens;

  if (budget < MINIMUM_THINKING_BUDGET_TOKENS) {
    throw new ProviderError({
      provider: 'anthropic',
      cause: undefined,
      message:
        `[provider:anthropic] thinking.budget_tokens (${budget}) is below Anthropic's minimum ` +
        `of ${MINIMUM_THINKING_BUDGET_TOKENS}.`,
    });
  }

  if (budget >= maximumTokens) {
    throw new ProviderError({
      provider: 'anthropic',
      cause: undefined,
      message:
        `[provider:anthropic] thinking.budget_tokens (${budget}) must be less than max_tokens ` +
        `(${maximumTokens}). Raise maximumTokens above ${budget}, or lower thinking.budget_tokens ` +
        `below ${maximumTokens}.`,
    });
  }
}

/**
 * Build a provider-neutral {@link TokenUsage} from an Anthropic `usage` payload.
 *
 * Anthropic's `input_tokens` already EXCLUDES cache activity — it,
 * `cache_creation_input_tokens`, and `cache_read_input_tokens` are three
 * disjoint buckets. `cacheCreationTokens`/`cacheReadTokens` are only set when
 * the API actually reported the field; they are never fabricated as `0`.
 */
function buildAnthropicUsage(
  usage: NonNullable<AnthropicMessageResponse['usage']>,
): GenerateResponse['usage'] {
  return {
    prompt: usage.input_tokens ?? 0,
    completion: usage.output_tokens ?? 0,
    total: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    ...(usage.cache_creation_input_tokens !== undefined
      ? { cacheCreationTokens: usage.cache_creation_input_tokens }
      : {}),
    ...(usage.cache_read_input_tokens !== undefined
      ? { cacheReadTokens: usage.cache_read_input_tokens }
      : {}),
  };
}

/**
 * Creates a GenerateFunction backed by the Anthropic Messages API.
 *
 * When no `client` is provided, dynamically imports `@anthropic-ai/sdk`
 * and constructs one using `apiKey` or the `ANTHROPIC_API_KEY` env var.
 *
 * Note: "Provider" here is distinct from the Vercel AI SDK's concept of
 * "provider". This factory returns a `GenerateFunction` — a plain async
 * function that produces a `GenerateResponse` — not an SDK provider object.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): GenerateFunction {
  const { maximumTokens = 4096 } = options;
  assertThinkingBudgetFits(options.thinking, maximumTokens);
  const resolvedModel = resolveAnthropicModel(options.model);
  const resolvedEffort = options.effort
    ? resolveAnthropicEffort(options.effort, resolvedModel)
    : undefined;
  const common = resolveCommonParameters(options);
  let clientPromise: Promise<AnthropicClient> | undefined;
  const cacheAwareAssembly =
    options.assembler && options.contextBudget
      ? createCacheAwareAssembly(options.assembler, options.contextBudget, options.pinnedMessages)
      : undefined;

  function getClient(): Promise<AnthropicClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = import('@anthropic-ai/sdk').then((module) => {
        const Anthropic = module.default ?? module.Anthropic;
        const clientOptions: Record<string, unknown> = { apiKey: options.apiKey };
        if (options.baseURL) clientOptions['baseURL'] = options.baseURL;
        return new Anthropic(clientOptions) as unknown as AnthropicClient;
      });
    }
    return clientPromise;
  }

  return async (context: GenerateContext): Promise<GenerateResponse> => {
    const effectiveMaximumTokens = context.maximumTokens ?? maximumTokens;
    assertThinkingBudgetFits(options.thinking, effectiveMaximumTokens);
    const client = await getClient();
    const conversationForRequest = cacheAwareAssembly
      ? cacheAwareAssembly(context)
      : context.conversation.current;
    const { system, messages } = toAnthropicMessages(
      conversationForRequest,
      options.extendedCacheTtl ? { extendedCacheTtl: true } : undefined,
    );
    const tools = await context.toolbox.toAnthropicTools();
    const hasTools = tools.length > 0;

    const params: Record<string, unknown> = {
      model: resolvedModel,
      messages,
      max_tokens: effectiveMaximumTokens,
    };

    if (system !== undefined) params['system'] = system;
    if (resolvedEffort !== undefined) params['output_config'] = { effort: resolvedEffort };
    if (options.thinking) params['thinking'] = options.thinking;
    if (options.requestMetadata) params['metadata'] = options.requestMetadata;

    // Tool choice: when 'none', omit tools entirely; otherwise set tool_choice
    if (options.toolChoice === 'none') {
      // Anthropic has no tool_choice 'none' — omit tools to prevent calls
    } else if (hasTools) {
      params['tools'] = tools;
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

      const toolCalls = parseAnthropicToolCalls(response.content);

      const usage = response.usage ? buildAnthropicUsage(response.usage) : undefined;

      return {
        content: textParts.join(''),
        toolCalls,
        usage,
        metadata: {
          effectiveModel: resolvedModel,
          effectiveEffort: resolvedEffort ?? 'none',
        },
      };
    } catch (error) {
      throw new ProviderError({ provider: 'anthropic', cause: error });
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
export function createAnthropicProviderStream(
  options: Omit<AnthropicProviderOptions, 'client'> & { client?: AnthropicStreamingClient },
): StreamingGenerateFunction {
  const { maximumTokens = 4096 } = options;
  assertThinkingBudgetFits(options.thinking, maximumTokens);
  const resolvedModel = resolveAnthropicModel(options.model);
  const resolvedEffort = options.effort
    ? resolveAnthropicEffort(options.effort, resolvedModel)
    : undefined;
  const common = resolveCommonParameters(options);
  let clientPromise: Promise<AnthropicStreamingClient> | undefined;
  const cacheAwareAssembly =
    options.assembler && options.contextBudget
      ? createCacheAwareAssembly(options.assembler, options.contextBudget, options.pinnedMessages)
      : undefined;

  function getClient(): Promise<AnthropicStreamingClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = import('@anthropic-ai/sdk').then((module) => {
        const Anthropic = module.default ?? module.Anthropic;
        const clientOptions: Record<string, unknown> = { apiKey: options.apiKey };
        if (options.baseURL) clientOptions['baseURL'] = options.baseURL;
        return new Anthropic(clientOptions) as unknown as AnthropicStreamingClient;
      });
    }
    return clientPromise;
  }

  return async (
    context: GenerateContext & { streaming: StreamingHandle },
  ): Promise<GenerateResponse> => {
    const effectiveMaximumTokens = context.maximumTokens ?? maximumTokens;
    assertThinkingBudgetFits(options.thinking, effectiveMaximumTokens);
    const client = await getClient();
    const { streaming } = context;
    const conversationForRequest = cacheAwareAssembly
      ? cacheAwareAssembly(context)
      : context.conversation.current;
    const { system, messages } = toAnthropicMessages(
      conversationForRequest,
      options.extendedCacheTtl ? { extendedCacheTtl: true } : undefined,
    );
    const tools = await context.toolbox.toAnthropicTools();
    const hasTools = tools.length > 0;

    const params: Record<string, unknown> = {
      model: resolvedModel,
      messages,
      max_tokens: effectiveMaximumTokens,
      stream: true,
    };

    if (system !== undefined) params['system'] = system;
    if (resolvedEffort !== undefined) params['output_config'] = { effort: resolvedEffort };
    if (options.thinking) params['thinking'] = options.thinking;
    if (options.requestMetadata) params['metadata'] = options.requestMetadata;

    // Tool choice: when 'none', omit tools entirely; otherwise set tool_choice
    if (options.toolChoice === 'none') {
      // Anthropic has no tool_choice 'none' — omit tools to prevent calls
    } else if (hasTools) {
      params['tools'] = tools;
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
      let cacheCreationTokens: number | undefined;
      let cacheReadTokens: number | undefined;

      // Track in-progress tool calls by content block index
      const pendingToolCalls: Map<number, { id?: string; name: string; partialJson: string }> =
        new Map();

      for await (const event of stream) {
        if (context.signal?.aborted) break;
        switch (event.type) {
          case 'message_start': {
            inputTokens = event.message?.usage?.input_tokens;
            cacheCreationTokens = event.message?.usage?.cache_creation_input_tokens;
            cacheReadTokens = event.message?.usage?.cache_read_input_tokens;
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

      // Build completed tool calls. Skipped entirely when the caller aborted mid-stream:
      // any accumulated partialJson is caller-truncated, not model-malformed, so it must
      // never be parsed and misreported as a ToolCallParseError.
      const toolCalls: ToolCallInput[] = [];
      if (!context.signal?.aborted) {
        for (const pending of pendingToolCalls.values()) {
          let parsedArguments: unknown;
          if (pending.partialJson) {
            try {
              parsedArguments = JSON.parse(pending.partialJson) as unknown;
            } catch (parseError) {
              throw new ToolCallParseError({
                provider: 'anthropic',
                toolName: pending.name,
                toolCallId: pending.id,
                rawArguments: pending.partialJson,
                cause: parseError,
              });
            }
          }
          toolCalls.push({
            id: pending.id,
            name: pending.name,
            arguments: parsedArguments,
          });
        }
      }

      // Build usage
      const usage =
        inputTokens !== undefined || outputTokens !== undefined
          ? {
              prompt: inputTokens ?? 0,
              completion: outputTokens ?? 0,
              total: (inputTokens ?? 0) + (outputTokens ?? 0),
              ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
              ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
            }
          : undefined;

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
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({ provider: 'anthropic', cause: error });
    }
  };
}
