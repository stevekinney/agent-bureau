---
"conversationalist": minor
---

`Conversation.compact()` and `compactConversation()` now accept a structured `preservePolicy` on `CompactionOptions` (`{ pinned?, decisions?, errors? }`, all defaulting to `true`). When set, compaction preserves — regardless of recency — messages pinned via `metadata.pinned === true`, decision annotations via `metadata.decision === true`, and errors via `toolResult.outcome === 'error'` or `metadata.error === true`. Preserved messages that are half of a tool-call/tool-result pair now pull in their partner in both directions (previously only a recent tool-result pulled in its tool-call). Because these flags default to `true`, plain `compact()` calls now preserve error tool-results and pinned/decision messages that were previously summarized away — this is an intentional behavior change; pass `preservePolicy: { pinned: false, decisions: false, errors: false }` to restore the old summarize-everything-outside-the-recent-window behavior.
