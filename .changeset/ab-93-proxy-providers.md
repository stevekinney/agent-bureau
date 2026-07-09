---
"conversationalist": minor
---

`toAnthropicMessages` accepts an optional second argument, `{ extendedCacheTtl?: boolean }`. When set, every `cache_control` breakpoint lowered from a `cacheBoundary` mark opts into Anthropic's extended one-hour cache TTL (`cache_control: { type: 'ephemeral', ttl: '1h' }`) instead of the default 5-minute one. `AnthropicCacheControl` gains the matching optional `ttl?: '5m' | '1h'` field. Backward compatible — omitting the option preserves the existing 5-minute-default behavior byte-for-byte.
