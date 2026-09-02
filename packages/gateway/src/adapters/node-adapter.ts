import type { Hono } from 'hono';

import type { ServerAdapter, ServerAdapterOptions, ServerHandle } from './types';

/** A raw TCP socket, as passed to a `'connection'` event listener. */
export type DestroyableSocket = {
  destroy(): void;
  once(event: 'close', listener: () => void): unknown;
};

/**
 * The subset of Node's `http.Server` (what `@hono/node-server`'s `serve()`
 * returns) that `stop()` needs: a `close()` that accepts an optional
 * error-first callback, invoked once the server has actually closed.
 */
export type CloseableServer = {
  close(callback?: (error?: Error) => void): unknown;
  /**
   * Forcibly destroys every open connection (Node's `http.Server` since
   * 18.2.0). Optional because a fake test server may not implement it, and
   * because it does not exist at all on Node 18.0–18.1 (the repository's
   * `node >=18` engine range permits both) — `createNodeAdapter`'s
   * `forceClose()` falls back to destroying sockets it has tracked itself
   * via `on('connection', ...)` when this is absent, rather than silently
   * becoming a no-op and leaving `stop()` to hang past the drain timeout.
   */
  closeAllConnections?(): void;
  /**
   * Node's `http.Server` (any `net.Server`) emits `'connection'` with the
   * raw socket for every new inbound TCP connection. Optional so a minimal
   * fake test server can omit it — when both this and
   * `closeAllConnections` are absent, `forceClose()` has no way to close
   * open connections and is a documented no-op.
   */
  on?(event: 'connection', listener: (socket: DestroyableSocket) => void): unknown;
};

/**
 * Promisifies a Node-style `close(callback)` server shutdown. Extracted so
 * it can be tested independently of `@hono/node-server`'s dynamic import.
 */
export function promisifyClose(server: CloseableServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/** The subset of `@hono/node-server`'s `serve()` this adapter depends on. */
export type NodeServeFunction = (options: {
  fetch: Hono['fetch'];
  port: number;
  hostname?: string;
}) => CloseableServer;

/**
 * Loads `@hono/node-server`'s `serve()`. Extracted as an injectable
 * dependency (default: the real dynamic import) so tests can exercise
 * `createNodeAdapter().serve(...).stop()` end to end against a fake
 * closeable server, without module-mocking the dynamic import.
 */
export interface CreateNodeAdapterDependencies {
  loadServe?: () => Promise<NodeServeFunction>;
}

/** Loads the real `@hono/node-server` `serve()`. Exported for direct testing. */
export const defaultLoadServe: () => Promise<NodeServeFunction> = async () => {
  const modulePath = '@hono/node-server';
  const mod = (await import(/* webpackIgnore: true */ modulePath)) as {
    serve: NodeServeFunction;
  };
  return mod.serve;
};

/**
 * Creates a server adapter that uses @hono/node-server for HTTP
 * handling and its serve-static middleware for file serving.
 *
 * The @hono/node-server package is an optional peer dependency —
 * this adapter dynamically imports it at runtime so bundlers that
 * target Bun never pull it in.
 *
 * WebSocket support requires Bun's native upgrade mechanism, so
 * the Node adapter logs a warning when a wsHandler is provided.
 * Auth token protection for WebSocket connections is similarly
 * unavailable outside Bun.
 */
export function createNodeAdapter(dependencies: CreateNodeAdapterDependencies = {}): ServerAdapter {
  const { loadServe = defaultLoadServe } = dependencies;

  return {
    async mountStaticFiles(app: Hono, path: string, root: string): Promise<void> {
      const modulePath = '@hono/node-server/serve-static';
      const mod = (await import(/* webpackIgnore: true */ modulePath)) as {
        serveStatic: (options: { root: string }) => unknown;
      };
      app.use(`${path}*`, mod.serveStatic({ root }) as Parameters<typeof app.use>[1]);
    },

    async serve(app: Hono, options: ServerAdapterOptions): Promise<ServerHandle> {
      const { port, hostname, wsHandler, authToken } = options;

      if (wsHandler) {
        console.warn(
          '[gateway] WebSocket support is not available with the Node.js adapter. ' +
            'Real-time event streaming over WebSocket requires the Bun runtime. ' +
            'The HTTP API remains fully functional.',
        );

        if (authToken) {
          console.warn(
            '[gateway] WebSocket auth-token protection is not available with the Node.js adapter. ' +
              'HTTP route authentication still applies, but WebSocket upgrade ' +
              "requests cannot be validated without Bun's native server.",
          );
        }
      }

      const serve = await loadServe();
      const server = serve({ fetch: app.fetch, port, hostname });

      // AB-235: track open sockets ourselves so forceClose() can still
      // bound shutdown on a Node runtime older than 18.2 (no
      // closeAllConnections) instead of silently becoming a no-op there.
      const sockets = new Set<DestroyableSocket>();
      server.on?.('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });

      return {
        stop() {
          return promisifyClose(server);
        },
        forceClose() {
          // AB-235: escalates the already-in-flight `close()` above by
          // destroying any connections still open, which causes the
          // pending `close(callback)` to fire immediately. Prefer the
          // built-in closeAllConnections() when available; fall back to
          // destroying the sockets tracked above otherwise.
          if (server.closeAllConnections) {
            server.closeAllConnections();
            return;
          }
          for (const socket of sockets) {
            socket.destroy();
          }
        },
      };
    },
  };
}
