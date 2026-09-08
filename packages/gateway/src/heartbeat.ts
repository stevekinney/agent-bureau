/**
 * The Gateway connection's default heartbeat cadence, in milliseconds.
 *
 * Shared, by import, between the server's connection watchdog
 * (`live-events.ts`'s `LiveFrameBroker`) and the UI client's
 * application-level ping (`ui/hooks/use-websocket.svelte.ts`, AB-299) — both
 * sides default to the same cadence rather than each hardcoding their own
 * copy of `8_000`. This module has zero imports of its own on purpose: the
 * UI client is browser code, and importing this value must never drag in
 * server-only runtime dependencies (`bureau`, `@lostgradient/operative`,
 * `lifecycle`, ...) the way importing `./live-events` or `./types` as a
 * value (rather than `import type`) would.
 *
 * Must be shorter than the reverse-proxy and server idle timeout so the
 * connection is never silently killed during long silences (e.g. a parked
 * human-in-the-loop workflow or a slow tool call). Bun.serve defaults
 * `idleTimeout` to 10 s; common reverse proxies (nginx, AWS ALB) default to
 * 60 s. 8 s is safely under both.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 8_000;
