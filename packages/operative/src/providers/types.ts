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
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
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
