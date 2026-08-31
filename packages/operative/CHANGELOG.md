# @lostgradient/operative

## 0.4.0

### Minor Changes

- c2ec10f: `createAgent` now defaults `stopWhen` to `stopWhen.noToolCalls()` when the caller omits it, instead of running every step to `maximumSteps` with no stop condition at all. Pass an explicit `stopWhen` (still fully overridable) for agents that must finish on a tool call, such as a handoff.
- 3c45232: Migrate the Gemini provider from the frozen `@google/generative-ai` package to Google's maintained `@google/genai` SDK (peer floor `>=2.19.0`).

  BREAKING (Gemini client surface; released as a minor under 0.x convention): this changes both the optional peer dependency name and the structural shape of the client you may pass as `options.client`. Anyone constructing their own Gemini client must update on both counts.

  - Install `@google/genai` instead of `@google/generative-ai`. The old package has not been published since 2025-04-30.
  - `createGeminiProvider`/`createGeminiProviderStream` now take a `GoogleGenAI` client rather than a `GenerativeModel` handle. Calls go through the `models` namespace (`client.models.generateContent`), the model id travels with each request instead of being bound at client construction, and `generateContentStream` resolves to the chunk async-iterable directly rather than to a `{ stream }` wrapper.
  - Response objects lost their `.response` envelope: `candidates` and `usageMetadata` now sit at the top level of `GeminiGenerateContentResult`, and `functionCall.name`/`functionCall.args` are optional, so a call with no name is dropped and a named call with no arguments becomes an empty argument object.
  - Request bodies use `@google/genai`'s single flat `config` block. The former top-level `systemInstruction`, `tools`, and `toolConfig` fields and the nested `generationConfig` object all fold into it.
  - `createGeminiEmbedder` takes a `GoogleGenAI` client too: `client.models.embedContent({ model, contents })` returning a batch of `embeddings`, and it now throws a `ProviderError` when the API returns no vector for a text.
  - `createMockGeminiModel`/`createMockGeminiStreamingModel` from `@lostgradient/operative/providers/test` were reshaped to match, so fakes stay trivial to construct.
  - The structural client interfaces take a new exported `GeminiGenerateContentRequest` (`{ model: string; contents: unknown; config?: unknown }`) rather than a bare `Record<string, unknown>`. `GenerateContentParameters` is an SDK `interface` and so has no implicit index signature, which made a real `GoogleGenAI` unassignable to `GeminiGenerativeModel`/`GeminiStreamingModel` — passing one to `options.client` required an `as unknown as` cast, defeating the migration path above. Naming the required fields fixes that in both directions; fakes stay trivial, and `providers/gemini-client-assignability.test-d.ts` locks the assignability in at type-check time.

  Model resolution, effort/thinking-budget mapping, tool calling, streaming, and structured output are otherwise unchanged, and the provider still issues only `POST /v1beta/models/{model}:generateContent` (or `:streamGenerateContent`) with an `x-goog-api-key` header.

### Patch Changes

- c2ec10f: Document `textValueStore(new MemoryStorage())` from `@lostgradient/weft/storage` as the copy-paste-runnable in-memory `ConditionalTextValueStore` for `createSessionStore`, matching the pattern operative's own test suite uses.
- c2ec10f: Document that `createTopicBoundaryDetector`'s `allowedTopics`/`blockedKeywords` matching is literal, case-insensitive substring matching, not semantic — a paraphrased, on-topic input that never uses the literal keyword is flagged as off-topic. No behavior change.
- c2ec10f: Correct the `createHandoffTool` documentation. Warn against `stopWhen.noToolCalls()`, which never terminates a handoff loop, and recommend composing `stopWhen.every(stopWhen.toolCalled(name), stopWhen.not(stopWhen.toolOutcome('error')))` with a step cap instead of bare `stopWhen.toolCalled(name)` — the latter inspects only the generated call name, so it also fires on a handoff whose arguments fail validation, ending the run with no `HANDOFF_MARKER` and `extractHandoffTarget` returning `undefined`. Document that `undefined` check as mandatory, and document the default `z.object({})` input schema alongside an honest account of a custom one: it constrains and validates the call but does not travel into the handoff marker, so the values are recoverable from the recorded tool call on `RunResult.steps`, not from `extractHandoffTarget`.
- 3c45232: Bump the `@anthropic-ai/sdk` devDependency from `^0.116.0` to `^0.122.0`. No breaking changes apply between these versions, so `src/providers/anthropic.ts` and `src/providers/streaming/normalize-anthropic.ts` are unchanged and the `>=0.50.0` peer dependency floor is unchanged.
- 3c45232: Bump the `openai` devDependency from `^7.4.0` to `^7.8.0`. No breaking changes apply between these versions, so `src/providers/openai.ts`, `src/providers/embeddings/openai.ts`, and `src/providers/streaming/normalize-openai.ts` are unchanged and the `>=4.0.0` peer dependency floor is unchanged.
- 59f7642: Stop tool-result materialization from throwing on a self-referential array. `interoperability`'s non-JSON fallback called `String()` directly, which relies on `Array.prototype.join`'s cycle guard — an engine extension rather than a spec requirement. On Bun 1.3.13 that yields `'1,2,'`; on Bun 1.4.0 it recurses until the stack overflows and a `RangeError` escapes what is supposed to be a total normalization step. Cycles are now elided before coercion, so every supported runtime produces the documented result. Circular plain objects still render as `[object Object]`, unchanged. This ships to consumers because `interoperability` is inlined into these packages at build time.
- Updated dependencies [995734a]
- Updated dependencies [c2ec10f]
- Updated dependencies [59f7642]
- Updated dependencies [3c45232]
  - armorer@2.0.1
  - conversationalist@1.0.1

## 0.3.0

### Minor Changes

- a6e18f2: Require request-scoped Armorer execution authority when using approval-gated toolboxes, and update the stateless approval flow for Armorer 2.

### Patch Changes

- Updated dependencies [a6e18f2]:
  - armorer@2.0.0

## 0.2.0

### Minor Changes

- 00e34f2: `SessionHandle.recover()` now surfaces a failed durable re-attach through `emitter` instead of returning an indistinguishable `null`. `SessionRecoverEvent` gains a `failures` array (each entry carrying the rejected `runId` and its `error`), populated whenever `engine.resume()` rejects while re-attaching to a session's `running` refs — distinguishing "nothing to resume" (`failures: []`) from "resume was attempted and failed" (`failures.length > 0`). `recover()` itself keeps returning `AgentRun | null` and never throws.
- 8e70c14: Add `createLazyGenerate` for shared, retryable lazy loading of selected generate functions with invocation-local abort handling.
- 31d4780: Wire `@lostgradient/operative` into the Changesets and trusted-publishing release pipeline.
- f4fd0ed: Rename validated run data from `structuredOutput` to `output`, reject old persisted run-result shapes explicitly, add cached `unwrap()` and typed output accessors, and expose diagnostic handles for durable runs whose originating agent definition is unavailable.
- d3670e3: `createAgent`'s standalone `CreateAgentOptions` now encodes `tools`/`toolbox`/`permissions` exclusivity at the type level: `tools` + `toolbox`, `toolbox` + `permissions`, and all three together are now compile-time errors, matching the existing runtime guard. `tools`, `permissions`, `tools` + `permissions`, and `toolbox` alone remain valid, as does passing no tool configuration, including when `tools`/`permissions` are forwarded as already-optional (`T | undefined`-typed) values.

  `CreateAgentOptions` is now a `type` (a union-based intersection), not an `interface` — a consumer that previously wrote `interface MyOptions extends CreateAgentOptions` for the full options bag needs `type MyOptions = CreateAgentOptions & { ... }` instead. Extending or declaration-merging onto just the non-exclusive fields (`generate`, `instructions`, `stopWhen`, etc.) still works via the newly exported `CreateAgentOptionsBase` interface.

### Patch Changes

- e45b40c: Fix `session.recover()` leaving a session's `RunRef` stranded at `status: 'running'` forever when a recovered durable run reaches a terminal state before `recover()` resumes it. `engine.resume()` rejecting for an already-terminal workflow now reconciles the persisted `RunRef` (and recovered conversation history) to the workflow's actual terminal status instead of being silently swallowed; an unknown `runId` is left untouched.
- dfc571b: Optimize session listing with a maintained summary index while preserving compatibility with legacy session records.
- Updated dependencies [22de20a]
- Updated dependencies [ed70acf]
- Updated dependencies [aff071a]
- Updated dependencies [22de20a]
- Updated dependencies [d947aad]
- Updated dependencies [d229843]
- Updated dependencies [8bddca2]
  - conversationalist@1.0.0
  - armorer@1.0.0
