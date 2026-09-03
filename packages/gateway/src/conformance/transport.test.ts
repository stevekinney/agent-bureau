/**
 * Real Gateway transport conformance (AB-98's tst-07a / AB-272).
 *
 * Every scenario in this file drives a real Bun HTTP, SSE, and WebSocket
 * server through `startLoopbackGateway` (`../test/loopback`) — real
 * `fetch`, a real SSE reader over a real response-body stream, and a real
 * `WebSocket`. AB-92's real-runtime conformance tier: this proves the
 * public wire contract holds over an actual socket, never general
 * lifecycle correctness (that is `bureau/test/harness.test.ts`'s tier).
 *
 * No test here assigns to `globalThis.fetch`, `globalThis.WebSocket`, or
 * `globalThis.EventSource` — the "no global patching" grep test at the
 * bottom of this file is itself part of the suite, not a review
 * convention.
 */
import { readdir, readFile } from 'node:fs/promises';

import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import type { LoopbackGateway } from '../test/loopback';
import { LoopbackTransportUnsupportedError, startLoopbackGateway } from '../test/loopback';
import { SCOPE } from '../types';

function immediateGenerate(content = 'ok') {
  return async () => ({ content, toolCalls: [] });
}

/** Never resolves on its own — only when the run's abort signal fires. */
function blockingGenerate() {
  return (context: { signal?: AbortSignal }) =>
    new Promise<{ content: string; toolCalls: never[] }>((resolve) => {
      context.signal?.addEventListener(
        'abort',
        () => resolve({ content: 'aborted', toolCalls: [] }),
        { once: true },
      );
    });
}

async function withGateway<T>(
  build: () => Promise<LoopbackGateway>,
  use: (gateway: LoopbackGateway) => Promise<T>,
): Promise<T> {
  const gateway = await build();
  try {
    return await use(gateway);
  } finally {
    await gateway.stop();
  }
}

function authHeader(gateway: LoopbackGateway): { authorization: string } {
  return { authorization: `Bearer ${gateway.authToken}` };
}

async function createScopedKey(gateway: LoopbackGateway, scopes: string[]): Promise<string> {
  const response = await gateway.fetch('/api/v1/keys', {
    method: 'POST',
    headers: { ...authHeader(gateway), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'scoped-test-key', scopes }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { plaintext: string };
  return body.plaintext;
}

describe('Gateway transport conformance — Bun runtime', () => {
  it('rejects an unauthenticated request', async () => {
    await withGateway(
      () =>
        startLoopbackGateway({
          agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
          generate: immediateGenerate(),
        }),
      async (gateway) => {
        const response = await gateway.fetch('/api/v1/runs');
        expect(response.status).toBe(401);
      },
    );
  });

  it('rejects an authenticated request with insufficient scope', async () => {
    await withGateway(
      () =>
        startLoopbackGateway({
          agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
          generate: immediateGenerate(),
        }),
      async (gateway) => {
        // A key scoped only for runs:read cannot POST /api/v1/runs, which
        // requires runs:write.
        const token = await createScopedKey(gateway, [SCOPE.RUNS_READ]);

        const response = await gateway.fetch('/api/v1/runs', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hello', agentName: 'echo' }),
        });
        expect(response.status).toBe(403);
      },
    );
  });

  it('rejects a WebSocket upgrade from a disallowed origin', async () => {
    await withGateway(
      () =>
        startLoopbackGateway({
          agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
          generate: immediateGenerate(),
          allowedOrigins: ['https://allowed.example'],
        }),
      async (gateway) => {
        let rejected = false;
        try {
          const socket = new BunWebSocketWithHeaders(
            `${gateway.url.replace('http', 'ws')}/ws?token=${gateway.authToken}`,
            { headers: { origin: 'https://attacker.example' } },
          );
          await new Promise<void>((resolve, reject) => {
            socket.addEventListener('open', () => resolve(), { once: true });
            socket.addEventListener('error', () => reject(new Error('rejected')), { once: true });
            socket.addEventListener('close', () => reject(new Error('rejected')), { once: true });
          });
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
      },
    );
  });

  it('redacts a sensitive field from a delivered response rather than either leaking it or silently dropping the field', async () => {
    const secretApiKey = 'sk-real-secret-do-not-leak-1234567890';
    await withGateway(
      () =>
        startLoopbackGateway({
          agents: {},
          generate: immediateGenerate(),
          // `GET /api/v1/configuration` is the gateway's own wire contract
          // for this: `bureau.getConfiguration()` runs every configured
          // `provider` through `redactProvider` (`runtime-composition.ts`),
          // which strips `apiKey` before the value ever reaches this
          // response — the field is redacted at the gateway/bureau
          // boundary, not by an operative-level guardrail (which is a
          // model-output concern the "redacted field" acceptance criterion
          // does not name).
          provider: { provider: 'anthropic', model: 'claude-x', apiKey: secretApiKey },
        }),
      async (gateway) => {
        const response = await gateway.fetch('/api/v1/configuration', {
          headers: authHeader(gateway),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          provider?: { provider: string; model: string; apiKey?: string };
        };

        // Not silently dropped: the rest of the provider configuration
        // still arrives, proving this is a redaction of one field, not an
        // omission of the whole shape.
        expect(body.provider?.provider).toBe('anthropic');
        expect(body.provider?.model).toBe('claude-x');
        expect(body.provider?.apiKey).toBeUndefined();

        const rawResponse = await gateway.fetch('/api/v1/configuration', {
          headers: authHeader(gateway),
        });
        const raw = await rawResponse.text();
        expect(raw).not.toContain(secretApiKey);
      },
    );
  });

  it('rejects a malformed WebSocket frame with a typed error rather than closing the connection', async () => {
    await withGateway(
      () =>
        startLoopbackGateway({
          agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
          generate: immediateGenerate(),
        }),
      async (gateway) => {
        const ws = await gateway.openWebSocket(`/ws?token=${gateway.authToken}`);
        try {
          // `ws.send` JSON-encodes a typed `ClientFrame`, so sending a bare
          // string through it produces a syntactically valid JSON VALUE
          // (a string) that is still the wrong SHAPE (not an object) — the
          // real malformed-frame contract `parseClientFrame` enforces.
          // Tightened to the specific typed error code/message so this
          // documents that contract rather than merely "some error came
          // back" (copilot review, PR #469).
          ws.send('this is not json' as never);
          const errorFrame = await ws.next();
          expect(errorFrame).toMatchObject({
            type: 'error',
            code: 'INVALID_FRAME',
            message: 'Frame must be a JSON object',
          });

          // The connection stays open and the protocol keeps working — a
          // ping still round-trips a pong.
          ws.send({ type: 'ping' });
          const pongFrame = await ws.next();
          expect(pongFrame.type).toBe('pong');
          expect(ws.readyState).toBe(WebSocket.OPEN);
        } finally {
          ws.close();
          await ws.waitForClose();
        }
      },
    );
  });

  it('does not deliver duplicate frames for a duplicate subscription to the same run', async () => {
    await withGateway(
      // Ad-hoc (no agentName) dispatch, deliberately: `createRun` only
      // routes by catalog agent name in a MULTI-agent bureau — with one
      // (or zero) catalog agents, `agentName` is metadata only and every
      // run actually executes through this bureau-level `generate`. Using
      // that directly here (rather than a separate catalog agent) avoids
      // depending on multi-agent selection this suite does not otherwise
      // need.
      () => startLoopbackGateway({ agents: {}, generate: blockingGenerate() }),
      async (gateway) => {
        const runResponse = await gateway.fetch('/api/v1/runs', {
          method: 'POST',
          headers: { ...authHeader(gateway), 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hold' }),
        });
        const run = (await runResponse.json()) as { id: string };

        const ws = await gateway.openWebSocket(`/ws?token=${gateway.authToken}`);
        try {
          ws.send({ type: 'subscribe', runId: run.id });
          const firstAck = await ws.next();
          expect(firstAck.type).toBe('subscribed');
          // The duplicate: same connection, same runId.
          ws.send({ type: 'subscribe', runId: run.id });
          const secondAck = await ws.next();
          expect(secondAck.type).toBe('subscribed');

          const abortResponse = await gateway.fetch(`/api/v1/runs/${run.id}/abort`, {
            method: 'POST',
            headers: authHeader(gateway),
          });
          expect(abortResponse.status).toBe(200);

          // No real timer: a WebSocket delivers frames in order on one
          // connection, and the broker broadcasts to a subscriber
          // synchronously — a duplicate `run.aborted` from the doubled
          // subscription above would already be sitting in the socket
          // buffer ahead of any later message. So after the first
          // `run.aborted`, send one `ping` and read until its `pong`,
          // counting any `run.aborted` frames received in between; `pong`
          // is a deterministic "nothing more is coming from before this
          // point" fence.
          let abortedFrameCount = 0;
          for (;;) {
            const frame = await ws.next();
            if (frame.type === 'event' && frame.event === 'run.aborted' && frame.runId === run.id) {
              abortedFrameCount += 1;
              break;
            }
          }
          ws.send({ type: 'ping' });
          for (;;) {
            const frame = await ws.next();
            if (frame.type === 'pong') break;
            if (frame.type === 'event' && frame.event === 'run.aborted' && frame.runId === run.id) {
              abortedFrameCount += 1;
            }
          }
          expect(abortedFrameCount).toBe(1);
        } finally {
          ws.close();
          await ws.waitForClose();
        }
      },
    );
  });

  it('terminates an in-flight run when an abort request arrives over the wire', async () => {
    await withGateway(
      () => startLoopbackGateway({ agents: {}, generate: blockingGenerate() }),
      async (gateway) => {
        const runResponse = await gateway.fetch('/api/v1/runs', {
          method: 'POST',
          headers: { ...authHeader(gateway), 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hold' }),
        });
        expect(runResponse.status).toBe(201);
        const run = (await runResponse.json()) as { id: string };

        const sse = await gateway.openEventStream(`/api/v1/events?runId=${run.id}`, {
          headers: authHeader(gateway),
        });
        try {
          const abortResponse = await gateway.fetch(`/api/v1/runs/${run.id}/abort`, {
            method: 'POST',
            headers: authHeader(gateway),
          });
          expect(abortResponse.status).toBe(200);

          let sawAborted = false;
          for (let attempt = 0; attempt < 50 && !sawAborted; attempt++) {
            const frame = await sse.next();
            if (!frame) break;
            if (frame.type === 'event' && frame.event === 'run.aborted' && frame.runId === run.id) {
              sawAborted = true;
            }
          }
          expect(sawAborted).toBe(true);
        } finally {
          await sse.close();
        }
      },
    );
  });

  it('proves the response came over a real socket, not a patched global (server-set header)', async () => {
    await withGateway(
      () =>
        startLoopbackGateway({
          agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
          generate: immediateGenerate(),
        }),
      async (gateway) => {
        const response = await gateway.fetch('/api/v1/health/live', {
          headers: authHeader(gateway),
        });
        // requestIdentifier middleware stamps a fresh x-request-id on every
        // real response; a patched-global fake would have no reason to
        // produce this.
        expect(response.headers.get('x-request-id')).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      },
    );
  });

  it('releases the port and refuses a subsequent connection after stop()', async () => {
    const gateway = await startLoopbackGateway({
      agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
      generate: immediateGenerate(),
    });
    const { url } = gateway;

    await gateway.stop();

    let refused = false;
    try {
      await fetch(`${url}/api/v1/health/live`);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it('leaves the connection registry and Bureau shutdown report clean after every client disconnects', async () => {
    const gateway = await startLoopbackGateway({
      agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
      generate: immediateGenerate(),
    });

    const sse = await gateway.openEventStream('/api/v1/events', { headers: authHeader(gateway) });
    const ws = await gateway.openWebSocket(`/ws?token=${gateway.authToken}`);

    // Public evidence only — AB-219's /ready connection accounting through
    // live-events.ts's own subscriber registry, never a private map read
    // from this test.
    const whileOpenResponse = await gateway.fetch('/api/v1/health/ready', {
      headers: authHeader(gateway),
    });
    const whileOpen = (await whileOpenResponse.json()) as {
      subsystems: { connections: { total: number } };
    };
    expect(whileOpen.subsystems.connections.total).toBeGreaterThanOrEqual(2);

    await sse.close();
    ws.close();
    await ws.waitForClose();

    let total = -1;
    for (let attempt = 0; attempt < 50; attempt++) {
      const readyResponse = await gateway.fetch('/api/v1/health/ready', {
        headers: authHeader(gateway),
      });
      const ready = (await readyResponse.json()) as {
        subsystems: { connections: { total: number } };
      };
      total = ready.subsystems.connections.total;
      if (total === 0) break;
    }
    expect(total).toBe(0);

    // tst-03c (the Bureau harness's own quiescence report) is out of
    // AB-261's delivery boundary — this reaches the same evidence through
    // the public `Bureau.shutdown()` report instead. Called BEFORE
    // `gateway.stop()` (whose own teardown calls `shutdown()` again,
    // documented idempotent) so this is the first, real call — a second,
    // already-idempotent call could return an empty `owners` list and let
    // the loop below assert nothing.
    const shutdownReport = await gateway.bureau.shutdown();
    expect(shutdownReport.owners.length).toBeGreaterThan(0);
    for (const owner of shutdownReport.owners) {
      expect(owner.outcome).not.toBe('failed');
      expect(owner.outcome).not.toBe('unresolved');
    }

    await gateway.stop();
  });
});

describe('Gateway transport conformance — Node runtime', () => {
  it('reports WebSocket as an unsupported capability rather than hanging or being silently skipped', async () => {
    await withGateway(
      () =>
        startLoopbackGateway({
          agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
          generate: immediateGenerate(),
          serverRuntime: 'node',
        }),
      async (gateway) => {
        // The typed capability outcome this scenario proves: never an
        // unsupported transport silently reported as available.
        expect(gateway.supportsWebSocket).toBe(false);

        let caught: unknown;
        try {
          await gateway.openWebSocket('/ws');
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(LoopbackTransportUnsupportedError);
        expect((caught as LoopbackTransportUnsupportedError).transport).toBe('websocket');
        expect((caught as LoopbackTransportUnsupportedError).serverRuntime).toBe('node');
      },
    );
  });

  it('runs the same HTTP/SSE scenario list: auth, scope, and redaction', async () => {
    const secretApiKey = 'sk-node-secret-do-not-leak-1234567890';
    await withGateway(
      () =>
        startLoopbackGateway({
          agents: {},
          generate: immediateGenerate(),
          provider: { provider: 'anthropic', model: 'claude-x', apiKey: secretApiKey },
          serverRuntime: 'node',
        }),
      async (gateway) => {
        const unauthenticated = await gateway.fetch('/api/v1/runs');
        expect(unauthenticated.status).toBe(401);

        const scopedToken = await createScopedKey(gateway, [SCOPE.RUNS_READ]);
        const insufficientScope = await gateway.fetch('/api/v1/runs', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${scopedToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ message: 'hello' }),
        });
        expect(insufficientScope.status).toBe(403);

        // See the Bun-lane scenario's comment: GET /api/v1/configuration is
        // the gateway's own wire-redaction contract (redactProvider strips
        // apiKey before the response body is built).
        const response = await gateway.fetch('/api/v1/configuration', {
          headers: authHeader(gateway),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          provider?: { provider: string; model: string; apiKey?: string };
        };
        expect(body.provider?.provider).toBe('anthropic');
        expect(body.provider?.apiKey).toBeUndefined();
        const rawResponse = await gateway.fetch('/api/v1/configuration', {
          headers: authHeader(gateway),
        });
        const raw = await rawResponse.text();
        expect(raw).not.toContain(secretApiKey);
      },
    );
  });

  it('terminates an in-flight run over abort, observed via a real SSE reader', async () => {
    await withGateway(
      () =>
        startLoopbackGateway({ agents: {}, generate: blockingGenerate(), serverRuntime: 'node' }),
      async (gateway) => {
        const runResponse = await gateway.fetch('/api/v1/runs', {
          method: 'POST',
          headers: { ...authHeader(gateway), 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hold' }),
        });
        const run = (await runResponse.json()) as { id: string };

        const sse = await gateway.openEventStream(`/api/v1/events?runId=${run.id}`, {
          headers: authHeader(gateway),
        });
        try {
          const abortResponse = await gateway.fetch(`/api/v1/runs/${run.id}/abort`, {
            method: 'POST',
            headers: authHeader(gateway),
          });
          expect(abortResponse.status).toBe(200);

          let sawAborted = false;
          for (let attempt = 0; attempt < 50 && !sawAborted; attempt++) {
            const frame = await sse.next();
            if (!frame) break;
            if (frame.type === 'event' && frame.event === 'run.aborted' && frame.runId === run.id) {
              sawAborted = true;
            }
          }
          expect(sawAborted).toBe(true);
        } finally {
          await sse.close();
        }
      },
    );
  });
});

describe('Gateway transport conformance — bounded reads over a real socket', () => {
  it('rejects a pending WebSocket read when its AbortSignal fires before any frame arrives', async () => {
    await withGateway(
      () =>
        startLoopbackGateway({
          agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
          generate: immediateGenerate(),
        }),
      async (gateway) => {
        const ws = await gateway.openWebSocket(`/ws?token=${gateway.authToken}`);
        try {
          // No frame is pending — the socket has just opened and nothing
          // has been sent yet — so this read is genuinely still waiting
          // when the controller aborts it, exercising the real
          // "abort a pending read" path over a real socket rather than an
          // already-aborted signal.
          const controller = new AbortController();
          const readPromise = ws.next(controller.signal);
          controller.abort();

          let caught: unknown;
          try {
            await readPromise;
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(Error);
        } finally {
          ws.close();
          await ws.waitForClose();
        }
      },
    );
  });

  it('resolves a pending read normally when a frame arrives before its AbortSignal ever fires', async () => {
    await withGateway(
      () =>
        startLoopbackGateway({
          agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
          generate: immediateGenerate(),
        }),
      async (gateway) => {
        const ws = await gateway.openWebSocket(`/ws?token=${gateway.authToken}`);
        try {
          // A live, never-aborted signal on a read that DOES resolve
          // normally — proves the abort listener this read registered is
          // cleaned up on the success path too, not only on abort.
          const controller = new AbortController();
          ws.send({ type: 'ping' });
          const frame = await ws.next(controller.signal);
          expect(frame.type).toBe('pong');
          expect(controller.signal.aborted).toBe(false);
        } finally {
          ws.close();
          await ws.waitForClose();
        }
      },
    );
  });
});

describe('Gateway transport conformance — no process-global patching', () => {
  it('never assigns to globalThis.fetch, globalThis.WebSocket, or globalThis.EventSource anywhere in this directory', async () => {
    const conformanceDirectory = new URL('.', import.meta.url);
    const entries = await readdir(conformanceDirectory, { withFileTypes: true });
    const testFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'));
    // A future file added to this directory is covered automatically —
    // never a hardcoded file list that silently stops proving anything
    // once someone adds a sibling.
    expect(testFiles.length).toBeGreaterThan(0);

    const files = [
      ...testFiles.map((entry) => new URL(entry.name, conformanceDirectory)),
      new URL('../test/loopback.ts', import.meta.url),
    ];
    const globalAssignmentPattern = /(?:globalThis|global)\.(fetch|WebSocket|EventSource)\s*=/;

    for (const file of files) {
      const contents = await readFile(file, 'utf-8');
      expect(contents).not.toMatch(globalAssignmentPattern);
    }
  });
});

/**
 * Bun's `WebSocket` constructor accepts a non-standard second `{ headers }`
 * argument this suite relies on to set a real `Origin` header from a
 * server-side test client (a real browser cannot forge `Origin`, but a real
 * client-to-server socket can, and this is exactly the transport-level
 * lever the origin-check scenario needs) — confirmed against Bun 1.4's
 * actual runtime behavior, not merely assumed. `lib.dom.d.ts`'s ambient
 * `WebSocket` type has no such overload (Bun's runtime here exceeds its
 * own published types), so the cast is confined to this one local
 * constructor binding rather than widened globally.
 */
const BunWebSocketWithHeaders = WebSocket as unknown as new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;
