---
'conversationalist': minor
---

Re-export `JSONValue` and `JSONPrimitive` from `interoperability` directly instead of aliasing them. The alias made the bundler emit two distinct symbols in the published declarations — the inlined original plus the alias — and only the alias was exported. Any consumer whose inferred type reached the original could not name it, which TypeScript 6 reports as TS2883. Downstream packages building against `conversationalist/schemas` were the visible casualty.

`toJSONValue` now narrows `bigint`, `symbol`, and function inputs explicitly so each uses its own `toString` rather than falling through to a generic coercion. Output is unchanged for every input.

Also raises the `@anthropic-ai/sdk` peer range to `^0.116.0` and `zod` to `^4.4.3`. The Anthropic bump is consumer-visible: `ToolUseBlock` gained a required `caller` field in 0.116, so code constructing those blocks by hand needs updating.
