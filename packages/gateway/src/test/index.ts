import { waitForCondition, waitForRunState } from '@lostgradient/operative/test';
import type { Bureau, BureauOptions } from 'bureau';
import { createBureau } from 'bureau';

import { createGateway } from '../create-gateway';
import { createApiKeyStore } from '../keys/create-api-key-store';
import type { ApiKey, CreateApiKeyOptions } from '../keys/types';
import type { LiveFrameBrokerClock } from '../live-events';
import {
  gatewayAuthorizationRevisionForApiKey,
  gatewayCapabilitiesForScopes,
} from '../middleware/authentication';
import type { Gateway, GatewayOptions } from '../types';

export { waitForCondition, waitForRunState };

export const gatewayAuthorityTestScopes = ['runs:write', 'hooks:write'] as const;

/**
 * A fully manual {@link LiveFrameBrokerClock} — no real timers, no real
 * sleeps (AB-219's testing plan). Drives both `LiveFrameBroker`'s SSE
 * heartbeat `setInterval` and every connection's `createStallWatchdog`
 * `setTimeout`, sharing the same monotonic `now()` so cadence math and the
 * heartbeat that feeds it stay consistent under `advance()`.
 */
export function createManualLiveFrameBrokerClock(): LiveFrameBrokerClock & {
  advance(ms: number): void;
  pendingTimerCount(): number;
} {
  let time = 0;
  let nextHandle = 1;
  const timeouts = new Map<number, { at: number; callback: () => void }>();
  const intervals = new Map<number, { everyMs: number; nextAt: number; callback: () => void }>();

  return {
    now: () => time,
    setTimeout(callback, ms) {
      const handle = nextHandle++;
      timeouts.set(handle, { at: time + ms, callback });
      return handle;
    },
    clearTimeout(handle) {
      timeouts.delete(handle as number);
    },
    setInterval(callback, ms) {
      const handle = nextHandle++;
      intervals.set(handle, { everyMs: ms, nextAt: time + ms, callback });
      return handle;
    },
    clearInterval(handle) {
      intervals.delete(handle as number);
    },
    advance(ms: number) {
      const deadline = time + ms;
      // Fire every timeout/interval tick due by `deadline`, in due-time
      // order — a fired callback may itself schedule a new timeout (the
      // watchdog's own re-arm loop) or the next interval tick, so re-scan
      // until nothing more is due.
      for (;;) {
        let next: { kind: 'timeout' | 'interval'; handle: number; at: number } | undefined;
        for (const [handle, timeout] of timeouts.entries()) {
          if (timeout.at <= deadline && (!next || timeout.at < next.at)) {
            next = { kind: 'timeout', handle, at: timeout.at };
          }
        }
        for (const [handle, interval] of intervals.entries()) {
          if (interval.nextAt <= deadline && (!next || interval.nextAt < next.at)) {
            next = { kind: 'interval', handle, at: interval.nextAt };
          }
        }

        if (!next) break;

        time = next.at;
        if (next.kind === 'timeout') {
          const timeout = timeouts.get(next.handle);
          timeouts.delete(next.handle);
          timeout?.callback();
        } else {
          const interval = intervals.get(next.handle);
          if (interval) {
            interval.nextAt += interval.everyMs;
            interval.callback();
          }
        }
      }

      time = deadline;
    },
    pendingTimerCount: () => timeouts.size + intervals.size,
  };
}

export function attackerRequestContextFixture() {
  return {
    authority: {
      principalId: 'attacker',
      tenantId: 'attacker-tenant',
      ownerId: 'attacker-owner',
      capabilities: ['admin'],
      authorizationRevision: 'attacker:1',
    },
    audience: 'operator',
  };
}

export function expectedPersistedApiKeyAuthority(
  key: Pick<ApiKey, 'id' | 'scopes'>,
  ownerId: string,
) {
  return {
    agentId: ownerId,
    principalId: `api-key:${key.id}`,
    tenantId: 'bureau',
    ownerId,
    capabilities: gatewayCapabilitiesForScopes(key.scopes),
    authorizationRevision: gatewayAuthorizationRevisionForApiKey(key.id),
    audience: 'operator',
  };
}

export async function createGatewayAuthorityTestApiKey(
  gateway: Gateway,
  options: CreateApiKeyOptions = {
    name: 'authority-test-key',
    scopes: [...gatewayAuthorityTestScopes],
  },
) {
  if (!gateway.bureau.kv) {
    throw new Error('Authority regression tests require a gateway with a KV-backed bureau');
  }
  return createApiKeyStore(gateway.bureau.kv).create(options);
}

/**
 * Combined options for `createTestGateway`. Merges bureau-level configuration
 * with door-level configuration so tests can express their full setup in one
 * place, without manually constructing a bureau first.
 *
 * This type exists ONLY in the test helper — production callers of
 * `createGateway` must construct the bureau themselves.
 *
 * `agents` is optional here (unlike `BureauOptions` itself, where AB-22
 * requires it) — most gateway tests exercise `createRun`/session-based
 * dispatch and have no use for the typed catalog; `createTestGateway`
 * defaults it to `{}` when omitted.
 */
export type TestGatewayOptions = Omit<BureauOptions, 'agents'> &
  Partial<Pick<BureauOptions, 'agents'>> &
  GatewayOptions;

/** Type guard: is this a pre-built Bureau (vs. a plain options object)? */
function isBureau(value: Bureau | TestGatewayOptions): value is Bureau {
  return (
    'store' in value &&
    'ready' in value &&
    'dispose' in value &&
    typeof value.dispose === 'function'
  );
}

/**
 * Creates a gateway for testing. Accepts an optional bureau (if you have a
 * pre-built brain) or combined bureau+door options. Uses `app.request()` for
 * HTTP assertions without starting a real server.
 *
 * Three forms:
 *   createTestGateway()                    → default bureau, no door config
 *   createTestGateway(options)             → bureau created from options, door config from options
 *   createTestGateway(bureau, options?)    → pre-built bureau, door config from options
 */
export async function createTestGateway(): Promise<Gateway>;
export async function createTestGateway(options: TestGatewayOptions): Promise<Gateway>;
export async function createTestGateway(bureau: Bureau, options?: GatewayOptions): Promise<Gateway>;
export async function createTestGateway(
  bureauOrOptions?: Bureau | TestGatewayOptions,
  doorOptions?: GatewayOptions,
): Promise<Gateway> {
  if (!bureauOrOptions) {
    const bureau = await createBureau({ agents: {} });
    return createGateway(bureau);
  }

  if (isBureau(bureauOrOptions)) {
    return createGateway(bureauOrOptions, doorOptions ?? {});
  }

  // Treat as combined TestGatewayOptions: extract every door-specific field
  // (all of GatewayOptions) and pass the rest to createBureau. This must
  // enumerate every GatewayOptions key — an allowlist that silently dropped
  // new fields (e.g. evaluationReportsDirectory) would leak them into
  // bureauOptions, where createBureau ignores unknown keys and the option
  // has no effect.
  const {
    port,
    hostname,
    authToken,
    runtime,
    allowedOrigins,
    enableCsp,
    idleTimeout,
    evaluationReportsDirectory,
    a2a,
    ...bureauOptions
  } = bureauOrOptions;

  const bureau = await createBureau({ agents: {}, ...bureauOptions });
  return createGateway(bureau, {
    port,
    hostname,
    authToken,
    runtime,
    allowedOrigins,
    enableCsp,
    idleTimeout,
    evaluationReportsDirectory,
    a2a,
  });
}

/**
 * Sends a JSON request to a test gateway and returns the response.
 */
export async function requestJSON(
  gateway: Gateway,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return gateway.app.request(path, { ...init, headers });
}
