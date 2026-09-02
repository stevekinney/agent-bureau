---
'@lostgradient/operative': minor
---

BREAKING (released as a minor under 0.x convention): Replace `RunOptions.responseSchema`/`responseJsonSchema` and the non-Zod Standard Schema / raw JSON Schema structured-output paths with one Zod `output` contract (AB-18).

`RunOptions.output` (also `CreateAgentOptions.output`) now accepts only a Zod schema. There is no more Standard Schema input, raw JSON Schema input, or per-run response-format override — a caller holding a raw JSON Schema or a non-Zod validator must convert it to a Zod schema first. The provider-facing JSON Schema is now derived with Zod's own `z.toJSONSchema(schema, { io: 'input' })` (via the exported `toOutputJsonSchema`) instead of a hand-rolled wrapper; an unrepresentable schema throws a synchronous `OutputSchemaConversionError` with no generic-object fallback.

Validation now distinguishes two failure shapes: `OutputValidationError` (carrying the underlying `ZodError`'s `issues`) when the model's final text was valid JSON but didn't satisfy the schema, and `NonJsonOutputError` when the final text wasn't valid JSON at all (including when it still fails a schema of exactly `z.string()`). `StandardSchemaValidationError` is removed with no alias. The new `validateOutputValue(schema, candidate)` export validates an already-decoded candidate (a durable checkpoint's persisted `output`, or a provider that returns a decoded object instead of text) against the recursive JSONValue contract before the schema.

An `output` schema must not declare a field intended to carry binary or media content (the AB-70 amendment to this issue) — a generated asset a run produces belongs in `RunResult.parts` as a managed-asset reference, never inlined as base64 inside `output`.

**Migration**: rename `responseSchema` to `output` everywhere it's a Zod schema. A raw JSON Schema or non-Zod Standard Schema `responseSchema` has no direct replacement — author (or convert) the contract as a Zod schema instead. `responseJsonSchema` is removed with no replacement.
