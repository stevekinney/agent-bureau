---
"conversationalist": minor
---

`TokenUsage` gains provider-neutral `cacheCreationTokens` and `cacheReadTokens` fields, both optional and never fabricated — a provider or response with no native cache-token concept leaves them `undefined` rather than `0`.
