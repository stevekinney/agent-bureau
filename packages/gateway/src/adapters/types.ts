import type { Hono } from 'hono';

import type { WebSocketHandler } from '../websocket';

/** Options passed to a server adapter when starting the HTTP server. */
export type ServerAdapterOptions = {
  port: number;
  hostname?: string;
  wsHandler?: WebSocketHandler;
  authToken?: string;
  /**
   * Optional async verifier for WebSocket upgrade requests. The adapter
   * calls this before accepting an upgrade; returning `false` causes a 401.
   *
   * Build this from the same precedence as the HTTP auth middleware:
   * managed `ab_live_` keys verified via `ApiKeyStore.verify`, then static
   * token comparison. Keeping a single source of truth here prevents the WS
   * path from diverging from the HTTP path when the auth logic changes.
   *
   * When absent and `authToken` is also absent, all upgrades are accepted
   * (no-auth deployment). When absent and `authToken` is present, the Bun
   * adapter falls back to static-token comparison for backwards compatibility.
   */
  authenticate?: (request: Request) => Promise<boolean>;
  /**
   * Explicit list of allowed origins for WebSocket upgrade requests. When
   * non-empty, upgrade requests whose `Origin` header is absent or not in
   * the list are rejected with 403. When omitted or empty, no origin check
   * is performed.
   *
   * For the Bun adapter this must be enforced here (not in Hono middleware)
   * because Bun intercepts `/ws` upgrades before `app.fetch()` runs.
   */
  allowedOrigins?: string[];
  /**
   * Number of seconds to wait before closing an idle connection.
   *
   * Set this higher than the longest expected silence between SSE events
   * (e.g. a parked human-in-the-loop workflow). The SSE heartbeat interval
   * must be configured to fire before this timeout to prevent the connection
   * from being silently dropped.
   *
   * Bun default: 10 s. Common reverse-proxy default: 60–75 s (nginx, ALB).
   * Pick a value that sits above both heartbeat interval and the max silent
   * period, then set `heartbeatIntervalMs` below it.
   */
  idleTimeout?: number;
};

/** A handle to a running server that can be stopped. */
export type ServerHandle = {
  stop(): void;
};

/**
 * Abstracts the runtime-specific server creation so the gateway can
 * run on both Bun and Node.js without conditional imports at the
 * top level.
 */
export type ServerAdapter = {
  /** Mount static file serving middleware on the Hono app. */
  mountStaticFiles(app: Hono, path: string, root: string): void | Promise<void>;
  /** Start an HTTP server for the given Hono app. */
  serve(app: Hono, options: ServerAdapterOptions): ServerHandle | Promise<ServerHandle>;
};
