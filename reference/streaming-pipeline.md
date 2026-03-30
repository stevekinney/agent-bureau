# Streaming Pipeline

## Overview

The operative package has a `withStreaming()` wrapper that manages the conversation streaming lifecycle (`appendStreamingMessage` → `updateStreamingMessage` → `finalizeStreamingMessage`). Herald's streaming factories produce `AsyncIterable` streams. But the pipeline between them is thin—there's no block-level state tracking, no structured partial events for WebSocket relay, no backpressure handling for slow clients, and no way to observe what's happening mid-stream.

This work builds a richer streaming pipeline that tracks block-level state, emits structured partial events, handles client backpressure, and integrates with the gateway's WebSocket layer.

## What Exists Today

Read these files to understand the current state:

- `packages/operative/src/streaming.ts` — `withStreaming()`, `StreamingHandle`
- `packages/operative/src/types.ts` — `StreamingGenerateFunction`, `StreamingHandle`
- `packages/herald/src/types.ts` — `AnthropicStreamEvent`, `OpenAIChatCompletionChunk`, streaming client interfaces
- `packages/gateway/src/websocket/handler.ts` — WebSocket event relay
- `packages/gateway/src/websocket/protocol.ts` — `ServerFrame` types
- `packages/gateway/src/types.ts` — `ServerFrame` union type
- `packages/lifecycle/src/index.ts` — `TypedEventTarget`, `eventIterator`, observables

## Product Requirements

### PR-1: Block-Level State Machine

Track what's happening in the stream at a granular level. Streams produce different _block types_: text content, tool calls (with partial JSON), thinking/reasoning blocks, and metadata. The state machine tracks:

```typescript
type BlockType = 'text' | 'tool-call' | 'thinking' | 'metadata';

interface StreamBlock {
  id: string;
  type: BlockType;
  index: number;
  content: string;
  complete: boolean;
  /** For tool-call blocks: the tool name once known. */
  toolName?: string;
  /** For tool-call blocks: partial JSON arguments as they arrive. */
  partialArguments?: string;
}

interface StreamState {
  readonly blocks: ReadonlyArray<StreamBlock>;
  readonly activeBlock: StreamBlock | undefined;
  readonly textContent: string;
  readonly toolCalls: ReadonlyArray<StreamBlock>;
  readonly complete: boolean;
  readonly usage?: TokenUsage;
}
```

The state machine processes raw provider events (Anthropic `content_block_start`/`content_block_delta`/`content_block_stop`, OpenAI `delta.content`/`delta.tool_calls`) and produces a normalized `StreamState`.

### PR-2: Structured Partial Events

Define a typed event system for stream progress:

```typescript
interface StreamEventMap {
  'stream:start': { messageId: string };
  'stream:block-start': { block: StreamBlock };
  'stream:block-delta': { block: StreamBlock; delta: string };
  'stream:block-complete': { block: StreamBlock };
  'stream:text-delta': { content: string; accumulated: string };
  'stream:tool-call-start': { toolName: string; blockId: string };
  'stream:tool-call-delta': { toolName: string; partialArguments: string };
  'stream:tool-call-complete': { toolName: string; arguments: unknown };
  'stream:usage': { usage: TokenUsage };
  'stream:complete': { state: StreamState };
  'stream:error': { error: unknown };
}
```

These events are emitted via a `TypedEventTarget` from the lifecycle package. They can be consumed by:
- The gateway WebSocket layer for real-time client updates
- The operative loop for monitoring
- Logging/instrumentation

### PR-3: Provider-Agnostic Stream Normalizer

Each provider (Anthropic, OpenAI, Gemini) has a different streaming format. Create normalizer functions that consume provider-specific `AsyncIterable` streams and produce a unified stream of events:

```typescript
function normalizeAnthropicStream(
  stream: AsyncIterable<AnthropicStreamEvent>,
): AsyncIterable<StreamEvent>;

function normalizeOpenAIStream(
  stream: AsyncIterable<OpenAIChatCompletionChunk>,
): AsyncIterable<StreamEvent>;
```

Where `StreamEvent` is the discriminated union of all `StreamEventMap` values.

### PR-4: Enhanced withStreaming

Upgrade `withStreaming()` to use the state machine and emit structured events:

```typescript
interface EnhancedStreamingOptions {
  /** Event target to emit structured stream events on. */
  eventTarget?: TypedEventTarget<StreamEventMap>;
  /** Called with each text delta. */
  onTextDelta?: (delta: string, accumulated: string) => void;
  /** Called when a tool call starts. */
  onToolCallStart?: (toolName: string) => void;
  /** Called with partial tool call arguments. */
  onToolCallDelta?: (toolName: string, partialArgs: string) => void;
}
```

The existing `withStreaming()` API continues to work unchanged. The enhanced version is opt-in via `withEnhancedStreaming()`.

### PR-5: Client Backpressure

When a WebSocket client can't keep up with stream events, the pipeline should handle it:

- **Buffered relay**: Queue events up to a configurable buffer size (default: 100 events).
- **Coalescing**: When the buffer is full, coalesce consecutive `text-delta` events into a single event with the combined delta.
- **Drop policy**: If the buffer overflows even after coalescing, drop `text-delta` events (keeping tool-call and completion events).
- **Catch-up**: When the buffer drains, send a full `StreamState` snapshot so the client can reconcile.

```typescript
interface BackpressureOptions {
  maxBufferSize?: number;
  coalesceDeltas?: boolean;
  onOverflow?: (droppedCount: number) => void;
}
```

### PR-6: Gateway WebSocket Integration

Extend the gateway's WebSocket `ServerFrame` with streaming-specific frames:

```typescript
type ServerFrame =
  | { type: 'stream:text-delta'; runId: string; content: string; accumulated: string }
  | { type: 'stream:tool-call-start'; runId: string; toolName: string }
  | { type: 'stream:tool-call-delta'; runId: string; toolName: string; partialArgs: string }
  | { type: 'stream:tool-call-complete'; runId: string; toolName: string; arguments: unknown }
  | { type: 'stream:complete'; runId: string; state: StreamState }
  | { type: 'stream:error'; runId: string; error: string }
  // ... existing frames
```

## Architecture

### New Files

In `packages/operative/src/streaming/`:

- `types.ts` — `StreamBlock`, `StreamState`, `StreamEventMap`, `BackpressureOptions`
- `stream-state-machine.ts` — `createStreamStateMachine()` factory
- `stream-normalizer.ts` — provider-agnostic normalizer functions
- `enhanced-streaming.ts` — `withEnhancedStreaming()` wrapper
- `backpressure-buffer.ts` — `createBackpressureBuffer()` for client relay
- `index.ts` — re-exports

In `packages/herald/src/streaming/`:

- `normalize-anthropic.ts` — `normalizeAnthropicStream()`
- `normalize-openai.ts` — `normalizeOpenAIStream()`
- `index.ts` — re-exports

### Extended Files

- `packages/operative/src/streaming.ts` — keep existing `withStreaming()`, add re-export of enhanced version
- `packages/operative/src/index.ts` — re-export streaming modules
- `packages/herald/src/index.ts` — re-export normalizers
- `packages/gateway/src/websocket/protocol.ts` — add streaming frames
- `packages/gateway/src/websocket/handler.ts` — relay stream events to subscribers
- `packages/gateway/src/types.ts` — extend `ServerFrame` union

## Implementation Order (TDD)

### Phase 1: Stream State Machine

1. Write tests for `createStreamStateMachine()`:
   - Initial state has empty blocks, no active block, not complete
   - Processing `block-start` creates a new block in `blocks`
   - Processing `block-delta` updates active block content
   - Processing `block-complete` marks block as complete
   - `textContent` aggregates all text block content
   - `toolCalls` filters to tool-call blocks only
   - `activeBlock` tracks the currently incomplete block
   - `complete` flag set when stream finishes
   - `usage` tracked when provided
   - Multiple concurrent blocks handled (text + tool call interleaved)
   - Reset returns to initial state
2. Implement `stream-state-machine.ts`
3. Verify: `bun test packages/operative/src/streaming/stream-state-machine.test.ts`

### Phase 2: Provider Normalizers (Herald)

1. Write tests for `normalizeAnthropicStream()`:
   - `content_block_start` with type `text` → `stream:block-start` + `stream:text-delta`
   - `content_block_delta` with `text` delta → `stream:text-delta`
   - `content_block_start` with type `tool_use` → `stream:tool-call-start`
   - `content_block_delta` with `partial_json` → `stream:tool-call-delta`
   - `content_block_stop` → `stream:block-complete`
   - `message_delta` with `stop_reason` → `stream:complete`
   - `message_start` with usage → `stream:usage`
   - Empty stream → just `stream:complete`
2. Write tests for `normalizeOpenAIStream()`:
   - `delta.content` → `stream:text-delta`
   - `delta.tool_calls` with new index → `stream:tool-call-start`
   - `delta.tool_calls` with arguments → `stream:tool-call-delta`
   - `finish_reason: 'stop'` → `stream:complete`
   - Usage chunk → `stream:usage`
3. Implement normalizers
4. Verify: `bun test packages/herald/src/streaming/`

### Phase 3: Backpressure Buffer

1. Write tests for `createBackpressureBuffer()`:
   - Events pass through when buffer is not full
   - Buffer accumulates when consumer is slow
   - Text deltas coalesced when buffer is full
   - Non-text events preserved even during overflow
   - `onOverflow` callback fires with drop count
   - Buffer drain triggers state snapshot emission
   - Disposal cleans up and flushes remaining events
2. Implement `backpressure-buffer.ts`
3. Verify: `bun test packages/operative/src/streaming/backpressure-buffer.test.ts`

### Phase 4: Enhanced Streaming

1. Write tests for `withEnhancedStreaming()`:
   - Existing `withStreaming()` behavior preserved
   - `onTextDelta` called with each delta
   - `onToolCallStart` called when tool call begins
   - `onToolCallDelta` called with partial arguments
   - Events emitted on `eventTarget` when provided
   - Error in stream cancels conversation streaming message
   - State machine tracks all blocks through the stream
2. Implement `enhanced-streaming.ts`
3. Verify: `bun test packages/operative/src/streaming/enhanced-streaming.test.ts`

### Phase 5: Gateway WebSocket

1. Write tests:
   - Stream events relayed as typed `ServerFrame` messages
   - Subscriber receives `stream:text-delta` frames
   - Subscriber receives `stream:tool-call-start` frames
   - `stream:complete` frame includes final state
   - Backpressure buffer used for slow WebSocket clients
   - Unsubscribed clients don't receive stream frames
2. Update WebSocket handler and protocol
3. Verify: `bun test packages/gateway/src/websocket/`

### Phase 6: Integration

1. Run operative streaming tests: `bun test packages/operative/src/streaming/`
2. Run herald streaming tests: `bun test packages/herald/src/streaming/`
3. Run gateway tests: `bun test packages/gateway/`
4. Run full pipeline: `turbo run validate`

## Acceptance Criteria

- [ ] `createStreamStateMachine()` exported from `operative`
- [ ] State machine tracks blocks, active block, text content, tool calls, completion
- [ ] `normalizeAnthropicStream()` exported from `herald`
- [ ] `normalizeOpenAIStream()` exported from `herald`
- [ ] Normalizers produce identical `StreamEvent` types from different provider formats
- [ ] `withEnhancedStreaming()` exported from `operative`
- [ ] Enhanced streaming emits typed events on `TypedEventTarget`
- [ ] Callback hooks (`onTextDelta`, `onToolCallStart`, `onToolCallDelta`) fire correctly
- [ ] Existing `withStreaming()` unchanged and backward compatible
- [ ] `createBackpressureBuffer()` handles slow consumers
- [ ] Text deltas coalesced during buffer overflow
- [ ] Non-text events preserved during overflow
- [ ] Gateway WebSocket relays stream events as typed `ServerFrame` messages
- [ ] `ServerFrame` union extended with streaming-specific frame types
- [ ] 100% test coverage across all new streaming modules
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies
- [ ] All new modules follow factory-function pattern
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/operative/src/streaming/   # Operative streaming tests
bun test packages/herald/src/streaming/      # Herald normalizer tests
bun test packages/gateway/src/websocket/     # Gateway WebSocket tests
bun test --coverage packages/operative/      # Coverage
bun test --coverage packages/herald/         # Coverage
turbo run check-types --filter=operative     # Type check
turbo run check-types --filter=herald        # Type check
turbo run validate                           # Full pipeline
```

<promise>STREAMING_PIPELINE_COMPLETE</promise>
<promise>STREAMING_PIPELINE_FAILED</promise>
