---
'conversationalist': patch
---

Mark `@anthropic-ai/sdk` and `zod` as optional peer dependencies via `peerDependenciesMeta`. Each is used by exactly one subpath — the SDK by `conversationalist/adapters/anthropic`, zod by `conversationalist/schemas` — so consumers of the core transcript API were being asked to satisfy peers for entry points they never import. Consumers that do import those subpaths still install the respective peer and keep the declared range check; nothing changes for them.
