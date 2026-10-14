/**
 * Anthropic `temperature`/`top_p` support by resolved model ID — the single
 * source of truth behind both the model catalog's advertised
 * `parameterCompatibility` and the Anthropic provider's pre-request guard.
 * Every decision below was confirmed 2026-10-14 against Anthropic's
 * documentation:
 *
 * - `defaults-only`: https://platform.claude.com/docs/en/build-with-claude/thinking
 *   (Sampling parameters) lists the models: "On Claude Fable 5.1, Claude
 *   Mythos 5.1, Claude Fable 5, Claude Mythos 5, Claude Mythos Preview, Claude
 *   Opus 5.5, Claude Opus 5, Claude Opus 4.8, Claude Opus 4.7, Claude Sonnet
 *   5.5, Claude Sonnet 5, and Claude Haiku 5.5, non-default temperature,
 *   top_p, or top_k values return a 400 error on every request ... the top_p
 *   default is 0.99, so a top_p of 1 returns a 400 error, and so does a
 *   request that includes both temperature and top_p, even at their defaults."
 *   The per-model guides say the same: Opus 5.5
 *   (https://platform.claude.com/docs/en/models/opus-5-5/migration-guide,
 *   "Omit temperature, top_p, and top_k, or leave them at their defaults: any
 *   other value is rejected"), Sonnet 5.5 and Sonnet 5 (overview pages and
 *   https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide),
 *   Fable 5.1 (https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1)
 *   and Haiku 5.5, whose guide
 *   (https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)
 *   gives the values: "If a request includes temperature, it must be 1. If it
 *   includes top_p, it must be 0.99, its default."
 *   So each of the two is accepted alone at its default and nothing else is.
 *   The numeric temperature default (1) is stated only for Haiku 5.5; the
 *   Opus, Sonnet, Fable and Mythos pages say "default" without a number, so 1
 *   is carried over from that guide and the shared list above.
 * - `accepted`: the model takes sampling parameters.
 *   - Sonnet 4.6, Haiku 4.5 (alias and pinned snapshot) and every earlier
 *     Sonnet: https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide —
 *     "Claude Sonnet 4.6 and earlier models and Claude Haiku 4.5 accept
 *     `temperature`, `top_p`, and `top_k`".
 *   - Opus 4.6, Opus 4.5 and the dated Opus 4 snapshot: the restriction begins
 *     at "Claude Opus 4.7 and later models"
 *     (https://platform.claude.com/docs/en/models/opus-5-5/migration-guide), and
 *     the thinking page's list above stops at Opus 4.7, so earlier Opus models
 *     still accept them.
 * - Unsettled (no entry): the pages do not name `claude-haiku-4-20250506` or
 *   `claude-3-5-haiku-20241022`, nor any ID absent from this table. The catalog
 *   does not advertise sampling for an unsettled model, and the provider does
 *   not guard it — the request is sent and a 400 is classified after the fact
 *   (COR-989).
 *
 * `toolChoice` is decided separately, in `shared/tool-choice.ts`.
 */
export type SamplingSupport = 'accepted' | 'defaults-only' | 'unsettled';

/** The only values a `defaults-only` model accepts, and only one of the two per request. */
export const DEFAULT_ONLY_SAMPLING_VALUES = Object.freeze({ temperature: 1, topP: 0.99 });

export const ANTHROPIC_SAMPLING_SUPPORT: Readonly<Record<string, 'accepted' | 'defaults-only'>> =
  Object.freeze({
    'claude-fable-5-1': 'defaults-only',
    'claude-mythos-5-1': 'defaults-only',
    'claude-fable-5': 'defaults-only',
    'claude-mythos-5': 'defaults-only',
    'claude-opus-5-5': 'defaults-only',
    'claude-opus-5': 'defaults-only',
    'claude-opus-4-8': 'defaults-only',
    'claude-opus-4-7': 'defaults-only',
    'claude-sonnet-5-5': 'defaults-only',
    'claude-sonnet-5': 'defaults-only',
    'claude-haiku-5-5': 'defaults-only',
    'claude-opus-4-6': 'accepted',
    'claude-opus-4-5': 'accepted',
    'claude-sonnet-4-6': 'accepted',
    'claude-haiku-4-5': 'accepted',
    'claude-opus-4-20250514': 'accepted',
    'claude-sonnet-4-20250514': 'accepted',
    'claude-3-5-sonnet-20241022': 'accepted',
  });

export function anthropicSamplingSupport(resolvedModel: string): SamplingSupport {
  return ANTHROPIC_SAMPLING_SUPPORT[resolvedModel] ?? 'unsettled';
}
