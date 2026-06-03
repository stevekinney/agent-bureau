import { createGateway } from '../create-gateway';
import type { Bureau, Gateway, GatewayOptions, RunDetail } from '../types';

/**
 * Creates a gateway for testing. Uses app.request() for HTTP assertions
 * without starting a real server.
 */
export async function createTestGateway(options: GatewayOptions = {}): Promise<Gateway> {
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

export async function drainMicrotasks(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

export function yieldEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  failureMessage: string,
  maximumAttempts = 50,
  yieldTurn: () => Promise<void> = yieldEventLoopTurn,
): Promise<void> {
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    if (await condition()) {
      return;
    }
    await yieldTurn();
  }

  throw new Error(failureMessage);
}

export async function waitForRunState(
  bureau: Bureau,
  runId: string,
  predicate: (run: RunDetail) => boolean = (run) => run.status !== 'running',
): Promise<RunDetail> {
  let matchingRun: RunDetail | undefined;
  await waitForCondition(() => {
    const run = bureau.getRun(runId);
    if (run && predicate(run)) {
      matchingRun = run;
      return true;
    }
    return false;
  }, `Run ${runId} did not reach the expected state`);

  return matchingRun!;
}
