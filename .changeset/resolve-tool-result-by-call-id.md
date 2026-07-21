---
conversationalist: minor
---

Add `resolveToolResult(conversation, callId, toolResult, options?, environment?)` to replace the tool-result message for a `callId` with a new result, in place — producing exactly one tool-result message for that call afterwards. This is the primitive a host needs to turn a pending `action_required` result (appended before a run parks on approval) into the resolved result from `toolbox.resumeApproval()`, without ending up with two tool-result messages for the same call — a malformed conversation most providers reject or mishandle on the next turn.

The message is located purely by `toolResult.callId`, scanning `conversation.messages` — never by position or an undo/redo node graph — so it behaves identically on a freshly-built conversation and one rehydrated from a persisted `ConversationHistory`. The replacement keeps the original message's `id`, `createdAt`, and `position`. Throws `error:not-found` if no tool-result message exists for the `callId`, and `error:integrity` if more than one does. The `Conversation` class gains a matching `resolveToolResult(callId, toolResult, options?)` method.

Also hardens `validateConversationHistoryIntegrity`/`assertConversationHistoryIntegrity` with a new `integrity:duplicate-tool-result` check, so appending a second tool-result for a `callId` that already has one (the malformed shape `resolveToolResult` exists to prevent) is now caught at the append boundary too, not just when a naive resume path re-derives it.
