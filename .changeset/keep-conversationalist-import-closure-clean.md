---
'conversationalist': patch
---

Fix the published root and `conversation` entry points so they no longer leak a `node:module`/`createRequire` shim into browser bundles or a required `@anthropic-ai/sdk` type reference into strict consumers that have not installed the optional peer dependency. `AnthropicConversation` and its constituent block types now live in a dependency-free `adapters/anthropic/types` module that `history.ts` imports directly, and `interoperability`'s Node-crypto fallback reads `node:crypto` via `process.getBuiltinModule` instead of a bare `require(...)` call. This narrows the synchronous hashing helpers used internally by `interoperability` (and by `armorer`, which now declares `"node": "^20.16.0 || >=22.3.0"`) to Bun or Node.js versions with `process.getBuiltinModule`; the async `sha256Hex` remains universal via Web Crypto.
