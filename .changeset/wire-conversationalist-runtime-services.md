---
'conversationalist': minor
---

Add a `runtime` field to `ConversationEnvironment` (AB-321) carrying the AB-92/AB-252 `RuntimeServices` seam's `clock` and `identifiers`. `createConversationHistory`, `createConversationHistoryUnsafe`, `buildMessage`, and the `Conversation` class all read a conversation's id and timestamps through it when supplied, defaulting to a real-globals implementation (`createDefaultRuntimeServices` from `lifecycle`) when omitted — matching the pre-existing default behavior exactly. Explicit `now`/`randomId` overrides on `ConversationEnvironment` still take precedence over `runtime` when both are supplied, so no existing test double needs to change.

Also fixes a bug where `new Conversation()` (no `initial` argument) always minted its default conversation through the real globals, even when the caller supplied a custom `environment` — the constructor's default parameter value was evaluated before the environment was resolved. `new Conversation(undefined, { runtime })` now mints through the supplied runtime, which is what makes conversation ids and timestamps reproducible across two identically-seeded manual runtimes (AB-92's byte-identical reproduction guarantee).
