---
'conversationalist': minor
---

`fromMarkdown` (and `conversationFromMarkdown`) gain an optional `runtime` parameter — the AB-92/AB-252 `RuntimeServices` identifier and clock seam (AB-325). When markdown carries no frontmatter, `fromMarkdown` used to mint the conversation id, every message id, and the shared timestamp through `crypto.randomUUID()`/`new Date()` directly; it now reads them through `runtime.identifiers`/`runtime.clock`, defaulting to the real implementation (`createDefaultRuntimeServices` from `lifecycle`) — matching the pre-existing default behavior exactly. `conversationFromMarkdown` forwards `environment?.runtime` into `fromMarkdown` so a manual runtime supplied for the returned `Conversation` also controls the raw parse, closing the last non-deterministic read in conversationalist's markdown round-trip.
