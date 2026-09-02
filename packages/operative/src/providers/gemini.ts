import type { GeminiPart } from 'armorer/adapters/gemini';
import { parseGeminiToolCalls } from 'armorer/adapters/gemini';
import type { ConversationHistory } from 'conversationalist';
import { toGeminiMessages } from 'conversationalist/adapters/gemini';
import { sha256HexSync } from 'interoperability';

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
  GeminiCountTokensRequest,
  GeminiGenerateContentRequest,
  GeminiGenerativeModel,
  GeminiProviderOptions,
  GeminiStreamingModel,
  GeminiTokenCountingClient,
  GeminiUsageMetadata,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
  TokenCountResult,
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
  /**
   * Digest of the stable prefix {@link GeminiRequestContent.cachedContent} was
   * created from — the key the resolver memoized it under, so a request the
   * provider rejects for naming a dead cache can drop exactly that entry.
   * Absent whenever the provider created no cache for this request.
   */
  cacheKey: string | undefined;
}

/** The lowered stable prefix a `caches.create` call is built from. */
type GeminiCachePayload = ReturnType<typeof toGeminiMessages>;

/** One provider-created cache resource, with what is known about its lifetime. */
interface ManagedCache {
  /** Server-generated resource name, referenced as `config.cachedContent`. */
  readonly name: string;
  /**
   * Epoch milliseconds after which the resource is treated as gone. `undefined`
   * when neither the SDK nor `cacheTtl` said anything usable, in which case the
   * entry is only ever replaced reactively — see {@link isMissingCacheError}.
   */
  readonly expiresAt: number | undefined;
}

/**
 * How many distinct stable prefixes one generated function keeps cache
 * resources for.
 *
 * A generate function is reusable across runs, so the number of prefixes it
 * sees is unbounded in principle — a `Map` keyed by prefix and never trimmed
 * would grow for the life of the process. At the bound, the least recently
 * used entry is evicted: the next request for that prefix simply creates a
 * fresh resource, so eviction costs one extra `caches.create` and never
 * changes what a request means.
 *
 * The evicted resource is deliberately not deleted server-side. Gemini expires
 * it on its own TTL, and {@link GeminiCacheCreatingClient} names only `create`
 * — widening that interface to reach `caches.delete` would break every fake a
 * caller has written against it, to reclaim something the server reclaims
 * anyway.
 *
 * Eight is chosen as comfortably more distinct system-or-pinned prefixes than
 * one generate function realistically multiplexes, while staying small enough
 * that the retained set is trivially bounded.
 */
const MAXIMUM_MANAGED_CACHES = 8;

/**
 * Parses the SDK's cache duration string — digits, up to nine fractional
 * digits, terminated by `'s'` (`'3600s'`, `'3.5s'`) — into milliseconds.
 * Anything else returns `undefined`: this package does not re-specify Gemini's
 * duration grammar, so a string it cannot read is passed to the API unchanged
 * and simply yields no local expiry bookkeeping.
 */
function parseCacheTtlMilliseconds(ttl: string): number | undefined {
  const match = /^(\d+(?:\.\d{1,9})?)s$/.exec(ttl);
  const seconds = match?.[1];
  if (seconds === undefined) return undefined;
  return Number(seconds) * 1000;
}

/**
 * Decides when a freshly created cache resource stops being usable.
 *
 * The SDK's own `CachedContent.expireTime` wins whenever it is present and
 * parseable: it is the server's answer, and it accounts for Gemini's default
 * TTL on a `caches.create` that carried no `ttl` of its own — the case the
 * caller's `cacheTtl` cannot describe at all. A configured `cacheTtl` is the
 * fallback for a response (or a caller's fake) that reports no `expireTime`.
 * When neither yields a timestamp the entry carries no expiry, and a resource
 * that dies anyway is recovered from at request time instead.
 */
function resolveCacheExpiry(
  created: GeminiCachedContent,
  cacheTtl: string | undefined,
  createdAt: number,
): number | undefined {
  if (created.expireTime !== undefined) {
    const expireTime = Date.parse(created.expireTime);
    if (!Number.isNaN(expireTime)) return expireTime;
  }
  if (cacheTtl !== undefined) {
    const ttlMilliseconds = parseCacheTtlMilliseconds(cacheTtl);
    if (ttlMilliseconds !== undefined) return createdAt + ttlMilliseconds;
  }
  return undefined;
}

/** The message of whatever the SDK threw, however it chose to throw it. */
function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

/** Ways Gemini words a `cachedContent` reference it will not honor. */
const MISSING_CACHE_REASONS = ['not found', 'expired', 'does not exist'];

/**
 * Recognizes a request rejected because the cache resource it named is gone.
 *
 * Expiry bookkeeping narrows this window but cannot close it: a resource can
 * lapse between the freshness check and the request landing, and it can be
 * deleted out from under this process entirely. Gemini publishes no
 * machine-readable code for "that cache is gone", so this reads the message —
 * conservatively, requiring both that it names the cached-content resource and
 * that it gives a reason consistent with the resource being absent, so an
 * ordinary quota or safety rejection never triggers a pointless re-creation.
 */
function isMissingCacheError(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase();
  if (!message.includes('cachedcontent') && !message.includes('cached content')) return false;
  return MISSING_CACHE_REASONS.some((reason) => message.includes(reason));
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
 * Enforces the tail-only input contract a caller-owned `cachedContent` carries.
 *
 * A `CachedContent` resource is a *prompt prefix*: `@google/genai`'s own README
 * describes `ai.caches` as the way "to reduce costs when repeatedly using the
 * same large prompt prefix", `CreateCachedContentConfig` holds the `contents`
 * and `systemInstruction` that prefix is made of, and `GenerateContentConfig`
 * carries `cachedContent` alongside a `systemInstruction` of its own. So a
 * request that names a cache *and* re-sends the material already inside it
 * states that material twice.
 *
 * The provider-managed path avoids that by splitting at the `cacheBoundary`
 * mark it created, but that boundary is only knowable because operative built
 * the cache. A caller-owned resource is opaque here — operative never sees its
 * contents and cannot subtract them — so the contract is inverted instead:
 * whoever owns the cache owns the boundary, and passes only the tail.
 *
 * One half of that contract is mechanically checkable and is checked here. A
 * system message lowers to `config.systemInstruction`, which would ride
 * alongside `config.cachedContent` and either duplicate the instruction the
 * cache already holds or contradict it. That is rejected with a
 * {@link ProviderError} naming the fix, rather than sent as a quietly doubled
 * prompt or left to come back as an opaque provider rejection.
 *
 * The other half — turns already inside the cache, re-sent as ordinary
 * `contents` — is not checkable from here at all, for exactly the reason above,
 * and is stated as a contract on {@link GeminiProviderOptions.cachedContent}.
 */
function assertTailOnlyConversation(
  systemInstruction: unknown,
  cachedContent: string | undefined,
): void {
  if (cachedContent === undefined || systemInstruction === undefined) return;
  throw new ProviderError({
    provider: 'gemini',
    cause: undefined,
    message: `[provider:gemini] cachedContent (${cachedContent}) names a cache you own, so the conversation passed to each call must be the tail only — the turns that are not already in that cache. This one carries a system message, which would be sent as config.systemInstruction alongside config.cachedContent and duplicate or contradict the instruction the cache holds. Put the system prompt in the cache and leave it out of the conversation, or drop cachedContent.`,
  });
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
 * The per-request content resolver both Gemini factories share, plus the hook
 * a factory uses to retire a cache entry the API has just told it is dead.
 */
interface GeminiContentResolver {
  /** Produces the content for one request, creating or reusing a cache as needed. */
  resolve(context: GenerateContext): Promise<GeminiRequestContent>;
  /** Drops the entry stored under `cacheKey`, leaving every other prefix's cache intact. */
  invalidate(cacheKey: string): void;
}

/**
 * Builds the per-request content resolver both Gemini factories share,
 * covering all three caching modes this provider supports.
 *
 * Uncached (no cache options): the conversation is converted verbatim, exactly
 * as before this existed.
 *
 * Caller-owned cache (`cachedContent`): the name is passed straight through to
 * `config.cachedContent`. Operative creates nothing and owns no lifecycle — and
 * because it cannot see inside a resource it did not create, the conversation
 * must arrive tail-only. See {@link assertTailOnlyConversation}.
 *
 * Provider-managed cache (`assembler` + `contextBudget`): the assembler runs in
 * stable-prefix mode, the conversation is split at the resulting
 * `cacheBoundary`, and the prefix is created as a `CachedContent` resource
 * whose name later requests reference while sending only the tail.
 * `systemInstruction` is omitted from those requests because it lives in the
 * cache; nothing else is dropped.
 *
 * Resources are memoized **per stable prefix**, keyed by a SHA-256 digest of
 * the lowered prefix payload, never once per factory. A generated function is
 * reusable across runs, so a factory-wide singleton would hand a second
 * conversation the first one's cached content: the request would omit its own
 * system and pinned prefix while pointing at another run's, which is both a
 * wrong answer and a leak of the earlier run's instructions into it. Keying on
 * the payload makes "same prefix" the only thing that shares a resource. The
 * model and `cacheTtl` are fixed for a resolver's lifetime, so neither needs to
 * be in the key. The map is bounded — see {@link MAXIMUM_MANAGED_CACHES}.
 *
 * Each entry carries what {@link resolveCacheExpiry} could determine about its
 * lifetime, and a lapsed entry is replaced — for that key alone, leaving every
 * other prefix's resource untouched — rather than referenced until the API
 * rejects it. Whatever expiry bookkeeping cannot catch is recovered from at
 * request time by {@link sendWithCacheRecovery}.
 *
 * Creation is memoized as a promise, so two concurrent first calls for one
 * prefix share a single `caches.create` — and so does a burst that arrives
 * after that prefix's resource expires, which installs one renewal every waiter
 * then shares rather than one billable resource per request. A rejected
 * creation is evicted rather than retained: with keying and expiry in place it
 * would otherwise be the only permanently immortal state here, and one
 * transient failure would poison that prefix for the life of the provider.
 * Every call that meets a failing creation still throws — a creation failure
 * normalizes through `ProviderError` and there is deliberately no quiet
 * fallback to an uncached request, which would hide a billing and behavior
 * change from the caller who asked for caching — what an eviction buys is that
 * the *next* call gets a real attempt instead of a replayed rejection.
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
}): GeminiContentResolver {
  const { options, resolvedModel } = input;
  const cacheAwareAssembly =
    options.assembler && options.contextBudget
      ? createCacheAwareAssembly(options.assembler, options.contextBudget, options.pinnedMessages)
      : undefined;

  /** Prefix digest to in-flight-or-settled creation. Insertion order is LRU order. */
  const managedCaches = new Map<string, Promise<ManagedCache>>();

  async function createCache(payload: GeminiCachePayload): Promise<ManagedCache> {
    const client = input.cacheClient ?? (await input.importClient());
    const config: Record<string, unknown> = {};
    if (payload.systemInstruction !== undefined) {
      config['systemInstruction'] = payload.systemInstruction;
    }
    if (payload.contents.length > 0) config['contents'] = payload.contents;
    if (options.cacheTtl !== undefined) config['ttl'] = options.cacheTtl;

    // Normalized here rather than at the two call sites: this is the only
    // Gemini API call either factory makes outside its own `try`, and leaving
    // it unwrapped would let a raw SDK error escape a provider that normalizes
    // every other failure into `ProviderError`.
    const createdAt = Date.now();
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
    return {
      name: created.name,
      expiresAt: resolveCacheExpiry(created, options.cacheTtl, createdAt),
    };
  }

  function startCreation(cacheKey: string, payload: GeminiCachePayload): Promise<ManagedCache> {
    const creation = createCache(payload);
    // A failed creation is not a cache resource, so it does not belong in a map
    // of them. The identity check keeps a late rejection from deleting the
    // successor that already replaced it.
    creation.catch(() => {
      if (managedCaches.get(cacheKey) === creation) managedCaches.delete(cacheKey);
    });
    managedCaches.set(cacheKey, creation);

    const [leastRecentlyUsed] = managedCaches.keys();
    if (managedCaches.size > MAXIMUM_MANAGED_CACHES && leastRecentlyUsed !== undefined) {
      managedCaches.delete(leastRecentlyUsed);
    }
    return creation;
  }

  /**
   * Resolves the cache name for one request, renewing a lapsed resource at most
   * once no matter how many requests meet it at the same moment.
   *
   * Every waiter for a prefix awaits the same stored promise, so a burst that
   * arrives after that resource expires wakes with the same lapsed answer.
   * Deciding to renew is therefore not enough — each waiter has to know whether
   * *another* waiter already decided. The map is re-read at the resume point and
   * everything from there to {@link startCreation} is synchronous;
   * `startCreation` installs its entry before it yields, so the read and the
   * install happen in one turn. Exactly one waiter can find its own entry still
   * in place, and it is the one that renews; the rest see the successor and
   * await that instead. Without this, a burst of *n* requests after every expiry
   * created *n* billable Gemini caches and kept only the last.
   *
   * The re-read guards the live path too: it stops a waiter that has been asleep
   * across a replacement from re-inserting the stale entry over its successor
   * while refreshing LRU order.
   */
  async function acquireCache(cacheKey: string, payload: GeminiCachePayload): Promise<string> {
    const existing = managedCaches.get(cacheKey);
    if (existing) {
      const managed = await existing;
      const current = managedCaches.get(cacheKey);
      if (current === existing) {
        if (managed.expiresAt === undefined || managed.expiresAt > Date.now()) {
          // Re-insert so eviction sweeps a genuinely cold prefix, not a busy one.
          managedCaches.delete(cacheKey);
          managedCaches.set(cacheKey, existing);
          return managed.name;
        }
        // Lapsed, and this waiter still holds the entry it woke to, so it is the
        // one renewal: delete first so the replacement enters at the LRU tail.
        managedCaches.delete(cacheKey);
      } else if (current !== undefined) {
        // Someone renewed while this waiter slept. Share it rather than create a
        // second resource for the same prefix; a name that is somehow stale
        // again by the time it is sent is what `sendWithCacheRecovery` is for.
        const renewed = await current;
        return renewed.name;
      }
    }
    const created = await startCreation(cacheKey, payload);
    return created.name;
  }

  return {
    invalidate(cacheKey: string): void {
      managedCaches.delete(cacheKey);
    },

    async resolve(context: GenerateContext): Promise<GeminiRequestContent> {
      if (!cacheAwareAssembly) {
        const { systemInstruction, contents } = toGeminiMessages(context.conversation.current);
        assertTailOnlyConversation(systemInstruction, options.cachedContent);
        return {
          systemInstruction,
          contents,
          cachedContent: options.cachedContent,
          cacheKey: undefined,
        };
      }

      const assembled = cacheAwareAssembly(context);
      const split = splitAtCacheBoundary(assembled);
      if (!split) {
        const { systemInstruction, contents } = toGeminiMessages(assembled);
        return { systemInstruction, contents, cachedContent: undefined, cacheKey: undefined };
      }

      const payload = toGeminiMessages(split.prefix);
      const cacheKey = sha256HexSync(JSON.stringify(payload));
      const cachedContent = await acquireCache(cacheKey, payload);
      const { contents } = toGeminiMessages(split.tail);
      return { systemInstruction: undefined, contents, cachedContent, cacheKey };
    },
  };
}

/**
 * Runs one request against freshly resolved content and, at most once, rebuilds
 * the cache and runs it again when the provider rejected it for naming a cache
 * resource that is gone.
 *
 * Expiry bookkeeping shrinks that window but cannot close it — a resource can
 * lapse between the freshness check and the request landing, or be deleted by
 * something else entirely — so the alternative to recovering here is a run that
 * fails on a condition the provider can simply fix. Recovery is bounded to a
 * single extra attempt: a second identical rejection is a real error, not a
 * stale handle, and retrying it forever would just be a slower failure.
 *
 * `send` reports through `markEmitted` that it has already handed output to the
 * caller. A streaming attempt that has pushed text to `streaming.update` cannot
 * be replayed without rewinding what the caller has already seen, so once that
 * is called the error is surfaced rather than recovered from.
 *
 * The recoverability test deliberately runs on the raw SDK error, before
 * `ProviderError` normalization, so it reads the provider's own wording.
 */
async function sendWithCacheRecovery<T>(
  input: {
    resolver: GeminiContentResolver;
    context: GenerateContext;
    send: (content: GeminiRequestContent, markEmitted: () => void) => Promise<T>;
  },
  /** Recoveries still allowed. Recurses at most once, so depth is bounded at two. */
  recoveriesLeft = 1,
): Promise<T> {
  const { resolver, context, send } = input;

  // Outside the `try`, matching the pre-existing boundary: a cache-creation
  // failure already arrives normalized and must not be re-wrapped.
  const content = await resolver.resolve(context);
  let emitted = false;

  try {
    return await send(content, () => {
      emitted = true;
    });
  } catch (error) {
    if (
      recoveriesLeft > 0 &&
      !emitted &&
      content.cacheKey !== undefined &&
      isMissingCacheError(error)
    ) {
      resolver.invalidate(content.cacheKey);
      return await sendWithCacheRecovery(input, recoveriesLeft - 1);
    }
    throw new ProviderError({ provider: 'gemini', cause: error });
  }
}

/**
 * Resolves, once at factory-construction time, the client the provider-managed
 * cache path will call `caches.create` on — or `undefined` when the provider
 * imports its own client and can use that.
 *
 * Precedence, in order: a cache-capable injected `client`, then `cacheClient`,
 * then the client this factory imports for itself. An injected client that can
 * create caches always wins, because `cacheClient` is documented as the escape
 * hatch for a client that cannot — and the two may carry different
 * credentials, projects, or endpoints, so preferring `cacheClient` over a
 * perfectly capable `client` risks generating against a cache the generating
 * client cannot see. `cacheClient` still applies with no injected client at
 * all: it names a cache-capable client, which is exactly what this needs, and
 * consulting it costs nothing an import would not.
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
  if (options.client && isCacheCreatingClient(options.client)) return options.client;
  if (options.cacheClient) return options.cacheClient;
  if (!options.client) return undefined;
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

  const resolver = createGeminiContentResolver({
    options,
    resolvedModel,
    cacheClient,
    importClient,
  });

  return async (context: GenerateContext): Promise<GenerateResponse> => {
    const client = await getClient();
    const tools = await context.toolbox.toGeminiTools();

    return await sendWithCacheRecovery({
      resolver,
      context,
      send: async (content): Promise<GenerateResponse> => {
        const config = buildGeminiConfig({
          systemInstruction: content.systemInstruction,
          cachedContent: content.cachedContent,
          tools,
          toolChoice: options.toolChoice,
          // Construction-time `options.responseFormat` (an explicit caller
          // override) wins when set; otherwise fall back to the per-run
          // `context.responseFormat` the loop derives from
          // `RunOptions.output` (AB-18), so a run's `output` schema reaches
          // the wire without every caller having to re-derive and pass it
          // at provider construction.
          responseFormat: options.responseFormat ?? context.responseFormat,
          maximumTokens: context.maximumTokens ?? common.maximumTokens,
          temperature: common.temperature,
          topP: common.topP,
          stopSequences: common.stopSequences,
          thinkingBudget: resolvedEffort?.thinkingBudget,
        });

        const request: GeminiGenerateContentRequest = {
          model: resolvedModel,
          contents: content.contents,
          ...(Object.keys(config).length > 0 ? { config } : {}),
        };

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
      },
    });
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

  const resolver = createGeminiContentResolver({
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
    const tools = await context.toolbox.toGeminiTools();

    return await sendWithCacheRecovery({
      resolver,
      context,
      send: async (content, markEmitted): Promise<GenerateResponse> => {
        const config = buildGeminiConfig({
          systemInstruction: content.systemInstruction,
          cachedContent: content.cachedContent,
          tools,
          toolChoice: options.toolChoice,
          // Construction-time `options.responseFormat` (an explicit caller
          // override) wins when set; otherwise fall back to the per-run
          // `context.responseFormat` the loop derives from
          // `RunOptions.output` (AB-18), so a run's `output` schema reaches
          // the wire without every caller having to re-derive and pass it
          // at provider construction.
          responseFormat: options.responseFormat ?? context.responseFormat,
          maximumTokens: context.maximumTokens ?? common.maximumTokens,
          temperature: common.temperature,
          topP: common.topP,
          stopSequences: common.stopSequences,
          thinkingBudget: resolvedEffort?.thinkingBudget,
        });

        const request: GeminiGenerateContentRequest = {
          model: resolvedModel,
          contents: content.contents,
          ...(Object.keys(config).length > 0 ? { config } : {}),
        };

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
              // Past this point the caller has seen output, so a later
              // missing-cache rejection can no longer be retried away.
              markEmitted();
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
      },
    });
  };
}

/**
 * Options for createGeminiTokenCounter.
 */
export interface GeminiTokenCounterOptions {
  /**
   * An already-constructed client. A real `GoogleGenAI` instance satisfies
   * {@link GeminiTokenCountingClient} with no cast — see
   * `providers/gemini-client-assignability.test-d.ts`.
   */
  client?: GeminiTokenCountingClient;
  /** Falls back to the `GOOGLE_API_KEY` environment variable when omitted. */
  apiKey?: string;
  /**
   * Overrides the Gemini SDK's default base URL (`HttpOptions.baseUrl`).
   * Accepts any string — including a credential-injecting proxy origin — with
   * no shape validation, matching `GeminiProviderOptions.baseURL`. A proxy in
   * front of Gemini still speaks the `models.countTokens` API, which is why
   * `getProviderCapabilities('gemini')` keeps reporting
   * `serverSideTokenCounting: true` regardless of this value.
   */
  baseURL?: string;
}

/**
 * The `@google/genai` `models.countTokens` operation, error-normalized.
 */
export interface GeminiTokenCountingOperations {
  /**
   * Counts the tokens `request.contents` (and `request.config`, when
   * supplied) would consume, server-side, before any generation request is
   * made.
   *
   * Returns AB-64's provider-neutral {@link TokenCountResult}.
   */
  countTokens(request: GeminiCountTokensRequest): Promise<TokenCountResult>;
}

/**
 * Creates a client for Gemini's native server-side token-counting API.
 *
 * When no `client` is provided, dynamically imports `@google/genai` and
 * constructs one from `apiKey`/`baseURL` — so a consumer that never calls
 * `countTokens` never loads the SDK. The key comes from `apiKey` or the
 * `GOOGLE_API_KEY` environment variable, resolved by the same helper the
 * generate and batch factories use; a missing key fails here rather than as
 * an opaque auth error on the first request.
 *
 * Gemini-only: per AB-155, this is progressive enhancement over a genuine
 * native mechanism. Anthropic's `messages.countTokens` is a real sibling
 * capability but is deliberately out of scope for this factory — it gets its
 * own issue. OpenAI has no server-side token-counting endpoint at all, and no
 * synthesized character-ratio estimate stands in for it through this
 * signature: a token count feeds budgeting decisions, and a wrong number
 * there is worse than no number. There is simply nothing to import for
 * OpenAI — not a factory that errors or silently no-ops.
 */
export function createGeminiTokenCounter(
  options: GeminiTokenCounterOptions = {},
): GeminiTokenCountingOperations {
  let clientPromise: Promise<GeminiTokenCountingClient> | undefined;

  function getClient(): Promise<GeminiTokenCountingClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      const apiKey = resolveGeminiApiKey(options.apiKey);
      // No cast: a real `GoogleGenAI` satisfies `GeminiTokenCountingClient` as
      // declared, the same guarantee a consumer passing their own client
      // relies on. `gemini-client-assignability.test-d.ts` locks it in.
      clientPromise = import('@google/genai').then(
        (module) =>
          new module.GoogleGenAI({
            apiKey,
            ...(options.baseURL ? { httpOptions: { baseUrl: options.baseURL } } : {}),
          }),
      );
    }
    return clientPromise;
  }

  return {
    async countTokens(request: GeminiCountTokensRequest): Promise<TokenCountResult> {
      try {
        const client = await getClient();
        const response = await client.models.countTokens(request);
        // `totalTokens` is optional in the SDK, but AB-64's `TokenCountResult`
        // requires it — normalized to `0` once, here, rather than pushed onto
        // every caller as a `?? 0`. `cachedTokens` stays optional and is never
        // fabricated: it is present only when the SDK reports
        // `cachedContentTokenCount`.
        const result: TokenCountResult = {
          totalTokens: response.totalTokens ?? 0,
          provider: 'gemini',
          model: request.model,
          ...(response.cachedContentTokenCount !== undefined
            ? { cachedTokens: response.cachedContentTokenCount }
            : {}),
        };
        return result;
      } catch (error) {
        // getClient() can itself throw a ProviderError (a missing API key, via
        // resolveGeminiApiKey) from inside this try — re-wrapping that would
        // double-stack the "[provider:gemini]" prefix and obscure the real
        // cause, so an already-normalized error passes through unchanged.
        if (error instanceof ProviderError) throw error;
        throw new ProviderError({ provider: 'gemini', cause: error });
      }
    },
  };
}
