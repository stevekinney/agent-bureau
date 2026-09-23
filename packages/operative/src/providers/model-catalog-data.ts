import type { Modality, ModalityMatrix } from 'conversationalist';
import type { ProviderName } from './types.ts';

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

export interface ModelLimitEntry {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
}

export const ANTHROPIC_LIMITS: Readonly<Record<string, ModelLimitEntry>> = Object.freeze({
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

export const OPENAI_LIMITS: Readonly<Record<string, ModelLimitEntry>> = Object.freeze({
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

export const GEMINI_LIMITS: Readonly<Record<string, ModelLimitEntry>> = Object.freeze({
  // Long-standing published Gemini 2.5 Pro specification
  // (ai.google.dev/gemini-api/docs/models); the per-model docs page returned
  // 404 on 2026-09-02, so this is not independently reconfirmed live.
  'gemini-2.5-pro': { contextWindowTokens: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.5-flash': { contextWindowTokens: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.0-flash': { contextWindowTokens: 1_048_576, maxOutputTokens: 8_192 },
});

export const MODEL_LIMITS: Readonly<
  Record<ProviderName, Readonly<Record<string, ModelLimitEntry>>>
> = Object.freeze({
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

export const MODEL_MODALITIES: Readonly<
  Record<ProviderName, Readonly<Record<string, ModalityMatrix>>>
> = Object.freeze({
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
