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
    mountStaticFiles(app: Hono, path: string, root: string): void {
      // Defer the import to serve time so requiring this adapter
      // does not eagerly pull in @hono/node-server.
      const modulePath = '@hono/node-server/serve-static';
      void import(/* webpackIgnore: true */ modulePath).then(
        (mod: { serveStatic: (options: { root: string }) => unknown }) => {
          app.use(`${path}*`, mod.serveStatic({ root }) as Parameters<typeof app.use>[1]);
        },
      );
    },

    serve(app: Hono, options: ServerAdapterOptions): ServerHandle {
      const { port, hostname } = options;

      let serverHandle: { close(): void } | undefined;

      const modulePath = '@hono/node-server';
      void import(/* webpackIgnore: true */ modulePath).then(
        (mod: {
          serve: (options: { fetch: Hono['fetch']; port: number; hostname?: string }) => unknown;
        }) => {
          const result = mod.serve({
            fetch: app.fetch,
            port,
            hostname,
          });
          serverHandle = result as { close(): void };
        },
      );

      return {
        stop() {
          serverHandle?.close();
        },
      };
    },
  };
}
