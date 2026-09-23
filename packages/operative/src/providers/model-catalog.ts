import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';
import type { MediaLimits, MimeFamily, Modality, ModalityMatrix } from 'conversationalist';

import { readEnvironmentConfiguration } from '../environment-configuration.ts';
import { ANTHROPIC_LIMITS, GEMINI_LIMITS, OPENAI_LIMITS } from './model-catalog-data.ts';
import {
  buildAnthropicRow,
  buildGeminiRow,
  buildOpenAIRow,
  deepFreeze,
} from './model-catalog-rows.ts';
import type { BaseProviderOptions, Effort, ProviderName } from './types.ts';

export { requireLimits, requireModalities, type ModelLimitEntry } from './model-catalog-data.ts';

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
  readonly maxConcurrentGenerations?: number | undefined;
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
  readonly generatedAssetBehavior?: readonly GeneratedAssetBehavior[] | undefined;
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
  readonly endpointAmbiguous?: boolean | undefined;
  readonly pricing?:
    | {
        readonly inputPerMillionTokens: number;
        readonly outputPerMillionTokens: number;
        readonly currency: string;
      }
    | undefined;
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

/**
 * The base URL the `openai` SDK would use when no explicit one is passed.
 * Mirrors `capabilities.ts`'s historical `readOpenAIBaseUrlOverride`, moved
 * here because `endpointAmbiguous` is now decided in this module.
 */
function readOpenAIBaseUrlOverride(): string | undefined {
  return readEnvironmentConfiguration().openaiBaseUrl;
}

export interface CreateModelCatalogOptions {
  readonly openAIBaseURL?: string | undefined;
  readonly now?: (() => string) | undefined;
  /**
   * The AB-92/AB-252 `RuntimeServices` seam (AB-325) backing the default
   * `now` when `options.now` is not supplied. Defaults to the real
   * implementation; `options.now` still takes precedence over `runtime`
   * when both are supplied, for backward compatibility.
   */
  readonly runtime?: RuntimeServices | undefined;
}

/**
 * Builds the static `ModelCatalog` seed: synchronous, side-effect-free, no
 * network input or output, no timer, no `queueMicrotask`, and no background
 * work. `now` defaults to `options.runtime.clock.nowISO()` (the real
 * implementation when `runtime` is omitted) and is the only clock this
 * module reads — inject `now` or a manual `runtime` in tests. Returns a
 * deeply frozen catalog whose initial `revision` is `1`.
 */
export function createModelCatalog(options?: CreateModelCatalogOptions): ModelCatalog {
  const runtime = options?.runtime ?? createDefaultRuntimeServices();
  const now = options?.now ?? (() => runtime.clock.nowISO());
  const freshness = now();
  const endpointAmbiguous = Boolean(options?.openAIBaseURL || readOpenAIBaseUrlOverride());

  const anthropicDescriptors = Object.keys(ANTHROPIC_LIMITS).map((model) =>
    deepFreeze(buildAnthropicRow(model, freshness)),
  );
  const openAIDescriptors = Object.keys(OPENAI_LIMITS).map((model) =>
    deepFreeze(buildOpenAIRow(model, freshness, endpointAmbiguous)),
  );
  const geminiDescriptors = Object.keys(GEMINI_LIMITS).map((model) =>
    deepFreeze(buildGeminiRow(model, freshness)),
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
