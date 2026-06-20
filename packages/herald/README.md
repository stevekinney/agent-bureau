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

## Quick Start

```typescript
import { createAnthropicGenerate } from 'herald/anthropic';
import { defineAgent } from 'operative';
import { createToolbox } from 'armorer';

// Client is optional — herald imports the SDK lazily using ANTHROPIC_API_KEY
const generate = createAnthropicGenerate({ model: 'claude-opus-4-5' });

// Herald produces a `GenerateFunction`; run it through an operative agent.
const agent = defineAgent({ name: 'assistant', generate, toolbox: createToolbox([]) });

const result = await agent.run('What is the capital of France?');
console.log(result.content);
```

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```

---

## Package Structure

### `herald` — Main entry point

Re-exports everything from all subpath modules. Use this when you want a single import for multiple providers or utilities.

**Exported values:** `createAnthropicGenerate`, `createAnthropicGenerateStream`, `createOpenAIGenerate`, `createOpenAIGenerateStream`, `createGeminiGenerate`, `createGeminiGenerateStream`, `createFalloverGenerate`, `FalloverExhaustedError`, `classifyProviderError`, `createProviderHealthTracker`, `createRoutingGenerate`, `createStepBasedStrategy`, `createComplexityStrategy`, `createCostAwareStrategy`, `composeStrategies`, `extractComplexitySignals`, `withRoutingMetrics`, `createOpenAIEmbedder`, `createGeminiEmbedder`, `createVoyageEmbedder`, `createOllamaEmbedder`, `normalizeAnthropicStream`, `normalizeOpenAIStream`, `toOpenAIResponseFormat`, `toGeminiResponseFormat`, `toAnthropicToolChoice`, `toOpenAIToolChoice`, `toGeminiToolChoice`, `HeraldError`, `shouldRetryHeraldError`.

**Exported types:** `GenerateFunction`, `StreamingGenerateFunction`, `GenerateContext`, `GenerateResponse`, `StreamingHandle`, `TokenUsage`, `ProviderName`, `BaseProviderOptions`, `AnthropicProviderOptions`, `AnthropicClient`, `AnthropicStreamingClient`, `AnthropicMessageResponse`, `AnthropicStreamEvent`, `OpenAIProviderOptions`, `OpenAIClient`, `OpenAIStreamingClient`, `OpenAIChatCompletion`, `OpenAIChatCompletionChunk`, `GeminiProviderOptions`, `GeminiGenerativeModel`, `GeminiStreamingModel`, `GeminiGenerateContentResult`, `FalloverOptions`, `FalloverProvider`, `FalloverEvent`, `ProviderHealth`, `ErrorClassification`, `RoutingOptions`, `ModelRoute`, `RoutingStrategy`, `RoutingDecision`, `RoutingEvent`, `RoutingMetrics`, `RoutingMetricsResult`, `ComplexitySignals`, `ComplexityStrategyOptions`, `CostAwareStrategyOptions`, `StepBasedStrategyOptions`, `ResponseFormat`, `ToolChoice`.

---

### `herald/anthropic`

```typescript
import { createAnthropicGenerate, createAnthropicGenerateStream } from 'herald/anthropic';
```

**`createAnthropicGenerate(options: AnthropicProviderOptions): GenerateFunction`**

Creates a non-streaming generate function backed by the Anthropic Messages API. When no `client` is provided, the SDK is imported lazily using `apiKey` or the `ANTHROPIC_API_KEY` environment variable.

```typescript
interface AnthropicProviderOptions {
  model: string;
  client?: AnthropicClient; // inject a pre-built client (or mock)
  apiKey?: string; // falls back to ANTHROPIC_API_KEY
  maximumTokens?: number; // default: 4096
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  toolChoice?: ToolChoice; // 'auto' | 'required' | 'none' | { tool: string }
  responseFormat?: ResponseFormat;
}
```

**`createAnthropicGenerateStream(options): StreamingGenerateFunction`**

Same options as `createAnthropicGenerate` except `client` accepts an `AnthropicStreamingClient`. Progressively calls `streaming.update` with accumulated text and collects tool call fragments into complete `ToolCallInput` objects.

```typescript
import { createAnthropicGenerate } from 'herald/anthropic';
import { defineAgent } from 'operative';
import { createToolbox } from 'armorer';

const generate = createAnthropicGenerate({
  model: 'claude-opus-4-5',
  maximumTokens: 8192,
  temperature: 0.7,
});

const agent = defineAgent({ name: 'assistant', generate, toolbox: createToolbox([]) });
const result = await agent.run('Summarize the Anthropic alignment approach.');
console.log(result.content);
```

---

### `herald/openai`

```typescript
import { createOpenAIGenerate, createOpenAIGenerateStream } from 'herald/openai';
```

**`createOpenAIGenerate(options: OpenAIProviderOptions): GenerateFunction`**

Creates a non-streaming generate function backed by the OpenAI Chat Completions API. When no `client` is provided, the SDK is imported lazily using `apiKey` or the `OPENAI_API_KEY` environment variable. The `baseURL` option enables OpenAI-compatible providers such as LM Studio, Ollama, and Groq.

```typescript
interface OpenAIProviderOptions {
  model: string;
  client?: OpenAIClient; // inject a pre-built client (or mock)
  apiKey?: string; // falls back to OPENAI_API_KEY
  baseURL?: string; // for OpenAI-compatible providers
  maximumTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
}
```

**`createOpenAIGenerateStream(options): StreamingGenerateFunction`**

Same options as `createOpenAIGenerate` except `client` accepts an `OpenAIStreamingClient`.

```typescript
import { createOpenAIGenerate } from 'herald/openai';
import { defineAgent } from 'operative';
import { createToolbox } from 'armorer';

// Standard OpenAI
const generate = createOpenAIGenerate({ model: 'gpt-4o' });

// OpenAI-compatible local model — a local server ignores the key, but read it
// from the environment so the example never normalizes a fake secret literal.
const localGenerate = createOpenAIGenerate({
  model: 'llama-3.2-3b-instruct',
  baseURL: 'http://localhost:1234/v1',
  apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? 'local-development-only',
});

const agent = defineAgent({ name: 'assistant', generate, toolbox: createToolbox([]) });
const result = await agent.run('List three prime numbers.');
console.log(result.content);
```

---

### `herald/gemini`

```typescript
import { createGeminiGenerate, createGeminiGenerateStream } from 'herald/gemini';
```

**`createGeminiGenerate(options: GeminiProviderOptions): GenerateFunction`**

Creates a non-streaming generate function backed by the Google Gemini API. When no `client` is provided, the SDK is imported lazily using `apiKey` or the `GOOGLE_API_KEY` environment variable.

```typescript
interface GeminiProviderOptions {
  model: string;
  client?: GeminiGenerativeModel; // inject a pre-built model (or mock)
  apiKey?: string; // falls back to GOOGLE_API_KEY
  maximumTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
}
```

**`createGeminiGenerateStream(options): StreamingGenerateFunction`**

Same options as `createGeminiGenerate` except `client` accepts a `GeminiStreamingModel`.

```typescript
import { createGeminiGenerate } from 'herald/gemini';
import { defineAgent } from 'operative';
import { createToolbox } from 'armorer';

const generate = createGeminiGenerate({ model: 'gemini-2.0-flash' });
const agent = defineAgent({ name: 'assistant', generate, toolbox: createToolbox([]) });
const result = await agent.run('What is 2 + 2?');
console.log(result.content);
```

---

### `herald/streaming`

```typescript
import { normalizeAnthropicStream, normalizeOpenAIStream } from 'herald/streaming';
```

Normalizes provider-specific streaming responses into a provider-agnostic `AsyncIterable<StreamEvent>` that `operative` and `gateway` consume.

**`normalizeAnthropicStream(stream: AsyncIterable<AnthropicStreamEvent>): AsyncIterable<StreamEvent>`**

Converts Anthropic SSE events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`) into unified `StreamEvent` objects: `stream:text-delta`, `stream:tool-call-start`, `stream:tool-call-delta`, `stream:tool-call-complete`, `stream:block-start`, `stream:block-delta`, `stream:block-complete`, `stream:usage`, and `stream:complete`.

**`normalizeOpenAIStream(stream: AsyncIterable<OpenAIChatCompletionChunk>): AsyncIterable<StreamEvent>`**

Converts OpenAI streaming chunks into the same unified `StreamEvent` shape. Handles the trailing usage-only chunk emitted when `stream_options.include_usage` is set.

```typescript
import { createAnthropicGenerateStream } from 'herald/anthropic';
import { defineAgent, withStreaming } from 'operative';
import { createToolbox } from 'armorer';

// `create*GenerateStream` returns a `StreamingGenerateFunction`, which needs a
// `streaming` handle and cannot be passed to operative directly. Wrap it with
// `withStreaming` to get a standard `GenerateFunction`: the wrapper appends a
// streaming message to the conversation and updates it as tokens arrive.
const streamingGenerate = createAnthropicGenerateStream({ model: 'claude-opus-4-5' });
const generate = withStreaming(streamingGenerate);

const agent = defineAgent({ name: 'assistant', generate, toolbox: createToolbox([]) });
const result = await agent.run('Write a haiku about distributed systems.');
console.log(result.content);
```

---

### `herald/instrumentation`

```typescript
import { instrument } from 'herald/instrumentation';
```

**`instrument(generateFunction: GenerateFunction, options): GenerateFunction`**

Wraps any `GenerateFunction` with OpenTelemetry tracing. Each call creates a span tracking the provider, model, token usage, and any errors. Requires `@opentelemetry/api` as a peer dependency.

```typescript
type InstrumentableGenerateOptions = {
  provider: ProviderName; // 'anthropic' | 'openai' | 'gemini' | 'voyage' | 'ollama'
  model: string;
  maximumTokens?: number;
};

type InstrumentationOptions = {
  tracer?: Tracer; // pre-built OTel Tracer; defaults to trace.getTracer('herald')
  tracerName?: string; // defaults to 'herald'
  tracerVersion?: string; // defaults to '0.0.0'
};
```

```typescript
import { createOpenAIGenerate } from 'herald/openai';
import { instrument } from 'herald/instrumentation';

const base = createOpenAIGenerate({ model: 'gpt-4o' });
const generate = instrument(base, { provider: 'openai', model: 'gpt-4o' });

// generate now emits OTel spans named 'gen_ai.generate openai' on every call
```

---

### `herald/embeddings`

```typescript
import {
  createOpenAIEmbedder,
  createGeminiEmbedder,
  createVoyageEmbedder,
  createOllamaEmbedder,
} from 'herald/embeddings';
```

Re-exports all four embedder factories. All return `Embedder`—a function with signature `(texts: string[]) => Promise<EmbeddingVector[]>` where `EmbeddingVector` is `number[]`.

---

### `herald/embeddings/openai`

```typescript
import { createOpenAIEmbedder } from 'herald/embeddings/openai';
```

**`createOpenAIEmbedder(options?: OpenAIEmbedderOptions): Embedder`**

```typescript
interface OpenAIEmbedderOptions {
  client?: OpenAIEmbeddingClient; // inject a pre-built client (or mock)
  apiKey?: string; // falls back to OPENAI_API_KEY
  model?: string; // default: 'text-embedding-3-small'
}
```

```typescript
import { createOpenAIEmbedder } from 'herald/embeddings/openai';

const embed = createOpenAIEmbedder({ model: 'text-embedding-3-large' });
const vectors = await embed(['semantic search', 'vector database']);
console.log(vectors[0]?.length); // 3072 for text-embedding-3-large
```

---

### `herald/embeddings/gemini`

```typescript
import { createGeminiEmbedder } from 'herald/embeddings/gemini';
```

**`createGeminiEmbedder(options?: GeminiEmbedderOptions): Embedder`**

```typescript
interface GeminiEmbedderOptions {
  client?: GeminiEmbeddingClient; // inject a pre-built GoogleGenerativeAI instance (or mock)
  apiKey?: string; // falls back to GEMINI_API_KEY
  model?: string; // default: 'gemini-embedding-001'
}
```

```typescript
import { createGeminiEmbedder } from 'herald/embeddings/gemini';

const embed = createGeminiEmbedder();
const [vector] = await embed(['hello world']);
```

---

### `herald/embeddings/voyage`

```typescript
import { createVoyageEmbedder } from 'herald/embeddings/voyage';
```

**`createVoyageEmbedder(options: VoyageEmbedderOptions): Embedder`**

Uses `fetch` directly—no SDK required.

```typescript
interface VoyageEmbedderOptions {
  apiKey: string; // required — no env var fallback
  model?: string; // default: 'voyage-3'
  endpoint?: string; // default: 'https://api.voyageai.com/v1/embeddings'
}
```

```typescript
import { createVoyageEmbedder } from 'herald/embeddings/voyage';

const embed = createVoyageEmbedder({ apiKey: process.env.VOYAGE_API_KEY! });
const vectors = await embed(['document text to index']);
```

---

### `herald/embeddings/ollama`

```typescript
import { createOllamaEmbedder } from 'herald/embeddings/ollama';
```

**`createOllamaEmbedder(options?: OllamaEmbedderOptions): Embedder`**

Uses `fetch` directly against a local Ollama instance—no SDK required.

```typescript
interface OllamaEmbedderOptions {
  model?: string; // default: 'nomic-embed-text'
  baseURL?: string; // default: 'http://localhost:11434'
}
```

```typescript
import { createOllamaEmbedder } from 'herald/embeddings/ollama';

const embed = createOllamaEmbedder({ model: 'mxbai-embed-large' });
const vectors = await embed(['local embedding with no API key needed']);
```

---

### `herald/fallover`

```typescript
import {
  createFalloverGenerate,
  FalloverExhaustedError,
  classifyProviderError,
  createProviderHealthTracker,
} from 'herald/fallover';
```

**`createFalloverGenerate(options: FalloverOptions): GenerateFunction`**

Creates a single `GenerateFunction` that cascades across multiple providers. On failure, errors are classified and recovery is handled per strategy:

- **`auth`** (401/403): skip to next provider, place failed provider on cooldown.
- **`rate-limit`** (429): skip to next provider, place failed provider on cooldown.
- **`server-error`** (5xx): retry up to `retriesPerProvider` with exponential backoff, then skip.
- **`overflow`**: throw immediately—the content is too large, cascading won't help.
- **`network`**: retry up to `retriesPerProvider`, then skip.
- **`unknown`**: skip to next provider immediately.

When all providers are exhausted, throws `FalloverExhaustedError`.

```typescript
type FalloverOptions = {
  providers: FalloverProvider[]; // ordered list—tried left to right
  retriesPerProvider?: number; // default: 1
  retryDelay?: number; // base ms between retries, doubles per attempt; default: 1000
  cooldownDuration?: number; // ms a provider stays on cooldown; default: 300_000 (5 min)
  now?: () => number; // injectable clock for tests
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; // injectable for tests
  onFallover?: (event: FalloverEvent) => void;
  onRecovery?: (provider: string) => void;
  classifyError?: (error: unknown) => ErrorClassification;
};

type FalloverProvider = {
  name: string;
  generate: GenerateFunction;
};
```

**`createProviderHealthTracker(providers, options?)`**

Standalone health tracker. Useful when you want to monitor provider availability independently of the fallover loop.

```typescript
type ProviderHealth = {
  name: string;
  available: boolean;
  lastError?: { code: number; message: string; timestamp: number };
  cooldownUntil?: number;
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
};
```

**`classifyProviderError(error: unknown): ErrorClassification`**

Classifies an arbitrary SDK error into `'auth' | 'rate-limit' | 'server-error' | 'overflow' | 'network' | 'unknown'`. Override via `FalloverOptions.classifyError` for custom classification logic.

**`FalloverExhaustedError`**

Thrown when all providers have been tried and failed. Contains an `errors` array of `{ provider: string; error: unknown }` entries.

```typescript
import { createAnthropicGenerate } from 'herald/anthropic';
import { createOpenAIGenerate } from 'herald/openai';
import { createFalloverGenerate, FalloverExhaustedError } from 'herald/fallover';
import { defineAgent } from 'operative';
import { createToolbox } from 'armorer';

const generate = createFalloverGenerate({
  providers: [
    { name: 'anthropic', generate: createAnthropicGenerate({ model: 'claude-opus-4-5' }) },
    { name: 'openai', generate: createOpenAIGenerate({ model: 'gpt-4o' }) },
  ],
  retriesPerProvider: 2,
  onFallover: ({ failedProvider, nextProvider }) =>
    console.warn(`${failedProvider} failed, trying ${nextProvider}`),
});

const agent = defineAgent({ name: 'assistant', generate, toolbox: createToolbox([]) });

try {
  const result = await agent.run('Hello!');
  console.log(result.content);
} catch (error) {
  if (error instanceof FalloverExhaustedError) {
    console.error('All providers failed:', error.errors);
  }
}
```

---

### `herald/routing`

```typescript
import {
  createRoutingGenerate,
  createStepBasedStrategy,
  createComplexityStrategy,
  createCostAwareStrategy,
  composeStrategies,
  extractComplexitySignals,
  withRoutingMetrics,
} from 'herald/routing';
```

**`createRoutingGenerate(options: RoutingOptions): GenerateFunction`**

Creates a generate function that selects a different model route on each call based on the provided strategy. The strategy inspects the `GenerateContext` and returns a route name. If the selected route does not exist, `fallback` is used.

```typescript
type RoutingOptions = {
  routes: ModelRoute[];
  strategy: RoutingStrategy;
  fallback: string; // required — used when the strategy picks an unknown route
  onRoute?: (event: RoutingEvent) => void;
};

type ModelRoute = {
  name: string;
  generate: GenerateFunction;
  costPerMillionTokens?: number; // used by withRoutingMetrics cost tracking
};

type RoutingStrategy = (context: GenerateContext, routes: readonly ModelRoute[]) => RoutingDecision;

type RoutingDecision = { route: string; reason: string };
```

**`createStepBasedStrategy(options: StepBasedStrategyOptions): RoutingStrategy`**

Selects routes by position in the agent loop.

```typescript
type StepBasedStrategyOptions = {
  first: string; // route for step 0
  middle: string; // route for intermediate steps
  last?: string; // route when no tool calls are pending (heuristic for final step)
  middleAfterStep?: number; // step at which to switch from first to middle; default: 1
};
```

**`createComplexityStrategy(options: ComplexityStrategyOptions): RoutingStrategy`**

Scores the conversation context and routes to `simple`, `complex`, or `frontier` models. The default heuristic routes to `frontier` when `toolCount > 10`, `lastMessageLength > 2000`, or `conversationDepth > 20`; to `simple` when all are below 3/500/5; to `complex` otherwise.

```typescript
type ComplexityStrategyOptions = {
  simple: string;
  complex: string;
  frontier?: string; // defaults to complex when omitted
  scorer?: (signals: ComplexitySignals) => 'simple' | 'complex' | 'frontier';
};
```

**`createCostAwareStrategy(options: CostAwareStrategyOptions): RoutingStrategy`**

Switches to a cheaper model when spending approaches a budget limit.

```typescript
type CostAwareStrategyOptions = {
  thresholdRatio: number; // switch when spent/budget >= this
  getBudgetState: () => { spent: number; budget: number };
  cheap: string;
  expensive: string;
};
```

**`composeStrategies(...strategies: RoutingStrategy[]): RoutingStrategy`**

Chains strategies left-to-right, using the first one that returns a valid route name.

**`extractComplexitySignals(context: GenerateContext): ComplexitySignals`**

Extracts `messageCount`, `toolCount`, `lastMessageLength`, `hasCodeContent`, `conversationDepth`, and `pendingToolResults` from a `GenerateContext`. Pass a custom `scorer` to `createComplexityStrategy` to use these signals with your own logic.

**`withRoutingMetrics(options: RoutingOptions): RoutingMetricsResult`**

Wraps routing with per-route metrics tracking: call counts, token costs (using `costPerMillionTokens`), and per-call latencies.

```typescript
type RoutingMetricsResult = {
  generate: GenerateFunction;
  metrics: RoutingMetrics;
};

type RoutingMetrics = {
  readonly routeCounts: ReadonlyMap<string, number>;
  readonly routeCosts: ReadonlyMap<string, number>;
  readonly routeLatencies: ReadonlyMap<string, number[]>;
  reset(): void;
};
```

```typescript
import { createAnthropicGenerate } from 'herald/anthropic';
import { createOpenAIGenerate } from 'herald/openai';
import { createStepBasedStrategy, withRoutingMetrics } from 'herald/routing';
import { defineAgent } from 'operative';
import { createToolbox } from 'armorer';

const { generate, metrics } = withRoutingMetrics({
  routes: [
    {
      name: 'fast',
      generate: createOpenAIGenerate({ model: 'gpt-4o-mini' }),
      costPerMillionTokens: 0.15,
    },
    {
      name: 'smart',
      generate: createAnthropicGenerate({ model: 'claude-opus-4-5' }),
      costPerMillionTokens: 15,
    },
  ],
  strategy: createStepBasedStrategy({ first: 'fast', middle: 'smart' }),
  fallback: 'fast',
});

const agent = defineAgent({ name: 'architect', generate, toolbox: createToolbox([]) });
await agent.run('Plan a software architecture.');
console.log(metrics.routeCounts); // Map { 'fast' => 1 }
metrics.reset();
```

---

### `herald/test`

```typescript
import {
  createMockAnthropicClient,
  createMockOpenAIClient,
  createMockGeminiModel,
  createMockAnthropicStreamingClient,
  createMockOpenAIStreamingClient,
  createMockGeminiStreamingModel,
  // pre-built fixture payloads
  anthropicTextResponse,
  anthropicToolUseResponse,
  anthropicMixedResponse,
  anthropicNoUsageResponse,
  anthropicStreamTextEvents,
  anthropicStreamToolUseEvents,
  anthropicStreamMixedEvents,
  anthropicStreamMultiToolEvents,
  anthropicStreamEmptyEvents,
  openAITextResponse,
  openAIToolCallResponse,
  openAIMixedResponse,
  openAINoUsageResponse,
  openAIStreamTextChunks,
  openAIStreamToolCallChunks,
  openAIStreamMixedChunks,
  openAIStreamMultiToolChunks,
  openAIStreamEmptyChunks,
  geminiTextResponse,
  geminiFunctionCallResponse,
  geminiMixedResponse,
  geminiNoUsageResponse,
  geminiStreamTextChunks,
  geminiStreamFunctionCallChunks,
  geminiStreamMixedChunks,
  geminiStreamMultiFunctionCallChunks,
  geminiStreamEmptyChunks,
} from 'herald/test';
```

Mock clients inject pre-queued responses without making real API calls. Every call is recorded in `._calls` for assertion in tests.

**`createMockAnthropicClient(responses: AnthropicMessageResponse[], errors?: Error[]): MockAnthropicClient`**

Returns responses in queue order. When `errors` is provided, throws each error in sequence before the corresponding response.

**`createMockOpenAIClient(responses: OpenAIChatCompletion[], errors?: Error[]): MockOpenAIClient`**

**`createMockGeminiModel(responses: GeminiGenerateContentResult[], errors?: Error[]): MockGeminiModel`**

**`createMockAnthropicStreamingClient(eventSequences: AnthropicStreamEvent[][], errors?: Error[], options?: { errorAfterEvents?: number }): MockAnthropicStreamingClient`**

Yields queued `AnthropicStreamEvent[]` sequences one per call. Pass `{ errorAfterEvents: n }` to simulate mid-stream errors after `n` events.

**`createMockOpenAIStreamingClient(chunkSequences: OpenAIChatCompletionChunk[][], errors?, options?): MockOpenAIStreamingClient`**

**`createMockGeminiStreamingModel(chunkSequences, errors?, options?): MockGeminiStreamingModel`**

```typescript
import { describe, it, expect } from 'bun:test';
import { createToolbox } from 'armorer';
import { appendMessages, Conversation, createConversationHistory } from 'conversationalist';
import { createAnthropicGenerate } from 'herald/anthropic';
import { createMockAnthropicClient, anthropicTextResponse } from 'herald/test';

describe('createAnthropicGenerate', () => {
  it('returns the model response text', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicGenerate({ model: 'claude-opus-4-5', client });

    // Build the real GenerateContext shapes — a Conversation instance and a
    // Toolbox — so the adapter can read conversation.current and enumerate tools.
    const history = appendMessages(createConversationHistory(), {
      role: 'user',
      content: 'Hello',
    });
    const conversation = new Conversation(history);

    // Invoke generate directly in unit tests without operative's run().
    const response = await generate({
      conversation,
      toolbox: createToolbox([]),
      step: 0,
    });

    expect(typeof response.content).toBe('string');
    expect(client._calls).toHaveLength(1);
  });
});
```
