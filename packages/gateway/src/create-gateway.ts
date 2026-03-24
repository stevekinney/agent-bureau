import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';

import { createBureau } from './create-bureau';
import { createAuthentication, errorHandler, requestIdentifier } from './middleware';
import { createRoutes } from './routes';
import { createPages } from './server/pages';
import type { Gateway, GatewayOptions } from './types';
import { DEFAULT_PORT } from './types';
import { createWebSocketHandler } from './websocket';

export function createGateway(options: GatewayOptions = {}): Gateway {
  const bureau = createBureau(options);
  const port = options.port ?? DEFAULT_PORT;

  const app = new Hono();

  // Global middleware
  app.use('*', cors());
  app.use('*', requestIdentifier);
  app.use('/api/*', createAuthentication(options.authToken));

  // Mount API routes
  app.route('/', createRoutes(bureau));

  // Mount SSR pages
  app.route(
    '/',
    createPages({
      store: bureau.store,
      provider: options.provider,
      maximumSteps: bureau.getConfiguration().maximumSteps,
      systemPrompt: options.systemPrompt,
    }),
  );

  // Serve static files
  app.use('/public/*', serveStatic({ root: 'dist/' }));

  // Global error handler
  app.onError(errorHandler);

  function start() {
    const wsHandler = createWebSocketHandler({ store: bureau.store });

    const server = Bun.serve({
      port,
      hostname: options.hostname,
      fetch(request, server) {
        const url = new URL(request.url);

        // WebSocket upgrade
        if (url.pathname === '/ws') {
          if (options.authToken) {
            const authHeader = request.headers.get('authorization') ?? '';
            const token = authHeader.toLowerCase().startsWith('bearer ')
              ? authHeader.slice(7).trim()
              : url.searchParams.get('token');

            if (!token || token !== options.authToken) {
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
        open: (ws) => wsHandler.open(ws),
        message: (ws, data) => wsHandler.message(ws, data),
        close: (ws) => wsHandler.close(ws),
      },
    });

    return {
      stop() {
        void server.stop();
        wsHandler.dispose();
        bureau.dispose();
      },
    };
  }

  return { app, bureau, store: bureau.store, port, start };
}
