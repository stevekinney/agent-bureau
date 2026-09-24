---
'conversationalist': minor
---

Add `appendStreamingMessage` and the streaming modules (`streaming`, `history-streaming`,
`streaming-accumulator`) to conversationalist's public API for building up a message incrementally
as provider responses stream in.

This also moves conversationalist's shared runtime-services and tool-protocol types onto two
published dependencies, `@lostgradient/lifecycle` and `@lostgradient/tool-protocol`, rather than
duplicating that logic locally — a minor bump rather than a patch because it's a public API
addition, not just an internal change.
