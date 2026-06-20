# Interoperability

`interoperability` contains the shared JSON-safe contracts used by the Agent Bureau packages. It started as the common tool-call and tool-result model for `armorer` and `conversationalist`, and now also includes embedding vector and hashing helpers used by retrieval-oriented packages.

It exists so both packages can agree on one JSON-safe public contract for:

- tool call input and materialization
- tool result input and materialization
- canonical tool error and action payloads
- embedding vector validation and cosine similarity
- stable hashing helpers

## What It Does

- Defines JSON-safe primitive, object, array, tool-call, tool-result, tool-error, and tool-action types.
- Materializes permissive tool inputs into canonical runtime records.
- Rejects synchronous materialization of live streaming tool results and points callers to the async variants.
- Provides embedding-vector guards, magnitude calculation, cosine similarity, and incremental SHA-256 helpers.

## How It Works

The materializers normalize caller input at package boundaries. They fill generated identifiers when requested, preserve JSON-safe payloads, and collect async stream content when the async variants are used. That gives higher-level packages one stable representation even when provider adapters or runtime callers supply different input shapes.

## Project Role

`interoperability` is the contract layer below the tool and conversation packages. `armorer` executes tools with these types, `conversationalist` records tool interactions with the same types, `memory` and `herald` reuse the embedding helpers, and `integration` verifies that those contracts remain consumable from package entry points.

## Public API

### JSON types

**`JSONPrimitive`**: A union of `string | number | boolean | null`—the scalar leaf values of a JSON document.

**`JSONValue`**: A recursive union of `JSONPrimitive`, `ReadonlyArray<JSONValue>`, and `{ [key: string]: JSONValue }`. Any value assignable to this type is guaranteed round-trip safe through `JSON.stringify` / `JSON.parse`.

### Tool-call types

**`ToolCallInput`**: The permissive shape accepted by the materializer. `id` is optional and `arguments` is `unknown`—provider adapters pass raw values here.

```typescript
type ToolCallInput = {
  id?: string | undefined;
  name: string;
  arguments?: unknown;
};
```

**`ToolCall`**: The canonical runtime record produced by `materializeToolCall`. `id` is always present and `arguments` is always `JSONValue`.

```typescript
type ToolCall = {
  id: string;
  name: string;
  arguments: JSONValue;
};
```

**`MaterializeToolCallOptions`**: Options accepted by `materializeToolCall` and `materializeToolCalls`.

```typescript
type MaterializeToolCallOptions = {
  generateId?: () => string;
};
```

### Tool-result types

**`ToolResultInput`**: The permissive input shape. `content` is `unknown`, `error.details` is `unknown`, `action.schema` is `unknown`, and streaming variants accept `stream` or `result` as an `AsyncIterable<unknown>`.

**`ToolResult`**: The canonical output. `content` is `JSONValue`, `error.details` is `JSONValue`, and streaming fields are absent—content from streams has been collected and normalized.

**`ToolError`**: The normalized error sub-object on `ToolResult`.

```typescript
type ToolError = {
  code: string;
  category: ToolErrorCategory;
  retryable: boolean;
  message: string;
  details?: JSONValue | undefined;
};
```

**`ToolErrorInput`**: The permissive counterpart to `ToolError`—`details` is `unknown` here.

**`ToolErrorCategory`**: A string literal union of `'validation' | 'permission' | 'not_found' | 'conflict' | 'transient' | 'timeout' | 'cancelled' | 'internal'`.

**`ToolAction`**: An approval or human-input request attached to a `ToolResult`.

```typescript
type ToolAction = {
  type: 'approval' | 'input';
  message?: string | undefined;
  schema?: JSONValue | undefined;
};
```

**`ToolActionInput`**: The permissive counterpart to `ToolAction`—`schema` is `unknown`.

### Embedding types

**`EmbeddingVector`**: A plain `number[]`. The mutable, mutable-write type.

**`EmbeddingVectorLike`**: `ArrayLike<number>`—widens to `Float32Array` and other typed arrays as well as `number[]`. Functions that only _read_ a vector accept this type.

**`Embedder`**: `(texts: string[]) => EmbeddingVector[] | Promise<EmbeddingVector[]>`. The standard async-compatible embedding function signature consumed by `memory` and `herald`.

**`IsEmbeddingVectorOptions`**: Options for `isEmbeddingVector`.

```typescript
type IsEmbeddingVectorOptions = {
  dimension?: number; // require this exact length
  allowEmpty?: boolean; // permit a zero-length vector (default: false)
};
```

### Hash types

**`IncrementalHash`**: A streaming hasher returned by `createIncrementalHash`.

```typescript
type IncrementalHash = {
  update(data: string): void;
  digest(): string;
};
```

---

### Tool-call materializers

#### `materializeToolCall`

```typescript
function materializeToolCall(
  toolCall: ToolCallInput,
  options?: MaterializeToolCallOptions,
): ToolCall;
```

Normalizes one `ToolCallInput` into a canonical `ToolCall`. Fills a missing `id` with `options.generateId?.()` or `crypto.randomUUID()`. Coerces `arguments` to a `JSONValue`—non-serializable values are round-tripped through `JSON.stringify` / `JSON.parse`, falling back to `String()`.

#### `materializeToolCalls`

```typescript
function materializeToolCalls(
  toolCalls: ReadonlyArray<ToolCallInput>,
  options?: MaterializeToolCallOptions,
): ToolCall[];
```

Normalizes an array of tool-call inputs, applying the same options to each entry.

```typescript
import { materializeToolCall, materializeToolCalls } from 'interoperability';

// Single call — id generated automatically
const call = materializeToolCall({ name: 'get-weather', arguments: { city: 'Denver' } });
// { id: '<uuid>', name: 'get-weather', arguments: { city: 'Denver' } }

// Batch with a deterministic id generator
const calls = materializeToolCalls(
  [
    { name: 'get-weather', arguments: { city: 'Denver' } },
    { id: 'call-2', name: 'get-forecast', arguments: { days: 3 } },
  ],
  { generateId: () => 'generated-id' },
);
```

---

### Tool-result materializers

#### `materializeToolResult`

```typescript
function materializeToolResult(toolResult: ToolResultInput): ToolResult;
```

Normalizes one non-streaming `ToolResultInput`. Throws if the input contains a streaming payload (`stream` field or `result` as an `AsyncIterable`)—use `materializeToolResultAsync` in that case.

#### `materializeToolResults`

```typescript
function materializeToolResults(toolResults: ReadonlyArray<ToolResultInput>): ToolResult[];
```

Normalizes multiple non-streaming results.

#### `materializeToolResultAsync`

```typescript
function materializeToolResultAsync(toolResult: ToolResultInput): Promise<ToolResult>;
```

Normalizes one tool result. When the input carries a streaming payload, collects all chunks into an array before returning the canonical record.

#### `materializeToolResultsAsync`

```typescript
function materializeToolResultsAsync(
  toolResults: ReadonlyArray<ToolResultInput>,
): Promise<ToolResult[]>;
```

Normalizes multiple results in parallel, collecting any streams.

```typescript
import {
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResultsAsync,
} from 'interoperability';

// Non-streaming — synchronous
const result = materializeToolResult({
  callId: 'call-1',
  outcome: 'success',
  content: { temperature: 72, unit: 'fahrenheit' },
});

// Error result
const errorResult = materializeToolResult({
  callId: 'call-2',
  outcome: 'error',
  content: null,
  error: {
    code: 'NOT_FOUND',
    category: 'not_found',
    retryable: false,
    message: 'City not found',
  },
});

// Streaming result — collect chunks before returning
async function* tokenStream() {
  yield 'It is ';
  yield 'sunny.';
}

const streamResult = await materializeToolResultAsync({
  callId: 'call-3',
  outcome: 'success',
  content: null,
  stream: tokenStream(),
});
// streamResult.content === ['It is ', 'sunny.']

// Batch async
const allResults = await materializeToolResultsAsync([
  { callId: 'call-4', outcome: 'success', content: 42 },
  { callId: 'call-5', outcome: 'success', content: null, stream: tokenStream() },
]);
```

---

### Embedding helpers

#### `isEmbeddingVector`

```typescript
function isEmbeddingVector(
  value: unknown,
  options?: IsEmbeddingVectorOptions,
): value is EmbeddingVectorLike;
```

Type guard that accepts `number[]` and `Float32Array` (but not arbitrary `ArrayLike` objects or `DataView`). Returns `false` for empty vectors unless `allowEmpty` is set, and for vectors whose length does not match `dimension`.

#### `computeEmbeddingVectorMagnitude`

```typescript
function computeEmbeddingVectorMagnitude(vector: EmbeddingVectorLike): number;
```

Returns the Euclidean (L2) norm of the vector. Returns `0` for an empty vector.

#### `cosineSimilarity`

```typescript
function cosineSimilarity(left: EmbeddingVectorLike, right: EmbeddingVectorLike): number;
```

Returns a value in `[-1, 1]`: `1` for identical direction, `0` for orthogonal, `-1` for opposite. Returns `0` for zero-magnitude vectors.

- Throws `RangeError` when the vectors have different lengths.
- Throws `TypeError` when either vector contains a non-finite entry (`NaN` or `Infinity`).

```typescript
import {
  isEmbeddingVector,
  computeEmbeddingVectorMagnitude,
  cosineSimilarity,
} from 'interoperability';

const raw: unknown = JSON.parse('[0.1, 0.2, 0.3]');

if (isEmbeddingVector(raw, { dimension: 3 })) {
  // TypeScript narrows raw to EmbeddingVectorLike
  const magnitude = computeEmbeddingVectorMagnitude(raw); // ≈ 0.374

  const query = [0.1, 0.2, 0.3];
  const score = cosineSimilarity(raw, query); // 1 — identical direction
}

// Validate a Float32Array from storage
const stored = new Float32Array([0.5, 0.5]);
if (isEmbeddingVector(stored)) {
  const sim = cosineSimilarity(stored, [0.5, 0.5]); // 1
}
```

---

### Hashing helpers

#### `sha256Hex`

```typescript
function sha256Hex(text: string): Promise<string>;
```

Computes the SHA-256 hex digest of `text` using the Web Crypto API. Works in all environments—browsers, Node.js, Bun, Deno.

#### `sha256HexSync`

```typescript
function sha256HexSync(text: string): string;
```

Synchronous SHA-256 hex digest. Uses `Bun.CryptoHasher` in Bun and `node:crypto` in Node.js. Throws in browser environments where no synchronous crypto API is available.

#### `createIncrementalHash`

```typescript
function createIncrementalHash(algorithm?: string): IncrementalHash;
```

Returns a streaming hasher that accumulates data across multiple `.update()` calls, then finalizes with `.digest()`. Defaults to `'sha256'`. Uses `Bun.CryptoHasher` in Bun and `node:crypto` in Node.js. Throws in browser environments.

```typescript
import { sha256Hex, sha256HexSync, createIncrementalHash } from 'interoperability';

// Async — works everywhere
const digest = await sha256Hex('hello world'); // 'b94d27...'

// Sync — Bun and Node only
const syncDigest = sha256HexSync('hello world');

// Incremental — hash a large payload in chunks
const hasher = createIncrementalHash();
hasher.update('part one ');
hasher.update('part two');
const finalDigest = hasher.digest();
```

---

## Notes

- All materialized output is JSON-safe.
- Missing tool-call identifiers are filled by `options.generateId?.()` when provided, or `crypto.randomUUID()` otherwise.
- Synchronous tool-result materializers throw when passed a streaming result—use the `Async` variants instead.
- `armorer` and `conversationalist` both re-export this surface from their own package entry points.

## Development

Run package checks from this directory:

```bash
bun run validate
```
