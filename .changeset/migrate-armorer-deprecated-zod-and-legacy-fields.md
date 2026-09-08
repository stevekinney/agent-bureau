---
'armorer': patch
---

Migrates armorer's pre-existing `@typescript-eslint/no-deprecated` warnings (AB-367, bucket 4 of AB-366's pull request #572) to their non-deprecated replacements:

- `z.ZodTypeAny` → `z.ZodType` (Zod's documented type-only replacement; identical resolved type, no behavior change).
- `.passthrough()` → `.loose()` (Zod's documented replacement for the same loose-object schema).
- `z.ZodIssue` → `z.core.$ZodIssue` (type-only alias rename).

These three are type-only and carry no runtime change.

A real behavior change: several internal reads of `ToolExecutionResult`'s deprecated `errorMessage`/`errorCategory` fields (`@deprecated Use error.message/error.category instead`, still present and still populated on every result armorer constructs) dropped their fallback to the deprecated field, now reading only `result.error?.message`/`result.error?.category`. armorer itself always sets `error` alongside the deprecated fields, so this is a no-op for every result armorer produces. It is observable only for a hand-built `ToolExecutionResult` (or `ToolResultLike`, e.g. in `armorer/mcp`'s `toCallToolResult`) that sets `errorMessage`/`errorCategory` without also setting `error` — that legacy-only shape now falls through to `stringifyResult(result.content)` (or, for `errorCategory`, to `undefined`) instead of surfacing the deprecated field. `armorer`'s write side is unchanged: `errorMessage`/`errorCategory` are still populated on every constructed error result for any caller still reading the deprecated fields directly.

`AddEventListenerOptionsLike` and `AsyncIteratorOptions` (formerly declared and re-exported via `is-tool.ts`) are still exported from armorer's root, unchanged for any consumer — a patch release must not drop a documented, still-`@deprecated` type export (code review finding, PR #585). They're now declared directly at the export site in `index.ts` instead of being re-exported from `is-tool.ts`, which stops `@typescript-eslint/no-deprecated` from flagging the re-export line (the rule flags _uses_ of a deprecated symbol, and a `type X = Y` declaration of the deprecated name itself is not a use) without suppressing anything or changing the public surface.
