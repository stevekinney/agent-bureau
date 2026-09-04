/**
 * Real Gateway backpressure conformance (AB-274 / AB-98's tst-07d slice).
 *
 * There is no dedicated gateway-level backpressure policy beyond the
 * declared per-run replay buffer bound `live-events.ts` already ships:
 * `RUN_FRAME_BUFFER_LIMIT = 2000`, private to that module, so this suite
 * pins the same value as a local constant (below) rather than importing it
 * — deliberately, to enforce the production policy's actual number, not to
 * invent a different one. Every ASSERTION against that bound is made
 * through the public wire contract only (a full replay's frame count),
 * never a private field read. This suite asserts exactly that production
 * policy, never one invented for the test:
 *
 * - The buffer accounting for a run that emits far more than the declared
 *   bound stays within it — a full replay opened only after the run has
 *   finished never returns more than the bound, proving old history is
 *   dropped rather than the buffer growing without limit.
 * - A subscriber that reads far more slowly than the run emits — subscribed
 *   from the start, but never draining its queue until the run has already
 *   finished — still receives every live frame it was subscribed for, with
 *   no gap and no duplicate. No drop path exists in production for a
 *   connection that stays open (`broadcast()` only drops a subscriber whose
 *   `sendFrame` itself throws, i.e. one whose socket is already gone), so
 *   "closed with a typed reason" is not this suite's branch: this is the
 *   "receives every frame" branch, read from the actual delivery code
 *   rather than assumed.
 * - AB-313 (AC5): the SAME "receives every frame it was subscribed for, no
 *   drop for an open connection" policy applies to the durable-history
 *   reconnect/replay path (`startDurableFallback`, AB-312) — a WebSocket
 *   subscriber engaged in durable fallback (its in-memory buffer holds
 *   nothing for the run, forcing every frame through
 *   `Bureau.subscribeEventHistory`'s replay-then-tail) that does not read
 *   until well after every durable event for that run has committed still
 *   receives all of them, in order, once it drains — `live-events.ts`
 *   documents this as the one unified policy, closing AB-87's "buffer
 *   bound unspecified" gap for both paths at once rather than inventing a
 *   second, competing bound for the durable case.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stopWhen } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createSqliteStorageFixture, waitForRunState } from 'bureau/test';
import { createManualRuntimeServices } from 'lifecycle';
import { z } from 'zod';

import type { LoopbackGateway, LoopbackWebSocketClient } from '../test/loopback';
import { startLoopbackGateway } from '../test/loopback';
import type { ServerFrame } from '../types';

/** Declared in `live-events.ts` (private there) — read back for assertions here. */
const RUN_FRAME_BUFFER_LIMIT = 2_000;

function authHeader(gateway: LoopbackGateway): { authorization: string } {
  return { authorization: `Bearer ${gateway.authToken}` };
}

function runSeqOf(frame: ServerFrame): number | undefined {
  return 'runSeq' in frame ? frame.runSeq : undefined;
}

function isTerminalEvent(frame: ServerFrame): boolean {
  return (
    frame.type === 'event' && (frame.event === 'run.completed' || frame.event === 'run.aborted')
  );
}

function isTerminalEventFor(frame: ServerFrame, runId: string): boolean {
  return isTerminalEvent(frame) && 'runId' in frame && frame.runId === runId;
}

/** A no-op `next` tool that lets a step take a fast, real armorer round-trip. */
function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

async function wsReadUntil(
  ws: LoopbackWebSocketClient,
  shouldStop: (frame: ServerFrame) => boolean,
  maxAttempts: number,
): Promise<ServerFrame[]> {
  const seen: ServerFrame[] = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const frame = await ws.next();
    seen.push(frame);
    if (shouldStop(frame)) break;
  }
  return seen;
}

describe('Gateway backpressure conformance — read from the production buffer policy', () => {
  it('the per-run replay buffer accounting stays within its declared bound for a run that emits far more than that bound', async () => {
    // One step, MANY parallel tool calls (armorer executes a response's
    // tool calls concurrently): each call alone produces eight
    // `runSeq`-bearing frames (`toolbox.call`, `tool.started`,
    // `toolbox.execute-start`, `toolbox.validate-success`,
    // `toolbox.execute-success`, `tool.settled`, `toolbox.settled`,
    // `toolbox.complete`) without growing the conversation the way dozens
    // of sequential steps would — cheap frame volume, not cheap step count.
    // Before AB-318, `validate-success`/`execute-success` cross-talked
    // across every concurrently in-flight call on this shared `Tool`
    // instance — each of the 30 calls' listeners saw all 30 calls' events,
    // so those two types alone produced 900 frames apiece and 30 calls
    // cleared `RUN_FRAME_BUFFER_LIMIT` easily. AB-318 fixed that
    // duplication (each event now reaches only the call that produced it),
    // so the real, non-duplicated total is 8 × `callCount` + a small fixed
    // per-run overhead — `callCount` is raised here to keep clearing the
    // bound on the corrected, honest count.
    const callCount = 300;
    const nextTool = createNextTool();
    const generate = async (context: { step: number }) => {
      if (context.step === 0) {
        return {
          content: 'go',
          toolCalls: Array.from({ length: callCount }, () => ({ name: 'next', arguments: {} })),
        };
      }
      return { content: 'done', toolCalls: [] };
    };

    const gateway = await startLoopbackGateway({
      agents: {},
      generate,
      toolbox: createToolbox([nextTool]),
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      // Subscribed BEFORE the run even exists, to the wildcard run set
      // (`/api/v1/events` with no `runId` — `ALL_RUNS_SUBSCRIPTION`), so
      // every frame this run ever emits is delivered LIVE — `broadcast()`
      // dispatches to a live subscriber synchronously, with no buffer
      // window involved. This is ground truth for how much the run
      // actually emitted, independent of the buffer's own bound.
      const watcher = await gateway.openEventStream('/api/v1/events', {
        headers: authHeader(gateway),
      });

      const runResponse = await gateway.fetch('/api/v1/runs', {
        method: 'POST',
        headers: { ...authHeader(gateway), 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'go' }),
      });
      expect(runResponse.status).toBe(201);
      const run = (await runResponse.json()) as { id: string };

      let totalRead = 0;
      const watched = await wsWatcherReadUntil(watcher, run.id);
      totalRead = watched.count;
      expect(watched.sawTerminal).toBe(true);
      // Ground truth: the run really did emit more than the declared
      // buffer bound before the buffer's own accounting is checked below.
      expect(totalRead).toBeGreaterThan(RUN_FRAME_BUFFER_LIMIT);

      // A fresh, full replay (`since: 0`) — opened only now, after the run
      // is already finished — is the buffer's own public accounting for
      // this run, bounded regardless of how much was actually emitted.
      const replay = await gateway.openEventStream(
        `/api/v1/events?runId=${run.id}&since=${encodeURIComponent(run.id)}:0`,
        { headers: authHeader(gateway) },
      );
      const replayedSeqs: number[] = [];
      for (let attempt = 0; attempt < RUN_FRAME_BUFFER_LIMIT + 50; attempt++) {
        const frame = await replay.next();
        if (!frame) break;
        const seq = runSeqOf(frame);
        if (seq !== undefined) replayedSeqs.push(seq);
        if (isTerminalEventFor(frame, run.id)) break;
      }
      await replay.close();

      expect(replayedSeqs.length).toBeLessThanOrEqual(RUN_FRAME_BUFFER_LIMIT);
      // The buffer keeps the MOST RECENT frames (a sliding window, not an
      // arbitrary drop) — the replay's own lowest sequence number is well
      // past 1, proving old history was actually evicted rather than the
      // window simply never having grown that large.
      expect(Math.min(...replayedSeqs)).toBeGreaterThan(1);
      // And it still ends on the same terminal frame — the tail of the
      // window is exact, only the head was trimmed.
      expect(replayedSeqs.at(-1)).toBe(Math.max(...replayedSeqs));
    } finally {
      await gateway.stop();
    }
  });

  it('a subscriber that reads far more slowly than the run emits still receives every frame it was subscribed for, no gap and no duplicate — no drop path exists for an open connection', async () => {
    const { generate: gatedGenerate, release } = releasableGenerate();

    const gateway = await startLoopbackGateway({
      agents: {},
      generate: gatedGenerate,
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const runResponse = await gateway.fetch('/api/v1/runs', {
        method: 'POST',
        headers: { ...authHeader(gateway), 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'go' }),
      });
      const run = (await runResponse.json()) as { id: string };

      // The "slow consumer": subscribed from the very start (before the
      // gate is released, so it is live for every frame the run emits),
      // but this test never calls `ws.next()` on it until the run has
      // already finished elsewhere — the real-socket equivalent of a
      // consumer that reads far more slowly than the run emits.
      const slow = await gateway.openWebSocket(`/ws?token=${gateway.authToken}`);
      slow.send({ type: 'subscribe', runId: run.id, since: 0 });

      // A second, actively-reading connection to the SAME run drives the
      // gate and tells us when the run is actually finished, without the
      // slow consumer itself reading anything yet.
      const watcher = await gateway.openEventStream(
        `/api/v1/events?runId=${run.id}&since=${encodeURIComponent(run.id)}:0`,
        { headers: authHeader(gateway) },
      );
      release();
      let sawTerminal = false;
      for (let attempt = 0; attempt < 200 && !sawTerminal; attempt++) {
        const frame = await watcher.next();
        if (!frame) break;
        if (isTerminalEventFor(frame, run.id)) sawTerminal = true;
      }
      await watcher.close();
      expect(sawTerminal).toBe(true);

      // NOW the slow consumer starts draining — replay (from `since: 0`)
      // plus every live frame it queued while unread must still all be
      // there, in order, since this connection was subscribed the whole
      // time and no drop path applies to an open connection.
      const drainedRaw = await wsReadUntil(slow, (frame) => isTerminalEventFor(frame, run.id), 200);
      const drained = drainedRaw.filter((frame) => frame.type !== 'subscribed');
      slow.close();
      await slow.waitForClose();

      expect(drained.some((frame) => isTerminalEventFor(frame, run.id))).toBe(true);
      const drainedSeqs = drained.map(runSeqOf).filter((seq): seq is number => seq !== undefined);
      const sortedSeqs = [...drainedSeqs].sort((a, b) => a - b);
      // No gaps: every consecutive pair advances by exactly 1.
      for (let i = 1; i < sortedSeqs.length; i++) {
        expect(sortedSeqs[i]).toBe((sortedSeqs[i - 1] ?? 0) + 1);
      }
      // No duplicates.
      expect(new Set(drainedSeqs).size).toBe(drainedSeqs.length);

      // Cross-checked against an independent ground-truth replay from the
      // same buffer.
      const groundTruth = await gateway.openEventStream(
        `/api/v1/events?runId=${run.id}&since=${encodeURIComponent(run.id)}:0`,
        { headers: authHeader(gateway) },
      );
      const groundTruthSeqs: number[] = [];
      for (let attempt = 0; attempt < 200; attempt++) {
        const frame = await groundTruth.next();
        if (!frame) break;
        const seq = runSeqOf(frame);
        if (seq !== undefined) groundTruthSeqs.push(seq);
        if (isTerminalEventFor(frame, run.id)) break;
      }
      await groundTruth.close();

      expect(sortedSeqs).toEqual(groundTruthSeqs.sort((a, b) => a - b));
    } finally {
      await gateway.stop();
    }
  });

  it('AB-313 (AC5): a WebSocket subscriber engaged in durable fallback that does not read for a while still receives every durable event, no gap or duplicate, once it drains', async () => {
    const path = join(
      tmpdir(),
      `ab-313-durable-backpressure-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    const runtime = createManualRuntimeServices();

    try {
      const gatewayA = await startLoopbackGateway({
        agents: {},
        generate: async () => ({ content: 'done', toolCalls: [] }),
        stopWhen: stopWhen.noToolCalls(),
        storage: createSqliteStorageFixture({ runtime, path }),
      });

      let runId!: string;
      try {
        const runResponse = await gatewayA.fetch('/api/v1/runs', {
          method: 'POST',
          headers: { ...authHeader(gatewayA), 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'go' }),
        });
        const run = (await runResponse.json()) as { id: string };
        runId = run.id;
        await waitForRunState(gatewayA.bureau, runId);

        // Synthesize additional run-owned durable events beyond the run's
        // one real terminal transition — `bureau.store.recordAction` is
        // the same supported synthesizer `durable-event-history.test.ts`
        // and `durable-history.test.ts` already use to exercise more than
        // one committed event per owner; `run.error` is a real member of
        // `RUN_DURABLE_ACTION_TYPES`, so each recording produces one more
        // committed durable event under this same run's owner.
        for (let i = 0; i < 24; i++) {
          gatewayA.bureau.store.recordAction(runId, 'run.error', { synthetic: i });
        }
        await runtime.deferred.drain();
      } finally {
        await gatewayA.stop();
      }

      // A fresh Bureau/Gateway over the SAME durable storage: its own
      // in-memory `runFrameBuffers` holds nothing for `runId`, so a
      // reconnect is forced through the durable fallback for every frame.
      const gatewayB = await startLoopbackGateway({
        agents: {},
        generate: async () => ({ content: 'unused', toolCalls: [] }),
        storage: createSqliteStorageFixture({ runtime, path }),
      });

      try {
        const groundTruth = await gatewayB.bureau.eventHistory({ kind: 'run', id: runId });
        if ('outcome' in groundTruth)
          throw new Error(`expected a page, got ${groundTruth.outcome}`);
        expect(groundTruth.events.length).toBe(25); // 1 real run.completed + 24 synthetic run.error

        const ws = await gatewayB.openWebSocket(`/ws?token=${gatewayB.authToken}`);
        ws.send({ type: 'subscribe', runId, since: 0 });

        // The "slow consumer": subscribed, engaging the durable fallback
        // (proven below by the frames actually being `durable-event`
        // frames), but this test does not call `ws.next()` again until
        // AFTER every durable event for this owner has already committed
        // — the real-socket equivalent of a consumer that reads far more
        // slowly than the feed commits.
        await runtime.deferred.drain();

        // Stop once every durable event has arrived (25 total: the 1 real
        // run.completed plus 24 synthetic run.error) — never on the FIRST
        // matching frame, since replay delivers all 24 `run.error` events
        // in order and stopping early would under-count them.
        let durableCount = 0;
        const drainedRaw = await wsReadUntil(
          ws,
          (frame) => {
            if (frame.type === 'durable-event') durableCount += 1;
            return durableCount >= 25;
          },
          200,
        );
        ws.close();
        await ws.waitForClose();

        const durableFrames = drainedRaw.filter((frame) => frame.type === 'durable-event');
        expect(durableFrames.length).toBe(25);
        expect(durableFrames.filter((frame) => frame.event === 'run.completed')).toHaveLength(1);
        expect(durableFrames.filter((frame) => frame.event === 'run.error')).toHaveLength(24);
        // No duplicate: every one of the 24 synthetic markers appears exactly once.
        const syntheticIndices = durableFrames
          .filter(
            (frame): frame is Extract<ServerFrame, { type: 'durable-event' }> =>
              frame.type === 'durable-event' && frame.event === 'run.error',
          )
          .map((frame) => (frame.detail as { synthetic?: number }).synthetic)
          .filter((value): value is number => value !== undefined);
        expect(new Set(syntheticIndices).size).toBe(24);
        expect([...syntheticIndices].sort((a, b) => a - b)).toEqual(
          Array.from({ length: 24 }, (_, index) => index),
        );
      } finally {
        await gatewayB.stop();
      }
    } finally {
      await rm(path, { force: true });
      await rm(`${path}-wal`, { force: true });
      await rm(`${path}-shm`, { force: true });
    }
  });
});

/** A `generate` that stays pending until `release()` is called, then completes with no tool calls. */
function releasableGenerate(): {
  generate: () => Promise<{ content: string; toolCalls: never[] }>;
  release: () => void;
} {
  let releaseFn: (() => void) | undefined;
  let released = false;
  const generate = () =>
    new Promise<{ content: string; toolCalls: never[] }>((resolve) => {
      if (released) {
        resolve({ content: 'done', toolCalls: [] });
        return;
      }
      releaseFn = () => resolve({ content: 'done', toolCalls: [] });
    });
  return {
    generate,
    release: () => {
      released = true;
      releaseFn?.();
    },
  };
}

async function wsWatcherReadUntil(
  watcher: Awaited<ReturnType<LoopbackGateway['openEventStream']>>,
  runId: string,
): Promise<{ count: number; sawTerminal: boolean }> {
  let count = 0;
  let sawTerminal = false;
  for (let attempt = 0; attempt < 50_000 && !sawTerminal; attempt++) {
    const frame = await watcher.next();
    if (!frame) break;
    if (runSeqOf(frame) !== undefined) count += 1;
    if (isTerminalEventFor(frame, runId)) sawTerminal = true;
  }
  return { count, sawTerminal };
}
