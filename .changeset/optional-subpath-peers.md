---
'conversationalist': patch
---

Mark `@anthropic-ai/sdk` as an optional peer dependency via `peerDependenciesMeta`. The SDK is used only by the `conversationalist/adapters/anthropic` entry point, so consumers of the core transcript API were being asked to satisfy an SDK peer for an entry point they never import. Consumers that do use the Anthropic adapter must now install `@anthropic-ai/sdk` themselves (optional peers are not auto-installed) — the adapter's README section documents this — and the declared `^0.116.0` range check still applies when they do.

`zod` stays a **required** peer: the root entry point reaches it at runtime (`index` → `guards` → `schemas`), so it is not confined to the `conversationalist/schemas` subpath.
