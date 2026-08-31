import type { Message } from 'conversationalist';

import type { TokenBudget } from '../context/token-budget.ts';
import type { ContextAssembler } from '../context/types.ts';
import type { ResponseFormat, ToolChoice } from './structured-output/types.ts';

export type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
  TokenUsage,
} from '../types.ts';

/**
 * Provider names supported by operative providers.
 */
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'voyage' | 'ollama';

/**
 * Provider-neutral reasoning-effort tier. Superset of Tribunal's
 * `effort IN ('low','medium','high','xhigh','max')` database CHECK
 * constraint. Each shipped provider maps this to its own native mechanism —
 * see `providers/shared/effort.ts` for the per-provider mapping table and
 * the fallback matrix used when a resolved model doesn't support a tier.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Base options shared across all provider factories.
 */
export interface BaseProviderOptions {
  /**
   * Provider-native model ID, OR a shorthand alias resolved once at
   * provider-construction time — see `providers/shared/model-registry.ts`
   * for the per-provider alias table and its single resolution point.
   * Full provider-native IDs pass through unchanged. The alias `'inherit'`
   * is never resolved here; it is a caller-side concern (see that module's
   * doc comment).
   */
  model: string;
  /**
   * Provider-neutral effort tier. Mapped to the resolved model's native
   * mechanism, with a deterministic fallback when unsupported — see
   * `providers/shared/effort.ts`. The actually-used tier is reported back
   * on `GenerateResponse.metadata.effectiveEffort`.
   */
  effort?: Effort;
  maximumTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  /**
   * Provider-neutral per-run request metadata, attached to every generate
   * request of the run. Mapped to each provider's native field: Anthropic
   * Messages `metadata`; OpenAI Chat Completions `metadata` (native
   * string-keyed map, up to 16 keys). Gemini has no request-level metadata
   * field in its API — this option is an explicit no-op for
   * {@link createGeminiProvider}.
   *
   * Anthropic caveat: its `Metadata` type documents exactly one field
   * (`user_id`) — the whole object is still forwarded as-is so a
   * credential-injecting proxy (see {@link AnthropicProviderOptions.baseURL})
   * can inspect arbitrary keys on the wire, but sending non-`user_id` keys
   * straight to Anthropic's real endpoint (no proxy in front) gets the
   * request rejected. Only pass extra keys when a proxy will translate or
   * strip them before forwarding.
   */
  requestMetadata?: Record<string, string>;
}

/**
 * Structural interface for the Anthropic SDK client surface the provider uses.
 */
export interface AnthropicClient {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicMessageResponse>;
  };
}

/**
 * Minimal shape of an Anthropic Messages API response.
 */
export interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  stop_reason?: string;
}

/**
 * Structural mirror of the Anthropic SDK's `ThinkingConfigParam` union, for
 * {@link AnthropicProviderOptions.thinking}.
 *
 * Declared structurally rather than re-exported from `@anthropic-ai/sdk`
 * because that SDK is an *optional* peer dependency: a direct type import
 * would drag it into this package's published declarations and break every
 * consumer who does not install it. `anthropic-thinking-assignability.test-d.ts`
 * pins this against drift by asserting the SDK's own `ThinkingConfigParam` is
 * assignable to this type, so a fourth variant added upstream fails the build
 * here rather than silently becoming unreachable.
 *
 * All three of the SDK's variants are present on purpose. An earlier revision
 * declared only `enabled`/`disabled`, which narrowed a supposedly native-shaped
 * escape hatch and left `{ type: 'adaptive' }` — a mode Anthropic actually
 * accepts — unreachable without defeating the type system.
 */
export type AnthropicThinkingConfig =
  | {
      type: 'enabled';
      /**
       * Anthropic's constraint, quoted from the SDK's own declaration: "Must
       * be ≥1024 and less than `max_tokens`." Both provider factories check
       * this rather than letting the API reject the request — the ≥1024 floor
       * at construction, and the `< max_tokens` bound per request, since
       * {@link GenerateContext.maximumTokens} can raise the effective
       * `max_tokens` above the construction-time value on any given call.
       */
      budget_tokens: number;
      /** `'omitted'` redacts thinking content but keeps a signature for multi-turn continuity. */
      display?: 'summarized' | 'omitted' | null;
    }
  | { type: 'disabled' }
  | {
      type: 'adaptive';
      /** `'omitted'` redacts thinking content but keeps a signature for multi-turn continuity. */
      display?: 'summarized' | 'omitted' | null;
    };

/**
 * Options for createAnthropicProvider.
 */
export interface AnthropicProviderOptions extends BaseProviderOptions {
  client?: AnthropicClient;
  apiKey?: string;
  /**
   * Overrides the Anthropic SDK's default base URL. Accepts any string —
   * including a credential-injecting proxy origin — with no shape
   * validation. Passed straight to the `Anthropic` client constructor.
   */
  baseURL?: string;
  /**
   * Opts every `cache_control` breakpoint lowered from a conversation
   * `cacheBoundary` into Anthropic's extended one-hour cache TTL instead of
   * the default 5-minute one. No effect unless `assembler`/`contextBudget`
   * (or an already-marked conversation) actually produce a cache boundary.
   */
  extendedCacheTtl?: boolean;
  /**
   * Enables prompt-cache-aware context assembly. When set (together with
   * {@link AnthropicProviderOptions.contextBudget}), each call runs
   * `assembler` in stable-prefix mode instead of sending the conversation
   * verbatim. The resulting `cacheBoundary` mark on the assembled
   * system/pinned prefix is preserved through to the request, so
   * `toAnthropicMessages` lowers it to a `cache_control` breakpoint — see
   * `createContextAssembler`'s `stablePrefix` option.
   */
  assembler?: ContextAssembler;
  /** Token budget passed to `assembler`. Required when `assembler` is set. */
  contextBudget?: TokenBudget;
  /** Passed through to `assembler` as `pinnedMessages` (e.g. reference docs, tool usage notes). */
  pinnedMessages?: ReadonlyArray<Message>;
  /**
   * Requests Anthropic's extended-thinking mode, mirroring the native
   * `thinking` request field shape directly — see
   * {@link AnthropicThinkingConfig} for the full union (`enabled`, `disabled`,
   * and `adaptive`).
   *
   * This is deliberately a second, provider-native escape hatch rather than
   * a provider-neutral abstraction: `effort` is already operative's one
   * neutral knob over this dimension, and layering a second abstraction over
   * the same concept would just create two competing vocabularies for the
   * same thing. `thinking` and `effort` lower to different wire fields
   * (`thinking` vs. `output_config.effort`) and neither overrides the
   * other — when both are set, both are sent, and Anthropic applies its own
   * documented interaction between them. This sits alongside
   * `extendedCacheTtl` and `baseURL` as the other native-shape options on
   * this type.
   *
   * ## Known limitation: thinking is not yet supported end-to-end with tool calls
   *
   * Setting this alongside a toolbox is **not** a supported combination today.
   * Anthropic documents thinking-block replay as mandatory inside a tool-use
   * turn — "Required: within a tool-use turn, pass thinking blocks back",
   * "complete and unmodified", each block carrying the signed `signature` the
   * server decrypts to reconstruct the reasoning. This provider extracts only
   * `text` and `tool_use` blocks from the response, so the `thinking` (or
   * `redacted_thinking`) block that accompanied the tool call never reaches
   * the conversation, and the follow-up request that carries the tool result
   * omits it. Anthropic does not hard-fail that request: it degrades — the API
   * strips blocks that would form an invalid turn structure, or silently
   * disables thinking for that request — so the failure mode is quality loss
   * that never announces itself, not an error the caller can catch.
   *
   * Fixing it means preserving native response blocks in conversation history,
   * which is **output**-side work owned by AB-73 (the multimodal output
   * contract, project ABP-13) and reaches into conversationalist's message
   * model and `run-step.ts`. AB-157 — the issue that added this option — is
   * scoped to the *request* knob only, and is recorded as `related` to AB-73
   * precisely so both do not quietly reshape the same response surface. Until
   * AB-73 lands, use this option on tool-free requests, or accept that
   * multi-step tool loops lose reasoning continuity between steps.
   *
   * ## Validation
   *
   * `{ type: 'enabled' }`'s budget is checked against Anthropic's documented
   * bounds; see {@link AnthropicThinkingConfig}. Both factories additionally
   * reject, at construction, the combinations Anthropic documents as
   * incompatible with an active thinking configuration: a non-default
   * {@link BaseProviderOptions.temperature}, a
   * {@link BaseProviderOptions.topP} below 0.95, and — for `{ type: 'enabled' }`
   * only — a forced {@link BaseProviderOptions.toolChoice} (`'required'` or a
   * named tool). Forced tool use is fine with `{ type: 'adaptive' }`, which
   * Anthropic explicitly supports.
   */
  thinking?: AnthropicThinkingConfig;
}

/**
 * Structural interface for the OpenAI SDK client surface the provider uses.
 */
export interface OpenAIClient {
  chat: {
    completions: {
      create(params: Record<string, unknown>): Promise<OpenAIChatCompletion>;
    };
  };
}

/**
 * Minimal shape of an OpenAI Chat Completion response.
 */
export interface OpenAIChatCompletion {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Options for createOpenAIProvider.
 */
export interface OpenAIProviderOptions extends BaseProviderOptions {
  client?: OpenAIClient;
  apiKey?: string;
  /**
   * Overrides the OpenAI SDK's default base URL. Accepts any string —
   * including a credential-injecting proxy origin — with no shape
   * validation. Enables LM Studio, Ollama, Groq, etc.
   */
  baseURL?: string;
}

/**
 * Minimal shape of a `@google/genai` `GenerateContentParameters` request body.
 *
 * The SDK's own `GenerateContentParameters` is an `interface`, so it carries no
 * implicit index signature and is therefore *not* assignable to
 * `Record<string, unknown>`. Naming the required `model`/`contents` fields here
 * — and widening only the payload-shaped fields to `unknown` — is what lets a
 * real `GoogleGenAI` instance satisfy {@link GeminiGenerativeModel} and
 * {@link GeminiStreamingModel} without a cast, while keeping consumer fakes
 * trivial to write. Do not add an index signature: that would put the
 * assignability back where it was.
 */
export interface GeminiGenerateContentRequest {
  /** Provider-native model id, sent with every request by the maintained SDK. */
  model: string;
  /** `ContentListUnion` in the SDK; widened here so fakes need not model it. */
  contents: unknown;
  /** `GenerateContentConfig` in the SDK; omitted when no options are set. */
  config?: unknown;
}

/**
 * Structural interface for a `@google/genai` client.
 *
 * The maintained SDK centres on a `GoogleGenAI` client whose `models`
 * namespace takes the model id on every request, rather than binding a model
 * handle at construction time the way the previous SDK's `getGenerativeModel()`
 * did.
 *
 * A real `GoogleGenAI` instance is assignable to this interface — see
 * `gemini-client-assignability.test-d.ts`, which locks that in.
 */
export interface GeminiGenerativeModel {
  models: {
    generateContent(params: GeminiGenerateContentRequest): Promise<GeminiGenerateContentResult>;
  };
}

/**
 * Minimal shape of a `@google/genai` `GenerateContentResponse`.
 *
 * Candidates and usage sit at the top level — the frozen SDK's `.response`
 * wrapper is gone. `functionCall.name` and `functionCall.args` are both
 * optional in the maintained SDK, so parts must be narrowed before they are
 * handed to armorer's stricter `GeminiPart` union.
 */
export interface GeminiGenerateContentResult {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name?: string; args?: Record<string, unknown> };
      }>;
    };
  }>;
  usageMetadata?: GeminiUsageMetadata;
}

/**
 * Minimal shape of a `@google/genai` `GenerateContentResponseUsageMetadata`.
 *
 * `promptTokenCount` INCLUDES `cachedContentTokenCount` — the SDK states it
 * outright: "When `cached_content` is set, this also includes the number of
 * tokens in the cached content." That makes Gemini match OpenAI's inclusive
 * accounting rather than Anthropic's disjoint buckets, which is why
 * `buildGeminiUsage` subtracts rather than passing the count straight through.
 * Gemini reports no cache-write counterpart, so there is nothing to map to
 * `cacheCreationTokens`.
 */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  /** Tokens of the prompt served from a context cache, per the SDK's own docs. */
  cachedContentTokenCount?: number;
}

/**
 * Minimal shape of a `@google/genai` `CreateCachedContentParameters`.
 *
 * `model` is required in the SDK and required here. `config` is
 * `CreateCachedContentConfig` — carrying `contents`, `systemInstruction`,
 * `ttl`, `displayName`, `tools`, and `toolConfig` — widened to `unknown` for
 * the same reason {@link GeminiGenerateContentRequest} widens its own
 * payload-shaped fields: the SDK's config types are `interface`s with no
 * implicit index signature, so a `Record<string, unknown>` here would take a
 * real `GoogleGenAI` out of reach without a cast.
 */
export interface GeminiCreateCachedContentRequest {
  /** Provider-native model id. Must match the model used to generate. */
  model: string;
  /** `CreateCachedContentConfig` in the SDK; omitted when no options are set. */
  config?: unknown;
}

/**
 * Minimal shape of a `@google/genai` `CachedContent`. Every field is optional
 * in the SDK, so every field is optional here.
 */
export interface GeminiCachedContent {
  /** Server-generated resource name — the handle passed back as `cachedContent`. */
  name?: string;
  displayName?: string;
  model?: string;
  createTime?: string;
  updateTime?: string;
  expireTime?: string;
  /** `CachedContentUsageMetadata` in the SDK, carrying `totalTokenCount`. */
  usageMetadata?: { totalTokenCount?: number };
}

/**
 * Structural interface for the `caches` namespace of a `@google/genai` client.
 *
 * Deliberately narrower than the SDK's `Caches` class, which also exposes
 * `get`, `list`, `update`, and `delete`. This package only ever creates a cache
 * resource, so only `create` is named — a smaller surface for a caller's fake
 * to satisfy, and the same minimal-interface rule the batch and generate
 * interfaces follow. A real `GoogleGenAI` satisfies this; see
 * `gemini-client-assignability.test-d.ts`.
 */
export interface GeminiCacheCreatingClient {
  caches: {
    create(params: GeminiCreateCachedContentRequest): Promise<GeminiCachedContent>;
  };
}

/**
 * Minimal shape of a `@google/genai` `CountTokensParameters`.
 *
 * `model` and `contents` are required in the SDK and required here; `config`
 * is `CountTokensConfig` — carrying `systemInstruction`, `tools`, and
 * `generationConfig`, none of which this package needs to inspect — widened to
 * `unknown` for the same reason {@link GeminiGenerateContentRequest} widens its
 * own payload-shaped fields: the SDK's config types are `interface`s with no
 * implicit index signature, so a `Record<string, unknown>` here would take a
 * real `GoogleGenAI` out of reach without a cast.
 */
export interface GeminiCountTokensRequest {
  /** Provider-native model id. Token counts are model-specific. */
  model: string;
  /** `ContentListUnion` in the SDK; widened here so fakes need not model it. */
  contents: unknown;
  /** `CountTokensConfig` in the SDK; omitted when no options are set. */
  config?: unknown;
}

/**
 * Minimal shape of a `@google/genai` `CountTokensResponse`.
 *
 * Both fields are optional in the SDK — `totalTokens` genuinely can come back
 * absent, not merely zero, so this type never fabricates a `0` for it. That
 * mirrors {@link GeminiUsageMetadata} and {@link TokenUsage}'s own rule:
 * "absent" and "zero" are distinct, and a caller doing budgeting on a token
 * count needs to be able to tell them apart.
 *
 * **Provisional.** This is deliberately the SDK's own field names, unrenamed,
 * rather than a new provider-neutral shape — AB-64 is still in Backlog and
 * will define the real context/output-limit fields this package standardizes
 * on. Introducing a parallel budgeting shape here now would just be more
 * surface for AB-64 to reconcile against later.
 */
export interface GeminiCountTokensResponse {
  /** Total token count for `contents` (and `config`, when supplied). */
  totalTokens?: number;
  /** Tokens attributable to a referenced context cache. */
  cachedContentTokenCount?: number;
}

/**
 * Structural interface for the `models.countTokens` operation of a
 * `@google/genai` client.
 *
 * Deliberately narrower than the SDK's `Models` class, which also exposes
 * `generateContent`, `embedContent`, and much more — this package only ever
 * calls `countTokens` through this interface, matching the minimal-interface
 * rule {@link GeminiCacheCreatingClient} and the batch interfaces follow. A
 * real `GoogleGenAI` satisfies this; see `gemini-client-assignability.test-d.ts`.
 */
export interface GeminiTokenCountingClient {
  models: {
    countTokens(params: GeminiCountTokensRequest): Promise<GeminiCountTokensResponse>;
  };
}

/**
 * Options for createGeminiProvider.
 */
export interface GeminiProviderOptions extends BaseProviderOptions {
  client?: GeminiGenerativeModel;
  apiKey?: string;
  /**
   * Overrides the Gemini SDK's default base URL (`HttpOptions.baseUrl`).
   * Accepts any string — including a credential-injecting proxy origin —
   * with no shape validation.
   */
  baseURL?: string;
  /**
   * Names an already-created `CachedContent` resource to serve this run's
   * prompt prefix from, lowered verbatim to `config.cachedContent`.
   *
   * ## Contract: the conversation you pass must be the tail only
   *
   * A `CachedContent` resource *is* the head of the prompt — it holds the
   * `systemInstruction` and `contents` the model sees before anything on the
   * request. Setting this option therefore does not append a cache to your
   * conversation; it declares that the head of the conversation already lives
   * server-side. Every call must pass **only the turns that are not in that
   * cache**. Passing the same full conversation you would have sent uncached
   * states the cached prefix twice, which changes the prompt the model reads and
   * bills you for the duplicate tokens on every request.
   *
   * Operative cannot do the subtraction for you. It never sees inside a resource
   * it did not create, so it has no boundary to split on — unlike the
   * provider-managed path below, where it created the prefix and knows exactly
   * where it ends. You own the cache, so you own the boundary.
   *
   * The one half of the contract that *is* checkable is enforced: a conversation
   * carrying a system message is rejected with a `ProviderError` at the point of
   * use, because that message would be sent as `config.systemInstruction`
   * beside `config.cachedContent` and duplicate or contradict the instruction
   * the cache holds. Re-sent conversational turns cannot be detected from here
   * and are yours to keep out.
   *
   * ## Naming and exclusivity
   *
   * Named after the SDK's own `GenerateContentConfig.cachedContent` field
   * rather than after anything on {@link AnthropicProviderOptions}, because
   * there is no Anthropic analog to rename it to: Anthropic's prompt cache is
   * an unnamed, per-request `cache_control` breakpoint with no handle, while
   * Gemini's is an explicitly-created server resource addressed by its
   * server-generated name.
   *
   * Mutually exclusive with {@link GeminiProviderOptions.assembler} +
   * {@link GeminiProviderOptions.contextBudget}: one names a cache you own,
   * the other has the provider create and own one. Setting both is rejected at
   * factory-construction time rather than silently resolved.
   */
  cachedContent?: string;
  /**
   * Enables prompt-cache-aware context assembly. When set (together with
   * {@link GeminiProviderOptions.contextBudget}), each call runs `assembler`
   * in stable-prefix mode instead of sending the conversation verbatim. The
   * `cacheBoundary` mark on the assembled system/pinned prefix splits the
   * conversation: everything up to and including the boundary is created as a
   * `CachedContent` resource, and every request then sends only the tail and
   * references the cache by name.
   *
   * A resource is created once **per distinct stable prefix**, not once per
   * generated function. A generate function is reusable across runs, so a
   * second conversation with a different system prompt or different pinned
   * content gets its own resource rather than inheriting the first run's — it
   * would otherwise omit its own prefix while pointing at another run's, which
   * is both a wrong answer and a leak of that run's instructions into it. The
   * retained set is bounded, and the least recently used entry is evicted past
   * the bound; eviction abandons the resource to its own server-side TTL and
   * costs at most one extra creation the next time that prefix comes back.
   *
   * Expiry is tracked per entry, from the SDK's own `CachedContent.expireTime`
   * where it reports one and from {@link GeminiProviderOptions.cacheTtl}
   * otherwise, so a lapsed resource is replaced rather than referenced until
   * the API rejects it. A resource that dies inside the remaining window — it
   * lapsed between the check and the request, or was deleted elsewhere — is
   * detected from the rejection and rebuilt once for that request.
   *
   * Same name, same type, and the same `assembler && contextBudget`
   * engagement condition as {@link AnthropicProviderOptions.assembler} — the
   * concept genuinely matches, so the name does too. What differs is the
   * lowering: `toGeminiMessages` documents `cacheBoundary` as a wire-level
   * no-op for Gemini, because Gemini has no per-message annotation to lower it
   * to. The mark is still the mechanism here; it just steers an out-of-band
   * `caches.create` call rather than a `cache_control` field.
   */
  assembler?: ContextAssembler;
  /** Token budget passed to `assembler`. Required when `assembler` is set. */
  contextBudget?: TokenBudget;
  /** Passed through to `assembler` as `pinnedMessages` (e.g. reference docs, tool usage notes). */
  pinnedMessages?: ReadonlyArray<Message>;
  /**
   * TTL for the provider-created cache resource, as the SDK's duration string
   * (`'3600s'`, up to nine fractional digits). Passed to `caches.create` as
   * `config.ttl`; when omitted, Gemini applies its own server-side default.
   *
   * The deliberate divergence from
   * {@link AnthropicProviderOptions.extendedCacheTtl}: that option is a
   * boolean because Anthropic offers exactly two fixed lifetimes (5 minutes,
   * or 1 hour) for an annotation on a request that is about to be sent
   * anyway. Gemini's TTL is an arbitrary duration on a standalone resource
   * with its own lifecycle, so a boolean could not express it and the
   * `extended` framing would be a fiction. No effect unless `assembler` +
   * `contextBudget` actually produce a provider-created cache — a cache named
   * through {@link GeminiProviderOptions.cachedContent} carries the TTL it was
   * created with.
   *
   * Also the fallback for local expiry bookkeeping: the provider replaces a
   * lapsed cache rather than referencing it, and prefers the SDK's own
   * `CachedContent.expireTime` for that — it accounts for Gemini's server-side
   * default when this is unset, which nothing here could otherwise know. This
   * value is used only when the response reports no usable `expireTime`.
   */
  cacheTtl?: string;
  /**
   * Cache-capable client used for the `caches.create` calls the `assembler` +
   * `contextBudget` path makes.
   *
   * Precedence is: a {@link GeminiProviderOptions.client} that itself exposes
   * `caches`, then this, then the client the factory imports for itself. A
   * real `GoogleGenAI` exposes `caches`, and so does the imported client, so
   * this is purely an escape hatch for a hand-written fake or a narrowed
   * wrapper — and it is deliberately the *lower* precedence of the two: the
   * two clients may carry different credentials, projects, or endpoints, so
   * creating through this one while generating through a perfectly capable
   * `client` risks referencing a cache the generating client cannot see.
   *
   * With no injected client at all, this is still used when supplied; it names
   * a cache-capable client, which is exactly what the path needs. Supplying
   * neither, with the assembler path enabled and an injected client that has
   * no `caches`, is rejected at factory-construction time.
   */
  cacheClient?: GeminiCacheCreatingClient;
}

// ── Streaming Types ─────────────────────────────────────────────────

/**
 * Events emitted by the Anthropic Messages API when streaming.
 */
export interface AnthropicStreamEvent {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop';
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  index?: number;
  content_block?: { type: string; id?: string; name?: string; text?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
    usage?: { output_tokens?: number };
  };
  usage?: { output_tokens?: number };
}

/**
 * A single chunk from the OpenAI Chat Completions streaming API.
 */
export interface OpenAIChatCompletionChunk {
  choices: Array<{
    delta: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

/**
 * Structural interface for an Anthropic client that supports streaming.
 */
export interface AnthropicStreamingClient {
  messages: {
    create(params: Record<string, unknown>): AsyncIterable<AnthropicStreamEvent>;
  };
}

/**
 * Structural interface for an OpenAI client that supports streaming.
 */
export interface OpenAIStreamingClient {
  chat: {
    completions: {
      create(params: Record<string, unknown>): AsyncIterable<OpenAIChatCompletionChunk>;
    };
  };
}

/**
 * Structural interface for a `@google/genai` client that supports streaming.
 *
 * `models.generateContentStream` resolves to the async iterable of chunks
 * directly; the frozen SDK's `{ stream }` wrapper object is gone, and each
 * chunk is a full `GenerateContentResponse`.
 *
 * A real `GoogleGenAI` instance is assignable to this interface — see
 * `gemini-client-assignability.test-d.ts`, which locks that in.
 */
export interface GeminiStreamingModel {
  models: {
    generateContentStream(
      params: GeminiGenerateContentRequest,
    ): Promise<AsyncIterable<GeminiGenerateContentResult>>;
  };
}

// ── Batch Inference Types ───────────────────────────────────────────
//
// Three providers expose a native batch-inference endpoint and their request
// shapes have almost nothing in common: Anthropic inlines the per-request
// Messages bodies, OpenAI points at a previously uploaded JSONL file, and
// Gemini names a source (`src`) that may be inline requests, a GCS/BigQuery
// URI, or an uploaded file name. The structural interfaces below mirror each
// SDK as it actually is rather than flattening the three into one invented
// shape — see `providers/batches/` for the factories built on them, and
// `getProviderCapabilities` in `providers/capabilities.ts` for which providers
// have a batch endpoint at all.
//
// Every member is declared with method syntax on purpose. TypeScript compares
// method parameters bivariantly, which is what lets a real SDK client satisfy
// these interfaces without a cast even though the SDKs' own parameter types are
// `interface`s (no implicit index signature) and some of their members are
// arrow-function properties. Declaring a request parameter as
// `Record<string, unknown>` would break that in both directions — the mistake
// documented on {@link GeminiGenerateContentRequest}. Widen only the
// payload-shaped fields, and name the rest.
//
// `providers/batch-client-assignability.test-d.ts` locks all of this in against
// the real `Anthropic`, `OpenAI`, and `GoogleGenAI` classes.

/**
 * One request inside an Anthropic Message Batch.
 */
export interface AnthropicBatchCreateRequestItem {
  /** Caller-chosen id, unique within the batch, used to match up results. */
  custom_id: string;
  /**
   * `MessageCreateParamsNonStreaming` in the SDK — the same body
   * `messages.create` takes. Widened here so fakes need not model the whole
   * Messages request surface.
   */
  params: unknown;
}

/**
 * Minimal shape of an Anthropic `messages.batches.create` request body.
 */
export interface AnthropicBatchCreateRequest {
  requests: ReadonlyArray<AnthropicBatchCreateRequestItem>;
}

/**
 * Minimal shape of Anthropic's `messages.batches.list` query, mirroring the
 * SDK's cursor `PageParams`.
 */
export interface AnthropicBatchListQuery {
  limit?: number;
  before_id?: string;
  after_id?: string;
}

/**
 * Per-status request tallies on an Anthropic Message Batch. Every request
 * starts in `processing` and moves to one of the other buckets only once the
 * whole batch ends.
 */
export interface AnthropicMessageBatchRequestCounts {
  canceled: number;
  errored: number;
  expired: number;
  processing: number;
  succeeded: number;
}

/**
 * Minimal shape of an Anthropic `MessageBatch`.
 */
export interface AnthropicMessageBatch {
  id: string;
  processing_status: 'in_progress' | 'canceling' | 'ended';
  request_counts: AnthropicMessageBatchRequestCounts;
  /** Set only once processing ends. */
  results_url: string | null;
  created_at: string;
  /** Set only once processing ends. */
  ended_at: string | null;
  expires_at: string;
}

/**
 * Processing result for a single request in an Anthropic Message Batch.
 *
 * Kept as a discriminated union rather than a widened object so callers can
 * narrow on `type`. `message` and `error` are widened because they are the
 * full Messages response and error payloads.
 */
export type AnthropicMessageBatchResult =
  | { type: 'succeeded'; message: unknown }
  | { type: 'errored'; error: unknown }
  | { type: 'canceled' }
  | { type: 'expired' };

/**
 * One line of the `.jsonl` results stream for an Anthropic Message Batch.
 * Results are not guaranteed to arrive in request order — match them up by
 * `custom_id`.
 */
export interface AnthropicMessageBatchIndividualResponse {
  custom_id: string;
  result: AnthropicMessageBatchResult;
}

/**
 * Structural interface for the Anthropic SDK client surface the batch factory
 * uses: the stable `client.messages.batches` resource.
 *
 * `list` is typed as an `AsyncIterable` rather than a promise because the SDK
 * returns a `PagePromise`, which is directly iterable and fetches further pages
 * as it goes. `results` keeps the SDK's `Promise<AsyncIterable<…>>` shape: the
 * request that opens the `.jsonl` stream is awaited first, then the lines are
 * iterated.
 */
export interface AnthropicBatchClient {
  messages: {
    batches: {
      create(params: AnthropicBatchCreateRequest): Promise<AnthropicMessageBatch>;
      retrieve(messageBatchId: string): Promise<AnthropicMessageBatch>;
      list(query?: AnthropicBatchListQuery): AsyncIterable<AnthropicMessageBatch>;
      cancel(messageBatchId: string): Promise<AnthropicMessageBatch>;
      results(
        messageBatchId: string,
      ): Promise<AsyncIterable<AnthropicMessageBatchIndividualResponse>>;
    };
  };
}

/**
 * Minimal shape of an Anthropic `messages.countTokens` request body.
 *
 * Mirrors `MessageCountTokensParams` in the installed `@anthropic-ai/sdk`
 * (0.122.0): `messages` and `model` are required, everything else is optional.
 *
 * Every optional field is declared even though this package never inspects one
 * of them. An object literal passed at a call site is subject to excess
 * property checking against this interface, so a field omitted here would be
 * unpassable by a caller — the interface has to name the whole request surface
 * to stay usable, not just the part operative reads.
 *
 * Bodies are widened to `unknown` rather than `Record<string, unknown>`. The
 * SDK's parameter types are `interface`s with no implicit index signature, so
 * `Record<string, unknown>` fails the bivariant method check in *both*
 * directions and makes a real `Anthropic` un-injectable without a cast. That is
 * the defect AB-154 found on the Gemini migration, and it is why
 * {@link AnthropicClient} still needs an `as unknown as` at its construction
 * site today. `anthropic-token-counting-assignability.test-d.ts` pins this one
 * down so it cannot regress the same way.
 */
export interface AnthropicCountTokensRequest {
  /** Provider-native model id. Token counts are model-specific. */
  model: string;
  /** `Array<MessageParam>` in the SDK; widened so fakes need not model it. */
  messages: unknown;
  /** `string | Array<TextBlockParam>` in the SDK. */
  system?: unknown;
  /** `Array<ToolUnion>` in the SDK. Tools count toward the total. */
  tools?: unknown;
  /** `ToolChoice` in the SDK. */
  tool_choice?: unknown;
  /** `ThinkingConfigParam` in the SDK. */
  thinking?: unknown;
  /** `OutputConfig` in the SDK. */
  output_config?: unknown;
  /** `CacheControlEphemeral | null` in the SDK. */
  cache_control?: unknown;
}

/**
 * Minimal shape of an Anthropic `MessageTokensCount` response.
 *
 * **`input_tokens` is optional here although the SDK declares it required.**
 * That is deliberate, not a transcription slip. The declared type describes
 * what Anthropic's own endpoint returns; it is not a runtime guarantee, and
 * this package is routinely pointed at something else — see
 * {@link AnthropicProviderOptions.baseURL}, which accepts any origin including
 * a credential-injecting proxy. Typing the field as required would let a
 * response that genuinely omits it surface as `undefined` through a `number`,
 * or invite a `?? 0` default at the call site.
 *
 * Narrowing is the caller's job precisely because "absent" and "zero" are
 * different facts, and a caller budgeting against a token count needs to tell
 * them apart. This mirrors {@link GeminiCountTokensResponse} and
 * {@link TokenUsage}, which carry the same rule. A real `MessageTokensCount`
 * still satisfies this interface: a required property is assignable to an
 * optional one of the same type.
 *
 * **Provisional.** Deliberately the SDK's own field name, unrenamed, rather
 * than a new provider-neutral shape — AB-64 is still in Backlog and will define
 * the context/output-limit fields this package standardizes on. Inventing a
 * parallel budgeting shape now would only be more surface for AB-64 to
 * reconcile. Note that this is the same *policy* as
 * {@link GeminiCountTokensResponse}, not the same fields: Anthropic reports
 * `input_tokens`, Gemini reports `totalTokens`, and neither is translated into
 * the other's vocabulary here.
 */
export interface AnthropicCountTokensResponse {
  /**
   * Total tokens across the request's messages, system prompt, and tools.
   * Absent when the response genuinely omits it; never fabricated as `0`.
   */
  input_tokens?: number;
}

/**
 * Structural interface for the `messages.countTokens` operation of an
 * `@anthropic-ai/sdk` client.
 *
 * Deliberately narrower than the SDK's `Messages` resource, which also exposes
 * `create`, `stream`, and `batches` — this package only ever calls
 * `countTokens` through this interface, matching the minimal-interface rule
 * {@link AnthropicBatchClient} and the Gemini interfaces follow. A real
 * `Anthropic` satisfies this; see
 * `anthropic-token-counting-assignability.test-d.ts`.
 */
export interface AnthropicTokenCountingClient {
  messages: {
    countTokens(params: AnthropicCountTokensRequest): Promise<AnthropicCountTokensResponse>;
  };
}

/**
 * Minimal shape of an OpenAI `batches.create` request body.
 *
 * Unlike Anthropic and Gemini, OpenAI takes no inline requests: the batch is
 * built from a JSONL file already uploaded with purpose `batch`, named here by
 * `input_file_id`.
 */
export interface OpenAIBatchCreateRequest {
  /** Only `'24h'` is currently accepted by the API. */
  completion_window: '24h';
  /**
   * The API route every request in the file targets, e.g.
   * `'/v1/chat/completions'`, `'/v1/responses'`, or `'/v1/embeddings'`. Typed
   * as `string` rather than pinned to the SDK's literal union so a newly
   * supported route does not require an operative release; the installed SDK's
   * `BatchCreateParams['endpoint']` is the authority on what the API accepts.
   */
  endpoint: string;
  /** Id of an uploaded JSONL file containing the batched requests. */
  input_file_id: string;
  metadata?: Record<string, string> | null;
}

/**
 * Minimal shape of OpenAI's `batches.list` query, mirroring the SDK's
 * `CursorPageParams`.
 */
export interface OpenAIBatchListQuery {
  after?: string;
  limit?: number;
}

/**
 * Per-status request tallies on an OpenAI batch.
 */
export interface OpenAIBatchRequestCounts {
  completed: number;
  failed: number;
  total: number;
}

/**
 * Minimal shape of an OpenAI `Batch`.
 */
export interface OpenAIBatch {
  id: string;
  object: 'batch';
  endpoint: string;
  input_file_id: string;
  completion_window: string;
  /** Unix seconds. */
  created_at: number;
  status:
    | 'validating'
    | 'failed'
    | 'in_progress'
    | 'finalizing'
    | 'completed'
    | 'expired'
    | 'cancelling'
    | 'cancelled';
  /** Id of the file holding results for the requests that succeeded. */
  output_file_id?: string;
  /** Id of the file holding results for the requests that errored. */
  error_file_id?: string;
  request_counts?: OpenAIBatchRequestCounts;
}

/**
 * Structural interface for the OpenAI SDK client surface the batch factory
 * uses: the top-level `client.batches` resource.
 *
 * There is deliberately no `results` member: OpenAI returns results as an
 * uploaded file, so a caller reads `output_file_id` through `client.files`
 * rather than streaming them off the batch itself.
 */
export interface OpenAIBatchClient {
  batches: {
    create(body: OpenAIBatchCreateRequest): Promise<OpenAIBatch>;
    retrieve(batchId: string): Promise<OpenAIBatch>;
    list(query?: OpenAIBatchListQuery): AsyncIterable<OpenAIBatch>;
    cancel(batchId: string): Promise<OpenAIBatch>;
  };
}

/**
 * Minimal shape of a `@google/genai` `CreateBatchJobParameters`.
 *
 * `model` is optional in the SDK and stays optional here: making it required
 * would fail assignability in both directions and take a real `GoogleGenAI`
 * out of reach without a cast.
 */
export interface GeminiCreateBatchJobRequest {
  /** Provider-native model id. Optional in the SDK — see the type's note. */
  model?: string;
  /**
   * `BatchJobSourceUnion` in the SDK: inline requests, a GCS/BigQuery URI, or
   * an uploaded file name. Widened so fakes need not model the union.
   */
  src: unknown;
  /** `CreateBatchJobConfig` in the SDK; omitted when no options are set. */
  config?: unknown;
}

/**
 * Names one existing `@google/genai` batch job. Gemini addresses jobs by a
 * server-generated resource name inside a parameter object, where Anthropic and
 * OpenAI take a bare id string — an asymmetry these interfaces keep rather than
 * paper over.
 */
export interface GeminiBatchJobReference {
  /** A fully-qualified batch job resource name, or its trailing id. */
  name: string;
  /** Per-request config in the SDK; omitted when no options are set. */
  config?: unknown;
}

/**
 * Minimal shape of a `@google/genai` `ListBatchJobsParameters`.
 */
export interface GeminiListBatchJobsRequest {
  /** `ListBatchJobsConfig` in the SDK, carrying `pageSize`/`pageToken`. */
  config?: unknown;
}

/**
 * Minimal shape of a `@google/genai` `BatchJob`. Every field is optional in the
 * SDK, so every field is optional here.
 */
export interface GeminiBatchJob {
  /** Server-generated resource name — the handle for `get`/`cancel`/`delete`. */
  name?: string;
  displayName?: string;
  /** `JobState` in the SDK, a string enum such as `'JOB_STATE_SUCCEEDED'`. */
  state?: string;
  createTime?: string;
  startTime?: string;
  endTime?: string;
  updateTime?: string;
  model?: string;
  /** `BatchJobDestination` in the SDK: where the results were written. */
  dest?: unknown;
  /** `JobError` in the SDK; set only for failed or cancelled jobs. */
  error?: unknown;
}

/**
 * Minimal shape of the `@google/genai` `DeleteResourceJob` returned by
 * `batches.delete`.
 */
export interface GeminiDeleteResourceJob {
  name?: string;
  done?: boolean;
  /** `JobError` in the SDK. */
  error?: unknown;
}

/**
 * Structural interface for a `@google/genai` client's `batches` namespace.
 *
 * Shaped nothing like the other two on purpose. `create` takes
 * `{ model, src, config }` instead of a request list or a file id; jobs are
 * addressed by resource name rather than id; the retrieval verb is `get`, not
 * `retrieve`; `cancel` resolves to nothing; and Gemini alone exposes `delete`.
 * `list` resolves to a `Pager`, so it is `Promise<AsyncIterable<…>>` where
 * Anthropic's and OpenAI's directly-iterable page promises are `AsyncIterable`.
 */
export interface GeminiBatchClient {
  batches: {
    create(params: GeminiCreateBatchJobRequest): Promise<GeminiBatchJob>;
    get(params: GeminiBatchJobReference): Promise<GeminiBatchJob>;
    list(params?: GeminiListBatchJobsRequest): Promise<AsyncIterable<GeminiBatchJob>>;
    cancel(params: GeminiBatchJobReference): Promise<void>;
    delete(params: GeminiBatchJobReference): Promise<GeminiDeleteResourceJob>;
  };
}
