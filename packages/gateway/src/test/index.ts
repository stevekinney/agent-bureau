import { createGateway } from '../create-gateway';
import type { Gateway, GatewayOptions } from '../types';

/**
 * Creates a gateway for testing. Uses app.request() for HTTP assertions
 * without starting a real server.
 */
export function createTestGateway(options: GatewayOptions = {}): Gateway {
  return createGateway(options);
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
