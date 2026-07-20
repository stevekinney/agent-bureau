---
conversationalist: minor
---

Add `buildMessage` and `prependMessages` builders. `buildMessage(input, options?, environment?)` mints a standalone, schema-valid `Message` without requiring a `ConversationHistory` — useful for simulating an inbound message (e.g. an adapter push handler) or handing a pre-built message to `appendMessages`/`prependMessages`. `prependMessages(conversation, ...inputs)` mirrors `appendMessages` for the front of the list, renumbering every existing message's `position` so it stays dense and ordered across the whole `ids` array, instead of requiring callers to hand-roll `Message` construction and renumbering for history pagination.

Also fixes a pre-existing bug where `prependSystemMessage` and `collapseSystemMessages` dropped `goalCompleted` from assistant messages while renumbering their positions.
