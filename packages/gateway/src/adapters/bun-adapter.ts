import type { Hono } from 'hono';
import { serveStatic } from 'hono/bun';

import type { GatewayWebSocketData } from '../websocket';
import type {
  ServerAdapter,
  ServerAdapterOptions,
  ServerHandle,
  WsAuthenticationResult,
} from './types';

/**
 * Handles an incoming `/ws` upgrade request for the Bun adapter, enforcing
 * authentication and origin checks before handing off to `server.upgrade`.
 *
 * This logic is extracted so it can be tested independently of `Bun.serve`.
 *
 * Authentication is resolved in priority order:
 * 1. `authenticate` — injected async verifier built from the same precedence
 *    as the HTTP middleware (managed `ab_live_` keys, then static token).
 *    Used when an `ApiKeyStore` is configured. Its `privileged` result
 *    flows straight through to `upgrade`.
 * 2. `authToken` — static token fallback for backwards compatibility when no
 *    `ApiKeyStore` is present. A successful match is privileged (AB-305) —
 *    the static token is an unrestricted admin credential, same as HTTP.
 * 3. No-op — when neither is provided, all upgrades are accepted (no-auth)
 *    as privileged — no restriction was configured at all.
 *
 * Returns a `Response` when the request should be rejected, or calls
 * `upgrade(request, privileged)` and returns `undefined` (cast as Response
 * to satisfy Bun's fetch signature) when the upgrade is accepted.
 */
export async function handleWsUpgrade(
  request: Request,
  url: URL,
  upgrade: (request: Request, privileged: boolean) => boolean,
  options: {
    authToken?: string;
    authenticate?: (request: Request) => Promise<WsAuthenticationResult>;
    allowedOrigins?: string[];
  },
): Promise<Response | undefined> {
  const { authToken, authenticate, allowedOrigins = [] } = options;
  let privileged = true;

  if (authenticate) {
    // Delegate to the injected verifier, which mirrors the HTTP auth middleware.
    const result = await authenticate(request);
    if (!result.allowed) {
      return new Response('Unauthorized', { status: 401 });
    }
    privileged = result.privileged;
  } else if (authToken) {
    // Static-token fallback for backwards compatibility (no ApiKeyStore).
    const authHeader = request.headers.get('authorization') ?? '';
    const headerToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : undefined;
    const queryToken = url.searchParams.get('token') ?? undefined;
    const token = headerToken ?? queryToken;

    if (!token || token !== authToken) {
      return new Response('Unauthorized', { status: 401 });
    }
    // The static token is an unrestricted admin credential (AB-305).
    privileged = true;
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

  const upgraded = upgrade(request, privileged);
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
      const {
        port,
        hostname,
        wsHandler,
        authToken,
        authenticate,
        allowedOrigins = [],
        idleTimeout,
      } = options;

      if (wsHandler) {
        const handler = wsHandler;
        const server = Bun.serve<GatewayWebSocketData>({
          port,
          hostname,
          // Wire the idle timeout so long-lived SSE connections and parked
          // human-in-the-loop workflows are not silently dropped. The heartbeat
          // must fire before this threshold; see DEFAULT_HEARTBEAT_INTERVAL_MS
          // in live-events.ts.
          idleTimeout,
          async fetch(request, server) {
            const url = new URL(request.url);

            if (url.pathname === '/ws') {
              const result = await handleWsUpgrade(
                request,
                url,
                // AB-305: `privileged` is attached to the socket's own
                // `data` at upgrade time (Bun's mechanism for carrying
                // per-connection state from the HTTP upgrade into the
                // `websocket` handlers below) so `handler.open` can mark
                // the resulting `LiveFrameBroker` subscriber's privilege
                // without re-deriving it from the request a second time.
                (r, privileged) => server.upgrade(r, { data: { privileged } }),
                {
                  authToken,
                  authenticate,
                  allowedOrigins,
                },
              );
              // When upgrade succeeds, handleWsUpgrade returns undefined.
              // Bun's fetch signature requires Response | undefined here.
              return result;
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
          port: server.port ?? port,
          stop() {
            return server.stop();
          },
          forceClose() {
            // AB-235: escalates the already-in-flight `stop()` above by
            // force-closing any connections still open. Bun resolves the
            // original `stop()` promise once this completes — there is
            // only ever one underlying stop operation per server.
            void server.stop(true);
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
        port: server.port ?? port,
        stop() {
          return server.stop();
        },
        forceClose() {
          void server.stop(true);
        },
      };
    },
  };
}
