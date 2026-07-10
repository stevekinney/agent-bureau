import { createTool, createToolbox } from 'armorer';
import type { ServerWebSocket } from 'bun';
import { describe, expect, it } from 'bun:test';
import { createBureau } from 'bureau';
import { waitForCondition, waitForRunState } from 'bureau/test';
import { stopWhen, type Toolbox } from 'operative';
import { createStepwiseBlockingGenerate } from 'operative/test';
import { z } from 'zod';

import { LiveFrameBroker } from './live-events';
import type { ServerFrame } from './types';
import { createWebSocketHandler } from './websocket/handler';

/**
 * AB-15 integration test: kills a live connection mid-generation, reconnects
 * with a replay cursor, and asserts the reconnected client sees every
 * frame the run emitted exactly once — no loss, no duplicates — for both
 * transports the door supports (WebSocket and SSE).
 *
 * Uses a real `bureau` (not a stub) wired into a real `LiveFrameBroker`
 * exactly as `create-gateway.ts` wires them, so this exercises the actual
 * runSeq stamping (`create-bureau.ts`) together with the actual replay
 * buffering (`live-events.ts` / `websocket/handler.ts`) — the two halves
 * of "gateway + bureau" the acceptance criteria call out.
 */

/** A no-op `next` tool that lets the run take more than one step. */
function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

async function readSseFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<ServerFrame[]> {
  const decoder = new TextDecoder();
  const frames: ServerFrame[] = [];
  let buffer = '';

  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by a blank line; only `data:` lines carry a frame.
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const raw of events) {
      const dataLine = raw.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) {
        continue;
      }
      frames.push(JSON.parse(dataLine.slice('data: '.length)) as ServerFrame);
    }
  }

  return frames;
}

function runSeqOf(frame: ServerFrame): number | undefined {
  return 'runSeq' in frame ? frame.runSeq : undefined;
}

async function setUpBlockedRun() {
  const { generate, releaseStep1 } = createStepwiseBlockingGenerate();
  const bureau = await createBureau({
    generate,
    toolbox: createToolbox([createNextTool()]) as unknown as Toolbox,
    stopWhen: stopWhen.noToolCalls(),
  });

  const broker = new LiveFrameBroker();
  const unsubscribe = bureau.subscribeLiveFrames((frame) => broker.broadcast(frame));

  const summary = await bureau.createRun({ message: 'go' });
  const runId = summary.id;

  // Let step 0 (immediate tool call) finish before the test takes control —
  // the run is now parked at step 1's blocked generate call.
  await waitForCondition(
    () => (bureau.store.getRun(runId)?.steps.length ?? 0) >= 1,
    'step 0 never completed',
  );

  return { bureau, broker, runId, releaseStep1, unsubscribe };
}

async function finishRun(bureau: Awaited<ReturnType<typeof createBureau>>, runId: string) {
  await waitForRunState(bureau, runId);
  // Drain deferred session-persistence listeners.
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('AB-15 resumable streaming: reconnect replays missed frames', () => {
  it('SSE: zero frame loss and no duplicates across a kill + reconnect', async () => {
    const { bureau, broker, runId, releaseStep1, unsubscribe } = await setUpBlockedRun();

    try {
      // Explicit `since=<runId>:0` — this connection wants a full replay from
      // the beginning (AB-15: an omitted `since` means "fresh subscribe, no
      // replay", so a genuine "reconnect from the start" must say so).
      const requestA = new Request(
        `http://example.test/api/v1/events?runId=${runId}&since=${encodeURIComponent(runId)}:0`,
      );
      const responseA = broker.createEventStreamResponse(requestA, { runIds: [runId] });
      const readerA = responseA.body?.getReader();
      expect(readerA).toBeDefined();
      if (!readerA) return;

      // Drain whatever step-0 frames already arrived (run.started, at least
      // one step.completed for the tool call) before killing the connection.
      const framesBeforeKill = await readSseFrames(readerA, 1);
      expect(framesBeforeKill.length).toBeGreaterThan(0);
      const lastSeenBeforeKill = Math.max(...framesBeforeKill.map((frame) => runSeqOf(frame) ?? 0));

      // Kill the connection — simulates a dropped tab/network blip.
      await readerA.cancel();

      // While NO ONE is subscribed, let the run continue to completion. Every
      // frame emitted here must still land in the replay buffer (broadcast()
      // records unconditionally, not just when there are live subscribers).
      releaseStep1({ content: 'step 1 done', toolCalls: [] });
      await finishRun(bureau, runId);

      // Reconnect with the last-seen cursor.
      const requestB = new Request(
        `http://example.test/api/v1/events?runId=${runId}&since=${encodeURIComponent(runId)}:${lastSeenBeforeKill}`,
      );
      const responseB = broker.createEventStreamResponse(requestB, { runIds: [runId] });
      const readerB = responseB.body?.getReader();
      expect(readerB).toBeDefined();
      if (!readerB) return;

      // Everything the run emitted after `lastSeenBeforeKill` must show up.
      const expectedRemaining = broker
        .getFramesSince(runId, lastSeenBeforeKill)
        .map((frame) => runSeqOf(frame));
      expect(expectedRemaining.length).toBeGreaterThan(0);

      const framesAfterReconnect = await readSseFrames(readerB, expectedRemaining.length);
      await readerB.cancel();

      const seqsAfterReconnect = framesAfterReconnect.map((frame) => runSeqOf(frame));

      // No loss: every frame the run emitted after the cursor shows up.
      expect(seqsAfterReconnect).toEqual(expectedRemaining);
      // No duplicates: nothing from before the cursor reappears.
      for (const seq of seqsAfterReconnect) {
        expect((seq ?? 0) > lastSeenBeforeKill).toBe(true);
      }
      // No duplicates across the two connections combined either.
      const allSeenSeqs = [
        ...framesBeforeKill.map((frame) => runSeqOf(frame)),
        ...seqsAfterReconnect,
      ];
      expect(new Set(allSeenSeqs).size).toBe(allSeenSeqs.length);
    } finally {
      unsubscribe();
      bureau.dispose();
    }
  });

  it('WebSocket: zero frame loss and no duplicates across a kill + reconnect', async () => {
    const { bureau, broker, runId, releaseStep1, unsubscribe } = await setUpBlockedRun();

    try {
      const handler = createWebSocketHandler({ broker });

      function createFakeSocket() {
        const sent: string[] = [];
        return {
          ws: { send: (data: string) => sent.push(data) } as unknown as ServerWebSocket<unknown>,
          sent,
        };
      }

      const connectionA = createFakeSocket();
      handler.open(connectionA.ws);
      // Explicit `since: 0` — AB-15 treats an omitted `since` as "fresh
      // subscribe, no replay", so a genuine "reconnect from the start" must
      // ask for it explicitly.
      handler.message(connectionA.ws, JSON.stringify({ type: 'subscribe', runId, since: 0 }));

      await waitForCondition(
        () => connectionA.sent.some((raw) => JSON.parse(raw).type === 'event'),
        'connection A never saw a run-scoped event frame',
      );

      const framesBeforeKill = connectionA.sent
        .map((raw) => JSON.parse(raw) as ServerFrame)
        .filter((frame) => 'runSeq' in frame);
      const lastSeenBeforeKill = Math.max(...framesBeforeKill.map((frame) => runSeqOf(frame) ?? 0));

      // Kill connection A.
      handler.close(connectionA.ws);

      // Run to completion while disconnected.
      releaseStep1({ content: 'step 1 done', toolCalls: [] });
      await finishRun(bureau, runId);

      // Reconnect on a fresh connection with the last-seen cursor.
      const connectionB = createFakeSocket();
      handler.open(connectionB.ws);
      handler.message(
        connectionB.ws,
        JSON.stringify({ type: 'subscribe', runId, since: lastSeenBeforeKill }),
      );

      const expectedRemaining = broker
        .getFramesSince(runId, lastSeenBeforeKill)
        .map((frame) => runSeqOf(frame));
      expect(expectedRemaining.length).toBeGreaterThan(0);

      const framesAfterReconnect = connectionB.sent
        .map((raw) => JSON.parse(raw) as ServerFrame)
        .filter((frame) => 'runSeq' in frame)
        .map((frame) => runSeqOf(frame));

      // No loss: exactly the missed frames, in order.
      expect(framesAfterReconnect).toEqual(expectedRemaining);
      // No duplicates: nothing before the cursor reappears on reconnect.
      for (const seq of framesAfterReconnect) {
        expect((seq ?? 0) > lastSeenBeforeKill).toBe(true);
      }
      // No duplicates across both connections combined.
      const allSeenSeqs = [
        ...framesBeforeKill.map((frame) => runSeqOf(frame)),
        ...framesAfterReconnect,
      ];
      expect(new Set(allSeenSeqs).size).toBe(allSeenSeqs.length);
    } finally {
      unsubscribe();
      bureau.dispose();
    }
  });
});
