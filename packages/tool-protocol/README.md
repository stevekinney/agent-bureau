# Tool Protocol

`@lostgradient/tool-protocol` owns the JSON-safe contracts that [Agent Bureau](https://github.com/stevekinney/agent-bureau)'s tool execution, conversation, and agent packages exchange: [`armorer`](https://github.com/stevekinney/agent-bureau/tree/main/packages/armorer), [`conversationalist`](https://github.com/stevekinney/agent-bureau/tree/main/packages/conversationalist), and [`@lostgradient/operative`](https://github.com/stevekinney/agent-bureau/tree/main/packages/operative).

## Installation

```bash
npm install @lostgradient/tool-protocol
```

It runs on Bun 1.4 or later and Node.js 22 or later, and ships compiled JavaScript with type declarations.

## What it does

- Defines JSON-safe primitive, object, array, tool-call, tool-result, tool-error, tool-action, and tool-policy types.
- Materializes permissive tool inputs into canonical runtime records.
- Rejects synchronous materialization of live streaming tool results and provides asynchronous collection variants.
- Uses [`@lostgradient/lifecycle`](https://github.com/stevekinney/agent-bureau/tree/main/packages/lifecycle) runtime services for deterministic identifier generation.

## Materializing a call and result

**Materialization** turns a permissive runtime input into the protocol record that another package can store or exchange. A missing call identifier comes from the supplied generator or the Lifecycle runtime; omitted arguments become an empty object.

```typescript
import { materializeToolCall, materializeToolResult } from '@lostgradient/tool-protocol';

const call = materializeToolCall(
  { name: 'lookup-order', arguments: { orderId: 'order-42' } },
  { generateId: () => 'call-1' },
);
const result = materializeToolResult({
  callId: call.id,
  outcome: 'success',
  content: { status: 'shipped' },
});
console.log(call.id, result.content);
```

Materialization preserves an existing identifier. It normalizes non-JSON values through serialization or a string fallback, and strips runtime-only result fields. It is not strict input validation or a deep-copy guarantee: already JSON-safe content can retain its object identity. Use `isJSONValue` or `assertJSONValue` when your boundary must reject unsupported values instead of representing them.

## Streaming results

`materializeToolResult` rejects a live stream because a synchronous call cannot wait for its chunks. Use `await materializeToolResultAsync(result, { signal })` to collect an async iterable before producing the record. The resulting `content` is an array of collected chunks, normalized as JSON; this API does not forward a live stream to the caller.

The plural asynchronous helper collects results concurrently with `Promise.all`. Supply cancellation when the owner can stop waiting, and avoid collecting unbounded streams into one protocol record. Tool execution, authorization, retries, and storage belong to the runtime that uses these records.

## Boundary

This package owns only the protocol exchanged between tool-producing and tool-consuming packages. Embedding contracts belong to [`@lostgradient/embeddings`](https://github.com/stevekinney/agent-bureau/tree/main/packages/embeddings); hashing and signing primitives belong to [`@lostgradient/cryptography`](https://github.com/stevekinney/agent-bureau/tree/main/packages/cryptography); schema normalization belongs to the package that owns the schema boundary.

## Development

This package lives in the [Agent Bureau](https://github.com/stevekinney/agent-bureau) repository. From `packages/tool-protocol`, run the checks and the build:

```bash
bun run typecheck
bun test
bun run build
```
