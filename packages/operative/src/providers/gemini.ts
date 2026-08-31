import type { GeminiPart } from 'armorer/adapters/gemini';
import { parseGeminiToolCalls } from 'armorer/adapters/gemini';
import type { ConversationHistory } from 'conversationalist';
import { toGeminiMessages } from 'conversationalist/adapters/gemini';

import { ProviderError } from './errors.ts';
import { createCacheAwareAssembly } from './shared/cache-aware-assembly.ts';
import { resolveGeminiEffort } from './shared/effort.ts';
import { resolveGeminiApiKey } from './shared/gemini-api-key.ts';
import { resolveGeminiModel } from './shared/model-registry.ts';
import { resolveCommonParameters } from './shared/resolve-common-parameters.ts';
import { toGeminiResponseFormat } from './structured-output/response-format-adapters.ts';
import { toGeminiToolChoice } from './structured-output/tool-choice-adapters.ts';
import type {
  GeminiCacheCreatingClient,
  GeminiCachedContent,
  GeminiGenerateContentRequest,
  GeminiGenerativeModel,
  GeminiProviderOptions,
  GeminiStreamingModel,
  GeminiUsageMetadata,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
} from './types.ts';

/** A function call as `@google/genai` reports it: every field optional. */
interface GeminiSdkFunctionCall {
  name?: string | undefined;
  args?: Record<string, unknown> | undefined;
}

/** A response part as `@google/genai` reports it: every field optional. */
interface GeminiSdkPart {
  text?: string | undefined;
  functionCall?: GeminiSdkFunctionCall | undefined;
}

/**
 * Narrows a `@google/genai` function call into armorer's stricter
 * `GeminiFunctionCallPart`, which requires both a name and an argument object.
 *
 * The maintained SDK marks `name` and `args` optional, so a call with no name
 * cannot be dispatched to any tool and is dropped, while a named call carrying
 * no arguments becomes an empty argument object.
 */
function toGeminiFunctionCallPart(functionCall: GeminiSdkFunctionCall): GeminiPart | undefined {
  if (functionCall.name === undefined) return undefined;
  return { functionCall: { name: functionCall.name, args: functionCall.args ?? {} } };
}

/**
 * `@google/genai` models a response part as a single object with every field
 * optional, while armorer's `GeminiPart` is a union whose variants each require
 * their own field. Narrow the SDK shape into that union, dropping parts that
 * carry neither text nor a dispatchable function call.
 */
function toGeminiParts(parts: ReadonlyArray<GeminiSdkPart>): GeminiPart[] {
  const narrowed: GeminiPart[] = [];
  for (const part of parts) {
    if (part.functionCall) {
      const functionCallPart = toGeminiFunctionCallPart(part.functionCall);
      if (functionCallPart) narrowed.push(functionCallPart);
    } else if (part.text !== undefined) {
      narrowed.push({ text: part.text });
    }
  }
  return narrowed;
}

/**
 * Build a provider-neutral {@link TokenUsage} from a Gemini `usageMetadata`.
 *
 * Gemini's `promptTokenCount` INCLUDES `cachedContentTokenCount` — the SDK
 * says so in as many words — which puts it with OpenAI's inclusive accounting
 * rather than Anthropic's disjoint buckets. To keep `TokenUsage.prompt`
 * meaning "fresh, non-cached input" across every provider, the cached count is
 * subtracted out here, exactly as `buildOpenAIUsage` does. `cacheReadTokens`
 * is only set when the API actually reported the field — never fabricated as
 * `0` — and Gemini reports no cache-write counterpart, so
 * `cacheCreationTokens` is always absent for this provider.
 *
 * `prompt` is clamped at `0`: a malformed or inconsistent response (a cached
 * count exceeding the prompt count, or a prompt count missing while the cached
 * count is present) must never surface as a negative prompt count, which would
 * violate `TokenUsage`'s non-negative contract and corrupt any downstream cost
 * estimate.
 *
 * This mapping is unconditional. Gemini reports `cachedContentTokenCount` for
 * its own implicit caching too, not only for a `cachedContent` resource the
 * caller asked for, so gating it on this package's cache options would drop
 * real usage data on an ordinary request.
 */
function buildGeminiUsage(usageMetadata: GeminiUsageMetadata): GenerateResponse['usage'] {
  const promptTokens = usageMetadata.promptTokenCount ?? 0;
  const completionTokens = usageMetadata.candidatesTokenCount ?? 0;
  const cachedTokens = usageMetadata.cachedContentTokenCount;
  return {
    prompt: cachedTokens !== undefined ? Math.max(promptTokens - cachedTokens, 0) : promptTokens,
    completion: completionTokens,
    total: usageMetadata.totalTokenCount ?? promptTokens + completionTokens,
    ...(cachedTokens !== undefined ? { cacheReadTokens: cachedTokens } : {}),
  };
}

/**
 * Everything the request body needs from the conversation, after any
 * cache-aware assembly has had its say.
 */
interface GeminiRequestContent {
  /** `ContentUnion` for `config.systemInstruction`; absent once it lives in a cache. */
  systemInstruction: unknown;
  /** `ContentListUnion` for the request's `contents`. */
  contents: unknown;
  /** Resource name for `config.cachedContent`, when a cache is in play. */
  cachedContent: string | undefined;
}

/**
 * Runtime narrowing for a caller-injected `client` that also happens to expose
 * the `caches` namespace.
 *
 * A real `GoogleGenAI` always does, and so does the client this module imports
 * for itself, so this only ever separates a hand-written fake or a narrowed
 * wrapper from a complete client. The check runs once, at factory-construction
 * time, so a misconfigured provider fails before it is ever called rather than
 * midway through a run.
 */
function isCacheCreatingClient(client: object): client is GeminiCacheCreatingClient {
  if (!('caches' in client)) return false;
  const caches: unknown = client.caches;
  if (typeof caches !== 'object' || caches === null) return false;
  if (!('create' in caches)) return false;
  return typeof caches.create === 'function';
}

/**
 * Splits an assembled conversation at its `cacheBoundary` mark into the stable
 * prefix that becomes the cache resource and the tail that is sent with every
 * request.
 *
 * The slice is structural — `ids` and `messages` are narrowed together and no
 * message is rebuilt — so both halves stay schema- and integrity-valid for
 * `toGeminiMessages`. Returns `undefined` when the assembly produced no
 * boundary (no system messages, no pinned messages), which is the Gemini
 * equivalent of Anthropic emitting no `cache_control` breakpoint: there is
 * nothing worth caching, so the conversation is sent whole and uncached.
 */
function splitAtCacheBoundary(
  history: ConversationHistory,
): { prefix: ConversationHistory; tail: ConversationHistory } | undefined {
  let boundaryIndex = -1;
  history.ids.forEach((id, index) => {
    if (history.messages[id]?.cacheBoundary) boundaryIndex = index;
  });
  if (boundaryIndex === -1) return undefined;

  const sliceHistory = (ids: ReadonlyArray<string>): ConversationHistory => {
    const messages: Record<string, (typeof history.messages)[string]> = {};
    for (const id of ids) {
      const message = history.messages[id];
      if (message) messages[id] = message;
    }
    return { ...history, ids, messages };
  };

  return {
    prefix: sliceHistory(history.ids.slice(0, boundaryIndex + 1)),
    tail: sliceHistory(history.ids.slice(boundaryIndex + 1)),
  };
}

/**
 * Builds the per-request content resolver both Gemini factories share,
 * covering all three caching modes this provider supports.
 *
 * Uncached (no cache options): the conversation is converted verbatim, exactly
 * as before this existed.
 *
 * Caller-owned cache (`cachedContent`): the name is passed straight through to
 * `config.cachedContent`. Operative creates nothing and owns no lifecycle.
 *
 * Provider-managed cache (`assembler` + `contextBudget`): the assembler runs in
 * stable-prefix mode, the conversation is split at the resulting
 * `cacheBoundary`, and the prefix is created once as a `CachedContent`
 * resource whose name every later request references while sending only the
 * tail. `systemInstruction` is omitted from those requests because it lives in
 * the cache; nothing else is dropped.
 *
 * The creation promise is memoized the same way the client promise is: two
 * concurrent first calls share one `caches.create`, and a rejection stays
 * rejected rather than silently retrying against a provider that already
 * refused. A creation failure normalizes through the caller's existing
 * `ProviderError` boundary — there is deliberately no quiet fallback to an
 * uncached request, which would hide a billing and behavior change from the
 * caller who asked for caching.
 */
function createGeminiContentResolver(input: {
  /**
   * Only the cache-relevant options, so both factories can share this despite
   * the streaming one narrowing `client` to {@link GeminiStreamingModel}.
   */
  options: Pick<
    GeminiProviderOptions,
    'assembler' | 'cacheTtl' | 'cachedContent' | 'contextBudget' | 'pinnedMessages'
  >;
  resolvedModel: string;
  cacheClient: GeminiCacheCreatingClient | undefined;
  importClient: () => Promise<GeminiCacheCreatingClient>;
}): (context: GenerateContext) => Promise<GeminiRequestContent> {
  const { options, resolvedModel } = input;
  const cacheAwareAssembly =
    options.assembler && options.contextBudget
      ? createCacheAwareAssembly(options.assembler, options.contextBudget, options.pinnedMessages)
      : undefined;

  let creationPromise: Promise<string> | undefined;

  async function createCache(prefix: ConversationHistory): Promise<string> {
    const client = input.cacheClient ?? (await input.importClient());
    const { systemInstruction, contents } = toGeminiMessages(prefix);
    const config: Record<string, unknown> = {};
    if (systemInstruction !== undefined) config['systemInstruction'] = systemInstruction;
    if (contents.length > 0) config['contents'] = contents;
    if (options.cacheTtl !== undefined) config['ttl'] = options.cacheTtl;

    // Normalized here rather than at the two call sites: this is the only
    // Gemini API call either factory makes outside its own `try`, and leaving
    // it unwrapped would let a raw SDK error escape a provider that normalizes
    // every other failure into `ProviderError`.
    let created: GeminiCachedContent;
    try {
      created = await client.caches.create({ model: resolvedModel, config });
    } catch (error) {
      throw new ProviderError({ provider: 'gemini', cause: error });
    }

    if (created.name === undefined) {
      throw new ProviderError({
        provider: 'gemini',
        cause: undefined,
        message:
          '[provider:gemini] caches.create returned no resource name, so there is no cache to reference on the request.',
      });
    }
    return created.name;
  }

  return async (context: GenerateContext): Promise<GeminiRequestContent> => {
    if (!cacheAwareAssembly) {
      const { systemInstruction, contents } = toGeminiMessages(context.conversation.current);
      return { systemInstruction, contents, cachedContent: options.cachedContent };
    }

    const assembled = cacheAwareAssembly(context);
    const split = splitAtCacheBoundary(assembled);
    if (!split) {
      const { systemInstruction, contents } = toGeminiMessages(assembled);
      return { systemInstruction, contents, cachedContent: undefined };
    }

    if (!creationPromise) creationPromise = createCache(split.prefix);
    const cachedContent = await creationPromise;
    const { contents } = toGeminiMessages(split.tail);
    return { systemInstruction: undefined, contents, cachedContent };
  };
}

/**
 * Resolves, once at factory-construction time, the client the provider-managed
 * cache path will call `caches.create` on — or `undefined` when the provider
 * imports its own client and can use that.
 *
 * Throws when caching is configured against an injected client that cannot
 * create caches and no `cacheClient` was supplied, and when `cachedContent`
 * (a cache the caller owns) is combined with the assembler options (a cache
 * the provider would create). Both are configuration mistakes with no correct
 * silent resolution, and both are knowable before a single request is made.
 */
function resolveCacheClient(
  options: Pick<
    GeminiProviderOptions,
    'assembler' | 'cacheClient' | 'cachedContent' | 'contextBudget'
  > & { client?: object | undefined },
): GeminiCacheCreatingClient | undefined {
  if (!options.assembler || !options.contextBudget) return undefined;
  if (options.cachedContent !== undefined) {
    throw new ProviderError({
      provider: 'gemini',
      cause: undefined,
      message:
        '[provider:gemini] cachedContent names a cache you own while assembler + contextBudget ask the provider to create one. Set one or the other.',
    });
  }
  if (options.cacheClient) return options.cacheClient;
  if (!options.client) return undefined;
  if (isCacheCreatingClient(options.client)) return options.client;
  throw new ProviderError({
    provider: 'gemini',
    cause: undefined,
    message:
      '[provider:gemini] cache-aware assembly needs a client exposing caches.create. The injected client has none — pass a full GoogleGenAI, or supply cacheClient.',
  });
}

/**
 * Builds the `config` block shared by the streaming and non-streaming Gemini
 * request bodies.
 *
 * `@google/genai` takes a single flat `GenerateContentConfig` — the frozen
 * SDK's separate top-level `systemInstruction` / `tools` / `toolConfig` fields
 * and its nested `generationConfig` object all collapse into it.
 *
 * `tools` and `toolConfig` stay on the request even when `cachedContent` is
 * set. `CreateCachedContentConfig` can carry them too, but the installed
 * `@google/genai` 2.19.0 declarations document no restriction either way, so
 * this package does not pre-judge one: tools remain per-request state (where
 * `toolChoice` lowering already lives) rather than being frozen into a cache
 * resource for a run's lifetime. If Gemini's server policy rejects a
 * particular tools-plus-cache combination, that surfaces as a `ProviderError`
 * from the request like any other API rejection.
 */
function buildGeminiConfig(input: {
  systemInstruction: unknown;
  cachedContent: string | undefined;
  tools: unknown[];
  toolChoice: GeminiProviderOptions['toolChoice'];
  responseFormat: GeminiProviderOptions['responseFormat'];
  maximumTokens: number | undefined;
  temperature: number | undefined;
  topP: number | undefined;
  stopSequences: readonly string[] | undefined;
  thinkingBudget: number | undefined;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const hasTools = input.tools.length > 0;

  if (input.cachedContent !== undefined) config['cachedContent'] = input.cachedContent;
  if (input.systemInstruction !== undefined) config['systemInstruction'] = input.systemInstruction;
  if (hasTools && input.toolChoice !== 'none') config['tools'] = input.tools;
  if (hasTools && input.toolChoice && input.toolChoice !== 'none')
    config['toolConfig'] = toGeminiToolChoice(input.toolChoice);

  if (input.maximumTokens !== undefined) config['maxOutputTokens'] = input.maximumTokens;
  if (input.temperature !== undefined) config['temperature'] = input.temperature;
  if (input.topP !== undefined) config['topP'] = input.topP;
  if (input.stopSequences) config['stopSequences'] = input.stopSequences;
  if (input.thinkingBudget !== undefined) {
    config['thinkingConfig'] = { thinkingBudget: input.thinkingBudget };
  }
  if (input.responseFormat) {
    const adapted = toGeminiResponseFormat(input.responseFormat);
    if (adapted !== undefined) Object.assign(config, adapted);
  }

  return config;
}

/**
 * Dynamically imports `@google/genai` and constructs a `GoogleGenAI` client.
 *
 * The client is returned as the local structural interfaces with no cast: a
 * real `GoogleGenAI` satisfies all three of them, which is the same guarantee
 * consumers rely on when they pass their own client through
 * {@link GeminiProviderOptions.client}. Keeping this cast-free means the
 * production path itself proves that guarantee at build time — including for
 * {@link GeminiCacheCreatingClient}, which is why the provider-managed cache
 * path needs no extra configuration when it constructs its own client.
 */
async function importGeminiClient(options: {
  apiKey?: string | undefined;
  baseURL?: string | undefined;
}): Promise<GeminiGenerativeModel & GeminiStreamingModel & GeminiCacheCreatingClient> {
  const module = await import('@google/genai');
  const apiKey = resolveGeminiApiKey(options.apiKey);
  return new module.GoogleGenAI({
    apiKey,
    ...(options.baseURL ? { httpOptions: { baseUrl: options.baseURL } } : {}),
  });
}

/**
 * Creates a GenerateFunction backed by the Google Gemini API.
 *
 * When no `client` (a `GoogleGenAI` instance) is provided, dynamically
 * imports `@google/genai` and constructs one using `apiKey` or
 * the `GOOGLE_API_KEY` env var.
 *
 * Note: "Provider" here is distinct from the Vercel AI SDK's concept of
 * "provider". This factory returns a `GenerateFunction` — a plain async
 * function that produces a `GenerateResponse` — not an SDK provider object.
 */
export function createGeminiProvider(options: GeminiProviderOptions): GenerateFunction {
  const resolvedModel = resolveGeminiModel(options.model);
  const resolvedEffort = options.effort
    ? resolveGeminiEffort(options.effort, resolvedModel)
    : undefined;
  const common = resolveCommonParameters(options);
  const cacheClient = resolveCacheClient(options);
  let clientPromise:
    Promise<GeminiGenerativeModel & GeminiStreamingModel & GeminiCacheCreatingClient> | undefined;

  function importClient(): Promise<
    GeminiGenerativeModel & GeminiStreamingModel & GeminiCacheCreatingClient
  > {
    if (!clientPromise) {
      clientPromise = importGeminiClient(options);
    }
    return clientPromise;
  }

  function getClient(): Promise<GeminiGenerativeModel> {
    if (options.client) return Promise.resolve(options.client);
    return importClient();
  }

  const resolveContent = createGeminiContentResolver({
    options,
    resolvedModel,
    cacheClient,
    importClient,
  });

  return async (context: GenerateContext): Promise<GenerateResponse> => {
    const client = await getClient();
    const { systemInstruction, contents, cachedContent } = await resolveContent(context);
    const tools = await context.toolbox.toGeminiTools();

    const config = buildGeminiConfig({
      systemInstruction,
      cachedContent,
      tools,
      toolChoice: options.toolChoice,
      responseFormat: options.responseFormat,
      maximumTokens: context.maximumTokens ?? common.maximumTokens,
      temperature: common.temperature,
      topP: common.topP,
      stopSequences: common.stopSequences,
      thinkingBudget: resolvedEffort?.thinkingBudget,
    });

    const request: GeminiGenerateContentRequest = {
      model: resolvedModel,
      contents,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };

    try {
      const result = await client.models.generateContent(request);

      const candidates = result.candidates ?? [];
      const parts = candidates[0]?.content?.parts ?? [];

      const textParts: string[] = [];
      for (const part of parts) {
        if (part.text) {
          textParts.push(part.text);
        }
      }

      const toolCalls = parseGeminiToolCalls(toGeminiParts(parts));

      const usageMetadata = result.usageMetadata;
      const usage = usageMetadata ? buildGeminiUsage(usageMetadata) : undefined;

      return {
        content: textParts.join(''),
        toolCalls,
        usage,
        metadata: {
          effectiveModel: resolvedModel,
          effectiveEffort: resolvedEffort ? resolvedEffort.effort : 'none',
        },
      };
    } catch (error) {
      throw new ProviderError({ provider: 'gemini', cause: error });
    }
  };
}

/**
 * Creates a StreamingGenerateFunction backed by the Google Gemini API.
 *
 * Streams chunks from the API, progressively calling `streaming.update`
 * with accumulated text and collecting function call parts into complete
 * ToolCallInput objects.
 *
 * When no `client` (a `GoogleGenAI` instance) is provided, dynamically
 * imports `@google/genai` and constructs one using `apiKey` or
 * the `GOOGLE_API_KEY` env var.
 */
export function createGeminiProviderStream(
  options: Omit<GeminiProviderOptions, 'client'> & { client?: GeminiStreamingModel },
): StreamingGenerateFunction {
  const resolvedModel = resolveGeminiModel(options.model);
  const resolvedEffort = options.effort
    ? resolveGeminiEffort(options.effort, resolvedModel)
    : undefined;
  const common = resolveCommonParameters(options);
  const cacheClient = resolveCacheClient(options);
  let clientPromise:
    Promise<GeminiGenerativeModel & GeminiStreamingModel & GeminiCacheCreatingClient> | undefined;

  function importClient(): Promise<
    GeminiGenerativeModel & GeminiStreamingModel & GeminiCacheCreatingClient
  > {
    if (!clientPromise) {
      clientPromise = importGeminiClient(options);
    }
    return clientPromise;
  }

  function getClient(): Promise<GeminiStreamingModel> {
    if (options.client) return Promise.resolve(options.client);
    return importClient();
  }

  const resolveContent = createGeminiContentResolver({
    options,
    resolvedModel,
    cacheClient,
    importClient,
  });

  return async (
    context: GenerateContext & { streaming: StreamingHandle },
  ): Promise<GenerateResponse> => {
    const client = await getClient();
    const { streaming } = context;
    const { systemInstruction, contents, cachedContent } = await resolveContent(context);
    const tools = await context.toolbox.toGeminiTools();

    const config = buildGeminiConfig({
      systemInstruction,
      cachedContent,
      tools,
      toolChoice: options.toolChoice,
      responseFormat: options.responseFormat,
      maximumTokens: context.maximumTokens ?? common.maximumTokens,
      temperature: common.temperature,
      topP: common.topP,
      stopSequences: common.stopSequences,
      thinkingBudget: resolvedEffort?.thinkingBudget,
    });

    const request: GeminiGenerateContentRequest = {
      model: resolvedModel,
      contents,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };

    try {
      const stream = await client.models.generateContentStream(request);

      let accumulatedText = '';
      const accumulatedFunctionCallParts: GeminiPart[] = [];
      let latestUsageMetadata: GeminiUsageMetadata | undefined;

      for await (const chunk of stream) {
        if (context.signal?.aborted) break;
        const candidates = chunk.candidates ?? [];
        const parts = candidates[0]?.content?.parts ?? [];

        for (const part of parts) {
          if (part.text) {
            accumulatedText += part.text;
            streaming.update(accumulatedText);
          }
          if (part.functionCall) {
            const functionCallPart = toGeminiFunctionCallPart(part.functionCall);
            if (functionCallPart) accumulatedFunctionCallParts.push(functionCallPart);
          }
        }

        if (chunk.usageMetadata) {
          latestUsageMetadata = chunk.usageMetadata;
        }
      }

      const toolCalls = parseGeminiToolCalls(accumulatedFunctionCallParts);

      const usage = latestUsageMetadata ? buildGeminiUsage(latestUsageMetadata) : undefined;

      return {
        content: accumulatedText,
        toolCalls,
        usage,
        metadata: {
          effectiveModel: resolvedModel,
          effectiveEffort: resolvedEffort ? resolvedEffort.effort : 'none',
        },
      };
    } catch (error) {
      throw new ProviderError({ provider: 'gemini', cause: error });
    }
  };
}
