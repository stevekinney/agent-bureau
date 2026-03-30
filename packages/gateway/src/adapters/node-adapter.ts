import type { Hono } from 'hono';

import type { ServerAdapter, ServerAdapterOptions, ServerHandle } from './types';

/**
 * Creates a server adapter that uses @hono/node-server for HTTP
 * handling and its serve-static middleware for file serving.
 *
 * The @hono/node-server package is an optional peer dependency —
 * this adapter dynamically imports it at runtime so bundlers that
 * target Bun never pull it in.
 */
export function createNodeAdapter(): ServerAdapter {
  return {
    async mountStaticFiles(app: Hono, path: string, root: string): Promise<void> {
      const modulePath = '@hono/node-server/serve-static';
      const mod = (await import(/* webpackIgnore: true */ modulePath)) as {
        serveStatic: (options: { root: string }) => unknown;
      };
      app.use(`${path}*`, mod.serveStatic({ root }) as Parameters<typeof app.use>[1]);
    },

    async serve(app: Hono, options: ServerAdapterOptions): Promise<ServerHandle> {
      const { port, hostname } = options;

      const modulePath = '@hono/node-server';
      const mod = (await import(/* webpackIgnore: true */ modulePath)) as {
        serve: (options: { fetch: Hono['fetch']; port: number; hostname?: string }) => unknown;
      };

      const server = mod.serve({ fetch: app.fetch, port, hostname }) as { close(): void };

      return {
        stop() {
          server.close();
        },
      };
    },
  };
}
