import type { Hono } from 'hono';
import { serveStatic } from 'hono/bun';

import type { ServerAdapter, ServerAdapterOptions, ServerHandle } from './types';

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
      const { port, hostname, wsHandler, authToken } = options;

      if (wsHandler) {
        const handler = wsHandler;
        const server = Bun.serve({
          port,
          hostname,
          fetch(request, server) {
            const url = new URL(request.url);

            if (url.pathname === '/ws') {
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

              const upgraded = server.upgrade(request, { data: undefined });
              if (upgraded) return undefined as unknown as Response;
              return new Response('WebSocket upgrade failed', { status: 400 });
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
