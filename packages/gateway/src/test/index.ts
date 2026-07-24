import { waitForCondition, waitForRunState } from '@lostgradient/operative/test';
import type { Bureau, BureauOptions } from 'bureau';
import { createBureau } from 'bureau';

import { createGateway } from '../create-gateway';
import type { Gateway, GatewayOptions } from '../types';

export { waitForCondition, waitForRunState };

/**
 * Combined options for `createTestGateway`. Merges bureau-level configuration
 * with door-level configuration so tests can express their full setup in one
 * place, without manually constructing a bureau first.
 *
 * This type exists ONLY in the test helper — production callers of
 * `createGateway` must construct the bureau themselves.
 */
export type TestGatewayOptions = BureauOptions & GatewayOptions;

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
    const bureau = await createBureau();
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

  const bureau = await createBureau(bureauOptions);
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
