---
'conversationalist': patch
---

`rewindBeforePosition` and `rewindBeforeMessage` now decide what survives a rewind by transcript order (`ids` order) rather than by comparing stored `message.position` values. Schema-valid histories can carry stale or sparse positions that disagree with the id order; the old position-based filter could retain messages that sit _after_ the boundary in the transcript, and tool-block preservation could keep a straddling pair alive on the strength of a stale position comparison. The boundary itself is still identified by stored position for `rewindBeforePosition` (the value a caller read off a message) and by id for `rewindBeforeMessage`; only prefix membership and tool-block extents now come from the ordered transcript. Well-formed histories — positions matching id order — behave exactly as before.
