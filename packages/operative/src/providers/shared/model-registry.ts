/**
 * Model-alias registry — resolves short, human-friendly shorthand names to
 * concrete, provider-native model IDs.
 *
 * This is the SINGLE documented resolution point per provider: each provider
 * factory (`createAnthropicProvider`, `createOpenAIProvider`,
 * `createGeminiProvider`, and their streaming counterparts) calls its
 * `resolve*Model` function exactly once, at construction time, and uses the
 * resolved ID for every request the returned `GenerateFunction` makes.
 *
 * Full provider-native IDs (e.g. `claude-opus-4-8`, `gpt-4.1`,
 * `gemini-2.5-pro`) are not in these tables, so they pass through unchanged.
 *
 * `'inherit'` is intentionally NEVER resolved here. In systems like
 * Tribunal, `inherit` means "use the parent run's/agent's current model" —
 * a piece of caller-side context this package has no visibility into.
 * Callers that support `inherit` semantics must resolve it to a concrete
 * model ID (or another alias) themselves before constructing a provider.
 */

/** Anthropic shorthand aliases. Mirrors Tribunal's `sonnet|opus|haiku|fable` vocabulary. */
export const ANTHROPIC_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
});

/**
 * OpenAI shorthand aliases. `gpt`/`gpt-mini`/`gpt-nano` map to the GPT-4.1
 * chat-completion family; `o`/`o-mini` map to the o-series reasoning models
 * that accept `reasoning_effort` (see `./effort.ts`). Targets are drawn from
 * the model IDs already pinned in `cost-estimation.ts`.
 */
export const OPENAI_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  gpt: 'gpt-4.1',
  'gpt-mini': 'gpt-4.1-mini',
  'gpt-nano': 'gpt-4.1-nano',
  o: 'o3',
  'o-mini': 'o3-mini',
});

/**
 * Gemini shorthand aliases. `pro`/`flash` map to the 2.5 thinking-capable
 * family; `flash-lite` maps to 2.0-flash, which has no thinking support
 * (see `./effort.ts`). Targets are drawn from the model IDs already pinned
 * in `cost-estimation.ts`.
 */
export const GEMINI_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  pro: 'gemini-2.5-pro',
  flash: 'gemini-2.5-flash',
  'flash-lite': 'gemini-2.0-flash',
});

function resolveModelAlias(model: string, aliases: Readonly<Record<string, string>>): string {
  if (model === 'inherit') return model;
  return aliases[model] ?? model;
}

/** Resolves an Anthropic shorthand alias (or full model ID) to a concrete model ID. */
export function resolveAnthropicModel(model: string): string {
  return resolveModelAlias(model, ANTHROPIC_MODEL_ALIASES);
}

/** Resolves an OpenAI shorthand alias (or full model ID) to a concrete model ID. */
export function resolveOpenAIModel(model: string): string {
  return resolveModelAlias(model, OPENAI_MODEL_ALIASES);
}

/** Resolves a Gemini shorthand alias (or full model ID) to a concrete model ID. */
export function resolveGeminiModel(model: string): string {
  return resolveModelAlias(model, GEMINI_MODEL_ALIASES);
}
