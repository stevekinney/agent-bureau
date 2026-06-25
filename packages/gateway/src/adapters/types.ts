import type { Hono } from 'hono';

import type { WebSocketHandler } from '../websocket';

/** Options passed to a server adapter when starting the HTTP server. */
export type ServerAdapterOptions = {
  port: number;
  hostname?: string;
  wsHandler?: WebSocketHandler;
  authToken?: string;
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
