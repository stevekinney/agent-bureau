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

import type { OutputValidator } from '@lostgradient/operative';
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

/**
 * A `generate` function that stays pending until `release()` is called.
 * AB-302's scenarios below use this so the SSE/WebSocket subscription is
 * established BEFORE `generate.completed` dispatches — a live-delivered
 * frame, never a replay-buffer race.
 */
function releasableGenerate(content: string): {
  generate: () => Promise<{ content: string; toolCalls: never[] }>;
  release: () => void;
} {
  let releaseFn: (() => void) | undefined;
  // `release()` can race `generate()` under load — the run's first step may
  // not have called `generate` yet when the test calls `release()` right
  // after opening its SSE/WebSocket subscription. Track the released state
  // independently so a `generate()` call that arrives AFTER `release()`
  // resolves immediately instead of registering a `releaseFn` nothing ever
  // calls (which would hang the test until bun's own timeout).
  let released = false;
  const generate = () =>
    new Promise<{ content: string; toolCalls: never[] }>((resolve) => {
      if (released) {
        resolve({ content, toolCalls: [] });
        return;
      }
      releaseFn = () => resolve({ content, toolCalls: [] });
    });
  return {
    generate,
    release: () => {
      released = true;
      releaseFn?.();
    },
  };
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

  it('AB-302: an output guardrail redact action is applied before the generate.completed frame is delivered over SSE — the raw secret never appears on the wire', async () => {
    const secret = 'sk-real-secret-do-not-leak-1234567890';
    const redactedText = '[redacted]';
    const secretValidator: OutputValidator = {
      name: 'secret-detector',
      validate: async (output) => ({
        valid: !output.includes(secret),
        category: 'secret',
        confidence: 1,
        redacted: redactedText,
      }),
    };
    const { generate, release } = releasableGenerate(`Contact us at ${secret} for help.`);

    await withGateway(
      () =>
        startLoopbackGateway({
          agents: {},
          generate,
          guardrails: { output: { validators: [secretValidator], action: 'redact' } },
        }),
      async (gateway) => {
        const runResponse = await gateway.fetch('/api/v1/runs', {
          method: 'POST',
          headers: { ...authHeader(gateway), 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'leak it' }),
        });
        expect(runResponse.status).toBe(201);
        const run = (await runResponse.json()) as { id: string };

        const sse = await gateway.openEventStream(`/api/v1/events?runId=${run.id}`, {
          headers: authHeader(gateway),
        });
        try {
          // Subscription is live BEFORE the generate call resolves, so the
          // frame below arrives as a genuine live delivery, never a
          // replay-buffer race.
          release();

          // `response.validated` is a deliberately different surface — its
          // whole contract is to show the pre/post redaction diff
          // (`original` vs `validated`) to a live glass-box subscriber, so
          // it is excluded from this scan by design, not by oversight. This
          // gateway connection is privileged (the harness's admin
          // authToken), so it is exactly the case AB-305 later carves out —
          // see that ticket's own scenarios below for the non-privileged
          // redaction this connection does NOT get. Only `generate.completed`
          // is this scenario's target: AB-302's acceptance criterion names
          // that frame specifically.
          let generateCompleted: { type: 'event'; event: string; detail: unknown } | undefined;
          for (let attempt = 0; attempt < 50 && !generateCompleted; attempt++) {
            const frame = await sse.next();
            if (!frame) break;
            if (frame.type === 'event' && frame.event === 'generate.completed') {
              generateCompleted = frame;
            }
          }
          expect(generateCompleted).toBeDefined();
          expect(JSON.stringify(generateCompleted)).not.toContain(secret);
          const detail = generateCompleted?.detail as { response?: { content?: string } };
          expect(detail.response?.content).toBe(redactedText);
        } finally {
          await sse.close();
        }
      },
    );
  });

  it('AB-302: an output guardrail redact action is applied before the generate.completed frame is delivered over WebSocket — the raw secret never appears on the wire', async () => {
    const secret = 'sk-real-secret-do-not-leak-9876543210';
    const redactedText = '[redacted]';
    const secretValidator: OutputValidator = {
      name: 'secret-detector',
      validate: async (output) => ({
        valid: !output.includes(secret),
        category: 'secret',
        confidence: 1,
        redacted: redactedText,
      }),
    };
    const { generate, release } = releasableGenerate(`Contact us at ${secret} for help.`);

    await withGateway(
      () =>
        startLoopbackGateway({
          agents: {},
          generate,
          guardrails: { output: { validators: [secretValidator], action: 'redact' } },
        }),
      async (gateway) => {
        const runResponse = await gateway.fetch('/api/v1/runs', {
          method: 'POST',
          headers: { ...authHeader(gateway), 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'leak it' }),
        });
        expect(runResponse.status).toBe(201);
        const run = (await runResponse.json()) as { id: string };

        const ws = await gateway.openWebSocket(`/ws?token=${gateway.authToken}`);
        try {
          ws.send({ type: 'subscribe', runId: run.id });
          const ack = await ws.next();
          expect(ack.type).toBe('subscribed');

          release();

          // `response.validated` is deliberately excluded from this scan —
          // see the SSE scenario above for why. This connection is
          // privileged (admin authToken), the case AB-305's scenarios below
          // exercise for both privilege levels.
          let generateCompleted: { type: 'event'; event: string; detail: unknown } | undefined;
          for (let attempt = 0; attempt < 50 && !generateCompleted; attempt++) {
            const frame = await ws.next();
            if (frame.type === 'event' && frame.event === 'generate.completed') {
              generateCompleted = frame;
            }
          }
          expect(generateCompleted).toBeDefined();
          expect(JSON.stringify(generateCompleted)).not.toContain(secret);
          const detail = generateCompleted?.detail as { response?: { content?: string } };
          expect(detail.response?.content).toBe(redactedText);
        } finally {
          ws.close();
          await ws.waitForClose();
        }
      },
    );
  });

  it('AB-302: the audit trail never carries the raw secret for a run under an output guardrail redact action — pinned, whether or not generate.completed is itself audited', async () => {
    const secret = 'sk-real-secret-do-not-leak-1122334455';
    const redactedText = '[redacted]';
    const secretValidator: OutputValidator = {
      name: 'secret-detector',
      validate: async (output) => ({
        valid: !output.includes(secret),
        category: 'secret',
        confidence: 1,
        redacted: redactedText,
      }),
    };

    await withGateway(
      () =>
        startLoopbackGateway({
          agents: {},
          generate: async () => ({ content: `Contact us at ${secret} for help.`, toolCalls: [] }),
          guardrails: { output: { validators: [secretValidator], action: 'redact' } },
        }),
      async (gateway) => {
        const runResponse = await gateway.fetch('/api/v1/runs', {
          method: 'POST',
          headers: { ...authHeader(gateway), 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'leak it' }),
        });
        expect(runResponse.status).toBe(201);
        const run = (await runResponse.json()) as { id: string };

        type AuditRecord = { type: string; detail?: Record<string, unknown> };
        let stepCompletedRecord: AuditRecord | undefined;
        let generateCompletedRecord: AuditRecord | undefined;
        for (
          let attempt = 0;
          attempt < 50 && (!stepCompletedRecord || !generateCompletedRecord);
          attempt++
        ) {
          const auditResponse = await gateway.fetch(`/api/v1/audit?runId=${run.id}`, {
            headers: authHeader(gateway),
          });
          expect(auditResponse.status).toBe(200);
          const records = (await auditResponse.json()) as AuditRecord[];
          stepCompletedRecord = records.find((record) => record.type === 'step.completed');
          generateCompletedRecord = records.find((record) => record.type === 'generate.completed');
        }

        // `step.completed` is one of `AUDIT_EVENT_TYPES` sunk into the
        // durable trail (`packages/bureau/src/audit-trail.ts`) and its
        // `content` is set from the SAME post-guardrail `response.content`
        // `generate.completed` now carries — pinning that this audit
        // record was never at risk from the ordering bug in the first
        // place, independent of today's fix.
        expect(stepCompletedRecord).toBeDefined();
        expect(stepCompletedRecord?.detail?.['content']).toBe(redactedText);
        expect(JSON.stringify(stepCompletedRecord)).not.toContain(secret);

        // `generate.completed` is NOT one of `AUDIT_EVENT_TYPES`, so it is
        // never sunk into the durable trail — but `routes/audit.ts`
        // deliberately passes live-store (Layer A) actions of any type
        // through unchanged for exactly this reason ("non-audited event
        // types (e.g. generate.*) are never in durableRecords and must
        // always pass through from the live store"). This run's
        // `generate.completed` action is still in the live ring buffer, so
        // this combined endpoint carries it too — proving the fix's reach
        // extends to this surface, not only the live SSE/WebSocket frame.
        // `response.validated` is excluded from this scan by design (see
        // the SSE/WebSocket scenarios above) — its `original` field is a
        // deliberate pre-redaction audit diff, not a leak. This is the
        // durable audit trail specifically (AB-305's ruling: it keeps the
        // full event, privileged by construction, regardless of the live
        // wire's per-connection projection).
        expect(generateCompletedRecord).toBeDefined();
        expect(JSON.stringify(generateCompletedRecord)).not.toContain(secret);
      },
    );
  });

  it('AB-305: a non-privileged SSE client sees response.validated redacted while a privileged one sees the raw diff', async () => {
    const secret = 'sk-real-secret-do-not-leak-ab305-sse';
    const redactedText = '[redacted]';
    const secretValidator: OutputValidator = {
      name: 'secret-detector',
      validate: async (output) => ({
        valid: !output.includes(secret),
        category: 'secret',
        confidence: 1,
        redacted: redactedText,
      }),
    };
    const { generate, release } = releasableGenerate(`Contact us at ${secret} for help.`);

    await withGateway(
      () =>
        startLoopbackGateway({
          agents: {},
          generate,
          guardrails: { output: { validators: [secretValidator], action: 'redact' } },
        }),
      async (gateway) => {
        // A key scoped only for runs:read is a normal, non-admin connection
        // — AB-305's "not privileged" case. The default authToken this
        // harness configures is the admin/static-token credential — AB-305's
        // "privileged" case — so both connections are real, differently
        // authorized clients, not the same credential twice.
        const scopedToken = await createScopedKey(gateway, [SCOPE.RUNS_READ]);

        const runResponse = await gateway.fetch('/api/v1/runs', {
          method: 'POST',
          headers: { ...authHeader(gateway), 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'leak it' }),
        });
        expect(runResponse.status).toBe(201);
        const run = (await runResponse.json()) as { id: string };

        const privilegedSse = await gateway.openEventStream(`/api/v1/events?runId=${run.id}`, {
          headers: authHeader(gateway),
        });
        const nonPrivilegedSse = await gateway.openEventStream(`/api/v1/events?runId=${run.id}`, {
          headers: { authorization: `Bearer ${scopedToken}` },
        });
        try {
          // Both subscriptions are live before generate() resolves, so the
          // frame below arrives as a genuine live delivery to both, never a
          // replay-buffer race.
          release();

          async function findResponseValidated(
            reader: Awaited<ReturnType<typeof gateway.openEventStream>>,
          ) {
            for (let attempt = 0; attempt < 50; attempt++) {
              const frame = await reader.next();
              if (!frame) break;
              if (frame.type === 'event' && frame.event === 'response.validated') {
                return frame;
              }
            }
            return undefined;
          }

          const [privilegedFrame, nonPrivilegedFrame] = await Promise.all([
            findResponseValidated(privilegedSse),
            findResponseValidated(nonPrivilegedSse),
          ]);

          expect(privilegedFrame).toBeDefined();
          expect(JSON.stringify(privilegedFrame)).toContain(secret);
          const privilegedDetail = privilegedFrame?.detail as {
            original?: { content?: string };
          };
          expect(privilegedDetail.original?.content).toBe(`Contact us at ${secret} for help.`);

          expect(nonPrivilegedFrame).toBeDefined();
          expect(JSON.stringify(nonPrivilegedFrame)).not.toContain(secret);
          const nonPrivilegedDetail = nonPrivilegedFrame?.detail as {
            original?: { content?: string };
          };
          expect(nonPrivilegedDetail.original?.content).toBe(redactedText);
        } finally {
          await privilegedSse.close();
          await nonPrivilegedSse.close();
        }
      },
    );
  });

  it('AB-305: a non-privileged WebSocket client sees response.validated redacted while a privileged one sees the raw diff', async () => {
    const secret = 'sk-real-secret-do-not-leak-ab305-ws';
    const redactedText = '[redacted]';
    const secretValidator: OutputValidator = {
      name: 'secret-detector',
      validate: async (output) => ({
        valid: !output.includes(secret),
        category: 'secret',
        confidence: 1,
        redacted: redactedText,
      }),
    };
    const { generate, release } = releasableGenerate(`Contact us at ${secret} for help.`);

    await withGateway(
      () =>
        startLoopbackGateway({
          agents: {},
          generate,
          guardrails: { output: { validators: [secretValidator], action: 'redact' } },
        }),
      async (gateway) => {
        const scopedToken = await createScopedKey(gateway, [SCOPE.RUNS_READ]);

        const runResponse = await gateway.fetch('/api/v1/runs', {
          method: 'POST',
          headers: { ...authHeader(gateway), 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'leak it' }),
        });
        expect(runResponse.status).toBe(201);
        const run = (await runResponse.json()) as { id: string };

        const privilegedWs = await gateway.openWebSocket(`/ws?token=${gateway.authToken}`);
        const nonPrivilegedWs = await gateway.openWebSocket(`/ws?token=${scopedToken}`);
        try {
          privilegedWs.send({ type: 'subscribe', runId: run.id });
          const privilegedAck = await privilegedWs.next();
          expect(privilegedAck.type).toBe('subscribed');
          nonPrivilegedWs.send({ type: 'subscribe', runId: run.id });
          const nonPrivilegedAck = await nonPrivilegedWs.next();
          expect(nonPrivilegedAck.type).toBe('subscribed');

          release();

          async function findResponseValidated(
            client: Awaited<ReturnType<typeof gateway.openWebSocket>>,
          ) {
            for (let attempt = 0; attempt < 50; attempt++) {
              const frame = await client.next();
              if (frame.type === 'event' && frame.event === 'response.validated') {
                return frame;
              }
            }
            return undefined;
          }

          const [privilegedFrame, nonPrivilegedFrame] = await Promise.all([
            findResponseValidated(privilegedWs),
            findResponseValidated(nonPrivilegedWs),
          ]);

          expect(privilegedFrame).toBeDefined();
          expect(JSON.stringify(privilegedFrame)).toContain(secret);
          const privilegedDetail = privilegedFrame?.detail as {
            original?: { content?: string };
          };
          expect(privilegedDetail.original?.content).toBe(`Contact us at ${secret} for help.`);

          expect(nonPrivilegedFrame).toBeDefined();
          expect(JSON.stringify(nonPrivilegedFrame)).not.toContain(secret);
          const nonPrivilegedDetail = nonPrivilegedFrame?.detail as {
            original?: { content?: string };
          };
          expect(nonPrivilegedDetail.original?.content).toBe(redactedText);
        } finally {
          privilegedWs.close();
          nonPrivilegedWs.close();
          await privilegedWs.waitForClose();
          await nonPrivilegedWs.waitForClose();
        }
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
        // produce this. This loopback gateway forwards the harness's
        // ManualRuntimeServices as `runtime` (AB-303), so the identifier is
        // the deterministic `identifiers.next('request')` shape
        // (`${identifierPrefix}-request-<n>`, Coordinator ruling on AB-337)
        // rather than a real UUID — still proof the real middleware ran,
        // just over the injected runtime seam instead of
        // `crypto.randomUUID()`.
        expect(response.headers.get('x-request-id')).toMatch(/^[a-z0-9]+-request-\d+$/);
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

  it('advances a connection watchdog only when the manual runtime advances (AB-303)', async () => {
    const gateway = await startLoopbackGateway({
      agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
      generate: immediateGenerate(),
    });

    async function readyConnections(): Promise<{
      total: number;
      late: number;
      unreachable: number;
    }> {
      const response = await gateway.fetch('/api/v1/health/ready', {
        headers: authHeader(gateway),
      });
      const body = (await response.json()) as {
        subsystems: { connections: { total: number; late: number; unreachable: number } };
      };
      return body.subsystems.connections;
    }

    // A WebSocket connection, not SSE: the SSE endpoint's own real
    // `heartbeatIntervalMs` (8000ms) `setInterval` writes `: heartbeat`
    // and records a fresh `transport-keepalive` pulse on every tick,
    // which would refresh the watchdog's activity clock as we advance
    // past it and mask exactly the thing this test wants to prove.
    // WebSocket has no such server-driven interval — a keepalive pulse is
    // only recorded when the client sends a `ping` frame — so a socket
    // that never pings is a clean, timer-free surface for the watchdog's
    // own check math.
    const ws = await gateway.openWebSocket(`/ws?token=${gateway.authToken}`);
    try {
      // The default heartbeat cadence (8000ms) still sizes the watchdog's
      // policy for this connection (AB-219: `cadenceMs` is always the
      // connection's own resolved `heartbeatIntervalMs`, even though
      // WebSocket doesn't use it to schedule a real interval the way SSE
      // does). The watchdog's own check interval is therefore
      // cadenceMs + graceMs + jitterMs = 8000 + 4000 + 800 = 12800
      // (live-events.test.ts's own math for this same default).
      expect(await readyConnections()).toEqual({ total: 1, late: 0, unreachable: 0 });

      // Advancing the manual runtime past one check interval (12_800ms)
      // — with no real `setTimeout` and no real sleep — is what moves the
      // watchdog to `late`.
      await gateway.runtime.advance(12_800);
      expect(await readyConnections()).toEqual({ total: 1, late: 1, unreachable: 0 });

      // A second check interval with still no fresh pulse moves it to
      // `unreachable` (missedPulseThreshold: 2).
      await gateway.runtime.advance(12_800);
      expect(await readyConnections()).toEqual({ total: 1, late: 0, unreachable: 1 });
    } finally {
      ws.close();
      await gateway.stop();
    }
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

  it('AB-274: serving a Node-adapter request never clobbers the process-wide Request/Response globals a later Bun-adapter gateway depends on', async () => {
    // `@hono/node-server`'s `serve()` defaults `overrideGlobalObjects` to
    // `true`: the first request it handles replaces `globalThis.Request`
    // and `globalThis.Response` with its own lightweight classes via
    // `Object.defineProperty(global, ...)` — a PROCESS-WIDE mutation, not
    // scoped to this one server. `node-adapter.ts` now passes
    // `overrideGlobalObjects: false` explicitly (see its own doc comment)
    // specifically to prevent this. Pinned here because it is otherwise
    // invisible within this file alone: `transport.test.ts`'s own
    // post-Node Bun-runtime scenarios (the "bounded reads" describe below)
    // are WebSocket-only, which never goes through `Hono`'s
    // `context.json()`/`Response` construction path the way a JSON POST
    // response does — so the regression would resurface silently unless a
    // real Node-adapter request is served, then a real Bun-adapter one, in
    // that order, in the same process.
    const nativeResponse = globalThis.Response;
    const nativeRequest = globalThis.Request;

    await withGateway(
      () =>
        startLoopbackGateway({
          agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
          generate: immediateGenerate(),
          serverRuntime: 'node',
        }),
      async (nodeGateway) => {
        const nodeResponse = await nodeGateway.fetch('/api/v1/runs', {
          method: 'POST',
          headers: { ...authHeader(nodeGateway), 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'go' }),
        });
        expect(nodeResponse.status).toBe(201);

        // The invariant itself: serving that request must not have swapped
        // the process-wide globals out from under anything else running in
        // this process.
        expect(globalThis.Response).toBe(nativeResponse);
        expect(globalThis.Request).toBe(nativeRequest);
      },
    );

    // The user-visible symptom, proven directly: a Bun-adapter gateway
    // started AFTER the Node-adapter request above still returns its real
    // JSON response — not Bun's generic "Welcome to Bun!" fallback page,
    // which is what a clobbered `Response` global produces (`Bun.serve()`
    // no longer recognizes Hono's constructed response as `instanceof
    // Response`).
    await withGateway(
      () =>
        startLoopbackGateway({
          agents: { echo: createAgent({ name: 'echo', generate: immediateGenerate() }) },
          generate: immediateGenerate(),
        }),
      async (bunGateway) => {
        const bunResponse = await bunGateway.fetch('/api/v1/runs', {
          method: 'POST',
          headers: { ...authHeader(bunGateway), 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'go' }),
        });
        expect(bunResponse.status).toBe(201);
        const run = (await bunResponse.json()) as { id: string; status: string };
        expect(run.status).toBe('running');
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
