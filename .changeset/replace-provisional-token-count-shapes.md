---
'@lostgradient/operative': minor
---

Replaced the two provisional, SDK-shaped token-count response types with `TokenCountResult`, per AB-64's binding contract.

`GeminiCountTokensResponse` and `AnthropicCountTokensResponse` — both exported from `providers/types.ts` and `providers/index.ts`, and both documented in their own JSDoc as provisional pending AB-64 — are removed. `createGeminiTokenCounter`'s and `createAnthropicTokenCounter`'s `countTokens` now return the new exported `TokenCountResult`:

```ts
export interface TokenCountResult {
  readonly totalTokens: number;
  readonly cachedTokens?: number;
  readonly provider: ProviderName;
  readonly model: string;
}
```

`totalTokens` is required, unlike the removed types' optional SDK-mirrored fields: each adapter now normalizes the SDK's absent case to `0` once, at its own mapping boundary, rather than pushing a `?? 0` onto every caller. `cachedTokens` keeps the "absent and zero are distinct" rule the removed types followed — it is set only when Gemini's response includes `cachedContentTokenCount`, and is never present for Anthropic, which reports no cache attribution.

**Migration:** a caller reading `.totalTokens`/`.cachedContentTokenCount` off a Gemini `countTokens()` result now reads `.totalTokens`/`.cachedTokens`, and a caller reading `.input_tokens` off an Anthropic result now reads `.totalTokens`. Both results additionally carry `provider` and `model`. `GeminiTokenCountingClient` and `AnthropicTokenCountingClient` — the structural, SDK-facing interfaces a real `GoogleGenAI`/`Anthropic` client satisfies — are unaffected: they keep the same inline response shapes they always exposed, declared inline rather than through the removed named types, so `gemini-client-assignability.test-d.ts` and `anthropic-token-counting-assignability.test-d.ts` still pass with no cast.

No consumer outside this package's own tests referenced either removed type, since both shipped under an explicit provisional JSDoc.
