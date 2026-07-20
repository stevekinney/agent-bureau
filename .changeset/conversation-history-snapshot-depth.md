---
conversationalist: patch
---

Fix `ConversationHistory` blowing TypeScript's instantiation depth (`TS2589`) when run through Svelte 5's `$state.snapshot` mapped type. The underlying `JSONValue` type (shared with `interoperability` and inlined into this package's build) now expresses its recursive array and object branches as named interfaces (`JSONArray`, `JSONObject`) instead of anonymous mapped-type literals, so TypeScript can cache the recursive instantiations instead of re-expanding them. Svelte consumers no longer need `$state.snapshot(conversation as unknown) as ConversationHistory` — a plain `$state.snapshot(conversation)` now typechecks.
