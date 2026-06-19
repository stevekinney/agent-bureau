# Herald

`herald` adapts model providers into the `GenerateFunction` shape used by `operative`. It is the provider layer for Agent Bureau: OpenAI, Anthropic, Gemini, embeddings, streaming normalization, fallover, routing, and structured-output conversion live here instead of inside the agent loop.

## What It Does

- Creates generate functions for OpenAI, Anthropic, and Gemini.
- Creates streaming generate functions and normalizes provider stream events.
- Converts Agent Bureau response format and tool-choice options into provider-specific payloads.
- Provides embedding factories for OpenAI, Gemini, Voyage, and Ollama.
- Wraps providers with fallover, health tracking, retry classification, and routing strategies.
- Exposes instrumentation hooks around provider calls.

## How It Works

Each provider factory accepts a provider client and options, then returns a function that matches the runtime contract exported by `operative`. The provider adapters use `conversationalist` to translate conversation history into provider messages and `armorer` to translate tools into provider tool declarations.

Higher-level wrappers compose those generate functions. Fallover tries providers in order and tracks health. Routing chooses a model route from step-based, complexity-aware, cost-aware, or custom strategies. Streaming helpers normalize provider-specific chunks into a common stream shape that `operative` and `gateway` can consume.

## Project Role

`operative` intentionally does not import provider SDKs. `herald` keeps provider code isolated so the agent loop can stay testable, provider-neutral, and reusable. `gateway` uses `herald` when a user supplies provider configuration, but direct library consumers can also pass their own generate function without using this package.

## Public Entry Points

- `createOpenAIGenerate()` and `createOpenAIGenerateStream()`
- `createAnthropicGenerate()` and `createAnthropicGenerateStream()`
- `createGeminiGenerate()` and `createGeminiGenerateStream()`
- `createFalloverGenerate()` and provider health helpers
- `createRoutingGenerate()` and routing strategies
- Embedders such as `createOpenAIEmbedder()`, `createGeminiEmbedder()`, `createVoyageEmbedder()`, and `createOllamaEmbedder()`
- Structured-output helpers such as `toOpenAIResponseFormat()` and `toGeminiToolChoice()`

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
