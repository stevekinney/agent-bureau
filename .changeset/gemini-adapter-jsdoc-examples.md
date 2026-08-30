---
'conversationalist': patch
'armorer': patch
---

Correct the Gemini adapter JSDoc examples, which demonstrated `@google/generative-ai`'s removed `getGenerativeModel()` API. They now show `@google/genai`'s `client.models.generateContent({ model, contents, config })` form, matching the SDK these packages declare.
