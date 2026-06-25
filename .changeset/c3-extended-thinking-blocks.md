---
"conversationalist": minor
---

Add extended-thinking content block support: ThinkingContent (preserving `signature`) and RedactedThinkingContent (preserving the encrypted `data` field, per Anthropic's block shape) in the message model, with the Anthropic adapter round-tripping both byte-for-byte. Cited text blocks also preserve their `citations` array so web-search citations survive the round-trip instead of being dropped.
