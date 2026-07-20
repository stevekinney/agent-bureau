import type { AnthropicContentBlock } from 'armorer/adapters/anthropic';
import { parseAnthropicToolCalls } from 'armorer/adapters/anthropic';
import type { ConversationHistory, Message, MessageInput } from 'conversationalist';
import { appendMessages, createProjection } from 'conversationalist';
import { toAnthropicMessages } from 'conversationalist/adapters/anthropic';
import type { ToolCallInput } from 'interoperability';

import type { TokenBudget } from '../context/token-budget.ts';
import type { ContextAssembler } from '../context/types.ts';
import { ProviderError, ToolCallParseError } from './errors.ts';
import { resolveAnthropicEffort } from './shared/effort.ts';
import { resolveAnthropicModel } from './shared/model-registry.ts';
import { resolveCommonParameters } from './shared/resolve-common-parameters.ts';
import { toAnthropicToolChoice } from './structured-output/tool-choice-adapters.ts';
import type {
  AnthropicClient,
  AnthropicMessageResponse,
  AnthropicProviderOptions,
  AnthropicStreamingClient,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
} from './types.ts';

/**
 * Converts an assembled `Message` (from `ContextAssembler`) into the
 * `MessageInput` shape `appendMessages` expects, preserving the
 * `cacheBoundary` mark a stable-prefix assembly sets on the boundary message.
 */
function toMessageInput(message: Message): MessageInput {
  const content: MessageInput['content'] =
    typeof message.content === 'string' ? message.content : [...message.content];
  return {
    role: message.role,
    content,
    metadata: { ...message.metadata },
    hidden: message.hidden,
    ...(message.toolCall ? { toolCall: message.toolCall } : {}),
    ...(message.toolResult ? { toolResult: message.toolResult } : {}),
    ...(message.tokenUsage ? { tokenUsage: message.tokenUsage } : {}),
    ...(message.cacheBoundary ? { cacheBoundary: true as const } : {}),
  };
}

/**
 * Creates a stateful helper that runs `assembler` in stable-prefix mode on
 * every call and folds the result into an incremental `ConversationHistory`
 * through `createProjection` — the same conversation-level prefix-extension
 * mechanism AB-98 built for incremental streaming projections. Reusing one
 * projection instance across calls means the unchanged stable prefix is
 * never re-processed, only the new tail; the `cacheBoundary` mark that
 * landed on the prefix's last message the first time it was appended is
 * therefore preserved untouched for as long as it stays a prefix extension,
 * which is exactly what lets Anthropic's `cache_control` breakpoint survive
 * across steps.
 */
function createCacheAwareAssembly(
  assembler: ContextAssembler,
  budget: TokenBudget,
  pinnedMessages?: ReadonlyArray<Message>,
): (context: GenerateContext) => ConversationHistory {
  const projection = createProjection<Message>({
    identify: (message) => message.id,
    reduce: ({ conversation, event }) => appendMessages(conversation, toMessageInput(event)),
  });

  return (context: GenerateContext): ConversationHistory => {
    const { messages } = assembler({
      conversation: context.conversation,
      budget,
      stablePrefix: true,
      ...(pinnedMessages ? { pinnedMessages } : {}),
    });
    projection.apply(messages);
    return projection.snapshot();
  };
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
      max_tokens: context.maximumTokens ?? maximumTokens,
    };

    if (system !== undefined) params['system'] = system;
    if (resolvedEffort !== undefined) params['output_config'] = { effort: resolvedEffort };
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

      const toolCalls = parseAnthropicToolCalls(
        response.content as unknown as AnthropicContentBlock[],
      );

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
      max_tokens: context.maximumTokens ?? maximumTokens,
      stream: true,
    };

    if (system !== undefined) params['system'] = system;
    if (resolvedEffort !== undefined) params['output_config'] = { effort: resolvedEffort };
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

      // Build completed tool calls
      const toolCalls: ToolCallInput[] = [];
      for (const pending of pendingToolCalls.values()) {
        let parsedArguments: unknown;
        if (pending.partialJson) {
          try {
            parsedArguments = JSON.parse(pending.partialJson) as unknown;
          } catch (parseError) {
            throw new ToolCallParseError({
              provider: 'anthropic',
              toolName: pending.name,
              toolCallId: pending.id ?? '',
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
