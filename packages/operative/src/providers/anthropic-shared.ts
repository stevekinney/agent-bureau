import type { ToolChoice } from '../structured-output/types.ts';
import { ProviderError } from './errors.ts';
import { createModelCatalog } from './model-catalog.ts';
import type { ResolvedCommonParameters } from './shared/resolve-common-parameters.ts';
import { toAnthropicToolChoice } from './structured-output/tool-choice-adapters.ts';
import type {
  AnthropicMessageCreateRequest,
  AnthropicMessageResponse,
  AnthropicThinkingConfig,
  GenerateResponse,
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
export function assertThinkingBudgetMeetsMinimum(
  thinking: AnthropicThinkingConfig | undefined,
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
export function assertThinkingBudgetBelowMaximum(
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
export function assertThinkingParametersCompatible(
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
 * the API actually reported a numeric value; they are never fabricated as
 * `0`.
 *
 * The SDK's real `Usage` type declares both cache fields `number | null`, not
 * merely optional — `null` is the API's way of saying "no cache activity,"
 * the same thing an absent field would mean. Checking `!= null` (rather than
 * `!== undefined`) treats the two the same, so this omits the field for
 * either rather than forwarding a literal `null` into {@link TokenUsage},
 * whose own type never accepted one.
 */
export function buildAnthropicUsage(
  usage: NonNullable<AnthropicMessageResponse['usage']>,
): GenerateResponse['usage'] {
  return {
    prompt: usage.input_tokens ?? 0,
    completion: usage.output_tokens ?? 0,
    total: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    ...(usage.cache_creation_input_tokens != null
      ? { cacheCreationTokens: usage.cache_creation_input_tokens }
      : {}),
    ...(usage.cache_read_input_tokens != null
      ? { cacheReadTokens: usage.cache_read_input_tokens }
      : {}),
  };
}

/**
 * The single `BackendDescriptor` (AB-64 AC2) matching `model` on the
 * `'messages'` endpoint, from the static seed catalog — an array of zero or
 * one entries, never fabricated. Zero when `model` has no seed row (a model
 * newer than the seed, or a typo): the resulting `GenerateFunction` then
 * reports `mode: 'opaque'` rather than an invented descriptor.
 */
export function anthropicDescriptorsFor(model: string) {
  return createModelCatalog().descriptors.filter(
    (descriptor) => descriptor.provider === 'anthropic' && descriptor.model === model,
  );
}

interface AnthropicRequestParts {
  model: string;
  messages: AnthropicMessageCreateRequest['messages'];
  maxTokens: number;
  stream?: boolean;
  system: AnthropicMessageCreateRequest['system'];
  effort: unknown;
  thinking: AnthropicMessageCreateRequest['thinking'];
  metadata: AnthropicMessageCreateRequest['metadata'];
  tools: unknown;
  toolChoice: ToolChoice | undefined;
  common: ResolvedCommonParameters;
}

export function buildAnthropicMessageRequest(
  parts: AnthropicRequestParts,
): AnthropicMessageCreateRequest {
  const params: AnthropicMessageCreateRequest = {
    model: parts.model,
    messages: parts.messages,
    max_tokens: parts.maxTokens,
    ...(parts.stream ? { stream: true } : {}),
  };
  addAnthropicOptionalFields(params, parts);
  addAnthropicTools(params, parts.tools, parts.toolChoice);
  return params;
}

function addAnthropicOptionalFields(
  params: AnthropicMessageCreateRequest,
  parts: AnthropicRequestParts,
): void {
  if (parts.system !== undefined) params['system'] = parts.system;
  if (parts.effort !== undefined) params['output_config'] = { effort: parts.effort };
  if (parts.thinking) params['thinking'] = parts.thinking;
  if (parts.metadata) params['metadata'] = parts.metadata;
  if (parts.common.temperature !== undefined) params['temperature'] = parts.common.temperature;
  if (parts.common.topP !== undefined) params['top_p'] = parts.common.topP;
  if (parts.common.stopSequences) params['stop_sequences'] = parts.common.stopSequences;
}

function addAnthropicTools(
  params: AnthropicMessageCreateRequest,
  tools: AnthropicMessageCreateRequest['tools'],
  toolChoice: ToolChoice | undefined,
): void {
  if (!Array.isArray(tools) || tools.length === 0 || toolChoice === 'none') return;
  params['tools'] = tools;
  const adapted = toolChoice ? toAnthropicToolChoice(toolChoice) : undefined;
  if (adapted !== undefined) params['tool_choice'] = adapted;
}
