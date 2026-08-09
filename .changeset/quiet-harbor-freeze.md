---
'conversationalist': minor
---

Guard `updateStreamingMessage` against writing to a message that is no longer streaming. Previously it cloned the target message by id and applied the new content unconditionally, so a token that arrived after `finalizeStreamingMessage` — the classic late-arriving-chunk race after a user hits stop — silently grew a message the UI had already presented as final. Every consumer had to hand-roll the guard; the post-cancel half of the same race already no-opped, because `cancelStreamingMessage` removes the message outright.

`updateStreamingMessage` now returns the conversation unchanged when the target message is not flagged as streaming, matching how it already handles an unknown message id. It stays a no-op rather than a thrown error so both halves of the race behave identically and a stop-button race cannot crash a stream. The rejected update also no longer reads `environment.now()`, so a stateful or fallible injected clock is left untouched.

`Conversation.updateStreamingMessage` (the stateful class wrapper) rejects the same updates without recording history: when the underlying call returns the conversation it was given, the wrapper skips the commit entirely. Previously each rejected chunk still pushed an undo node and emitted `change`, `messages.updated`, and `stream.updated`, so a post-stop token flood inflated the undo stack and — under `maxHistoryDepth` — could prune real ancestors to make room for states that never differed.

Consumers relying on the old behavior — render-side projections that reproject content onto an already-finalized message — should call `updateUnsafeStreamingMessage`, which keeps applying content regardless of streaming status and is now the documented escape hatch. Consumers with their own `shouldStop()`-style guard around `updateStreamingMessage` can drop it; the guard is now enforced at the library boundary.
