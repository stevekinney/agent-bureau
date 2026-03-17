# Streaming Responses

Use native streaming when tools return `AsyncIterable` output.

## Execution Modes

Armorer supports two modes for async-iterable tool output:

- `stream: false` (default): collect chunks into an array and return the array.
- `stream: true`: preserve a live stream on `ToolResult.stream` (and `ToolResult.result`).

## Example: Collect Fallback (Default)

```typescript
import { createTool } from 'armorer';
import { z } from 'zod';

const tokenTool = createTool({
  name: 'token-tool',
  description: 'Emit tokens',
  input: z.object({ prompt: z.string() }),
  async execute({ prompt }) {
    return {
      async *[Symbol.asyncIterator]() {
        yield `${prompt}:a`;
        yield `${prompt}:b`;
      },
    };
  },
});

const result = await tokenTool.execute({
  id: 'collect-1',
  name: 'token-tool',
  arguments: { prompt: 'hello' },
});

console.log(result.result); // ['hello:a', 'hello:b']
```

## Example: Live Stream Mode

```typescript
const result = await tokenTool.execute(
  {
    id: 'stream-1',
    name: 'token-tool',
    arguments: { prompt: 'hello' },
  },
  { stream: true },
);

for await (const chunk of result.stream!) {
  console.log('chunk', chunk);
}
```

## Stream Events

These events are emitted when a tool returns an async-iterable:

- `stream-start`: `{ mode: 'collect' | 'stream' }`
- `stream-chunk`: `{ chunk, index }`
- `stream-end`: `{ chunks, completed }`
- `stream-error`: `{ error, index }`

`output-chunk` is still emitted for compatibility.

```typescript
tokenTool.addEventListener('stream-start', (event) => {
  console.log('mode', event.detail.mode);
});

tokenTool.addEventListener('stream-chunk', (event) => {
  console.log(event.detail.index, event.detail.chunk);
});
```

## Incremental Digests

For async-iterable outputs:

- output digests are computed per chunk (incrementally).

## OpenAI Adapter Note

- `formatOpenAIToolResults(...)` is sync-only and throws on streaming results.
- `formatOpenAIToolResultsAsync(...)` collects stream chunks and returns formatted tool messages.
