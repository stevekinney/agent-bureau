---
'armorer': minor
---

Export `EventIteratorOptions`, `ToolDefinition`, and `AnyToolDefinition` from the package root. The public `Tool` type structurally references the first two, so consumers previously could not name the inferred type of anything built with `createTool` — TypeScript 6 rejects that outright with TS2883 ("cannot be named without a reference to ... This is likely not portable").

Also widens the optional peer ranges to the current releases: `@modelcontextprotocol/sdk` to `^1.30.0`, `@openai/agents` to `^0.14.3`, `@opentelemetry/api` to `^1.9.1`, and `zod` to `^4.4.3`. The `@openai/agents` move crosses several breaking releases; consumers pinned to `0.4.x` need to upgrade alongside.
