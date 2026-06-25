import type { Bureau } from 'bureau';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { ServerAdapter } from './adapters/types';
import { bootstrapApiKey, createApiKeyStore } from './keys';
import type { ApiKeyStore } from './keys/types';
import { LiveFrameBroker } from './live-events';
import {
  createAuthentication,
  createRateLimiter,
  createSecurityHeaders,
  errorHandler,
  requestIdentifier,
} from './middleware';
import { createRoutes } from './routes';
import { createPages } from './server/pages';
import type { Gateway, GatewayOptions } from './types';
import { DEFAULT_PORT } from './types';
import { createWebSocketHandler } from './websocket';

/**
 * Detects the current server runtime. Returns `'bun'` when running
 * inside the Bun runtime, `'node'` otherwise.
 */
function detectRuntime(): 'bun' | 'node' {
  return typeof Bun !== 'undefined' ? 'bun' : 'node';
}

/**
 * Resolves a ServerAdapter for the given runtime string.
 * Uses dynamic imports so that the unused adapter is never
 * pulled into the bundle.
 */
async function resolveAdapter(runtime: 'bun' | 'node'): Promise<ServerAdapter> {
  if (runtime === 'bun') {
    const { createBunAdapter } = await import('./adapters/bun-adapter');
    return createBunAdapter();
  }
  const { createNodeAdapter } = await import('./adapters/node-adapter');
  return createNodeAdapter();
}

/**
 * Creates a new Gateway (HTTP door) over an already-constructed Bureau (brain).
 *
 * The bureau is the first argument — it owns all agent/run/session logic.
 * The options object is door-only: port, hostname, authToken, runtime.
 * Gateway depends only on `bureau` and exposes the bureau's surface over
 * HTTP transport (run/session verbs → routes; AgentRun stream → WebSocket).
 *
 * This function is async because it resolves the server adapter (dynamic import)
 * and bootstraps the API key store against the bureau's KV backend.
 */
export async function createGateway(
  bureau: Bureau,
  options: GatewayOptions = {},
): Promise<Gateway> {
  const port = options.port ?? DEFAULT_PORT;
  const runtime = options.runtime ?? detectRuntime();
  const adapter = await resolveAdapter(runtime);
  const liveFrameBroker = new LiveFrameBroker();
  const unsubscribeLiveFrames = bureau.subscribeLiveFrames((frame) => {
    liveFrameBroker.broadcast(frame);
  });

  // ── API Key Store ───────────────────────────────────────────────
  // Reuse the bureau's KV store to avoid creating a duplicate backend.
  let apiKeyStore: ApiKeyStore | undefined;

  if (bureau.kv) {
    apiKeyStore = createApiKeyStore(bureau.kv);
    await bootstrapApiKey(apiKeyStore);
  }

  const app = new Hono();

  // Global middleware
  app.use('*', cors());
  app.use('*', requestIdentifier);
  app.use('*', createAuthentication(options.authToken, apiKeyStore));
  app.use('*', createRateLimiter({ store: bureau.kv }));
  app.use(
    '*',
    createSecurityHeaders({
      allowedOrigins: options.allowedOrigins,
      enableCsp: options.enableCsp,
    }),
  );

  // Mount API routes
  app.route('/', createRoutes({ bureau, broker: liveFrameBroker, apiKeyStore }));

  // Mount SSR pages — configuration (including systemPrompt) is read from
  // bureau.getConfiguration() so the door does not need to duplicate brain config.
  const configuration = bureau.getConfiguration();
  app.route(
    '/',
    createPages({
      bureau,
      provider: configuration.provider,
      maximumSteps: configuration.maximumSteps,
      systemPrompt: configuration.systemPrompt,
    }),
  );

  // Serve static files
  await adapter.mountStaticFiles(app, '/public/', 'dist/');

  // Global error handler
  app.onError(errorHandler);

  /**
   * Builds a WebSocket authentication verifier that mirrors the HTTP
   * `createAuthentication` middleware precedence:
   * 1. Managed `ab_live_` keys verified via `ApiKeyStore.verify`.
   * 2. Static token comparison.
   * 3. Pass-through when no auth is configured.
   *
   * This function is injected into the adapter so the `/ws` upgrade
   * path uses the same logic as the HTTP path without duplicating it.
   */
  function buildWsAuthenticate(
    authToken: string | undefined,
    store: ApiKeyStore | undefined,
  ): ((request: Request) => Promise<boolean>) | undefined {
    if (!authToken && !store) return undefined;

    return async (request: Request): Promise<boolean> => {
      const authHeader = request.headers.get('authorization') ?? '';
      const headerToken = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : undefined;
      const url = new URL(request.url);
      const queryToken = url.searchParams.get('token') ?? undefined;
      const token = headerToken ?? queryToken;

      if (!token) return false;

      if (store && token.startsWith('ab_live_')) {
        const key = await store.verify(token);
        if (key) return true;
      }

      if (authToken && token === authToken) return true;

      return false;
    };
  }

  async function start() {
    const wsHandler = createWebSocketHandler({ broker: liveFrameBroker });

    const handle = await adapter.serve(app, {
      port,
      hostname: options.hostname,
      wsHandler,
      authToken: options.authToken,
      authenticate: buildWsAuthenticate(options.authToken, apiKeyStore),
      allowedOrigins: options.allowedOrigins,
      idleTimeout: options.idleTimeout,
    });

    return {
      stop() {
        handle.stop();
        wsHandler.dispose();
        unsubscribeLiveFrames();
      },
    };
  }

  return { app, bureau, store: bureau.store, port, start };
}
