# @lostgradient/operative

## 0.7.0

### Minor Changes

- ca25ea3: Replace `AnthropicClient`/`AnthropicStreamingClient`'s `Record<string, unknown>` request parameter with a named `AnthropicMessageCreateRequest`, and remove the `as unknown as` cast that shape forced at both SDK construction sites.

  This narrows the structural type of the `client` you may pass as `options.client` to `createAnthropicProvider`/`createAnthropicProviderStream`. It is a compile-time break for anyone who constructed a hand-rolled client against the old `Record<string, unknown>` parameter, released as a minor under pre-1.0 semver rather than as a major, so that `@lostgradient/operative` does not declare a stable 1.0 surface ahead of schedule. There is no runtime break: the emitted HTTP request is byte-for-byte unchanged, and every shipped caller in this repository compiles without modification. Pin an exact version if you depend on a hand-rolled Anthropic client and cannot absorb a type change on a minor bump.

  - `messages.create`'s parameter is now `AnthropicMessageCreateRequest`: `model`, `messages`, and `max_tokens` are required; every other field the real `@anthropic-ai/sdk` `MessageCreateParamsBase` accepts (`cache_control`, `container`, `inference_geo`, `metadata`, `output_config`, `service_tier`, `stop_sequences`, `stream`, `system`, `temperature`, `thinking`, `tool_choice`, `tools`, `top_k`, `top_p`, `user_profile_id`) is declared optional and widened to `unknown`, plus a `signal?: unknown` field that has no SDK counterpart — `providers/anthropic.ts` folds `context.signal` into this same body object, and that pre-existing behavior is preserved unchanged. A hand-rolled client implementing `create(params: Record<string, unknown>)` no longer satisfies `AnthropicClient`; a custom `create` must accept (at least) the named required fields.
  - `AnthropicStreamingClient.messages.create` now returns `AsyncIterable<AnthropicStreamEvent> | Promise<AsyncIterable<AnthropicStreamEvent>>` rather than a bare `AsyncIterable<AnthropicStreamEvent>`. The promise arm is required because the real SDK's streaming overload returns an `APIPromise` — a `Promise`, not itself iterable — so a bare-iterable return type was never satisfiable by a real `Anthropic`. The bare-iterable arm is retained so a hand-rolled or mock client that returns its generator synchronously stays valid; narrowing to promise-only would break `for await (const event of client.messages.create(params))` against such a client. `createAnthropicProviderStream` awaits the result, which is a no-op on the non-promise arm.
  - `AnthropicMessageResponse.stop_reason` and its `usage.cache_creation_input_tokens`/`usage.cache_read_input_tokens` fields now allow `null` in addition to being optional, matching the real SDK's `Message`/`Usage` types, which declare them nullable rather than merely optional. This is a widening for readers, not a narrowing.
  - `createMockAnthropicClient`/`createMockAnthropicStreamingClient` from `@lostgradient/operative/providers/test` keep their existing runtime behaviour: the streaming mock still returns its async generator synchronously and still throws queued errors synchronously, so direct `for await` over the mock is unaffected. Only the `_calls` array is retyped, from `Record<string, unknown>[]` to `AnthropicMessageCreateRequest[]`.

  No behavior change to the emitted HTTP request: every field the provider was already setting on the request body is still set the same way, through the same bracket-notation assignments. `AnthropicMessageCreateRequest` is exported alongside the existing Anthropic types from both `@lostgradient/operative/providers` and the `@lostgradient/operative/anthropic` subpath.

  `anthropic-client-assignability.test-d.ts` (a type-only, coverage-inert `.test-d.ts` file that `tsconfig.build.json` excludes from published declarations) asserts a real `Anthropic` satisfies both interfaces with no cast, following the pattern `anthropic-token-counting-assignability.test-d.ts` established for AB-167.

- 5454047: Raise the declared Bun floor from `>=1.3.13` to `>=1.4.0`.

  The repository now pins Bun 1.4.0 everywhere it builds and tests: `packageManager`, both
  CI jobs, the release workflow, and the Dockerfile. Continuing to advertise `>=1.3.13`
  would leave a claim that no gate re-verifies on any pull request, which is the failure
  mode AB-169 exists to close. The declared floor now matches the only version actually
  tested.

  Released as a minor rather than a major because `engines` is advisory: npm and Bun warn
  rather than fail unless a consumer opts into strict engine checking. No runtime, type, or
  API surface changed in any of these packages.

  Consumers still on Bun 1.3.x should upgrade or pin an exact version. The full suite did
  pass under 1.3.13 at the time of this change, so the raised floor states what is
  supported going forward rather than a known incompatibility.

  The same floor was raised on the eight private workspace packages (`bureau`,
  `cloudflare`, `evaluation`, `gateway`, `interoperability`, `lifecycle`, `memory`,
  `skills`) for internal consistency. Those are unpublished, so they carry no changeset.

### Patch Changes

- Updated dependencies [5454047]
  - conversationalist@1.1.0
  - armorer@2.1.0

## 0.6.0

### Minor Changes

- 8ac2dc0: Add Anthropic server-side token counting.

  `createAnthropicTokenCounter` wraps `@anthropic-ai/sdk`'s `messages.countTokens(params: MessageCountTokensParams): APIPromise<MessageTokensCount>` — the same lazy-import, memoized-client, `ProviderError`-normalized shape as `createAnthropicBatchClient`, including its deference to the SDK's own `ANTHROPIC_API_KEY` lookup when `apiKey` is omitted. It exposes one operation, `countTokens({ model, messages, system?, tools?, ... })`, and returns the SDK's own `input_tokens` field unrenamed rather than inventing a provider-neutral budgeting shape: `AB-64` is still in Backlog and will define this package's real context/output-limit fields, so the response type is documented as provisional pending that.

  This is the Anthropic sibling `AB-159` deliberately left out of scope when it shipped `createGeminiTokenCounter`. Landing it makes `getProviderCapabilities('anthropic').serverSideTokenCounting: true` truthful — it was the only capability the catalog advertised that this package did not actually back. OpenAI still has no server-side token-counting endpoint, and this package does not synthesize a character-ratio estimate through the same signature: a token count feeds budgeting decisions, and a wrong number is worse than no number.

  One deliberate divergence from the SDK's own declarations: `AnthropicCountTokensResponse.input_tokens` is **optional** although `MessageTokensCount` declares it required. The declared type describes what Anthropic's endpoint returns, not a runtime guarantee — `baseURL` accepts any origin, including a credential-injecting proxy — so a count is never fabricated as `0` when a response genuinely omits it. "Absent" and "zero" stay distinguishable for callers budgeting against the result, matching the rule `GeminiCountTokensResponse` and `TokenUsage` already follow.

  The structural `AnthropicTokenCountingClient` interface follows the package's minimal-interface rule (named required fields, no `Record<string, unknown>` request parameter), and a new `anthropic-token-counting-assignability.test-d.ts` asserts that a real `Anthropic` satisfies it with no cast.

  No `peerDependencies` change. `messages.countTokens` has been stable on `client.messages` since `@anthropic-ai/sdk` 0.31.0 (2024-11-01), and the declared floor of `>=0.50.0` is already well above it, so every admitted version carries the method.

## 0.5.0

### Minor Changes

- 0a7d316: Add Gemini context caching.

  `GeminiProviderOptions` gains `assembler`, `contextBudget`, and `pinnedMessages` — the same names and the same `context/` types the Anthropic side already uses, because the concept genuinely matches. Setting `assembler` + `contextBudget` runs the context assembler in stable-prefix mode, splits the conversation at the resulting `cacheBoundary`, creates the prefix as a `@google/genai` `CachedContent` resource, and has every later request reference it by name while sending only the tail. `systemInstruction` moves into the cache and is omitted from those requests; nothing else is dropped. Wired on both `createGeminiProvider` and `createGeminiProviderStream`.

  A resource is created once per **distinct stable prefix**, keyed by a digest of the lowered prefix, not once per generated function. A generate function is reusable across runs, and a per-factory resource would hand a second conversation the first one's cached content — a request that omits its own system and pinned prefix while pointing at another run's, which is both a wrong answer and a leak of the earlier run's instructions into it. The retained set is bounded at eight prefixes, evicting the least recently used; an evicted resource is left to expire on its own server-side TTL and costs at most one extra creation if that prefix returns.

  Cache entries now track when they stop being usable, from the SDK's own `CachedContent.expireTime` where the response reports one and from the configured `cacheTtl` otherwise, so a lapsed resource is replaced — for that prefix alone — rather than referenced until every later request fails against a name that no longer resolves. A burst that arrives after an expiry installs exactly one renewal that every waiter shares. Each request awaits the same stored promise and therefore wakes to the same lapsed answer, so deciding to renew is not enough — a waiter has to know whether another already decided. The entry is re-read at the resume point, and everything from there through the replacement happens in one synchronous turn, so exactly one waiter renews and the rest share what it installed. A Gemini cache is a billable resource, so _n_ concurrent requests after every expiry previously meant _n_ paid-for caches of which only the last was kept. A resource that dies inside the remaining window, because it lapsed between the freshness check and the request or was deleted elsewhere, is recognized from the provider's own rejection and rebuilt once for that request; a streaming attempt that has already pushed text to the caller is not replayed, and a rejection about anything other than the cache is never retried. A failed `caches.create` is no longer retained either: the call that met it still throws, and the next call gets a real attempt rather than a replayed rejection.

  Two options diverge from the Anthropic names on purpose, because Gemini's cache is a named, explicitly-created server resource with its own lifecycle rather than a per-request `cache_control` breakpoint. `cacheTtl` takes Gemini's own duration string (`'3600s'`) where `extendedCacheTtl` is a boolean over Anthropic's two fixed lifetimes — a boolean cannot express an arbitrary TTL, and "extended" would be a fiction. `cachedContent` names an existing cache the caller created and owns, lowered verbatim to the SDK's `GenerateContentConfig.cachedContent` field; Anthropic's cache has no handle, so there is no name to borrow. Combining `cachedContent` with the assembler options, or enabling caching against an injected client with no `caches` namespace and no `cacheClient`, is rejected at factory-construction time rather than mid-run.

  `cachedContent` carries a documented **tail-only** input contract, because a `CachedContent` resource is the head of the prompt rather than an addition to it. Setting the option declares that the head of the conversation already lives server-side, so each call must pass only the turns that are not in the cache; passing the full conversation you would have sent uncached states the cached prefix twice, changing the prompt and paying for the duplicate on every request. Operative cannot do the subtraction for a resource it never created — it has no boundary to split on, unlike the provider-managed path where it built the prefix itself — so the caller who owns the cache owns the boundary. The half of the contract that is checkable is now enforced at the point of use: a conversation carrying a system message is rejected with a `ProviderError` naming the cache and the fix, rather than sent as a `config.systemInstruction` riding alongside `config.cachedContent` that duplicates or contradicts the cached instruction.

  `cacheClient` is the documented escape hatch for a client that cannot create caches, and it now behaves that way: precedence is a cache-capable injected `client`, then `cacheClient`, then the client the factory imports for itself. The two clients may carry different credentials, projects, or endpoints, so creating through `cacheClient` while generating through a perfectly capable `client` risked referencing a cache the generating client could not see.

  Gemini token accounting now reports `cacheReadTokens` from `cachedContentTokenCount` and subtracts it from `prompt`, matching the OpenAI provider: Gemini's `promptTokenCount` includes the cached count, unlike Anthropic's disjoint buckets. This applies to every response, not only cache-configured ones, because Gemini reports the field for its own implicit caching too. `cacheCreationTokens` stays absent — Gemini reports no cache-write count and it is never fabricated.

  Internal: the stable-prefix assembly helper the Anthropic provider used moves to `providers/shared/cache-aware-assembly.ts` so both providers share one implementation. Behavior is unchanged.

- 0a7d316: Add cross-provider batch inference and a static provider capability report.

  A new `providers/batches` subpath exposes one client per provider that has a native asynchronous batch endpoint: `createAnthropicBatchClient` (Anthropic Message Batches), `createOpenAIBatchClient` (the OpenAI Batch API), and `createGeminiBatchClient` (`@google/genai` batch jobs). Each is a thin, error-normalizing wrapper over the provider's own resource — the verbs, argument shapes, and returned objects stay the provider's, because the three APIs genuinely differ: Anthropic inlines per-request Messages bodies and streams results as JSONL, OpenAI builds a batch from an uploaded file and returns results as another file, and Gemini takes `{ model, src, config }` and addresses jobs by resource name. Like the existing provider factories, each SDK is imported dynamically, so a consumer that never batches never loads it.

  There is deliberately no OpenAI-compatible/local-server batch export. An Ollama, vLLM, or LM Studio server reuses OpenAI's chat shape and implements no batches endpoint, so `createOpenAIBatchClient` exposes no `baseURL` option and there is nothing to import for that case — unsupported is a compile-time fact, not a factory that fails at runtime. A caller with a batch-capable endpoint behind another origin passes their own client instead.

  `getProviderCapabilities(provider, { baseURL })` reports, synchronously and without side effects, which of four capabilities a provider supports: `batchInference`, `explicitThinkingRequest`, `requestControlledContextCaching`, and `serverSideTokenCounting`. A custom OpenAI `baseURL` reports no batch inference, because operative cannot tell a proxy from a local server and a wrong `true` is worse than a conservative `false`. This surface is provisional pending AB-64.

  The OpenAI answer accounts for the **effective** endpoint, not just the options object. `openai` documents `baseURL` as defaulting to `process.env['OPENAI_BASE_URL']`, and `createOpenAIBatchClient` constructs its client with no explicit base URL, so that variable silently decides where a batch request lands — pointed at LM Studio or Ollama, the advertised batch call reaches a server with no `/v1/batches` at all. `getProviderCapabilities` now reads the same variable and applies the same conservative rule it already applied to an explicit `baseURL`, with an empty string counting as the default endpoint in both cases. The function stays synchronous and side-effect-free, but its OpenAI row is now a fact about the running process rather than about the build, and is documented as such: call it when you need the answer instead of memoizing it at module load.

  Structural client interfaces for all three batch surfaces are added to `providers/types.ts`, and a new type-level test proves a real `Anthropic`, `OpenAI`, and `GoogleGenAI` each satisfy the matching interface with no cast.

  Each factory also verifies its client actually exposes the batch resource, and throws a `ProviderError` naming the required SDK version if it does not. This closes a real gap in the `openai` peer range: `client.batches` first shipped in `openai@4.34.0` and its `list` method in `4.38.0`, so an install satisfying the declared `>=4.0.0` could construct `createOpenAIBatchClient` successfully and then fail with an opaque `TypeError` on every operation. The peer range stays `>=4.0.0` deliberately — chat-only consumers should not be held to a batch-API floor — so the check is a construction-time guard rather than a version bump. `@anthropic-ai/sdk` (stable `messages.batches` since 0.33.0, floor `>=0.50.0`) and `@google/genai` (`batches` since 1.7.0, floor `>=2.19.0`) have no such gap and are guarded the same way for consistency. An injected `client` is checked when the factory is called; a lazily imported one as soon as it is constructed.

- 0a7d316: Add an explicit extended-thinking request parameter for Anthropic.

  `AnthropicProviderOptions` gains `thinking`, mirroring the native Anthropic request shape directly. Its type, exported as `AnthropicThinkingConfig`, is a structural mirror of the SDK's full `ThinkingConfigParam` union — `{ type: 'enabled'; budget_tokens: number }`, `{ type: 'disabled' }`, and `{ type: 'adaptive' }`, the first and last carrying an optional `display` — so adaptive thinking is reachable without defeating the type system. It is declared structurally rather than re-exported from `@anthropic-ai/sdk`, which is an optional peer dependency; a type-level test asserts the SDK's own `ThinkingConfigParam` stays assignable to it, so a variant added upstream fails the build instead of silently becoming unreachable.

  This is a second, provider-native escape hatch alongside the existing neutral `effort` knob rather than a competing abstraction over the same dimension — `effort` continues to lower to `output_config.effort`, `thinking` lowers to the `thinking` field, and neither overrides the other. When a caller sets both, both are sent on the request body and Anthropic applies its own documented interaction between them. Only `createAnthropicProvider` and `createAnthropicProviderStream` expose the option; OpenAI and Gemini have nothing to import for this, so `getProviderCapabilities` continues to report `explicitThinkingRequest: true` only for `anthropic`.

  An enabled budget is validated where the request is configured rather than left for the API to reject. Anthropic requires `budget_tokens` to be at least 1024 and strictly below `max_tokens`, and each half is checked where its inputs are actually known. The 1024 floor depends on nothing but the budget, so both factories reject it at construction. The `< max_tokens` bound depends on the `max_tokens` the request will send, and `GenerateContext.maximumTokens` is documented to override the construction-time value per call — so it is checked per request instead, before the client is touched. A `{ type: 'enabled', budget_tokens: 4096 }` against the default `maximumTokens` of 4096 therefore constructs fine and stays valid for a caller that passes `maximumTokens: 8192` on every invocation, while a call that would actually send an invalid pair throws a non-retryable `ProviderError` naming both values. Neither number is adjusted silently: raising `max_tokens` would change billing the caller did not ask for, and lowering `budget_tokens` would degrade the feature they explicitly requested.

  Both factories also reject, at construction, the parameter combinations Anthropic documents as incompatible with an active thinking configuration — each verified against Anthropic's thinking documentation rather than assumed, because they do not cover the same modes. A non-default `temperature` and a `topP` below 0.95 conflict with `enabled` and `adaptive` alike ("the restriction applies only while thinking is on: `temperature` and `top_k` are incompatible with thinking", and "`top_p` is allowed at values between 0.95 and 1"). A forced `toolChoice` — `'required'` or a named tool — conflicts with manual `{ type: 'enabled' }` only; Anthropic is explicit that "adaptive thinking, including on models where thinking is on by default, supports forced tool use", so that combination is deliberately left alone. `{ type: 'disabled' }` and an absent `thinking` skip all three.

  Known limitation: `thinking` is not yet supported end-to-end alongside tool calls. Anthropic requires the signed `thinking`/`redacted_thinking` block to be replayed, complete and unmodified, on the request that carries a tool result, and this provider extracts only `text` and `tool_use` blocks — so the block never reaches conversation history, and the follow-up request loses reasoning continuity (the API degrades rather than erroring, stripping blocks or disabling thinking for that request). Preserving native response blocks in conversation history is output-side work tracked separately as AB-73; the option's JSDoc carries the same warning.

- 0a7d316: Add Gemini server-side token counting.

  `createGeminiTokenCounter` wraps `@google/genai`'s `models.countTokens(params: CountTokensParameters): Promise<CountTokensResponse>` — the same lazy-import, memoized-client, `ProviderError`-normalized shape as `createGeminiBatchClient`. It exposes one operation, `countTokens({ model, contents, config? })`, and returns the SDK's own `{ totalTokens?, cachedContentTokenCount? }` fields unrenamed rather than inventing a provider-neutral budgeting shape: `AB-64` is still in Backlog and will define this package's real context/output-limit fields, so the response type is documented as provisional pending that.

  This is Gemini-only per `AB-155`'s progressive-enhancement decision. Anthropic's own `messages.countTokens` is a genuine sibling capability but is out of scope for this factory — it gets its own issue. OpenAI has no server-side token-counting endpoint at all, and this package does not synthesize a character-ratio estimate through the same signature: a token count feeds budgeting decisions, and a wrong number is worse than no number.

  The structural `GeminiTokenCountingClient` interface follows the package's minimal-interface rule (named required fields, no `Record<string, unknown>` request parameter), and `gemini-client-assignability.test-d.ts` gains an assertion that a real `GoogleGenAI` satisfies it with no cast.

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
