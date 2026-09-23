import { getModelPricing } from '../cost-estimation.ts';
import { requireLimits, requireModalities } from './model-catalog-data.ts';
import type { BackendDescriptor, EffortSupport, ModelAlias } from './model-catalog.ts';
import {
  GEMINI_THINKING_MODELS,
  OPENAI_REASONING_MODELS,
  resolveAnthropicEffort,
  resolveGeminiEffort,
  resolveOpenAIEffort,
} from './shared/effort.ts';
import {
  ANTHROPIC_MODEL_ALIASES,
  GEMINI_MODEL_ALIASES,
  OPENAI_MODEL_ALIASES,
} from './shared/model-registry.ts';
import type { BaseProviderOptions, Effort } from './types.ts';

// ── Effort degradation, derived from effort.ts — never a second table ──────

const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function anthropicDegradesTo(model: string): EffortSupport['degradesTo'] {
  const degradesTo: Partial<Record<Effort, Effort | undefined>> = {};
  for (const tier of EFFORT_ORDER) degradesTo[tier] = resolveAnthropicEffort(tier, model);
  return Object.freeze(degradesTo);
}

function openAIDegradesTo(model: string): EffortSupport['degradesTo'] {
  const degradesTo: Partial<Record<Effort, Effort | undefined>> = {};
  for (const tier of EFFORT_ORDER) degradesTo[tier] = resolveOpenAIEffort(tier, model);
  return Object.freeze(degradesTo);
}

function geminiDegradesTo(model: string): EffortSupport['degradesTo'] {
  const degradesTo: Partial<Record<Effort, Effort | undefined>> = {};
  for (const tier of EFFORT_ORDER) degradesTo[tier] = resolveGeminiEffort(tier, model)?.effort;
  return Object.freeze(degradesTo);
}

/** `portable` is every tier that survives its own provider's degradation unchanged. */
function portableTiers(degradesTo: EffortSupport['degradesTo']): readonly Effort[] {
  return EFFORT_ORDER.filter((tier) => degradesTo[tier] === tier);
}

function anthropicEffort(model: string): EffortSupport {
  const degradesTo = anthropicDegradesTo(model);
  return {
    portable: portableTiers(degradesTo),
    nativeMapping: 'output_config.effort',
    degradesTo,
  };
}

function openAIEffort(model: string): EffortSupport {
  const degradesTo = openAIDegradesTo(model);
  return {
    portable: portableTiers(degradesTo),
    nativeMapping: OPENAI_REASONING_MODELS.has(model) ? 'reasoning_effort' : 'unsupported',
    degradesTo,
  };
}

function geminiEffort(model: string): EffortSupport {
  const degradesTo = geminiDegradesTo(model);
  return {
    portable: portableTiers(degradesTo),
    nativeMapping: GEMINI_THINKING_MODELS.has(model)
      ? 'thinkingConfig.thinkingBudget'
      : 'unsupported',
    degradesTo,
  };
}

// ── Aliases, derived from model-registry.ts — never a second table ─────────

function aliasesFor(model: string, table: Readonly<Record<string, string>>): readonly ModelAlias[] {
  return Object.entries(table)
    .filter(([, resolvesTo]) => resolvesTo === model)
    .map(([alias, resolvesTo]) => ({ alias, resolvesTo }));
}

// ── Parameter compatibility ─────────────────────────────────────────────────
//
// Every field `BaseProviderOptions` declares. Gemini's adapter has no
// request-level metadata field (`providers/types.ts:56-72` documents
// `requestMetadata` as an explicit no-op for `createGeminiProvider`), so its
// rows omit that one entry; Anthropic and OpenAI honor it.

const FULL_PARAMETER_COMPATIBILITY: readonly (keyof BaseProviderOptions)[] = [
  'model',
  'effort',
  'maximumTokens',
  'temperature',
  'topP',
  'stopSequences',
  'toolChoice',
  'responseFormat',
  'requestMetadata',
];

const GEMINI_PARAMETER_COMPATIBILITY: readonly (keyof BaseProviderOptions)[] =
  FULL_PARAMETER_COMPATIBILITY.filter((field) => field !== 'requestMetadata');

// ── Row construction ────────────────────────────────────────────────────────

/**
 * Recursively freezes an object graph. The catalog and its top-level
 * `descriptors` array are frozen where they are constructed, but a
 * descriptor row's own nested values — `aliases`, `effort.portable`,
 * `pricing`, `mimeFamilies`, `mediaLimits` — are plain arrays/objects built
 * fresh per row and would otherwise stay mutable underneath a frozen
 * top-level object. Always recurses (never short-circuits on an
 * already-frozen parent), because freezing a parent does not freeze its
 * children — `ANTHROPIC_MODALITIES` is `Object.freeze`d but its per-modality
 * entry objects are not, until this runs.
 */
export function deepFreeze<T>(value: T): T {
  if (!isFreezableObject(value)) return value;
  for (const key of Object.keys(value)) {
    deepFreeze(Reflect.get(value, key));
  }
  return Object.freeze(value);
}

function isFreezableObject(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false;
  return Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype;
}

function pricingFor(model: string): BackendDescriptor['pricing'] {
  const pricing = getModelPricing(model);
  if (!pricing) return undefined;
  return {
    inputPerMillionTokens: pricing.promptCostPerMillionTokens,
    outputPerMillionTokens: pricing.completionCostPerMillionTokens,
    currency: 'USD',
  };
}

export function buildAnthropicRow(model: string, freshness: string): BackendDescriptor {
  const limits = requireLimits('anthropic', model);
  const pricingRow = pricingFor(model);
  return {
    descriptorVersion: 1,
    provider: 'anthropic',
    endpoint: 'messages',
    model,
    aliases: aliasesFor(model, ANTHROPIC_MODEL_ALIASES),
    lifecycle: 'stable',
    modalities: requireModalities('anthropic', model),
    mimeFamilies: ['text', 'image', 'document'],
    mediaLimits: [],
    contextWindowTokens: limits.contextWindowTokens,
    maxOutputTokens: limits.maxOutputTokens,
    streaming: true,
    tools: true,
    parallelTools: true,
    structuredOutput: true,
    parameterCompatibility: FULL_PARAMETER_COMPATIBILITY,
    caching: true,
    batchInference: true,
    explicitThinkingRequest: true,
    serverSideTokenCounting: true,
    effort: anthropicEffort(model),
    ...(pricingRow !== undefined ? { pricing: pricingRow } : {}),
    availability: 'available',
    health: 'unknown',
    source: 'static',
    freshness,
  };
}

export function buildOpenAIRow(
  model: string,
  freshness: string,
  endpointAmbiguous: boolean,
): BackendDescriptor {
  const limits = requireLimits('openai', model);
  const pricingRow = pricingFor(model);
  return {
    descriptorVersion: 1,
    provider: 'openai',
    endpoint: 'chat.completions',
    model,
    aliases: aliasesFor(model, OPENAI_MODEL_ALIASES),
    lifecycle: 'stable',
    modalities: requireModalities('openai', model),
    mimeFamilies: ['text', 'image', 'document'],
    mediaLimits: [],
    contextWindowTokens: limits.contextWindowTokens,
    maxOutputTokens: limits.maxOutputTokens,
    streaming: true,
    tools: true,
    parallelTools: true,
    structuredOutput: true,
    parameterCompatibility: FULL_PARAMETER_COMPATIBILITY,
    // OpenAI's chat.completions endpoint never supports request-controlled
    // caching or server-side token counting, ambiguous or not — only
    // batchInference depends on the effective endpoint. The effective
    // endpoint, not the options object: an ambiguous baseURL means operative
    // cannot tell whether the request reaches api.openai.com, a
    // credential-injecting proxy, or an OpenAI-compatible local server — see
    // capabilities.ts's historical rationale, now sourced from here.
    caching: false,
    batchInference: !endpointAmbiguous,
    explicitThinkingRequest: false,
    serverSideTokenCounting: false,
    effort: openAIEffort(model),
    endpointAmbiguous,
    ...(pricingRow !== undefined ? { pricing: pricingRow } : {}),
    availability: endpointAmbiguous ? 'unknown' : 'available',
    health: 'unknown',
    source: 'static',
    freshness,
  };
}

export function buildGeminiRow(model: string, freshness: string): BackendDescriptor {
  const limits = requireLimits('gemini', model);
  const pricingRow = pricingFor(model);
  return {
    descriptorVersion: 1,
    provider: 'gemini',
    endpoint: 'generateContent',
    model,
    aliases: aliasesFor(model, GEMINI_MODEL_ALIASES),
    lifecycle: 'stable',
    modalities: requireModalities('gemini', model),
    mimeFamilies: ['text', 'image', 'document', 'audio', 'video'],
    mediaLimits: [],
    contextWindowTokens: limits.contextWindowTokens,
    maxOutputTokens: limits.maxOutputTokens,
    streaming: true,
    tools: true,
    parallelTools: true,
    structuredOutput: true,
    // Gemini has no request-level metadata field; createGeminiProvider
    // treats it as an explicit no-op (providers/types.ts:56-72).
    parameterCompatibility: GEMINI_PARAMETER_COMPATIBILITY,
    caching: true,
    batchInference: true,
    explicitThinkingRequest: false,
    serverSideTokenCounting: true,
    effort: geminiEffort(model),
    ...(pricingRow !== undefined ? { pricing: pricingRow } : {}),
    availability: 'available',
    health: 'unknown',
    source: 'static',
    freshness,
  };
}
