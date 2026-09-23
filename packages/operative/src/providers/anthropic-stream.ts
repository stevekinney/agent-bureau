import type { ToolCallInput } from '@lostgradient/tool-protocol';
import { toAnthropicMessages } from 'conversationalist';

import { createAnthropicSdkClient, isAnthropicStreamingClient } from './anthropic-sdk.ts';
import {
  anthropicDescriptorsFor,
  assertThinkingBudgetBelowMaximum,
  assertThinkingBudgetMeetsMinimum,
  assertThinkingParametersCompatible,
  buildAnthropicMessageRequest,
} from './anthropic-shared.ts';
import { withBackendDescriptors } from './backend-descriptor-attachment.ts';
import { ProviderError, ToolCallParseError } from './errors.ts';
import { createCacheAwareAssembly } from './shared/cache-aware-assembly.ts';
import { resolveAnthropicEffort } from './shared/effort.ts';
import { resolveAnthropicModel } from './shared/model-registry.ts';
import { resolveCommonParameters } from './shared/resolve-common-parameters.ts';
import type {
  AnthropicProviderOptions,
  AnthropicStreamingClient,
  GenerateContext,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
} from './types.ts';

/**
 * Creates a StreamingGenerateFunction backed by the Anthropic Messages API.
 *
 * Streams events from the API, progressively calling `streaming.update`
 * with accumulated text and collecting tool call fragments into complete
 * ToolCallInput objects.
 *
 * When no `client` is provided, lazily loads `@anthropic-ai/sdk` in Bun or Node.js
 * and constructs one using `apiKey` or the `ANTHROPIC_API_KEY` env var.
 */
export function createAnthropicProviderStream(
  options: Omit<AnthropicProviderOptions, 'client'> & {
    client?: AnthropicStreamingClient | undefined;
  },
): StreamingGenerateFunction {
  const { maximumTokens = 4096 } = options;
  const resolvedModel = resolveAnthropicModel(options.model);
  const resolvedEffort = options.effort
    ? resolveAnthropicEffort(options.effort, resolvedModel)
    : undefined;
  const common = resolveCommonParameters(options);
  assertThinkingBudgetMeetsMinimum(options.thinking);
  assertThinkingParametersCompatible(options.thinking, options.toolChoice, common);
  let clientPromise: Promise<AnthropicStreamingClient> | undefined;
  const cacheAwareAssembly =
    options.assembler && options.contextBudget
      ? createCacheAwareAssembly(options.assembler, options.contextBudget, options.pinnedMessages)
      : undefined;

  function getClient(): Promise<AnthropicStreamingClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = Promise.resolve().then(() => {
        const clientOptions: Record<string, unknown> = { apiKey: options.apiKey };
        if (options.baseURL) clientOptions['baseURL'] = options.baseURL;
        return createAnthropicSdkClient<AnthropicStreamingClient>(
          clientOptions,
          isAnthropicStreamingClient,
        );
      });
    }
    return clientPromise;
  }

  const generate: StreamingGenerateFunction = async (
    context: GenerateContext & { streaming: StreamingHandle },
  ): Promise<GenerateResponse> => {
    const effectiveMaximumTokens = context.maximumTokens ?? maximumTokens;
    assertThinkingBudgetBelowMaximum(options.thinking, effectiveMaximumTokens);
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
    const params = buildAnthropicMessageRequest({
      model: resolvedModel,
      messages,
      maxTokens: effectiveMaximumTokens,
      system,
      stream: true,
      effort: resolvedEffort,
      thinking: options.thinking,
      metadata: options.requestMetadata,
      tools,
      toolChoice: options.toolChoice,
      common,
    });

    const requestOptions = context.signal ? { signal: context.signal } : undefined;

    try {
      // Await handles both sync (mock) and async (real SDK APIPromise) returns
      const stream = await Promise.resolve(client.messages.create(params, requestOptions));

      return await consumeAnthropicStream(
        stream,
        streaming,
        context.signal,
        resolvedModel,
        resolvedEffort,
      );
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({ provider: 'anthropic', cause: error });
    }
  };

  return withBackendDescriptors(generate, anthropicDescriptorsFor(resolvedModel));
}

async function consumeAnthropicStream(
  stream: AsyncIterable<import('./types.ts').AnthropicStreamEvent>,
  streaming: StreamingHandle,
  signal: AbortSignal | undefined,
  model: string,
  effort: string | undefined,
): Promise<GenerateResponse> {
  const state: StreamState = {
    accumulatedText: '',
    inputTokens: undefined,
    outputTokens: undefined,
    cacheCreationTokens: undefined,
    cacheReadTokens: undefined,
    pendingToolCalls: new Map(),
  };
  for await (const event of stream) {
    if (signal?.aborted) break;
    handleAnthropicStreamEvent(event, state, streaming);
  }
  const toolCalls = completeAnthropicToolCalls(state.pendingToolCalls, signal?.aborted);
  return {
    content: state.accumulatedText,
    toolCalls,
    usage: buildStreamUsage(state),
    metadata: { effectiveModel: model, effectiveEffort: effort ?? 'none' },
  };
}

type PendingToolCall = {
  id: string | undefined;
  name: string;
  partialJson: string;
  blockId: string | undefined;
};
type StreamState = {
  accumulatedText: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheCreationTokens: number | null | undefined;
  cacheReadTokens: number | null | undefined;
  pendingToolCalls: Map<number, PendingToolCall>;
};

function handleAnthropicStreamEvent(
  event: import('./types.ts').AnthropicStreamEvent,
  state: StreamState,
  streaming: StreamingHandle,
): void {
  if (event.type === 'message_start') return handleAnthropicMessageStart(event, state);
  if (event.type === 'content_block_start')
    return handleAnthropicBlockStart(event, state, streaming);
  if (event.type === 'content_block_delta')
    return handleAnthropicBlockDelta(event, state, streaming);
  if (event.type === 'message_delta') state.outputTokens = event.usage?.output_tokens;
}

function handleAnthropicMessageStart(
  event: import('./types.ts').AnthropicStreamEvent,
  state: StreamState,
): void {
  state.inputTokens = event.message?.usage?.input_tokens;
  state.cacheCreationTokens = event.message?.usage?.cache_creation_input_tokens;
  state.cacheReadTokens = event.message?.usage?.cache_read_input_tokens;
}

function handleAnthropicBlockStart(
  event: import('./types.ts').AnthropicStreamEvent,
  state: StreamState,
  streaming: StreamingHandle,
): void {
  if (event.content_block?.type !== 'tool_use' || event.index === undefined) return;
  const blockId = event.content_block.id;
  const pending = { id: blockId, name: event.content_block.name!, partialJson: '', blockId };
  state.pendingToolCalls.set(event.index, pending);
  if (blockId !== undefined)
    streaming.report?.({ type: 'stream:tool-call-start', toolName: pending.name, blockId });
}

function handleAnthropicBlockDelta(
  event: import('./types.ts').AnthropicStreamEvent,
  state: StreamState,
  streaming: StreamingHandle,
): void {
  if (event.delta?.type === 'text_delta' && event.delta.text) {
    state.accumulatedText += event.delta.text;
    streaming.update(state.accumulatedText);
    return;
  }
  handleAnthropicJsonDelta(event, state, streaming);
}

function handleAnthropicJsonDelta(
  event: import('./types.ts').AnthropicStreamEvent,
  state: StreamState,
  streaming: StreamingHandle,
): void {
  if (event.delta?.partial_json === undefined || event.index === undefined) return;
  const pending = state.pendingToolCalls.get(event.index);
  if (!pending) return;
  pending.partialJson += event.delta.partial_json;
  if (pending.blockId !== undefined) {
    streaming.report?.({
      type: 'stream:tool-call-delta',
      toolName: pending.name,
      blockId: pending.blockId,
      partialArguments: pending.partialJson,
    });
  }
}

function completeAnthropicToolCalls(
  pendingCalls: Map<number, PendingToolCall>,
  aborted: boolean | undefined,
): ToolCallInput[] {
  if (aborted) return [];
  return [...pendingCalls.values()].map((pending) => ({
    id: pending.id,
    name: pending.name,
    arguments: parseAnthropicToolArguments(pending),
  }));
}

function buildStreamUsage(state: StreamState): GenerateResponse['usage'] {
  if (state.inputTokens === undefined && state.outputTokens === undefined) return undefined;
  return {
    prompt: state.inputTokens ?? 0,
    completion: state.outputTokens ?? 0,
    total: (state.inputTokens ?? 0) + (state.outputTokens ?? 0),
    ...(state.cacheCreationTokens != null
      ? { cacheCreationTokens: state.cacheCreationTokens }
      : {}),
    ...(state.cacheReadTokens != null ? { cacheReadTokens: state.cacheReadTokens } : {}),
  };
}

function parseAnthropicToolArguments(pending: PendingToolCall): unknown {
  if (!pending.partialJson) return undefined;
  try {
    return JSON.parse(pending.partialJson) as unknown;
  } catch (cause) {
    throw new ToolCallParseError({
      provider: 'anthropic',
      toolName: pending.name,
      toolCallId: pending.id,
      rawArguments: pending.partialJson,
      cause,
    });
  }
}
