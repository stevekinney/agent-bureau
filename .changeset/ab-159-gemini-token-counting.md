---
'@lostgradient/operative': minor
---

Add Gemini server-side token counting.

`createGeminiTokenCounter` wraps `@google/genai`'s `models.countTokens(params: CountTokensParameters): Promise<CountTokensResponse>` — the same lazy-import, memoized-client, `ProviderError`-normalized shape as `createGeminiBatchClient`. It exposes one operation, `countTokens({ model, contents, config? })`, and returns the SDK's own `{ totalTokens?, cachedContentTokenCount? }` fields unrenamed rather than inventing a provider-neutral budgeting shape: `AB-64` is still in Backlog and will define this package's real context/output-limit fields, so the response type is documented as provisional pending that.

This is Gemini-only per `AB-155`'s progressive-enhancement decision. Anthropic's own `messages.countTokens` is a genuine sibling capability but is out of scope for this factory — it gets its own issue. OpenAI has no server-side token-counting endpoint at all, and this package does not synthesize a character-ratio estimate through the same signature: a token count feeds budgeting decisions, and a wrong number is worse than no number.

The structural `GeminiTokenCountingClient` interface follows the package's minimal-interface rule (named required fields, no `Record<string, unknown>` request parameter), and `gemini-client-assignability.test-d.ts` gains an assertion that a real `GoogleGenAI` satisfies it with no cast.
