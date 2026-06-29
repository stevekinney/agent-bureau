---
'conversationalist': minor
---

Remove Conversation-owned persistence from Conversationalist. Conversation instances now remain pure state/event objects; callers should persist `Conversation.current` themselves or use Bureau/Operative session persistence. This also removes Conversationalist's direct `@lostgradient/weft` dependency.
