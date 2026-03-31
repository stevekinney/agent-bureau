# Streaming Pipeline

> [!NOTE]
> **Status**: The streaming and live-transport work described here is shipped in the current gateway-first productization pass.

## Overview

**Streaming pipeline**: Agent Bureau now has a normalized path from provider streams to browser UI. `operative` owns block-aware streaming state and event emission, `gateway` converts those runtime events into live frames, and the client consumes those frames over WebSocket when available or server-sent events when it needs a portable fallback.

The simplest way to think about it is this: the runtime speaks in structured streaming events, the transport layer speaks in `ServerFrame`s, and the UI only needs to know which runs it wants to follow.

## Current Architecture

The shipped implementation spans these files:

- `packages/operative/src/streaming/index.ts`: exports `createStreamStateMachine()`, `withEnhancedStreaming()`, and the backpressure buffer utilities
- `packages/operative/src/streaming/types.ts`: normalized stream block, stream state, and stream event types
- `packages/herald/src/streaming/*`: provider-specific streaming normalization
- `packages/gateway/src/live-events.ts`: `LiveFrameBroker` for WebSocket and SSE subscribers
- `packages/gateway/src/routes/events.ts`: `/api/v1/events` SSE endpoint
- `packages/gateway/src/websocket/handler.ts`: WebSocket live-frame relay
- `packages/gateway/src/ui/hooks/use-websocket.ts`: browser transport hook with reconnect and SSE fallback
- `packages/gateway/src/ui/hooks/use-chat.ts`: streamed assistant text and tool activity
- `packages/gateway/src/ui/hooks/use-run-detail.ts`: live run timeline, output, and tool activity

## Runtime Event Surface

Inside `operative`, the streaming pipeline already tracks:

- block lifecycle
- text deltas
- tool-call start, delta, and completion
- usage updates
- completion and error events

That richer internal event model is useful because it separates _how a provider streams_ from _what the rest of the product needs to know_.

## Gateway Transport

The gateway now publishes normalized live frames for:

- run lifecycle changes
- streamed text deltas
- tool-call progress
- completion and error states
- scheduler state when explicitly requested

`LiveFrameBroker` is the transport-neutral piece. WebSocket connections and SSE streams both subscribe through the same broker, which keeps the runtime from caring how the client is connected.

## Client Behavior

The browser transport now behaves like a product surface rather than a thin socket demo:

- **Preferred path**: use WebSocket when the runtime supports it
- **Parity path**: fall back to `/api/v1/events` over EventSource when WebSocket is unavailable or cannot reconnect
- **Durable subscriptions**: track desired run subscriptions locally and restore them after reconnect
- **Live UI**: stream assistant text and tool activity into chat, and keep run detail synchronized with timeline and output changes

That reconnect behavior matters because it closes the old gap where a dropped socket meant the UI silently stopped following the active run.

## What Changed on This Branch

This branch completed the product-facing part of streaming:

- gateway now emits normalized live frames from the bureau runtime
- WebSocket and SSE share the same brokered frame source
- the chat UI no longer waits for only `run.completed`
- the run detail page renders live output, tool activity, and event history
- dashboard-level consumers can subscribe to all runs through the shared live feed

## Boundaries and Remaining Work

This shipped work deliberately stops short of a few deeper streaming features:

- The gateway relays the high-value run and tool streaming surface, not every internal block event.
- Backpressure utilities exist in `operative`, but the current gateway transport does not yet expose a richer overflow or reconciliation policy to clients.
- The UI does not yet render thinking or metadata blocks as first-class visual elements.

Those are still good candidates for future expansion, but the core end-to-end streaming path is no longer missing.

## Verification

Use these commands when touching the streaming surface:

```bash
bun test packages/operative/
bun test packages/herald/
bun test packages/gateway/
bun run validate
```
