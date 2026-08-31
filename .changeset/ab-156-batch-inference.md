---
'@lostgradient/operative': minor
---

Add cross-provider batch inference and a static provider capability report.

A new `providers/batches` subpath exposes one client per provider that has a native asynchronous batch endpoint: `createAnthropicBatchClient` (Anthropic Message Batches), `createOpenAIBatchClient` (the OpenAI Batch API), and `createGeminiBatchClient` (`@google/genai` batch jobs). Each is a thin, error-normalizing wrapper over the provider's own resource — the verbs, argument shapes, and returned objects stay the provider's, because the three APIs genuinely differ: Anthropic inlines per-request Messages bodies and streams results as JSONL, OpenAI builds a batch from an uploaded file and returns results as another file, and Gemini takes `{ model, src, config }` and addresses jobs by resource name. Like the existing provider factories, each SDK is imported dynamically, so a consumer that never batches never loads it.

There is deliberately no OpenAI-compatible/local-server batch export. An Ollama, vLLM, or LM Studio server reuses OpenAI's chat shape and implements no batches endpoint, so `createOpenAIBatchClient` exposes no `baseURL` option and there is nothing to import for that case — unsupported is a compile-time fact, not a factory that fails at runtime. A caller with a batch-capable endpoint behind another origin passes their own client instead.

`getProviderCapabilities(provider, { baseURL })` reports, statically and synchronously, which of four capabilities a provider supports: `batchInference`, `explicitThinkingRequest`, `requestControlledContextCaching`, and `serverSideTokenCounting`. A custom OpenAI `baseURL` reports no batch inference, because operative cannot tell a proxy from a local server and a wrong `true` is worse than a conservative `false`. This surface is provisional pending AB-64.

Structural client interfaces for all three batch surfaces are added to `providers/types.ts`, and a new type-level test proves a real `Anthropic`, `OpenAI`, and `GoogleGenAI` each satisfy the matching interface with no cast.
