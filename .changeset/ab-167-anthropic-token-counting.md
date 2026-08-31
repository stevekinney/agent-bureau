---
'@lostgradient/operative': minor
---

Add Anthropic server-side token counting.

`createAnthropicTokenCounter` wraps `@anthropic-ai/sdk`'s `messages.countTokens(params: MessageCountTokensParams): APIPromise<MessageTokensCount>` — the same lazy-import, memoized-client, `ProviderError`-normalized shape as `createAnthropicBatchClient`, including its deference to the SDK's own `ANTHROPIC_API_KEY` lookup when `apiKey` is omitted. It exposes one operation, `countTokens({ model, messages, system?, tools?, ... })`, and returns the SDK's own `input_tokens` field unrenamed rather than inventing a provider-neutral budgeting shape: `AB-64` is still in Backlog and will define this package's real context/output-limit fields, so the response type is documented as provisional pending that.

This is the Anthropic sibling `AB-159` deliberately left out of scope when it shipped `createGeminiTokenCounter`. Landing it makes `getProviderCapabilities('anthropic').serverSideTokenCounting: true` truthful — it was the only capability the catalog advertised that this package did not actually back. OpenAI still has no server-side token-counting endpoint, and this package does not synthesize a character-ratio estimate through the same signature: a token count feeds budgeting decisions, and a wrong number is worse than no number.

One deliberate divergence from the SDK's own declarations: `AnthropicCountTokensResponse.input_tokens` is **optional** although `MessageTokensCount` declares it required. The declared type describes what Anthropic's endpoint returns, not a runtime guarantee — `baseURL` accepts any origin, including a credential-injecting proxy — so a count is never fabricated as `0` when a response genuinely omits it. "Absent" and "zero" stay distinguishable for callers budgeting against the result, matching the rule `GeminiCountTokensResponse` and `TokenUsage` already follow.

The structural `AnthropicTokenCountingClient` interface follows the package's minimal-interface rule (named required fields, no `Record<string, unknown>` request parameter), and a new `anthropic-token-counting-assignability.test-d.ts` asserts that a real `Anthropic` satisfies it with no cast.

No `peerDependencies` change. `messages.countTokens` has been stable on `client.messages` since `@anthropic-ai/sdk` 0.31.0 (2024-11-01), and the declared floor of `>=0.50.0` is already well above it, so every admitted version carries the method.
