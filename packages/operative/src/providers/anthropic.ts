import { parseAnthropicToolCalls } from 'armorer/adapters/anthropic';
import { toAnthropicMessages } from 'conversationalist/adapters/anthropic';
import type { ToolCallInput } from 'interoperability';

import { ProviderError, ToolCallParseError } from './errors.ts';
import { createCacheAwareAssembly } from './shared/cache-aware-assembly.ts';
import { resolveAnthropicEffort } from './shared/effort.ts';
import { resolveAnthropicModel } from './shared/model-registry.ts';
import {
  resolveCommonParameters,
  type ResolvedCommonParameters,
} from './shared/resolve-common-parameters.ts';
import { toAnthropicToolChoice } from './structured-output/tool-choice-adapters.ts';
import type { ToolChoice } from './structured-output/types.ts';
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
 * The only `temperature` Anthropic accepts while thinking is on. Its docs:
 * "On older models, the restriction applies only while thinking is on:
 * `temperature` and `top_k` are incompatible with thinking" — and on Opus 4.7
 * and later a non-default `temperature` is rejected regardless of thinking.
 * Either way, `1` (the API default) is the single value that always survives.
 */
const THINKING_TEMPERATURE = 1;

/**
 * Anthropic's floor for `top_p` while thinking is on, quoted from the same
 * sentence: "`top_p` is allowed at values between 0.95 and 1." The bound is
 * inclusive, so exactly `0.95` is accepted.
 */
const MINIMUM_THINKING_TOP_P = 0.95;

/**
 * Rejects an `{ type: 'enabled' }` thinking budget below Anthropic's documented
 * minimum of 1024 tokens.
 *
 * This half of the constraint depends on nothing but the budget itself, so it
 * is checked once at construction. The upper bound — which depends on the
 * `max_tokens` actually sent — lives in
 * {@link assertThinkingBudgetBelowMaximum} instead.
 *
 * This throws rather than raising the budget: quietly substituting 1024 would
 * spend tokens the caller never asked for. The error is a configuration fault,
 * so it carries no status code and is not retryable.
 */
function assertThinkingBudgetMeetsMinimum(thinking: AnthropicThinkingConfig | undefined): void {
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
}

/**
 * Rejects an `{ type: 'enabled' }` thinking budget that is not strictly below
 * the `max_tokens` this request will actually send, naming both numbers.
 *
 * Deliberately per request, not per construction. `GenerateContext.maximumTokens`
 * is documented to override the provider's construction-time `maximumTokens`
 * for that call, so the effective limit is not known until the call happens: a
 * 4096-token budget against the default `maximumTokens` of 4096 is perfectly
 * valid for a caller that supplies `maximumTokens: 8192` on every invocation.
 * Checking at construction would reject a configuration that never produces an
 * invalid request.
 *
 * This throws rather than adjusting either number, deliberately. Quietly
 * raising `max_tokens` would change billing the caller never asked for, and
 * quietly lowering `budget_tokens` would degrade the feature they explicitly
 * requested — both would substitute our guess for their intent. The error is a
 * configuration fault, so it carries no status code and is not retryable.
 *
 * The check is strict because this provider sends no beta headers. Anthropic
 * documents one exception — under interleaved thinking
 * (`interleaved-thinking-2025-05-14`) the budget spans a whole assistant turn
 * and may exceed `max_tokens` — which becomes reachable only if a `betas`
 * option is ever added here.
 */
function assertThinkingBudgetBelowMaximum(
  thinking: AnthropicThinkingConfig | undefined,
  maximumTokens: number,
): void {
  if (thinking?.type !== 'enabled') return;

  const budget = thinking.budget_tokens;

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
 * Names a `toolChoice` that forces tool use, or `undefined` when it does not.
 *
 * Anthropic's two forcing shapes are `{ type: 'any' }` and
 * `{ type: 'tool', name }`, which this package's neutral `ToolChoice` spells
 * `'required'` and `{ tool }` respectively — see `toAnthropicToolChoice`.
 */
function describeForcedToolChoice(choice: ToolChoice | undefined): string | undefined {
  if (choice === 'required') return `'required'`;
  if (typeof choice === 'object') return `the named tool '${choice.tool}'`;
  return undefined;
}

/**
 * Rejects the option combinations Anthropic documents as incompatible with an
 * active `thinking` configuration, naming both conflicting fields.
 *
 * Three constraints, each verified against Anthropic's thinking documentation
 * rather than assumed, because they do not all apply to the same modes:
 *
 * - **`temperature`** — "the restriction applies only while thinking is on:
 *   `temperature` and `top_k` are incompatible with thinking." Applies to
 *   `enabled` *and* `adaptive`; only the default of `1` survives.
 * - **`topP`** — from the same sentence, "`top_p` is allowed at values between
 *   0.95 and 1." Also both active modes. This package sends no `top_k`, so
 *   that third parameter has nothing to guard.
 * - **forced `toolChoice`** — `enabled` **only**. Anthropic is explicit that
 *   the limitation is a manual-extended-thinking one: "Adaptive thinking,
 *   including on models where thinking is on by default, supports forced tool
 *   use." Guarding `adaptive` here would reject requests the API accepts.
 *
 * `{ type: 'disabled' }` and an absent `thinking` skip all three — the
 * conflicts exist only while thinking is actually on.
 *
 * Checked once at construction, which is complete for this provider: all three
 * fields are construction-time options and none of them is re-read from
 * `GenerateContext` on the way to the request body. (`GenerateContext.toolChoice`
 * exists, but the Anthropic provider lowers `options.toolChoice` only — if that
 * ever changes, this check has to move per request alongside it.)
 */
function assertThinkingParametersCompatible(
  thinking: AnthropicThinkingConfig | undefined,
  toolChoice: ToolChoice | undefined,
  common: ResolvedCommonParameters,
): void {
  if (thinking === undefined || thinking.type === 'disabled') return;

  if (common.temperature !== undefined && common.temperature !== THINKING_TEMPERATURE) {
    throw new ProviderError({
      provider: 'anthropic',
      cause: undefined,
      message:
        `[provider:anthropic] temperature (${common.temperature}) cannot be combined with ` +
        `thinking.type '${thinking.type}'. Anthropic accepts only the default temperature of ` +
        `${THINKING_TEMPERATURE} while thinking is on — omit temperature, or set thinking.type ` +
        `to 'disabled'.`,
    });
  }

  if (common.topP !== undefined && common.topP < MINIMUM_THINKING_TOP_P) {
    throw new ProviderError({
      provider: 'anthropic',
      cause: undefined,
      message:
        `[provider:anthropic] topP (${common.topP}) cannot be combined with thinking.type ` +
        `'${thinking.type}'. Anthropic accepts top_p only between ${MINIMUM_THINKING_TOP_P} and 1 ` +
        `while thinking is on — raise topP to at least ${MINIMUM_THINKING_TOP_P}, omit it, or set ` +
        `thinking.type to 'disabled'.`,
    });
  }

  const forced = describeForcedToolChoice(toolChoice);

  if (thinking.type === 'enabled' && forced !== undefined) {
    throw new ProviderError({
      provider: 'anthropic',
      cause: undefined,
      message:
        `[provider:anthropic] toolChoice ${forced} cannot be combined with thinking.type ` +
        `'enabled'. Anthropic rejects forced tool use with manual extended thinking — use ` +
        `toolChoice 'auto' or 'none', or switch thinking.type to 'adaptive', which does support ` +
        `forced tool use.`,
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
