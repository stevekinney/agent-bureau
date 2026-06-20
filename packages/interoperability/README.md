# Interoperability

`interoperability` contains the shared JSON-safe contracts used by the Agent Bureau packages. It started as the common tool-call and tool-result model for `armorer` and `conversationalist`, and now also includes embedding vector and hashing helpers used by retrieval-oriented packages.

It exists so both packages can agree on one JSON-safe public contract for:

- tool call input
- tool call materialization
- tool result input
- tool result materialization
- canonical tool error and action payloads
- embedding vector validation and cosine similarity
- stable hashing helpers

## What It Does

- Defines JSON-safe primitive, object, array, tool-call, tool-result, tool-error, and tool-action types.
- Materializes permissive tool inputs into canonical runtime records.
- Rejects synchronous materialization of live streaming tool results and points callers to async variants.
- Provides embedding-vector guards, magnitude calculation, cosine similarity, and incremental SHA-256 helpers.

## How It Works

The materializers normalize caller input at package boundaries. They fill generated identifiers when requested, preserve JSON-safe payloads, and collect async stream content when the async variants are used. That gives higher-level packages one stable representation even when provider adapters or runtime callers supply different input shapes.

## Project Role

`interoperability` is the contract layer below the tool and conversation packages. `armorer` executes tools with these types, `conversationalist` records tool interactions with the same types, `memory` and `herald` reuse the embedding helpers, and `integration` verifies that those contracts remain consumable from package entry points.

## Public API

### Types

- `JSONPrimitive`
- `JSONValue`
- `ToolAction`
- `ToolActionInput`
- `ToolCall`
- `ToolCallInput`
- `ToolError`
- `ToolErrorCategory`
- `ToolErrorInput`
- `ToolResult`
- `ToolResultInput`
- `MaterializeToolCallOptions`
- `Embedder`
- `EmbeddingVector`

### Functions

- `materializeToolCall`: normalize one `ToolCallInput` into a canonical `ToolCall`.
- `materializeToolCalls`: normalize multiple tool calls.
- `materializeToolResult`: normalize one non-streaming `ToolResultInput` into a canonical `ToolResult`.
- `materializeToolResultAsync`: normalize one tool result while collecting async stream payloads when present.
- `materializeToolResults`: normalize multiple non-streaming tool results.
- `materializeToolResultsAsync`: normalize multiple tool results while collecting stream payloads when present.
- `isEmbeddingVector`: validate embedding vector-like values.
- `computeEmbeddingVectorMagnitude`: compute vector magnitude.
- `cosineSimilarity`: compare two embedding vectors.
- `createIncrementalHash`, `sha256Hex`, and `sha256HexSync`: compute stable hashes.

## Notes

- All materialized output is JSON-safe.
- Missing tool-call identifiers can be generated through `MaterializeToolCallOptions.generateId`.
- Synchronous tool-result materializers reject live streaming results and direct callers to the async variants.
- `armorer` and `conversationalist` both re-export this surface from their own package entry points.

## Development

Run package checks from this directory:

```bash
bun run validate
```
