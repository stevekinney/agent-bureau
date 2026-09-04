/**
 * Real Gateway reconnect conformance (AB-274 / AB-98's tst-07d slice).
 *
 * Drops the actual client socket mid-run — closing the SSE reader / the
 * WebSocket, never merely unsubscribing — and proves a reconnect carrying
 * the last-observed `since` cursor (AB-15's replay cursor contract is
 * transport-symmetric: SSE and WebSocket both accept it) sees the union of
 * every externally meaningful event exactly once: no gap, no duplicate.
 * The same scenario runs over SSE and WebSocket so a transport-specific gap
 * fails rather than hiding behind a transport-specific expectation.
 *
 * "Externally meaningful event" here is exactly what AB-15 defines it to
 * be: every `runSeq`-bearing frame (`packages/bureau/src/types.ts` — `event`
 * and `stream:*` frames). `run-envelope` frames (`run-started`/`run-finished`)
 * are documented as deliberately NOT part of that replay contract — they
 * carry their own envelope-level sequencing and are live-only, so this
 * suite uses the run's own `run.completed`/`run.aborted` ACTION frame (which
 * DOES carry `runSeq`, and so is itself part of the assertion set) as the
 * terminal signal, never the non-replayable envelope.
 */
import { stopWhen } from '@lostgradient/operative';
import { createStepwiseBlockingGenerate } from '@lostgradient/operative/test';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type {
  LoopbackGateway,
  LoopbackWebSocketClient,
  ServerEventStreamReader,
} from '../test/loopback';
import { startLoopbackGateway } from '../test/loopback';
import type { ServerFrame } from '../types';

/** A no-op `next` tool that lets the run take more than one step. */
function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

function runSeqOf(frame: ServerFrame): number | undefined {
  return 'runSeq' in frame ? frame.runSeq : undefined;
}

/**
 * The run's own terminal action frame — carries `runSeq`, unlike the
 * live-only `run-envelope`/`run-finished` frame, so it is both this suite's
 * termination signal AND a legitimate member of the gap/duplicate
 * assertion set.
 */
function isTerminalEvent(frame: ServerFrame): boolean {
  return (
    frame.type === 'event' && (frame.event === 'run.completed' || frame.event === 'run.aborted')
  );
}

function authHeader(gateway: LoopbackGateway): { authorization: string } {
  return { authorization: `Bearer ${gateway.authToken}` };
}

async function setUpBlockedRun(gateway: LoopbackGateway) {
  const runResponse = await gateway.fetch('/api/v1/runs', {
    method: 'POST',
    headers: { ...authHeader(gateway), 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'go' }),
  });
  expect(runResponse.status).toBe(201);
  const run = (await runResponse.json()) as { id: string };
  return run.id;
}

/**
 * Reads real SSE frames from `sse` until `shouldStop` returns true for some
 * frame, or `maxAttempts` reads have happened (bounded, never a timer).
 * Returns every frame seen along the way, in arrival order.
 */
async function readUntil(
  sse: ServerEventStreamReader,
  shouldStop: (frame: ServerFrame) => boolean,
  maxAttempts = 500,
): Promise<ServerFrame[]> {
  const seen: ServerFrame[] = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const frame = await sse.next();
    if (!frame) break;
    seen.push(frame);
    if (shouldStop(frame)) break;
  }
  return seen;
}

async function wsReadUntil(
  ws: LoopbackWebSocketClient,
  shouldStop: (frame: ServerFrame) => boolean,
  maxAttempts = 500,
): Promise<ServerFrame[]> {
  const seen: ServerFrame[] = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const frame = await ws.next();
    seen.push(frame);
    if (shouldStop(frame)) break;
  }
  return seen;
}

/**
 * Sends a `subscribe` frame and reads until the `subscribed` ack. Per
 * `websocket/handler.ts`, replay frames (AB-15) are sent BEFORE the ack, so
 * this returns every frame seen along the way, replay included — never
 * assumes the ack is the first frame back. When `shouldStop` already
 * matched a replayed frame (the run finished before this reconnect even
 * subscribed), reading stops there rather than waiting past the ack.
 */
async function wsSubscribe(
  ws: LoopbackWebSocketClient,
  runId: string,
  since: number | undefined,
  shouldStop: (frame: ServerFrame) => boolean,
): Promise<ServerFrame[]> {
  ws.send({ type: 'subscribe', runId, ...(since !== undefined ? { since } : {}) });
  const seen = await wsReadUntil(ws, (frame) => frame.type === 'subscribed' || shouldStop(frame));
  if (seen.some(shouldStop)) {
    return seen.filter((frame) => frame.type !== 'subscribed');
  }
  return [
    ...seen.filter((frame) => frame.type !== 'subscribed'),
    ...(await wsReadUntil(ws, shouldStop)),
  ];
}

describe('Gateway reconnect conformance — no gap, no duplicate across a real socket drop', () => {
  it('SSE: the union of frames across a killed and reconnected connection contains every externally meaningful event exactly once', async () => {
    const { generate, releaseStep1 } = createStepwiseBlockingGenerate();
    const gateway = await startLoopbackGateway({
      agents: {},
      generate,
      toolbox: createToolbox([createNextTool()]),
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const runId = await setUpBlockedRun(gateway);

      // Connection A: full replay from the start (an explicit `since: 0` —
      // AB-15 treats an omitted `since` as "fresh subscribe, no replay").
      const sseA = await gateway.openEventStream(
        `/api/v1/events?runId=${runId}&since=${encodeURIComponent(runId)}:0`,
        { headers: authHeader(gateway) },
      );

      // Drain whatever step-0 frames already arrived before killing the
      // real socket. Step 1 is blocked, so this is a proper prefix of the
      // run — reading at least one frame is guaranteed (run.started).
      const framesBeforeKill = await readUntil(sseA, () => true, 1);
      expect(framesBeforeKill.length).toBeGreaterThan(0);
      const lastSeenBeforeKill = Math.max(...framesBeforeKill.map((frame) => runSeqOf(frame) ?? 0));

      // Kill the REAL socket — cancels the underlying fetch response body,
      // which aborts the server's request signal. Never an unsubscribe.
      await sseA.close();

      // While no one is subscribed, let the run continue to completion.
      releaseStep1({ content: 'step 1 done', toolCalls: [] });

      // Reconnect with the last-seen cursor and read to the run's terminal
      // action frame.
      const sseB = await gateway.openEventStream(
        `/api/v1/events?runId=${runId}&since=${encodeURIComponent(runId)}:${lastSeenBeforeKill}`,
        { headers: authHeader(gateway) },
      );
      const framesAfterReconnect = await readUntil(sseB, isTerminalEvent);
      await sseB.close();

      expect(framesAfterReconnect.some(isTerminalEvent)).toBe(true);
      const seqsAfterReconnect = framesAfterReconnect.map((frame) => runSeqOf(frame));

      // No duplicates: nothing from before the cursor reappears.
      for (const seq of seqsAfterReconnect) {
        expect((seq ?? 0) > lastSeenBeforeKill).toBe(true);
      }

      // Ground truth: a third connection asking for a full replay from the
      // beginning sees exactly what the run emitted — the public wire
      // contract, never a private buffer read from this test.
      const sseC = await gateway.openEventStream(
        `/api/v1/events?runId=${runId}&since=${encodeURIComponent(runId)}:0`,
        { headers: authHeader(gateway) },
      );
      const groundTruthFrames = await readUntil(sseC, isTerminalEvent);
      await sseC.close();
      const groundTruthSeqs = groundTruthFrames
        .map((frame) => runSeqOf(frame))
        .sort((a, b) => (a ?? 0) - (b ?? 0));

      const combinedSeqs = [
        ...framesBeforeKill.map((frame) => runSeqOf(frame)),
        ...seqsAfterReconnect,
      ].sort((a, b) => (a ?? 0) - (b ?? 0));

      // No gap, no duplicate: the union across both real connections equals
      // the ground truth set exactly, on the event set/sequence numbers,
      // never wall-clock timing.
      expect(combinedSeqs).toEqual(groundTruthSeqs);
      expect(new Set(combinedSeqs).size).toBe(combinedSeqs.length);
    } finally {
      await gateway.stop();
    }
  });

  it('WebSocket: the union of frames across a killed and reconnected connection contains every externally meaningful event exactly once', async () => {
    const { generate, releaseStep1 } = createStepwiseBlockingGenerate();
    const gateway = await startLoopbackGateway({
      agents: {},
      generate,
      toolbox: createToolbox([createNextTool()]),
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const runId = await setUpBlockedRun(gateway);

      const wsA = await gateway.openWebSocket(`/ws?token=${gateway.authToken}`);
      const framesBeforeKill = await wsSubscribe(wsA, runId, 0, () => true);
      expect(framesBeforeKill.length).toBeGreaterThan(0);
      const lastSeenBeforeKill = Math.max(...framesBeforeKill.map((frame) => runSeqOf(frame) ?? 0));

      // Kill the REAL socket. Never an unsubscribe frame.
      wsA.close();
      await wsA.waitForClose();

      releaseStep1({ content: 'step 1 done', toolCalls: [] });

      const wsB = await gateway.openWebSocket(`/ws?token=${gateway.authToken}`);
      const framesAfterReconnect = await wsSubscribe(
        wsB,
        runId,
        lastSeenBeforeKill,
        isTerminalEvent,
      );
      wsB.close();
      await wsB.waitForClose();

      expect(framesAfterReconnect.some(isTerminalEvent)).toBe(true);
      const seqsAfterReconnect = framesAfterReconnect.map((frame) => runSeqOf(frame));

      for (const seq of seqsAfterReconnect) {
        expect((seq ?? 0) > lastSeenBeforeKill).toBe(true);
      }

      const wsC = await gateway.openWebSocket(`/ws?token=${gateway.authToken}`);
      const groundTruthFrames = await wsSubscribe(wsC, runId, 0, isTerminalEvent);
      wsC.close();
      await wsC.waitForClose();
      const groundTruthSeqs = groundTruthFrames
        .map((frame) => runSeqOf(frame))
        .sort((a, b) => (a ?? 0) - (b ?? 0));

      const combinedSeqs = [
        ...framesBeforeKill.map((frame) => runSeqOf(frame)),
        ...seqsAfterReconnect,
      ].sort((a, b) => (a ?? 0) - (b ?? 0));

      expect(combinedSeqs).toEqual(groundTruthSeqs);
      expect(new Set(combinedSeqs).size).toBe(combinedSeqs.length);
    } finally {
      await gateway.stop();
    }
  });
});
