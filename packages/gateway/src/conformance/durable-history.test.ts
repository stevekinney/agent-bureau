/**
 * Durable-event-history Gateway conformance (AB-312).
 *
 * Two things this suite proves over a REAL loopback gateway (AB-272's
 * harness), never a synthetic broker/route unit test:
 *
 * - Paging a schedule owner's durable definition events through
 *   `GET /api/v1/schedules/:id/events` (the coordinator's 2026-09-03
 *   amendment on this issue) — including `limit`-bounded pagination via
 *   `hasMore`/`nextCursor`.
 * - The SSE and WebSocket reconnect-across-restart fallback: the Gateway
 *   process's Bureau is torn down and a FRESH one is constructed over the
 *   SAME durable storage backend (an in-process double of a restart,
 *   matching `durable-event-history.test.ts`'s own SQLite reopen pattern —
 *   a real process-kill proof is AB-275's, out of scope here), and a new
 *   client reconnecting with the last-observed cursor sees the run's
 *   terminal durable event exactly once — no gap, no duplicate. The client
 *   disconnects BEFORE the run's terminal action (a blocked step, released
 *   only after disconnect) so the terminal event is durably recorded while
 *   nobody is connected — the only way "exactly once across both
 *   connections" is a meaningful assertion rather than a tautology.
 *
 * Requires PERSISTENT storage (sqlite, with an explicit `path` so
 * `LoopbackGateway.stop()`'s own unconditional `storage.dispose()` is a
 * no-op — see `storage-fixtures.ts`'s `owned` doc comment): durable event
 * history composes only over a backend whose `capabilities().persistence
 * !== 'ephemeral'` (`create-bureau.ts`), and reopening "the same backend"
 * across two Bureau instances requires a real file, not `{ type: 'memory'
 * }`, which starts empty every time. A persistent backend also makes every
 * run on that bureau durable-engine-executed (`runtime.durable` composed
 * whenever storage is persistent) — `createStepwiseBlockingGenerate`'s
 * blocking `Promise` is still safe here: nothing actually restarts the
 * process until AFTER the run has run to completion in one continuous
 * execution: durable replay is exercised on retention/paging, not on this
 * step boundary.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stopWhen } from '@lostgradient/operative';
import type { DurableEventPage } from '@lostgradient/operative/durable';
import { createStepwiseBlockingGenerate, waitForCondition } from '@lostgradient/operative/test';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createSqliteStorageFixture, waitForRunState } from 'bureau/test';
import { createManualRuntimeServices } from 'lifecycle';
import { z } from 'zod';

import type {
  LoopbackGateway,
  LoopbackWebSocketClient,
  ServerEventStreamReader,
} from '../test/loopback';
import { startLoopbackGateway } from '../test/loopback';
import type { ServerFrame } from '../types';

/** A no-op `next` tool that lets the run take more than one step, matching `reconnect.test.ts`'s own fixture. */
function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

function authHeader(gateway: LoopbackGateway): { authorization: string } {
  return { authorization: `Bearer ${gateway.authToken}` };
}

function allocateSqlitePath(): string {
  return join(
    tmpdir(),
    `ab-312-durable-history-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

async function removeSqliteFiles(path: string): Promise<void> {
  await rm(path, { force: true });
  await rm(`${path}-wal`, { force: true });
  await rm(`${path}-shm`, { force: true });
}

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

function isLiveRunCompleted(frame: ServerFrame): boolean {
  return frame.type === 'event' && frame.event === 'run.completed';
}

function isDurableRunCompleted(frame: ServerFrame): boolean {
  return frame.type === 'durable-event' && frame.event === 'run.completed';
}

/**
 * Polls `gateway.bureau.eventHistory({ kind: 'run', id: runId })` until it
 * returns a non-empty page (bounded, via `waitForCondition` — never a real
 * sleep). The durable producer's write is a fire-and-forget listener off
 * the same action that settles the run (`waitForRunState` above), so its
 * own commit can land a turn or two after the run itself already reads as
 * terminal.
 */
async function waitForDurableRunCompleted(
  gateway: LoopbackGateway,
  runId: string,
): Promise<DurableEventPage> {
  let page: DurableEventPage | undefined;
  await waitForCondition(async () => {
    const outcome = await gateway.bureau.eventHistory({ kind: 'run', id: runId });
    if ('outcome' in outcome) {
      throw new Error(
        `expected a durable page for run "${runId}", got outcome "${outcome.outcome}"`,
      );
    }
    if (outcome.events.length === 0) return false;
    page = outcome;
    return true;
  }, `Durable event history for run "${runId}" never became non-empty`);

  if (!page) throw new Error(`Durable event history for run "${runId}" never became non-empty`);
  return page;
}

async function setUpBlockedRun(gateway: LoopbackGateway): Promise<string> {
  const runResponse = await gateway.fetch('/api/v1/runs', {
    method: 'POST',
    headers: { ...authHeader(gateway), 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'go' }),
  });
  expect(runResponse.status).toBe(201);
  const run = (await runResponse.json()) as { id: string };
  return run.id;
}

describe('Gateway durable event history conformance (AB-312)', () => {
  it("pages a schedule owner's durable definition events, including limit-bounded continuation", async () => {
    const path = allocateSqlitePath();
    const runtime = createManualRuntimeServices();
    const gateway = await startLoopbackGateway({
      agents: {},
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      storage: createSqliteStorageFixture({ runtime, path }),
    });

    try {
      const createResponse = await gateway.fetch('/schedules', {
        method: 'POST',
        headers: { ...authHeader(gateway), 'content-type': 'application/json' },
        body: JSON.stringify({ agentName: 'bureau', input: 'daily check', spec: '6h' }),
      });
      expect(createResponse.status).toBe(201);
      const schedule = (await createResponse.json()) as { id: string };

      const pauseResponse = await gateway.fetch(`/schedules/${schedule.id}/pause`, {
        method: 'POST',
        headers: authHeader(gateway),
      });
      expect(pauseResponse.status).toBe(200);

      const resumeResponse = await gateway.fetch(`/schedules/${schedule.id}/resume`, {
        method: 'POST',
        headers: authHeader(gateway),
      });
      expect(resumeResponse.status).toBe(200);

      // Full page: all three definition events, in order, no fire ever
      // recorded under this owner.
      const fullPageResponse = await gateway.fetch(`/api/v1/schedules/${schedule.id}/events`, {
        headers: authHeader(gateway),
      });
      expect(fullPageResponse.status).toBe(200);
      const fullPage = (await fullPageResponse.json()) as DurableEventPage;
      expect(fullPage.events.map((event) => event.kind)).toEqual([
        'schedule.created',
        'schedule.paused',
        'schedule.resumed',
      ]);
      expect(fullPage.hasMore).toBe(false);
      expect(fullPage.nextCursor).toBeDefined();

      // Limit-bounded continuation: page 1 (limit 1) then page 2 from its
      // own `nextCursor` reaches the same total, with no gap or duplicate.
      const page1Response = await gateway.fetch(`/api/v1/schedules/${schedule.id}/events?limit=1`, {
        headers: authHeader(gateway),
      });
      const page1 = (await page1Response.json()) as DurableEventPage;
      expect(page1.events.map((event) => event.kind)).toEqual(['schedule.created']);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();

      const page2Response = await gateway.fetch(
        `/api/v1/schedules/${schedule.id}/events?since=${encodeURIComponent(page1.nextCursor ?? '')}`,
        { headers: authHeader(gateway) },
      );
      const page2 = (await page2Response.json()) as DurableEventPage;
      expect(page2.events.map((event) => event.kind)).toEqual([
        'schedule.paused',
        'schedule.resumed',
      ]);

      expect([...page1.events, ...page2.events].map((event) => event.kind)).toEqual(
        fullPage.events.map((event) => event.kind),
      );
    } finally {
      await gateway.stop();
      await removeSqliteFiles(path);
    }
  });

  it("SSE: a reconnect after the Gateway restarts over the same durable storage sees the run's terminal event exactly once via the durable fallback", async () => {
    const path = allocateSqlitePath();
    const runtime = createManualRuntimeServices();
    // Definite-assignment: always set inside the try block below, before
    // this outer scope's use of it in gatewayB's own reconnect request —
    // never read uninitialized.
    let runId!: string;

    try {
      const { generate, releaseStep1 } = createStepwiseBlockingGenerate();
      const gatewayA = await startLoopbackGateway({
        agents: {},
        generate,
        toolbox: createToolbox([createNextTool()]),
        stopWhen: stopWhen.noToolCalls(),
        storage: createSqliteStorageFixture({ runtime, path }),
      });

      try {
        runId = await setUpBlockedRun(gatewayA);

        // Client 1: read the run's own frames up to the point the step-1
        // block parks it, then disconnect — BEFORE the terminal action
        // exists anywhere, live or durable.
        const sseA = await gatewayA.openEventStream(
          `/api/v1/events?runId=${runId}&since=${encodeURIComponent(runId)}:0`,
          { headers: authHeader(gatewayA) },
        );
        const framesBeforeDisconnect = await readUntil(sseA, () => true, 1);
        expect(framesBeforeDisconnect.length).toBeGreaterThan(0);
        expect(framesBeforeDisconnect.some(isLiveRunCompleted)).toBe(false);
        await sseA.close();

        // Release the block and let the run finish while nobody is
        // connected — its terminal action is recorded durably with no
        // live subscriber to observe it.
        releaseStep1({ content: 'step 1 done', toolCalls: [] });
        await waitForRunState(gatewayA.bureau, runId);

        // Control: the terminal event landed durably before this process
        // stops — proves the producer's write committed, not merely that
        // a live frame was seen (it never was, by any connection). The
        // durable write is a fire-and-forget listener off the SAME action
        // that settled the run above, so this polls briefly rather than
        // assuming it has already landed by the time `waitForRunState`
        // resolves.
        const page = await waitForDurableRunCompleted(gatewayA, runId);
        expect(page.events.map((event) => event.kind)).toContain('run.completed');
      } finally {
        await gatewayA.stop();
      }

      // A fresh Bureau/Gateway over the SAME durable storage — this
      // process's own in-memory `runFrameBuffers` holds nothing at all for
      // `runId`, so any reconnect for it is an immediate gap.
      const gatewayB = await startLoopbackGateway({
        agents: {},
        generate: async () => ({ content: 'unused', toolCalls: [] }),
        storage: createSqliteStorageFixture({ runtime, path }),
      });

      try {
        const sseB = await gatewayB.openEventStream(
          `/api/v1/events?runId=${runId}&since=${encodeURIComponent(runId)}:0`,
          { headers: authHeader(gatewayB) },
        );
        const framesAfterReconnect = await readUntil(sseB, isDurableRunCompleted);
        await sseB.close();

        const durableCompletedFrames = framesAfterReconnect.filter(isDurableRunCompleted);
        expect(durableCompletedFrames).toHaveLength(1);
        // No duplicate live 'event' copy of the same terminal action — the
        // broadcast-suppression path (AB-312) owns that, and this run
        // never resumes execution in the new process (no durable resume
        // wiring in this loopback harness), so nothing else could emit one.
        expect(framesAfterReconnect.some(isLiveRunCompleted)).toBe(false);
      } finally {
        await gatewayB.stop();
      }
    } finally {
      await removeSqliteFiles(path);
    }
  });

  it("WebSocket: the same cross-restart reconnect sees the run's terminal event exactly once via the durable fallback", async () => {
    const path = allocateSqlitePath();
    const runtime = createManualRuntimeServices();
    // Definite-assignment: always set inside the try block below, before
    // this outer scope's use of it in gatewayB's own reconnect request —
    // never read uninitialized.
    let runId!: string;

    try {
      const { generate, releaseStep1 } = createStepwiseBlockingGenerate();
      const gatewayA = await startLoopbackGateway({
        agents: {},
        generate,
        toolbox: createToolbox([createNextTool()]),
        stopWhen: stopWhen.noToolCalls(),
        storage: createSqliteStorageFixture({ runtime, path }),
      });

      try {
        runId = await setUpBlockedRun(gatewayA);

        const wsA = await gatewayA.openWebSocket(`/ws?token=${gatewayA.authToken}`);
        wsA.send({ type: 'subscribe', runId, since: 0 });
        const framesBeforeDisconnect = await wsReadUntil(
          wsA,
          (frame) => frame.type === 'subscribed',
          1,
        );
        expect(framesBeforeDisconnect.some(isLiveRunCompleted)).toBe(false);
        wsA.close();
        await wsA.waitForClose();

        releaseStep1({ content: 'step 1 done', toolCalls: [] });
        await waitForRunState(gatewayA.bureau, runId);

        const page = await waitForDurableRunCompleted(gatewayA, runId);
        expect(page.events.map((event) => event.kind)).toContain('run.completed');
      } finally {
        await gatewayA.stop();
      }

      const gatewayB = await startLoopbackGateway({
        agents: {},
        generate: async () => ({ content: 'unused', toolCalls: [] }),
        storage: createSqliteStorageFixture({ runtime, path }),
      });

      try {
        const wsB = await gatewayB.openWebSocket(`/ws?token=${gatewayB.authToken}`);
        wsB.send({ type: 'subscribe', runId, since: 0 });
        const frames = await wsReadUntil(
          wsB,
          (frame) => frame.type === 'subscribed' || isDurableRunCompleted(frame),
        );
        const moreFrames = frames.some(isDurableRunCompleted)
          ? []
          : await wsReadUntil(wsB, isDurableRunCompleted);
        wsB.close();
        await wsB.waitForClose();

        const allFrames = [...frames, ...moreFrames];
        const durableCompletedFrames = allFrames.filter(isDurableRunCompleted);
        expect(durableCompletedFrames).toHaveLength(1);
        expect(allFrames.some(isLiveRunCompleted)).toBe(false);
      } finally {
        await gatewayB.stop();
      }
    } finally {
      await removeSqliteFiles(path);
    }
  });
});
