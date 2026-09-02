import type { MediaLimits, MimeFamily, Modality, ModalityMatrix } from 'conversationalist';

import { getModelPricing } from '../cost-estimation.ts';
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
import type { BaseProviderOptions, Effort, ProviderName } from './types.ts';

/**
 * AB-64's ratified `BackendDescriptor`/`ModelCatalog` surface, implemented as
 * a static seed derived from the provider tables this package already ships
 * (`shared/effort.ts`, `shared/model-registry.ts`, `../cost-estimation.ts`),
 * never a hand-copied model list. See `model-catalog.test.ts` for the
 * computed-union assertions that keep the seed synchronized with those
 * tables, and AB-64's decision record (ratified 2026-09-01, amended
 * 2026-09-02) for the shapes below, transcribed verbatim except where the
 * coordinator's `modalities: ModalityMatrix` amendment replaces the three
 * parallel `inputModalities`/`outputModalities`/`acceptedSourceForms` fields.
 */

/** Deployment/lifecycle status of a backend row, independent of provider health. */
export type BackendLifecycleState = 'preview' | 'stable' | 'deprecated' | 'retired';

/** A shorthand alias that resolves to this descriptor's `model`. */
export interface ModelAlias {
  readonly alias: string;
  readonly resolvesTo: string;
}

export interface EffortSupport {
  readonly portable: readonly Effort[];
  readonly nativeMapping:
    'output_config.effort' | 'reasoning_effort' | 'thinkingConfig.thinkingBudget' | 'unsupported';
  /**
   * Generated from `effort.ts`'s `ANTHROPIC_EFFORT_SUPPORT` /
   * `OPENAI_REASONING_MODELS` / `GEMINI_THINKING_MODELS` tables via the
   * corresponding `resolve*Effort` function, never a second hand-maintained
   * table. See `model-catalog.test.ts`'s degradation-identity assertions.
   */
  readonly degradesTo: Readonly<Partial<Record<Effort, Effort | undefined>>>;
}

export interface GeneratedAssetBehavior {
  readonly modality: Modality;
  readonly synchronous: boolean;
  readonly maxConcurrentGenerations?: number;
}

export interface BackendDescriptor {
  readonly descriptorVersion: number;
  readonly provider: ProviderName;
  readonly endpoint: string;
  readonly model: string; // provider-native, post-alias
  readonly aliases: readonly ModelAlias[];
  readonly lifecycle: BackendLifecycleState;
  /**
   * AB-70's `ModalityMatrix`: `Record<Modality, { input: boolean; output:
   * boolean; sourceForms: readonly ContentSource['kind'][] }>`. Replaces the
   * three parallel `inputModalities`/`outputModalities`/`acceptedSourceForms`
   * fields per AB-64's 2026-09-02 coordinator amendment.
   */
  readonly modalities: ModalityMatrix;
  readonly mimeFamilies: readonly MimeFamily[];
  readonly mediaLimits: readonly MediaLimits[];
  readonly generatedAssetBehavior?: readonly GeneratedAssetBehavior[];
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly parallelTools: boolean;
  readonly structuredOutput: boolean;
  readonly parameterCompatibility: readonly (keyof BaseProviderOptions)[];
  readonly caching: boolean; // subsumes ProviderCapabilities.requestControlledContextCaching
  readonly batchInference: boolean;
  readonly explicitThinkingRequest: boolean;
  readonly serverSideTokenCounting: boolean;
  readonly effort: EffortSupport;
  /**
   * `true` for an ambiguous OpenAI endpoint (custom `baseURL` or
   * `OPENAI_BASE_URL`); capability flags are then conservatively `false` and
   * `availability` is `'unknown'`.
   */
  readonly endpointAmbiguous?: boolean;
  readonly pricing?: {
    readonly inputPerMillionTokens: number;
    readonly outputPerMillionTokens: number;
    readonly currency: string;
  };
  readonly availability: 'available' | 'unavailable' | 'unknown';
  readonly health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  readonly source: 'static' | 'provider-reported' | 'operator-override';
  readonly freshness: string; // ISO timestamp
}

export type CatalogProjection = 'general' | 'privileged';

export interface ModelCatalog {
  readonly revision: number;
  readonly descriptors: readonly BackendDescriptor[];
  readonly generatedAt: string;
  readonly stale: boolean;
  /**
   * AB-34's contract requires a caller read which projection it received
   * rather than infer it. `createModelCatalog` always populates
   * `'privileged'`; the `'general'`-redacting projection function is
   * mod-02e's scope (AB-247), not this module's.
   */
  readonly projection: CatalogProjection;
}

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

// ── Modality matrices ───────────────────────────────────────────────────────
//
// "known" (AB-64's term-table meaning) is what the provider's own generate
// endpoint can do, independent of what this package's adapter currently
// wires up — so these matrices describe the endpoint's documented input/
// output support, not `anthropic.ts`/`openai.ts`/`gemini.ts`'s current
// request-building code. Every seed model within a provider shares that
// provider's documented modality support on the endpoint this package
// targets (`messages`, `chat.completions`, `generateContent`).

const UNSUPPORTED_MODALITY_ENTRY: ModalityMatrix[Modality] = {
  input: false,
  output: false,
  sourceForms: [],
};

// https://platform.claude.com/docs/en/build-with-claude/vision — confirmed
// 2026-09-02: base64, URL, and the Files API (provider-file) are all
// documented input forms for image content on `messages`. Anthropic's
// `messages` endpoint has no audio or video input/output and no image or
// audio generation.
const ANTHROPIC_MODALITIES: ModalityMatrix = Object.freeze({
  text: { input: true, output: true, sourceForms: ['inline'] },
  image: {
    input: true,
    output: false,
    sourceForms: ['inline', 'data-url', 'remote-url', 'provider-file'],
  },
  document: { input: true, output: false, sourceForms: ['inline', 'remote-url', 'provider-file'] },
  audio: UNSUPPORTED_MODALITY_ENTRY,
  video: UNSUPPORTED_MODALITY_ENTRY,
  file: UNSUPPORTED_MODALITY_ENTRY,
});

// https://developers.openai.com/api/docs/guides/pdf-files and
// https://developers.openai.com/api/docs/guides/images-vision — confirmed
// 2026-09-02: both pages document base64/URL image and file input; neither
// documents a `file_id` (Files-API) input path for `chat.completions`
// specifically — that capability is scoped to the Responses API — so
// `chat.completions` document/image source forms stay inline-only.
// `chat.completions` has no audio or video input/output and no image or
// audio generation (that is the Responses/Realtime API's surface).
const OPENAI_MODALITIES: ModalityMatrix = Object.freeze({
  text: { input: true, output: true, sourceForms: ['inline'] },
  image: { input: true, output: false, sourceForms: ['inline', 'data-url', 'remote-url'] },
  document: { input: true, output: false, sourceForms: ['inline'] },
  audio: UNSUPPORTED_MODALITY_ENTRY,
  video: UNSUPPORTED_MODALITY_ENTRY,
  file: UNSUPPORTED_MODALITY_ENTRY,
});

// https://ai.google.dev/gemini-api/docs/audio and
// https://ai.google.dev/gemini-api/docs/video-understanding — confirmed
// 2026-09-02: `generateContent` accepts audio input ("Gemini can analyze
// audio input and generate text responses") and video input (inline bytes,
// `remote-url`-shaped YouTube/file URLs, or a prior File-API upload) on the
// 2.5/2.0 family this seed covers. Neither page documents audio or video
// *output* on `generateContent` (that is a separate Live/TTS surface), so
// both stay output: false.
const GEMINI_MODALITIES: ModalityMatrix = Object.freeze({
  text: { input: true, output: true, sourceForms: ['inline'] },
  image: { input: true, output: false, sourceForms: ['inline', 'data-url', 'remote-url'] },
  document: { input: true, output: false, sourceForms: ['inline', 'remote-url'] },
  audio: { input: true, output: false, sourceForms: ['inline', 'remote-url', 'provider-file'] },
  video: { input: true, output: false, sourceForms: ['inline', 'remote-url', 'provider-file'] },
  file: UNSUPPORTED_MODALITY_ENTRY,
});

// ── MODEL_LIMITS: hand-maintained, one row per model, provider-attributed ──
//
// Every row cites the provider documentation page it was read from and the
// date it was read. Rows marked "confirmed 2026-09-02" were read live via
// WebFetch against the cited URL while writing this module. Rows for
// retired/legacy dated snapshots whose model page no longer publishes specs
// (Anthropic retires a model's dedicated docs page on retirement) cite the
// long-standing published values for that snapshot instead, honestly noted
// as not independently reconfirmed on 2026-09-02.

interface ModelLimitEntry {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
}

const ANTHROPIC_LIMITS: Readonly<Record<string, ModelLimitEntry>> = Object.freeze({
  // https://platform.claude.com/docs/en/models/fable-5/overview — confirmed 2026-09-02.
  'claude-fable-5': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // Same page, "Fable vs. Mythos": Mythos 5 "shares Claude Fable 5's
  // specifications and pricing" — confirmed 2026-09-02.
  'claude-mythos-5': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/opus-4-8/overview — confirmed 2026-09-02.
  'claude-opus-4-8': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/opus-4-7/overview — confirmed 2026-09-02.
  'claude-opus-4-7': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/overview (compare-models table) — confirmed 2026-09-02.
  'claude-sonnet-5': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/opus-4-6/overview — confirmed 2026-09-02.
  'claude-opus-4-6': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/opus-4-5/overview — confirmed 2026-09-02.
  'claude-opus-4-5': { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
  // https://platform.claude.com/docs/en/models/sonnet-4-6/overview — confirmed 2026-09-02.
  'claude-sonnet-4-6': { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
  // https://platform.claude.com/docs/en/models/overview (compare-models table) — confirmed 2026-09-02.
  'claude-haiku-4-5': { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
  // Retired (https://platform.claude.com/docs/en/about-claude/model-deprecations
  // lists it retired June 15, 2026; its dedicated model page no longer
  // publishes specs). Value is Anthropic's originally published Claude Opus 4
  // specification, not reconfirmed live on 2026-09-02.
  'claude-opus-4-20250514': { contextWindowTokens: 200_000, maxOutputTokens: 32_000 },
  // Retired (same deprecations page, June 15, 2026). Value is Anthropic's
  // originally published Claude Sonnet 4 specification (64K with the
  // extended-output beta header), not reconfirmed live on 2026-09-02.
  'claude-sonnet-4-20250514': { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
  // No dedicated Anthropic model page or deprecation-history row exists for
  // this exact retired id (`defaultPricingTable` still prices it, and
  // Anthropic does not publish a standalone spec page for it). Value is
  // Claude Haiku 4.5's pre-128K-generation defaults (200K/64K), the closest
  // documented sibling in the same Haiku 4-generation line; not an
  // independently sourced figure for this specific model id.
  'claude-haiku-4-20250506': { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
  // Long-standing published Claude 3.5 Sonnet specification. Retired
  // (deprecations page: deprecated Aug 13 2025, retired Oct 28 2025), so no
  // live model page remains to reconfirm against on 2026-09-02.
  'claude-3-5-sonnet-20241022': { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
  // Long-standing published Claude 3.5 Haiku specification. Retired
  // (deprecations page: deprecated Dec 19 2025, retired Feb 19 2026), so no
  // live model page remains to reconfirm against on 2026-09-02.
  'claude-3-5-haiku-20241022': { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
});

const OPENAI_LIMITS: Readonly<Record<string, ModelLimitEntry>> = Object.freeze({
  // https://developers.openai.com/api/docs/models/gpt-4.1 — confirmed
  // 2026-09-02: context 1,047,576, max output 32,768.
  'gpt-4.1': { contextWindowTokens: 1_047_576, maxOutputTokens: 32_768 },
  // Same family; OpenAI documents gpt-4.1-mini and gpt-4.1-nano sharing the
  // gpt-4.1 page's context/output limits. Not separately confirmed live.
  'gpt-4.1-mini': { contextWindowTokens: 1_047_576, maxOutputTokens: 32_768 },
  'gpt-4.1-nano': { contextWindowTokens: 1_047_576, maxOutputTokens: 32_768 },
  // Long-standing published o-series specification (OpenAI's o3/o3-mini/
  // o4-mini model pages); the OpenAI docs domain redirected mid-fetch on
  // 2026-09-02 and the redirected page did not carry this table, so this is
  // not independently reconfirmed live in this change.
  o3: { contextWindowTokens: 200_000, maxOutputTokens: 100_000 },
  'o3-mini': { contextWindowTokens: 200_000, maxOutputTokens: 100_000 },
  'o4-mini': { contextWindowTokens: 200_000, maxOutputTokens: 100_000 },
  // Long-standing published GPT-4o specification, same live-fetch caveat as
  // the o-series rows above.
  'gpt-4o': { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
  'gpt-4o-mini': { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
});

const GEMINI_LIMITS: Readonly<Record<string, ModelLimitEntry>> = Object.freeze({
  // Long-standing published Gemini 2.5 Pro specification
  // (ai.google.dev/gemini-api/docs/models); the per-model docs page returned
  // 404 on 2026-09-02, so this is not independently reconfirmed live.
  'gemini-2.5-pro': { contextWindowTokens: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.5-flash': { contextWindowTokens: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.0-flash': { contextWindowTokens: 1_048_576, maxOutputTokens: 8_192 },
});

const MODEL_LIMITS: Readonly<Record<ProviderName, Readonly<Record<string, ModelLimitEntry>>>> =
  Object.freeze({
    anthropic: ANTHROPIC_LIMITS,
    openai: OPENAI_LIMITS,
    gemini: GEMINI_LIMITS,
    voyage: Object.freeze({}),
    ollama: Object.freeze({}),
  });

// Hand-maintained, one row per model, provider-attributed — every row cites
// the shared per-provider matrix defined above (itself cited against the
// provider documentation page and the date it was read) rather than
// re-deriving the shape from a loop, so a new model added below without a
// deliberate modality decision is a compile error, not a silent default.

const ANTHROPIC_MODALITIES_TABLE: Readonly<Record<string, ModalityMatrix>> = Object.freeze({
  // ANTHROPIC_MODALITIES above — https://platform.claude.com/docs/en/build-with-claude/vision,
  // confirmed 2026-09-02.
  'claude-fable-5': ANTHROPIC_MODALITIES,
  'claude-mythos-5': ANTHROPIC_MODALITIES,
  'claude-opus-4-8': ANTHROPIC_MODALITIES,
  'claude-opus-4-7': ANTHROPIC_MODALITIES,
  'claude-sonnet-5': ANTHROPIC_MODALITIES,
  'claude-opus-4-6': ANTHROPIC_MODALITIES,
  'claude-opus-4-5': ANTHROPIC_MODALITIES,
  'claude-sonnet-4-6': ANTHROPIC_MODALITIES,
  'claude-haiku-4-5': ANTHROPIC_MODALITIES,
  'claude-opus-4-20250514': ANTHROPIC_MODALITIES,
  'claude-sonnet-4-20250514': ANTHROPIC_MODALITIES,
  'claude-haiku-4-20250506': ANTHROPIC_MODALITIES,
  'claude-3-5-sonnet-20241022': ANTHROPIC_MODALITIES,
  'claude-3-5-haiku-20241022': ANTHROPIC_MODALITIES,
});

const OPENAI_MODALITIES_TABLE: Readonly<Record<string, ModalityMatrix>> = Object.freeze({
  // OPENAI_MODALITIES above — https://developers.openai.com/api/docs/guides/pdf-files
  // and https://developers.openai.com/api/docs/guides/images-vision, confirmed 2026-09-02.
  'gpt-4.1': OPENAI_MODALITIES,
  'gpt-4.1-mini': OPENAI_MODALITIES,
  'gpt-4.1-nano': OPENAI_MODALITIES,
  o3: OPENAI_MODALITIES,
  'o3-mini': OPENAI_MODALITIES,
  'o4-mini': OPENAI_MODALITIES,
  'gpt-4o': OPENAI_MODALITIES,
  'gpt-4o-mini': OPENAI_MODALITIES,
});

const GEMINI_MODALITIES_TABLE: Readonly<Record<string, ModalityMatrix>> = Object.freeze({
  // GEMINI_MODALITIES above — https://ai.google.dev/gemini-api/docs/audio and
  // https://ai.google.dev/gemini-api/docs/video-understanding, confirmed 2026-09-02.
  'gemini-2.5-pro': GEMINI_MODALITIES,
  'gemini-2.5-flash': GEMINI_MODALITIES,
  'gemini-2.0-flash': GEMINI_MODALITIES,
});

const MODEL_MODALITIES: Readonly<Record<ProviderName, Readonly<Record<string, ModalityMatrix>>>> =
  Object.freeze({
    anthropic: ANTHROPIC_MODALITIES_TABLE,
    openai: OPENAI_MODALITIES_TABLE,
    gemini: GEMINI_MODALITIES_TABLE,
    voyage: Object.freeze({}),
    ollama: Object.freeze({}),
  });

/**
 * Exported only for `model-catalog.test.ts`'s completeness assertions — not
 * part of the public `./providers` barrel. Throws when a model computed from
 * the provider tables has no `MODEL_LIMITS` row, so a later addition to
 * `ANTHROPIC_EFFORT_SUPPORT`/`*_MODEL_ALIASES`/`defaultPricingTable` without
 * a matching seed row fails loudly instead of emitting a fabricated `0`.
 */
export function requireLimits(provider: ProviderName, model: string): ModelLimitEntry {
  const entry = MODEL_LIMITS[provider][model];
  if (!entry) {
    throw new Error(`model-catalog: no MODEL_LIMITS entry for ${provider}/${model}`);
  }
  return entry;
}

/**
 * Exported only for `model-catalog.test.ts`'s completeness assertions — not
 * part of the public `./providers` barrel. Throws when a model computed from
 * the provider tables has no `MODEL_MODALITIES` row, mirroring
 * {@link requireLimits}.
 */
export function requireModalities(provider: ProviderName, model: string): ModalityMatrix {
  const entry = MODEL_MODALITIES[provider][model];
  if (!entry) {
    throw new Error(`model-catalog: no MODEL_MODALITIES entry for ${provider}/${model}`);
  }
  return entry;
}

// ── Row construction ────────────────────────────────────────────────────────

function pricingFor(model: string): BackendDescriptor['pricing'] {
  const pricing = getModelPricing(model);
  if (!pricing) return undefined;
  return {
    inputPerMillionTokens: pricing.promptCostPerMillionTokens,
    outputPerMillionTokens: pricing.completionCostPerMillionTokens,
    currency: 'USD',
  };
}

function buildAnthropicRow(model: string, freshness: string): BackendDescriptor {
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

function buildOpenAIRow(
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

function buildGeminiRow(model: string, freshness: string): BackendDescriptor {
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

/**
 * The base URL the `openai` SDK would use when no explicit one is passed.
 * Mirrors `capabilities.ts`'s historical `readOpenAIBaseUrlOverride`, moved
 * here because `endpointAmbiguous` is now decided in this module.
 */
function readOpenAIBaseUrlOverride(): string | undefined {
  return typeof Bun !== 'undefined' ? Bun.env['OPENAI_BASE_URL'] : process.env['OPENAI_BASE_URL'];
}

export interface CreateModelCatalogOptions {
  readonly openAIBaseURL?: string;
  readonly now?: () => string;
}

/**
 * Builds the static `ModelCatalog` seed: synchronous, side-effect-free, no
 * network input or output, no timer, no `queueMicrotask`, and no background
 * work. `now` defaults to the wall clock and is the only clock this module
 * reads — inject it in tests. Returns a deeply frozen catalog whose initial
 * `revision` is `1`.
 */
export function createModelCatalog(options?: CreateModelCatalogOptions): ModelCatalog {
  const now = options?.now ?? (() => new Date().toISOString());
  const freshness = now();
  const endpointAmbiguous = Boolean(options?.openAIBaseURL || readOpenAIBaseUrlOverride());

  const anthropicDescriptors = Object.keys(ANTHROPIC_LIMITS).map((model) =>
    Object.freeze(buildAnthropicRow(model, freshness)),
  );
  const openAIDescriptors = Object.keys(OPENAI_LIMITS).map((model) =>
    Object.freeze(buildOpenAIRow(model, freshness, endpointAmbiguous)),
  );
  const geminiDescriptors = Object.keys(GEMINI_LIMITS).map((model) =>
    Object.freeze(buildGeminiRow(model, freshness)),
  );

  const descriptors = Object.freeze([
    ...anthropicDescriptors,
    ...openAIDescriptors,
    ...geminiDescriptors,
  ]);

  return Object.freeze({
    revision: 1,
    descriptors,
    generatedAt: freshness,
    stale: false,
    projection: 'privileged',
  });
}
