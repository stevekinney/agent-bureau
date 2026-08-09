---
'conversationalist': minor
---

Guard `updateStreamingMessage` against writing to a message that is no longer streaming. Previously it cloned the target message by id and applied the new content unconditionally, so a token that arrived after `finalizeStreamingMessage` — the classic late-arriving-chunk race after a user hits stop — silently grew a message the UI had already presented as final. Every consumer had to hand-roll the guard; the post-cancel half of the same race already no-opped, because `cancelStreamingMessage` removes the message outright.

`updateStreamingMessage` now returns the conversation unchanged when the target message is not flagged as streaming, matching how it already handles an unknown message id. It stays a no-op rather than a thrown error so both halves of the race behave identically and a stop-button race cannot crash a stream.

Consumers relying on the old behavior — render-side projections that reproject content onto an already-finalized message — should call `updateUnsafeStreamingMessage`, which keeps applying content regardless of streaming status and is now the documented escape hatch. Consumers with their own `shouldStop()`-style guard around `updateStreamingMessage` can drop it; the guard is now enforced at the library boundary.
