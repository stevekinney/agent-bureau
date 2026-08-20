---
'conversationalist': patch
---

Fix the published root and `conversation` entry points so they no longer leak a `node:module`/`createRequire` shim into browser bundles or a required `@anthropic-ai/sdk` type reference into strict consumers that have not installed the optional peer dependency. `AnthropicConversation` and its constituent block types now live in a dependency-free `adapters/anthropic/types` module that `history.ts` imports directly, and `interoperability`'s Node-crypto fallback reads `node:crypto` via `process.getBuiltinModule` instead of a bare `require(...)` call.
