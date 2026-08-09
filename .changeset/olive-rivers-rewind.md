---
'conversationalist': minor
---

Add `rewindBeforePosition(conversation, position, options?)` and `rewindBeforeMessage(conversation, messageId, options?)` to `conversationalist/context`, plus matching `Conversation` methods and `withConversation` draft builders.

Both drop the message at the boundary **and everything after it** — the branch-rewind counterpart to `truncateFromPosition`, which keeps that same tail. Edit-and-resend flows previously had no helper for this direction and hand-rolled the immutable surgery over `ids`/`messages`/`updatedAt`, which is exactly the assembly the builder API exists to avoid. `rewindBeforeMessage` is the form edit flows usually want, since an adapter command hands you the id of the edited message rather than its position.

Positions are renumbered from zero. A tool-call/tool-result pair straddling the boundary is dropped whole by default, so a rewind never strands a call whose answer was rewound away; `preserveToolPairs: false` cuts strictly at the boundary and leaves the call pending. A boundary at or past the end returns the same conversation reference, so a no-op rewind adds no history entry and fires no events. An unknown message id is likewise a no-op.

Existing behavior is unchanged — this is purely additive.
