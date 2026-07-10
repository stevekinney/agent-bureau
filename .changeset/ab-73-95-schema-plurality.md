---
"armorer": minor
---

`createTool`'s `input` now accepts any Standard Schema-conforming validator (Valibot, ArkType, ...), not just Zod. A non-Zod validator is wrapped as a `z.ZodTypeAny` transform internally, so the existing execute/diagnostics/serialization pipeline is unchanged — validation runs via `~standard.validate()` and the validator's transformed output (not the raw input) reaches `execute()`.

Since a non-Zod Standard Schema has no general JSON Schema export, `createTool` now also accepts a sibling `inputSchema` option (a plain JSON Schema object) for provider serialization; `createTool` throws at creation time if a non-Zod `input` is supplied without one. Zod remains the documented default and needs no `inputSchema` — its JSON Schema is still derived automatically via `z.toJSONSchema`.
