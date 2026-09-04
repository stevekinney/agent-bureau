/**
 * Real Gateway disconnect-policy conformance (AB-274 / AB-98's tst-07d
 * slice), asserting the policy AB-212 implements and AB-37's decision
 * record rules, in both directions, over a real socket.
 *
 * - "Cancel-on-disconnect configured": an ATTACHED run — one started by a
 *   gateway request that forwarded that request's own `AbortSignal` into
 *   the run, per `classifyRunAttachment` (`routes/runs.ts`) — is aborted
 *   when the client's real socket drops mid-request. `POST /v1/chat/completions`
 *   with `stream: false` (`routes/openai-compat.ts`) is this repository's
 *   synchronous "HTTP call awaiting a run" row: the handler blocks on
 *   `activeRun.result` before responding, so a real client-side abort while
 *   that await is pending is a genuine mid-flight disconnect, never a
 *   connection closed after the response already landed.
 * - "Not configured": a client that disconnects an SSE/WebSocket EVENT
 *   SUBSCRIBER — as opposed to the request that started the run — never
 *   touches the run, per `live-events.ts`'s confirmed non-cancellation
 *   (AB-37's decision table). `classifyRunAttachment` returns `'detached'`
 *   here regardless of the run's durability class (no signal was ever
 *   forwarded into the run for an event-stream connection), which is
 *   exactly AB-37's explicit non-goal — "a durable or detached operation is
 *   never cancelled by a disconnect" — restated as this same test: nothing
 *   about this code path depends on durability, so covering the "signal
 *   never forwarded" branch of the classifier covers the durable case too.
 */
import { createAgent, stopWhen } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import type { LoopbackGateway } from '../test/loopback';
import { startLoopbackGateway } from '../test/loopback';
import type { ServerFrame } from '../types';

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

/** A `generate` that stays pending until `release()` is called. */
function releasableGenerate(content: string): {
  generate: () => Promise<{ content: string; toolCalls: never[] }>;
  release: () => void;
} {
  let releaseFn: (() => void) | undefined;
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

function authHeader(gateway: LoopbackGateway): { authorization: string } {
  return { authorization: `Bearer ${gateway.authToken}` };
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

describe('Gateway disconnect-policy conformance — asserted in both directions', () => {
  it('attached: a real mid-request socket drop on POST /v1/chat/completions aborts the run and the terminal event says so', async () => {
    await withGateway(
      () =>
        startLoopbackGateway({
          agents: { echo: createAgent({ name: 'echo', generate: blockingGenerate() }) },
          generate: blockingGenerate(),
        }),
      async (gateway) => {
        const controller = new AbortController();

        // Non-streaming: `openai-compat.ts` blocks on `activeRun.result`
        // before responding, so this request is still in flight — the
        // handler has not returned — when we abort it below. Real client
        // abort mid-request, not a connection dropped after the response
        // already landed (confirmed against Bun's actual `Request.signal`
        // behavior: an abort AFTER a normal response completes does not
        // fire the server's signal at all).
        const chatPromise = gateway
          .fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { ...authHeader(gateway), 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'echo',
              messages: [{ role: 'user', content: 'hi' }],
              stream: false,
            }),
            signal: controller.signal,
          })
          .catch((error: unknown) => error);

        // Discover the run this request started (there is exactly one) so
        // we can observe its outcome after the abort, since the client
        // itself never receives a response body once its own request is
        // the thing being aborted.
        let runId: string | undefined;
        for (let attempt = 0; attempt < 50 && !runId; attempt++) {
          const runsResponse = await gateway.fetch('/api/v1/runs', {
            headers: authHeader(gateway),
          });
          const runs = (await runsResponse.json()) as { id: string; status: string }[];
          runId = runs[0]?.id;
        }
        expect(runId).toBeDefined();
        if (!runId) return;

        controller.abort();
        await chatPromise;

        // The run reaches 'aborted' — bounded polling on the public GET
        // surface, never a real sleep.
        let status: string | undefined;
        for (let attempt = 0; attempt < 50 && status !== 'aborted'; attempt++) {
          const detailResponse = await gateway.fetch(`/api/v1/runs/${runId}`, {
            headers: authHeader(gateway),
          });
          const detail = (await detailResponse.json()) as { status: string };
          status = detail.status;
        }
        expect(status).toBe('aborted');

        // The terminal event says so: the `run.aborted` action frame's
        // `detail.reason` names the disconnect (AB-212's
        // `abortAttachedRunOnDisconnect`), read from the public audit
        // surface — never a private field.
        let abortedRecord: { detail?: Record<string, unknown> } | undefined;
        let disconnectRecord: { detail?: Record<string, unknown> } | undefined;
        for (let attempt = 0; attempt < 50 && (!abortedRecord || !disconnectRecord); attempt++) {
          const auditResponse = await gateway.fetch(`/api/v1/audit?runId=${runId}`, {
            headers: authHeader(gateway),
          });
          const records = (await auditResponse.json()) as {
            type: string;
            detail?: Record<string, unknown>;
          }[];
          abortedRecord = records.find((record) => record.type === 'run.aborted');
          disconnectRecord = records.find((record) => record.type === 'run.disconnect-aborted');
        }
        expect(abortedRecord).toBeDefined();
        const reason = abortedRecord?.detail?.['reason'];
        expect(typeof reason === 'string' ? reason : '').toContain('disconnected');
        expect(disconnectRecord).toBeDefined();
      },
    );
  });

  it('detached: a real socket drop on an SSE event subscriber never aborts the run, which stays running and reattachable', async () => {
    const { generate, release } = releasableGenerate('done');
    await withGateway(
      () => startLoopbackGateway({ agents: {}, generate, stopWhen: stopWhen.noToolCalls() }),
      async (gateway) => {
        const runResponse = await gateway.fetch('/api/v1/runs', {
          method: 'POST',
          headers: { ...authHeader(gateway), 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hold' }),
        });
        expect(runResponse.status).toBe(201);
        const run = (await runResponse.json()) as { id: string };

        // A pure event SUBSCRIBER — never the request that started the
        // run. `POST /api/v1/runs` already returned; this connection's
        // `AbortSignal` is never forwarded into the run at all, so
        // `classifyRunAttachment` classifies it `'detached'` independent of
        // durability (AB-37's non-goal, restated). `since: 0` replays what
        // already happened (the run is blocked on its very first `generate`
        // call and emits nothing further until released) so this read
        // resolves from the buffer rather than waiting on a live frame that
        // cannot arrive yet.
        const sse = await gateway.openEventStream(
          `/api/v1/events?runId=${run.id}&since=${encodeURIComponent(run.id)}:0`,
          { headers: authHeader(gateway) },
        );
        const firstFrame = await sse.next();
        expect(firstFrame).toBeDefined();

        // Kill the REAL socket — a genuine subscriber disconnect, not an
        // unsubscribe frame.
        await sse.close();

        // The run is still running: not touched by the subscriber's
        // disconnect.
        const stillRunningResponse = await gateway.fetch(`/api/v1/runs/${run.id}`, {
          headers: authHeader(gateway),
        });
        const stillRunning = (await stillRunningResponse.json()) as { status: string };
        expect(stillRunning.status).toBe('running');

        // It remains observable and reattachable: a fresh subscription
        // (a full replay, `since: 0`) still catches everything once the
        // run continues and finishes.
        const reattached = await gateway.openEventStream(
          `/api/v1/events?runId=${run.id}&since=${encodeURIComponent(run.id)}:0`,
          { headers: authHeader(gateway) },
        );
        release();

        let sawCompleted = false;
        for (let attempt = 0; attempt < 100 && !sawCompleted; attempt++) {
          const frame: ServerFrame | undefined = await reattached.next();
          if (!frame) break;
          if (frame.type === 'event' && frame.event === 'run.completed') {
            sawCompleted = true;
          }
        }
        await reattached.close();
        expect(sawCompleted).toBe(true);

        const finalResponse = await gateway.fetch(`/api/v1/runs/${run.id}`, {
          headers: authHeader(gateway),
        });
        const final = (await finalResponse.json()) as { status: string };
        expect(final.status).toBe('completed');
      },
    );
  });
});
