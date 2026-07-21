import type { Effort } from '../types.ts';

/**
 * Effort-capability fallback tables and resolution functions — one per
 * shipped provider (Anthropic, OpenAI, Gemini). Each `resolve*Effort`
 * function is the single place a provider factory computes the effort
 * value it will actually send, given the caller's requested provider-neutral
 * tier and the already-resolved (post-alias) model ID. Degradation is
 * always deterministic: an unsupported tier steps down to the nearest
 * supported lower tier; a model with no reasoning knob at all degrades to
 * "omit the parameter" (represented as `undefined`).
 */

const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Anthropic `output_config.effort` support by resolved model ID, per the
 * mapping table in AB-91:
 * - Fable 5, Sonnet 5, Opus 4.7, Opus 4.8: full `low` .. `max` range, including `xhigh`.
 * - Opus 4.5, Opus 4.6, Sonnet 4.6: `low` .. `max`, no `xhigh`.
 * - Haiku (any generation) and Sonnet 4.5 or earlier: no effort parameter support at all.
 * A resolved model absent from this table is treated conservatively as
 * unsupported (empty list) — the effort parameter is omitted rather than
 * guessed at.
 */
export const ANTHROPIC_EFFORT_SUPPORT: Readonly<Record<string, readonly Effort[]>> = Object.freeze({
  'claude-fable-5': EFFORT_ORDER,
  'claude-mythos-5': EFFORT_ORDER,
  'claude-opus-4-8': EFFORT_ORDER,
  'claude-opus-4-7': EFFORT_ORDER,
  'claude-sonnet-5': EFFORT_ORDER,
  'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
  'claude-opus-4-5': ['low', 'medium', 'high', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
});

/**
 * Resolves the requested effort tier to what Anthropic will actually
 * receive on `output_config.effort` for the resolved model. Returns
 * `undefined` when the model has no effort support at all — the caller
 * must omit `output_config` in that case.
 */
export function resolveAnthropicEffort(
  requested: Effort,
  resolvedModel: string,
): Effort | undefined {
  const supported = ANTHROPIC_EFFORT_SUPPORT[resolvedModel] ?? [];
  if (supported.length === 0) return undefined;
  if (supported.includes(requested)) return requested;

  const requestedIndex = EFFORT_ORDER.indexOf(requested);
  return (
    EFFORT_ORDER.slice(0, requestedIndex)
      .toReversed()
      .find((tier) => supported.includes(tier)) ?? supported[0]
  );
}

/**
 * OpenAI models that accept `reasoning_effort` — the o-series reasoning
 * models. The GPT-4o / GPT-4.1 chat-completion family rejects the
 * parameter, so it is degraded to "omit" for those models.
 */
export const OPENAI_REASONING_MODELS: ReadonlySet<string> = new Set(['o3', 'o3-mini', 'o4-mini']);

/**
 * Resolves the requested effort tier to OpenAI's `reasoning_effort` value.
 * OpenAI's own vocabulary has only three tiers (`low`/`medium`/`high`) —
 * the two provider-neutral tiers above `high` (`xhigh`, `max`) clamp down
 * to `high` rather than erroring. Returns `undefined` for non-reasoning
 * models, where the caller must omit `reasoning_effort` entirely.
 */
export function resolveOpenAIEffort(
  requested: Effort,
  resolvedModel: string,
): 'low' | 'medium' | 'high' | undefined {
  if (!OPENAI_REASONING_MODELS.has(resolvedModel)) return undefined;
  if (requested === 'low' || requested === 'medium') return requested;
  return 'high';
}

/**
 * Gemini models that expose `generationConfig.thinkingConfig` — the 2.5
 * family. `gemini-2.0-flash` has no thinking mode at all, so effort is
 * degraded to "omit" for it.
 */
export const GEMINI_THINKING_MODELS: ReadonlySet<string> = new Set([
  'gemini-2.5-pro',
  'gemini-2.5-flash',
]);

/**
 * Approximate `thinkingBudget` token allotments per provider-neutral tier.
 * `max` maps to Gemini's dynamic-thinking sentinel (`-1`), letting the
 * model decide its own budget rather than capping it.
 */
const GEMINI_EFFORT_BUDGETS: Readonly<Record<Effort, number>> = Object.freeze({
  low: 1024,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: -1,
});

export interface GeminiResolvedEffort {
  effort: Effort;
  thinkingBudget: number;
}

/**
 * Resolves the requested effort tier to a Gemini `thinkingBudget` for the
 * resolved model. Returns `undefined` when the model has no thinking mode
 * at all — the caller must omit `thinkingConfig` in that case.
 */
export function resolveGeminiEffort(
  requested: Effort,
  resolvedModel: string,
): GeminiResolvedEffort | undefined {
  if (!GEMINI_THINKING_MODELS.has(resolvedModel)) return undefined;
  return { effort: requested, thinkingBudget: GEMINI_EFFORT_BUDGETS[requested] };
}
