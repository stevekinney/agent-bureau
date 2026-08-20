---
'armorer': patch
---

Declare `"node": ">=20.16.0"` in `engines`. Armorer's `sha256HexSync`, `hmacSha256HexSync`, `timingSafeEqualHex`, and `createIncrementalHash` usage (via `interoperability`) now requires `process.getBuiltinModule`, which Node.js added in 20.16.0/22.3.0, in exchange for eliminating a bundler-injected `createRequire`/`node:module` shim from the published output (see the paired `conversationalist` changeset for the AB-31 context). This documents the real floor rather than narrowing it silently.
