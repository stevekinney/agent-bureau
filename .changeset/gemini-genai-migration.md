---
'@lostgradient/operative': minor
---

Migrate the Gemini provider from the frozen `@google/generative-ai` package to Google's maintained `@google/genai` SDK (peer floor `>=2.19.0`).

BREAKING (Gemini client surface; released as a minor under 0.x convention): this changes both the optional peer dependency name and the structural shape of the client you may pass as `options.client`. Anyone constructing their own Gemini client must update on both counts.

- Install `@google/genai` instead of `@google/generative-ai`. The old package has not been published since 2025-04-30.
- `createGeminiProvider`/`createGeminiProviderStream` now take a `GoogleGenAI` client rather than a `GenerativeModel` handle. Calls go through the `models` namespace (`client.models.generateContent`), the model id travels with each request instead of being bound at client construction, and `generateContentStream` resolves to the chunk async-iterable directly rather than to a `{ stream }` wrapper.
- Response objects lost their `.response` envelope: `candidates` and `usageMetadata` now sit at the top level of `GeminiGenerateContentResult`, and `functionCall.name`/`functionCall.args` are optional, so a call with no name is dropped and a named call with no arguments becomes an empty argument object.
- Request bodies use `@google/genai`'s single flat `config` block. The former top-level `systemInstruction`, `tools`, and `toolConfig` fields and the nested `generationConfig` object all fold into it.
- `createGeminiEmbedder` takes a `GoogleGenAI` client too: `client.models.embedContent({ model, contents })` returning a batch of `embeddings`, and it now throws a `ProviderError` when the API returns no vector for a text.
- `createMockGeminiModel`/`createMockGeminiStreamingModel` from `@lostgradient/operative/providers/test` were reshaped to match, so fakes stay trivial to construct.
- The structural client interfaces take a new exported `GeminiGenerateContentRequest` (`{ model: string; contents: unknown; config?: unknown }`) rather than a bare `Record<string, unknown>`. `GenerateContentParameters` is an SDK `interface` and so has no implicit index signature, which made a real `GoogleGenAI` unassignable to `GeminiGenerativeModel`/`GeminiStreamingModel` — passing one to `options.client` required an `as unknown as` cast, defeating the migration path above. Naming the required fields fixes that in both directions; fakes stay trivial, and `providers/gemini-client-assignability.test-d.ts` locks the assignability in at type-check time.

Model resolution, effort/thinking-budget mapping, tool calling, streaming, and structured output are otherwise unchanged, and the provider still issues only `POST /v1beta/models/{model}:generateContent` (or `:streamGenerateContent`) with an `x-goog-api-key` header.
