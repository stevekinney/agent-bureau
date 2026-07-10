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
import { DEFAULT_PORT, SCOPE } from './types';
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
 * Builds a WebSocket authentication verifier that mirrors the HTTP
 * `createAuthentication` middleware precedence:
 * 1. Managed `ab_live_` keys verified via `ApiKeyStore.verify`.
 *    The key must carry the `runs:read` scope — matching the scope
 *    guard on the HTTP `/api/v1/events` route — so that a key
 *    scoped only for `keys:manage` or `runs:write` cannot subscribe
 *    to live run frames.
 *    Keys with an empty scopes list are treated as admin and pass.
 * 2. Static token comparison. The static `authToken` acts as an
 *    unrestricted admin credential with no scope requirements.
 * 3. Pass-through when no auth is configured (returns `undefined`).
 *
 * This function is exported for direct unit testing. It is injected
 * into the server adapter so the `/ws` upgrade path enforces the same
 * auth + scope rules as the HTTP `/api/v1/events` route without
 * duplicating the logic.
 */
export function buildWsAuthenticate(
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
      if (key) {
        // Admin keys (empty scopes array) pass all checks.
        // Scoped keys must carry runs:read to subscribe to live frames.
        const isAdmin = key.scopes.length === 0;
        return isAdmin || key.scopes.includes(SCOPE.RUNS_READ);
      }
    }

    if (authToken && token === authToken) return true;

    return false;
  };
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
  // AB-15: drop a run's replay buffer once the run itself is deleted from
  // the bureau — nothing can reconnect to replay for a run that no longer
  // exists, so there is no reason to keep holding its frames.
  const clearRunBufferOnRemoval: Parameters<typeof bureau.addEventListener<'run.removed'>>[1] = (
    event,
  ) => {
    liveFrameBroker.clearRunBuffer(event.runId);
  };
  bureau.addEventListener('run.removed', clearRunBufferOnRemoval);

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
  app.route('/', createRoutes({ bureau, broker: liveFrameBroker, apiKeyStore, a2a: options.a2a }));

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
      evaluationReportsDirectory: options.evaluationReportsDirectory,
    }),
  );

  // Serve static files
  await adapter.mountStaticFiles(app, '/public/', 'dist/');

  // Global error handler
  app.onError(errorHandler);

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
        bureau.removeEventListener('run.removed', clearRunBufferOnRemoval);
      },
    };
  }

  return { app, bureau, store: bureau.store, port, start };
}
