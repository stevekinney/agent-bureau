import { createModelCatalog } from './model-catalog.ts';
import type { ProviderName } from './types.ts';

/**
 * What a provider can be asked to do beyond a plain generate call.
 *
 * Each flag names a *native* provider mechanism, not an operative feature.
 * Operative's rule for all four is progressive enhancement: expose the
 * provider's own mechanism where one exists, and export nothing at all where
 * one does not. "Unsupported" is a compile-time fact — there is no module to
 * import — never a factory that throws or silently no-ops at runtime. This
 * object is how a caller reads that fact at runtime, for a provider chosen
 * dynamically.
 */
export interface ProviderCapabilities {
  /**
   * The provider has a native asynchronous batch endpoint. See
   * `providers/batches/` — one factory per provider that has one, and no
   * factory for the ones that do not.
   */
  readonly batchInference: boolean;
  /**
   * A request can ask for extended thinking explicitly, as its own request
   * field. A reasoning-*effort tier* (`Effort`, mapped in
   * `providers/shared/effort.ts`) is a different, weaker thing and does not
   * count: it selects how hard the model tries, not whether thinking is
   * requested and returned.
   */
  readonly explicitThinkingRequest: boolean;
  /**
   * The request itself controls prompt caching — the caller marks what to
   * cache, per request. Implicit or automatic caching the provider applies on
   * its own does not count, because the request cannot steer it.
   */
  readonly requestControlledContextCaching: boolean;
  /**
   * The provider can count the tokens in a request server-side, before it is
   * sent for generation. A client-side estimator does not count.
   */
  readonly serverSideTokenCounting: boolean;
}

const NO_CAPABILITIES: ProviderCapabilities = {
  batchInference: false,
  explicitThinkingRequest: false,
  requestControlledContextCaching: false,
  serverSideTokenCounting: false,
};

/**
 * Reports which of the four capabilities a provider supports.
 *
 * Synchronous and side-effect-free by design: it makes no network call and
 * performs no provider discovery, so it is safe to call while assembling a
 * request, in a routing decision, or in a UI that renders which options to
 * offer. It answers from what operative knows at build time about the SDK
 * surfaces it ships against — `@anthropic-ai/sdk`, `openai`, and
 * `@google/genai` — plus one ambient input, described under "Reads the
 * environment" below.
 *
 * ## What each provider reports
 *
 * | Provider | Batch | Thinking | Caching | Token counting |
 * | --- | --- | --- | --- | --- |
 * | `anthropic` | yes | yes | yes | yes |
 * | `openai` (default endpoint) | yes | no | no | no |
 * | `openai` (custom `baseURL` **or** `OPENAI_BASE_URL` set) | no | no | no | no |
 * | `gemini` | yes | no | yes | yes |
 * | `voyage`, `ollama` | no | no | no | no |
 *
 * `voyage` and `ollama` are embedding-only providers here: operative ships
 * `createVoyageEmbedder` and `createOllamaEmbedder` and no generate function
 * for either, so none of these four generation-time capabilities applies. All
 * `false` is the honest report, not a placeholder.
 *
 * ## Why a custom OpenAI `baseURL` reports `false`
 *
 * A `baseURL` may point at `api.openai.com`, at a credential-injecting proxy in
 * front of it, or at a local Ollama / vLLM / LM Studio server that reuses
 * OpenAI's chat shape and implements nothing else. Operative cannot tell which
 * from a string, and reporting `true` for an endpoint that 404s is worse than
 * reporting `false` for one that happens to exist: a `false` costs a caller a
 * fallback path, while a wrong `true` costs them a failed request they were
 * told to expect to work. So any custom base URL reports `false` across the
 * board.
 *
 * That rule applies to `openai` alone because it is the only one of the three
 * whose `baseURL` is documented as an OpenAI-compatible-server escape hatch:
 * `OpenAIProviderOptions.baseURL` says "Enables LM Studio, Ollama, Groq, etc.",
 * while `AnthropicProviderOptions.baseURL` and `GeminiProviderOptions.baseURL`
 * document a credential-injecting proxy origin — something that forwards to the
 * real provider — so a custom value there does not imply a different, smaller
 * API.
 *
 * An empty-string `baseURL` counts as the default endpoint, because that is
 * what client construction actually does with it: every provider factory writes
 * the option through a truthiness check (`if (baseURL) …`), so `''` never
 * reaches the SDK and the default endpoint is used. An empty-string
 * `OPENAI_BASE_URL` counts as the default for the same reason.
 *
 * ## Reads the environment
 *
 * The `openai` answer depends on ambient environment, and cannot honestly not:
 * `openai` documents `baseURL` as "Defaults to `process.env['OPENAI_BASE_URL']`",
 * so an unset option is not the same thing as the default endpoint. A process
 * with `OPENAI_BASE_URL` pointing at LM Studio or Ollama is in exactly the
 * configuration the rule above is conservative about, and reporting
 * `batchInference: true` there would send a caller's batch request to a server
 * with no `/v1/batches` — `createOpenAIBatchClient` constructs its client with
 * no explicit base URL, so the SDK honors the override. This function therefore
 * reports on the *effective* endpoint: an explicit `options.baseURL` first, then
 * the environment override, then the default.
 *
 * Two consequences worth knowing. The answer can differ between two processes
 * running the same code, so it is a fact about this process rather than about
 * the build. And it is not memoizable across a change to `process.env` — call
 * it when you need the answer instead of caching it at module load.
 *
 * ## Descriptor projection (AB-64)
 *
 * This surface is now a projection over `createModelCatalog`'s static
 * `BackendDescriptor` seed (`./model-catalog.ts`), ratified by AB-64's
 * decision record. It is no longer the hand-maintained table this function's
 * body used to be — it groups the catalog's descriptor rows for `provider`
 * and folds each of the four flags across them (`caching` stands in for
 * `requestControlledContextCaching`) — but the public signature, the
 * conservative-ambiguous-`baseURL` rule, and every previously published
 * answer are unchanged: see `model-catalog.test.ts`'s characterization
 * matrix, which asserts bit-for-bit identical output against this function's
 * pre-AB-64 behavior for all five `ProviderName` values across four
 * environment states.
 *
 * @param provider - The provider to report on.
 * @param options.baseURL - The base URL that would be passed to the provider
 *   factory, if any. Only consulted for `openai`. Leaving it unset does not
 *   assert the default endpoint — `OPENAI_BASE_URL` is consulted next.
 */
export function getProviderCapabilities(
  provider: ProviderName,
  options?: { readonly baseURL?: string },
): ProviderCapabilities {
  switch (provider) {
    case 'anthropic':
    case 'openai':
    case 'gemini': {
      const rows = createModelCatalog({ openAIBaseURL: options?.baseURL }).descriptors.filter(
        (descriptor) => descriptor.provider === provider,
      );
      return {
        batchInference: rows.every((row) => row.batchInference),
        explicitThinkingRequest: rows.every((row) => row.explicitThinkingRequest),
        requestControlledContextCaching: rows.every((row) => row.caching),
        serverSideTokenCounting: rows.every((row) => row.serverSideTokenCounting),
      };
    }
    case 'voyage':
    case 'ollama':
      return NO_CAPABILITIES;
  }
}
