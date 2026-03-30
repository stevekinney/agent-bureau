import type { Hono } from 'hono';

import type { WebSocketHandler } from '../websocket';

/** Options passed to a server adapter when starting the HTTP server. */
export type ServerAdapterOptions = {
  port: number;
  hostname?: string;
  wsHandler?: WebSocketHandler;
  authToken?: string;
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
  mountStaticFiles(app: Hono, path: string, root: string): void;
  /** Start an HTTP server for the given Hono app. */
  serve(app: Hono, options: ServerAdapterOptions): ServerHandle;
};
