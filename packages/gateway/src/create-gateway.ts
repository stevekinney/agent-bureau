import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import type { GenerateFunction } from 'operative';
import type { Store } from 'sentinel';
import { createStore } from 'sentinel';

import { resolveGenerate } from './configuration';
import { createAuthentication, errorHandler, requestIdentifier } from './middleware';
import { createRoutes } from './routes';
import { createPages } from './server/pages';
import type { Gateway, GatewayOptions } from './types';
import { DEFAULT_MAXIMUM_STEPS, DEFAULT_PORT } from './types';
import { createWebSocketHandler } from './websocket';

export function createGateway(options: GatewayOptions = {}): Gateway {
  const store: Store = options.store ?? createStore();
  const port = options.port ?? DEFAULT_PORT;

  let generate: GenerateFunction | undefined = options.generate;
  if (!generate && options.provider) {
    generate = resolveGenerate(options.provider);
  }

  const app = new Hono();

  // Global middleware
  app.use('*', cors());
  app.use('*', requestIdentifier);
  app.use('/api/*', createAuthentication(options.authToken));

  // Mount routes
  const routes = createRoutes({
    store,
    generate,
    toolbox: options.toolbox,
    persistence: options.persistence,
    provider: options.provider,
    stopWhen: options.stopWhen,
    maximumSteps: options.maximumSteps ?? DEFAULT_MAXIMUM_STEPS,
    systemPrompt: options.systemPrompt,
  });

  app.route('/', routes);

  // Mount SSR pages
  const pages = createPages({
    store,
    provider: options.provider,
    toolbox: options.toolbox,
    maximumSteps: options.maximumSteps ?? DEFAULT_MAXIMUM_STEPS,
    systemPrompt: options.systemPrompt,
  });

  app.route('/', pages);

  // Serve static files
  app.use('/public/*', serveStatic({ root: 'dist/' }));

  // Global error handler
  app.onError(errorHandler);

  function start() {
    const wsHandler = createWebSocketHandler({ store });

    const server = Bun.serve({
      port,
      hostname: options.hostname,
      fetch(request, server) {
        // WebSocket upgrade
        if (new URL(request.url).pathname === '/ws') {
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
        store.dispose();
      },
    };
  }

  return { app, store, port, start };
}
