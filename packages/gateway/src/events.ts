/**
 * Public SSE event-streaming entry point for the gateway.
 *
 * Exposes the live-frame broker and its subscription types so that
 * callers who only need to integrate the event-streaming layer (e.g. a
 * thin sidecar proxy) can import from this subpath without pulling in the
 * full gateway + Hono + SSR stack.
 */
export type { EventStreamResponseOptions, LiveFrameSubscriberOptions } from './live-events';
export { ALL_RUNS_SUBSCRIPTION, LiveFrameBroker } from './live-events';
