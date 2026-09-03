import type { ToolRequestContext } from 'armorer';
import type { Bureau } from 'bureau';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { RuntimeServices } from 'lifecycle';
import { createDefaultRuntimeServices } from 'lifecycle';

import type { ServerAdapter } from './adapters/types';
import { bootstrapApiKey, createApiKeyStore } from './keys';
import type { ApiKeyStore } from './keys/types';
import type { LiveFrameBrokerClock } from './live-events';
import { LiveFrameBroker } from './live-events';
import {
  createAuthentication,
  createRateLimiter,
  createRequestIdentifier,
  createSecurityHeaders,
  errorHandler,
} from './middleware';
import {
  gatewayAuthorizationRevisionForApiKey,
  gatewayCapabilitiesForScopes,
  staticTokenAuthorizationRevision,
} from './middleware/authentication';
import { createRoutes } from './routes';
import { createHookIdempotencyRegistry } from './routes/hooks';
import { createPages } from './server/pages';
import type { Gateway, GatewayOptions, GatewayShutdownReport } from './types';
import { DEFAULT_PORT, SCOPE } from './types';
import { createWebSocketHandler } from './websocket';

/**
 * AB-235 default drain timeout: how long `stop()` waits for open
 * connections to close on their own before force-closing whatever
 * remains. Ten seconds sits comfortably inside a typical deployment
 * platform's shutdown grace period (commonly 30 s) while still giving an
 * in-flight request or a parked SSE/WebSocket client a real chance to
 * finish cleanly.
 */
export const DEFAULT_GATEWAY_DRAIN_TIMEOUT_MS = 10_000;

/**
 * The largest delay `setTimeout`/`setInterval` accept as a 32-bit signed
 * integer of milliseconds (both Bun and Node). A delay above this is
 * silently clamped to 1 ms rather than rejected, which would force-close
 * connections almost immediately instead of honoring a caller's much
 * longer requested drain — the opposite of what `drainTimeoutMs` promises.
 */
const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;

/**
 * Validates `shutdown.drainTimeoutMs` as a positive integer within the
 * runtime timer's representable range, defaulting to
 * {@link DEFAULT_GATEWAY_DRAIN_TIMEOUT_MS} when omitted. Throws eagerly
 * (at `createGateway()` call time, not lazily inside `stop()`) so a
 * misconfigured value fails fast during startup.
 */
function validateDrainTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_GATEWAY_DRAIN_TIMEOUT_MS;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_SAFE_TIMEOUT_MS) {
    throw new Error(
      `shutdown.drainTimeoutMs must be a positive integer no greater than ${MAX_SAFE_TIMEOUT_MS} ` +
        `(the runtime timer's representable range), received ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * Dependencies {@link createGateway} injects for the AB-235 shutdown-drain
 * race, mirroring AB-209's `loadServe`-style injection pattern
 * (`node-adapter.ts`'s `CreateNodeAdapterDependencies`). `setTimeoutFn`/
 * `clearTimeoutFn` default to the resolved `RuntimeServices.timers` (AB-303)
 * — the real globals when `options.runtime` is omitted — and the adapter
 * resolver defaults to the real dynamic-import resolver; tests override
 * either to exercise the drain timeout and force-close path
 * deterministically, without waiting in real time or standing up a real
 * Bun/Node server.
 */
export interface CreateGatewayDependencies {
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  resolveAdapterFn?: (serverRuntime: 'bun' | 'node') => Promise<ServerAdapter>;
}

/**
 * Races an in-flight server-stop promise against a drain timeout.
 * Resolves `true` when `stopping` settles (fulfilled or rejected) before
 * the timeout — a clean drain — and `false` when the timeout elapses
 * first. Never rejects on its own: a `stopping` rejection is treated as
 * "settled" here so the race resolves, and the caller's own separate
 * `await stopping` is what surfaces the actual error.
 *
 * Extracted as a standalone, dependency-injected function (rather than
 * inlined in `stop()`) so the AB-235 drain-timeout behavior is directly
 * unit-testable without waiting in real time — tests inject
 * `setTimeoutFn`/`clearTimeoutFn` and fire the timeout callback
 * themselves. `createGateway` always supplies both (from its resolved
 * `RuntimeServices.timers`), so the `setTimeout`/`clearTimeout` global
 * defaults below exist only for direct unit tests of this function.
 */
export async function raceDrainTimeout(
  stopping: Promise<unknown>,
  drainTimeoutMs: number,
  dependencies: Pick<CreateGatewayDependencies, 'setTimeoutFn' | 'clearTimeoutFn'> = {},
): Promise<boolean> {
  const {
    setTimeoutFn = (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeoutFn = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = dependencies;
  let timer: unknown;
  const timedOut = new Promise<'timed-out'>((resolve) => {
    timer = setTimeoutFn(() => resolve('timed-out'), drainTimeoutMs);
  });
  const settled = stopping.then(
    () => 'settled' as const,
    () => 'settled' as const,
  );
  const result = await Promise.race([settled, timedOut]);
  if (timer !== undefined) clearTimeoutFn(timer);
  return result === 'settled';
}

type RequestAuthorityValidator = (context: ToolRequestContext) => boolean | Promise<boolean>;
type BureauRequestAuthorityValidatorAccess = {
  readonly getRequestAuthorityValidator?: () => RequestAuthorityValidator | undefined;
  readonly waitForRecovery?: () => Promise<void>;
};

const gatewayValidatorState = new WeakMap<
  object,
  {
    readonly hostValidator: RequestAuthorityValidator | undefined;
    readonly gatewayValidators: Set<RequestAuthorityValidator>;
    installedValidator: RequestAuthorityValidator | undefined;
  }
>();
const STATIC_TOKEN_REVISION_SECRET_KEY = 'gateway:private:static-token-revision-secret';

async function resolveStaticTokenRevisionSecret(
  store: Bureau['kv'],
  identifiers: RuntimeServices['identifiers'],
): Promise<string | undefined> {
  if (!store) return undefined;
  const persisted = await store.get(STATIC_TOKEN_REVISION_SECRET_KEY);
  if (persisted) return persisted;

  const candidate = identifiers.next('gateway-static-token-revision-secret');
  const created = await store.conditionalBatch(
    [{ key: STATIC_TOKEN_REVISION_SECRET_KEY, expectedValue: null }],
    [{ type: 'set', key: STATIC_TOKEN_REVISION_SECRET_KEY, value: candidate }],
  );
  if (created) return candidate;

  const winner = await store.get(STATIC_TOKEN_REVISION_SECRET_KEY);
  if (winner) return winner;
  throw new Error('Static-token revision secret initialization lost without a persisted winner.');
}

/**
 * Detects the current server runtime. Returns `'bun'` when running
 * inside the Bun runtime, `'node'` otherwise.
 */
function detectServerRuntime(): 'bun' | 'node' {
  return typeof Bun !== 'undefined' ? 'bun' : 'node';
}

/**
 * Resolves a ServerAdapter for the given server-runtime string.
 * Uses dynamic imports so that the unused adapter is never
 * pulled into the bundle.
 */
async function resolveAdapter(serverRuntime: 'bun' | 'node'): Promise<ServerAdapter> {
  if (serverRuntime === 'bun') {
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

export function buildRequestAuthorityValidator(
  authToken: string | undefined,
  store: ApiKeyStore | undefined,
  staticTokenRevisionSecret?: string,
  now: () => number = Date.now,
): ((context: ToolRequestContext) => Promise<boolean>) | undefined {
  if (!authToken && !store) return undefined;

  return async (context) => {
    const { authority } = context;
    if (authority.principalId === 'static-token') {
      return (
        authToken !== undefined &&
        authority.authorizationRevision ===
          staticTokenAuthorizationRevision(authToken, staticTokenRevisionSecret) &&
        authority.capabilities.length === 1 &&
        authority.capabilities[0] === '*'
      );
    }
    if (!authority.principalId.startsWith('api-key:') || !store) return false;

    const keyId = authority.principalId.slice('api-key:'.length);
    const keys = await store.list();
    const key = keys.find((candidate) => candidate.id === keyId);
    if (!key?.active) return false;
    if (key.expiresAt !== undefined && Date.parse(key.expiresAt) <= now()) return false;
    if (authority.authorizationRevision !== gatewayAuthorizationRevisionForApiKey(key.id)) {
      return false;
    }

    const currentCapabilities = [...gatewayCapabilitiesForScopes(key.scopes)].sort();
    const capturedCapabilities = [...authority.capabilities].sort();
    return (
      currentCapabilities.length === capturedCapabilities.length &&
      currentCapabilities.every((capability, index) => capability === capturedCapabilities[index])
    );
  };
}

function composeRequestAuthorityValidators(
  hostValidator: RequestAuthorityValidator | undefined,
  gatewayValidators: ReadonlySet<RequestAuthorityValidator>,
): RequestAuthorityValidator | undefined {
  if (gatewayValidators.size === 0) return hostValidator;

  return async (context) => {
    const isGatewayAuthority = context.authority.authorizationRevision.startsWith('gateway:');
    if (!isGatewayAuthority) return hostValidator ? hostValidator(context) : false;
    for (const gatewayValidator of gatewayValidators) {
      if (await gatewayValidator(context)) return true;
    }
    return false;
  };
}

/**
 * Creates a new Gateway (HTTP door) over an already-constructed Bureau (brain).
 *
 * The bureau is the first argument — it owns all agent/run/session logic.
 * The options object is door-only: port, hostname, authToken, serverRuntime,
 * runtime (AB-303's `RuntimeServices` seam). Gateway depends only on
 * `bureau` and exposes the bureau's surface over HTTP transport
 * (run/session verbs → routes; AgentRun stream → WebSocket).
 *
 * This function is async because it resolves the server adapter (dynamic import)
 * and bootstraps the API key store against the bureau's KV backend.
 */
export async function createGateway(
  bureau: Bureau,
  options: GatewayOptions = {},
  dependencies: CreateGatewayDependencies = {},
): Promise<Gateway> {
  const drainTimeoutMs = validateDrainTimeoutMs(options.shutdown?.drainTimeoutMs);
  const port = options.port ?? DEFAULT_PORT;
  const serverRuntime = options.serverRuntime ?? detectServerRuntime();
  // AB-303: resolved exactly once, here, and forwarded as the same single
  // instance to everything below that reads current time, a monotonic
  // timer, or mints an identifier — never re-read from `options.runtime`
  // and never a process global directly beyond this point.
  const runtimeServices: RuntimeServices = options.runtime ?? createDefaultRuntimeServices();
  const adapter = await (dependencies.resolveAdapterFn ?? resolveAdapter)(serverRuntime);
  const liveFrameBrokerClock: LiveFrameBrokerClock = {
    now: runtimeServices.monotonic.now,
    nowISO: runtimeServices.clock.nowISO,
    setTimeout: runtimeServices.timers.setTimeout,
    clearTimeout: runtimeServices.timers.clearTimeout,
    setInterval: runtimeServices.timers.setInterval,
    clearInterval: runtimeServices.timers.clearInterval,
  };
  const liveFrameBroker = new LiveFrameBroker({ clock: liveFrameBrokerClock });
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
    apiKeyStore = createApiKeyStore(bureau.kv, runtimeServices.clock);
    await bootstrapApiKey(apiKeyStore);
  }
  const staticTokenRevisionSecret = await resolveStaticTokenRevisionSecret(
    bureau.kv,
    runtimeServices.identifiers,
  );
  const authorityValidatorAccess = bureau as Bureau & BureauRequestAuthorityValidatorAccess;
  const existingValidator = authorityValidatorAccess.getRequestAuthorityValidator?.();
  const previousGatewayValidator = gatewayValidatorState.get(bureau);
  const retainedState =
    previousGatewayValidator !== undefined &&
    previousGatewayValidator.installedValidator === existingValidator
      ? previousGatewayValidator
      : {
          hostValidator: existingValidator,
          gatewayValidators: new Set<RequestAuthorityValidator>(),
          installedValidator: existingValidator,
        };
  const gatewayRequestAuthorityValidator = buildRequestAuthorityValidator(
    options.authToken,
    apiKeyStore,
    staticTokenRevisionSecret,
    runtimeServices.clock.now,
  );
  if (gatewayRequestAuthorityValidator) {
    retainedState.gatewayValidators.add(gatewayRequestAuthorityValidator);
  }
  const requestAuthorityValidator = composeRequestAuthorityValidators(
    retainedState.hostValidator,
    retainedState.gatewayValidators,
  );
  retainedState.installedValidator = requestAuthorityValidator;
  if (requestAuthorityValidator !== existingValidator) {
    bureau.setRequestAuthorityValidator(requestAuthorityValidator);
  }
  gatewayValidatorState.set(bureau, retainedState);
  await authorityValidatorAccess.waitForRecovery?.();

  const app = new Hono();
  const hookIdempotencyRegistry = createHookIdempotencyRegistry();

  // Global middleware
  app.use('*', cors());
  app.use('*', createRequestIdentifier(runtimeServices.identifiers));
  app.use('*', createAuthentication(options.authToken, apiKeyStore, staticTokenRevisionSecret));
  app.use(
    '*',
    createRateLimiter({
      store: bureau.kv,
      now: runtimeServices.clock.now,
      hasHookIdempotencyReceipt: (principal, idempotencyKey) =>
        hookIdempotencyRegistry.has(principal, idempotencyKey),
    }),
  );
  app.use(
    '*',
    createSecurityHeaders({
      allowedOrigins: options.allowedOrigins,
      enableCsp: options.enableCsp,
    }),
  );

  // Mount API routes
  app.route(
    '/',
    createRoutes({
      bureau,
      broker: liveFrameBroker,
      apiKeyStore,
      a2a: options.a2a,
      hookIdempotencyRegistry,
    }),
  );

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
      port: handle.port,
      async stop(): Promise<GatewayShutdownReport> {
        // Start the server's own drain (stops accepting new connections,
        // then waits for in-flight requests/WebSocket connections to close)
        // before running the rest of teardown, rather than after — cleanup
        // that doesn't depend on the listener being fully drained shouldn't
        // be serialized behind it.
        const stopping = handle.stop();
        // AB-235 (AB-37: drain rather than abandon): tell every open
        // WebSocket and SSE stream to close through the existing subscriber
        // registry, so they start winding down in parallel with the
        // adapter's own drain instead of only after it times out.
        liveFrameBroker.closeAll();
        wsHandler.dispose();
        unsubscribeLiveFrames();
        bureau.removeEventListener('run.removed', clearRunBufferOnRemoval);
        if (gatewayRequestAuthorityValidator) {
          retainedState.gatewayValidators.delete(gatewayRequestAuthorityValidator);
          if (
            authorityValidatorAccess.getRequestAuthorityValidator?.() ===
            retainedState.installedValidator
          ) {
            const replacementValidator = composeRequestAuthorityValidators(
              retainedState.hostValidator,
              retainedState.gatewayValidators,
            );
            retainedState.installedValidator = replacementValidator;
            bureau.setRequestAuthorityValidator(replacementValidator);
          }
        }

        const drained = await raceDrainTimeout(stopping, drainTimeoutMs, {
          setTimeoutFn: dependencies.setTimeoutFn ?? runtimeServices.timers.setTimeout,
          clearTimeoutFn: dependencies.clearTimeoutFn ?? runtimeServices.timers.clearTimeout,
        });
        if (!drained) {
          // AB-235 escalation: the drain timeout elapsed with the adapter's
          // own stop() still pending — force-close whatever connections are
          // still open rather than holding the process past its deployment
          // grace period. `subscriberCount` is read now, before forcing,
          // so it reports how many connections were still open at the
          // moment we had to force them rather than however many remain
          // after.
          const forcedConnections = liveFrameBroker.subscriberCount;
          handle.forceClose();
          await stopping;
          return { drained: false, forcedConnections };
        }

        await stopping;
        return { drained: true, forcedConnections: 0 };
      },
    };
  }

  return { app, bureau, store: bureau.store, port, start };
}
