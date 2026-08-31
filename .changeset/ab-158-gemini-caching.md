---
'@lostgradient/operative': minor
---

Add Gemini context caching.

`GeminiProviderOptions` gains `assembler`, `contextBudget`, and `pinnedMessages` — the same names and the same `context/` types the Anthropic side already uses, because the concept genuinely matches. Setting `assembler` + `contextBudget` runs the context assembler in stable-prefix mode, splits the conversation at the resulting `cacheBoundary`, creates the prefix once as a `@google/genai` `CachedContent` resource, and has every later request reference it by name while sending only the tail. `systemInstruction` moves into the cache and is omitted from those requests; nothing else is dropped. Wired on both `createGeminiProvider` and `createGeminiProviderStream`.

Two options diverge from the Anthropic names on purpose, because Gemini's cache is a named, explicitly-created server resource with its own lifecycle rather than a per-request `cache_control` breakpoint. `cacheTtl` takes Gemini's own duration string (`'3600s'`) where `extendedCacheTtl` is a boolean over Anthropic's two fixed lifetimes — a boolean cannot express an arbitrary TTL, and "extended" would be a fiction. `cachedContent` names an existing cache the caller created and owns, lowered verbatim to the SDK's `GenerateContentConfig.cachedContent` field; Anthropic's cache has no handle, so there is no name to borrow. Combining `cachedContent` with the assembler options, or enabling caching against an injected client with no `caches` namespace and no `cacheClient`, is rejected at factory-construction time rather than mid-run.

Gemini token accounting now reports `cacheReadTokens` from `cachedContentTokenCount` and subtracts it from `prompt`, matching the OpenAI provider: Gemini's `promptTokenCount` includes the cached count, unlike Anthropic's disjoint buckets. This applies to every response, not only cache-configured ones, because Gemini reports the field for its own implicit caching too. `cacheCreationTokens` stays absent — Gemini reports no cache-write count and it is never fabricated.

Internal: the stable-prefix assembly helper the Anthropic provider used moves to `providers/shared/cache-aware-assembly.ts` so both providers share one implementation. Behavior is unchanged.
