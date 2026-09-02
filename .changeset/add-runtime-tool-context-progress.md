---
'armorer': minor
---

Add `RuntimeToolContext.progress()` (AB-217, ratifying AB-88's AC11) — a typed wrapper over the existing `progress` event so tool authors no longer hand-construct an `Event` and call `dispatch` themselves.

`progress<TDetail = unknown>(update: { percent?; message?; checkpoint?: TDetail }): void` dispatches the same `ToolProgressEvent`/`DefaultToolEvents['progress']` event a hand-constructed `dispatch(new ToolProgressEvent(...))` call produces today, so every existing `progress` listener continues to fire unchanged. The event's `checkpoint` now carries whatever value the tool author passes through verbatim — never re-serialized or reconstructed from `percent`/`message` — so a downstream consumer (an activity-backed execution's heartbeat forwarder, or a liveness-ingestion point) can read it directly.

Calling `progress()` outside of an active tool call (after it has completed or been aborted) is a no-op rather than a thrown error, matching the tolerant-context pattern of `RuntimeToolContext`'s other methods. `progress()` never resets or extends a tool's existing `timeout`.
