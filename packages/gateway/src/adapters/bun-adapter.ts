import type { Hono } from 'hono';
import { serveStatic } from 'hono/bun';

import type { ServerAdapter, ServerAdapterOptions, ServerHandle } from './types';

/**
 * Handles an incoming `/ws` upgrade request for the Bun adapter, enforcing
 * token authentication and origin checks before handing off to `server.upgrade`.
 *
 * This logic is extracted so it can be tested independently of `Bun.serve`.
 *
 * Returns a `Response` when the request should be rejected, or calls
 * `upgrade(request)` and returns `undefined` (cast as Response to satisfy
 * Bun's fetch signature) when the upgrade is accepted.
 */
export function handleWsUpgrade(
  request: Request,
  url: URL,
  upgrade: (request: Request) => boolean,
  options: { authToken?: string; allowedOrigins?: string[] },
): Response | undefined {
  const { authToken, allowedOrigins = [] } = options;

  if (authToken) {
    const authHeader = request.headers.get('authorization') ?? '';
    const headerToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : undefined;
    const queryToken = url.searchParams.get('token') ?? undefined;
    const token = headerToken ?? queryToken;

    if (!token || token !== authToken) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  // Enforce allowedOrigins on WebSocket upgrades. The Bun adapter
  // intercepts /ws before app.fetch() runs, so the Hono
  // createSecurityHeaders middleware never sees this request.
  // We must enforce the origin check here directly.
  if (allowedOrigins.length > 0) {
    const origin = request.headers.get('origin') ?? '';
    if (!allowedOrigins.includes(origin)) {
      return new Response('Origin not allowed for WebSocket upgrade', { status: 403 });
    }
  }

  const upgraded = upgrade(request);
  if (upgraded) return undefined;
  return new Response('WebSocket upgrade failed', { status: 400 });
}

/**
 * Creates a server adapter that uses Bun.serve() for HTTP handling
 * and hono/bun for static file serving. Supports WebSocket upgrade
 * when a wsHandler is provided.
 */
export function createBunAdapter(): ServerAdapter {
  return {
    mountStaticFiles(app: Hono, path: string, root: string): void {
      app.use(`${path}*`, serveStatic({ root }));
    },

    serve(app: Hono, options: ServerAdapterOptions): ServerHandle {
      const { port, hostname, wsHandler, authToken, allowedOrigins = [], idleTimeout } = options;

      if (wsHandler) {
        const handler = wsHandler;
        const server = Bun.serve({
          port,
          hostname,
          // Wire the idle timeout so long-lived SSE connections and parked
          // human-in-the-loop workflows are not silently dropped. The heartbeat
          // must fire before this threshold; see DEFAULT_HEARTBEAT_INTERVAL_MS
          // in live-events.ts.
          idleTimeout,
          fetch(request, server) {
            const url = new URL(request.url);

            if (url.pathname === '/ws') {
              const result = handleWsUpgrade(
                request,
                url,
                (r) => server.upgrade(r, { data: undefined }),
                {
                  authToken,
                  allowedOrigins,
                },
              );
              // When upgrade succeeds, result is undefined; Bun requires returning
              // undefined here but TypeScript expects Response, hence the cast.
              return result as Response;
            }
            return app.fetch(request);
          },
          websocket: {
            open: (ws) => handler.open(ws),
            message: (ws, data) => handler.message(ws, data),
            close: (ws) => handler.close(ws),
          },
        });

        return {
          stop() {
            void server.stop();
          },
        };
      }

      const server = Bun.serve({
        port,
        hostname,
        // Wire the idle timeout so long-lived SSE connections and parked
        // human-in-the-loop workflows are not silently dropped.
        idleTimeout,
        fetch(request) {
          return app.fetch(request);
        },
      });

      return {
        stop() {
          void server.stop();
        },
      };
    },
  };
}
