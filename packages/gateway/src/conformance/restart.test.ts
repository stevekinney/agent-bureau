/**
 * Gateway restart and durable-history replay conformance (AB-275).
 *
 * Unlike every other suite in this directory, this scenario never boots a
 * gateway in-process via `startLoopbackGateway` — the whole point of this
 * tier is a REAL process boundary. It reuses tst-06a's real-process crash
 * harness (`packages/integration/test/crash/harness.ts`/`fixture.ts`,
 * AB-270) rather than inventing a second one: `fixture.ts`'s `--gateway`
 * flag (AB-275) additionally starts a real `Gateway` — a real `Bun.serve`
 * loopback listener on an OS-assigned ephemeral port — over the SAME
 * bureau the crash fixture already builds, and reports the bound port in
 * its `'ready'` marker.
 *
 * The harness and fixture live in `packages/integration` (a sibling
 * package `gateway` cannot take a normal workspace dependency on — that
 * would be circular, since `packages/integration/package.json` now
 * depends on `gateway` itself to import `createGateway`), so this file
 * reaches them via a relative import rather than a package specifier. That
 * is the one designed coupling this issue's delivery boundary describes:
 * `restart.test.ts` (here) drives `runCrashScenario` (there) through its
 * `onMarker` hook.
 *
 * Scenario: a root run is started, killed with a real `SIGKILL` at the
 * `'checkpoint-committed'` marker, and recovered in a fresh process over
 * the SAME SQLite backend. The recovered run is driven to cancellation
 * (this fixture's own one linear scenario), which durably records exactly
 * one event for the run: `run.aborted` (`RUN_DURABLE_ACTION_TYPES` in
 * `bureau/src/durable-event-history.ts` — the only durable kind this
 * scenario's own fixture can ever reach). Everything below is built around
 * that one terminal fact:
 *
 * - Positive: durable history is paged from the last cursor a real client
 *   observed on the FIRST process (empty — nothing durable exists yet),
 *   then a real SSE and a real WebSocket tail are opened BEFORE the
 *   fixture's own park is answered with `cancel` — so nothing durable can
 *   commit between "the page" and "the tail starts covering." The union of
 *   that page and each tail contains `run.aborted` exactly once, over BOTH
 *   transports, checked by stable identity (`kind`, `owner.kind`,
 *   `owner.id` — never a sequence number; AB-91/AB-312's durable `sequence`
 *   and the live broker's `runSeq` are unrelated counters, per this
 *   issue's own coordinator ruling).
 * - Negative (written first, per this issue's testing plan): the SAME
 *   page is retaken AFTER the tails have already delivered `run.aborted`
 *   — i.e. the paging boundary is deliberately shifted one event too late,
 *   the concrete way an off-by-one in "the last cursor observed" surfaces
 *   here (this scenario's run reaches at most one durable event ever, so
 *   there is no earlier boundary to skip past into a gap — only a later
 *   one to double-count into a duplicate). `assertUnionExactlyOnce` must
 *   throw for that union and must NOT throw for the correct one, proving
 *   the identity check is load-bearing rather than vacuously true.
 *
 * AC6 (idempotent command retry across a restart) is OUT of this issue's
 * scope per the coordinator's 2026-09-04 ruling — that is AB-109's
 * territory (durable external command receipts), not faked or built here.
 *
 * `[nightly]`: this scenario launches two real OS processes and sends a
 * real `SIGKILL`, the same cadence-split shape AB-282 already gave the
 * crash-conformance lane. The pull-request lane's `test:gateway-conformance`
 * invocation excludes every `[nightly]`-tagged test by name pattern;
 * `nightly.yml`'s `gateway-conformance-full` job runs this lane unfiltered.
 * See `documentation/testing-cadence.md`.
 */
import type { DurableEventEnvelope, DurableEventPage } from '@lostgradient/operative/durable';
import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import { runCrashScenario } from '../../../integration/test/crash/harness';
import {
  CRASH_FIXTURE_GATEWAY_AUTH_TOKEN,
  type CrashMarker,
} from '../../../integration/test/crash/protocol';
import { readEventStream, wrapWebSocket } from '../test/loopback';
import type { ServerFrame } from '../types';

/** Bounds every real-socket read below — never used to ORDER an assertion, only to stop a genuinely stuck read from hanging the suite forever. */
const TAIL_READ_BOUND_MS = 15_000;

interface FixtureGatewayClient {
  page(runId: string, since?: string): Promise<DurableEventPage>;
  openEventStream(path: string): Promise<ReturnType<typeof readEventStream>>;
  openWebSocket(path: string): Promise<ReturnType<typeof wrapWebSocket>>;
}

function connectFixtureGateway(port: number): FixtureGatewayClient {
  const url = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;
  const authorization = `Bearer ${CRASH_FIXTURE_GATEWAY_AUTH_TOKEN}`;

  return {
    async page(runId, since) {
      const query = since !== undefined ? `?since=${encodeURIComponent(since)}` : '';
      const response = await fetch(`${url}/api/v1/runs/${runId}/events${query}`, {
        headers: { authorization },
      });
      if (!response.ok) {
        throw new Error(
          `restart conformance: paging "${runId}" failed with status ${response.status}`,
        );
      }
      return (await response.json()) as DurableEventPage;
    },
    async openEventStream(path) {
      const headers = new Headers({ authorization });
      headers.set('accept', 'text/event-stream');
      const response = await fetch(`${url}${path}`, { headers });
      if (!response.ok) {
        throw new Error(`restart conformance: SSE "${path}" failed with status ${response.status}`);
      }
      return readEventStream(response);
    },
    async openWebSocket(path) {
      const socket = new WebSocket(`${wsUrl}${path}`);
      await new Promise<void>((resolve, reject) => {
        const failed = (): void =>
          reject(new Error(`restart conformance: WebSocket "${path}" failed to connect`));
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', failed, { once: true });
        // A rejected upgrade fires 'close' without ever firing 'error' on Bun's
        // WebSocket — mirrors `startLoopbackGateway.openWebSocket`'s own guard.
        socket.addEventListener('close', failed, { once: true });
      });
      return wrapWebSocket(socket);
    },
  };
}

/** `(kind, owner.kind, owner.id)` — the coordinator's stable durable-event identity, never `sequence`. */
function identityOfEnvelope(envelope: DurableEventEnvelope): string {
  return `${envelope.kind}:${envelope.owner.kind}:${envelope.owner.id}`;
}

/** The `'durable-event'` frame's own equivalent identity (`event`, `'run'`, `runId`), matching {@link identityOfEnvelope}. `undefined` for any other frame type (e.g. a live `'event'`/`'subscribed'` frame), which callers filter out. */
function identityOfDurableFrame(frame: ServerFrame): string | undefined {
  return frame.type === 'durable-event' ? `${frame.event}:run:${frame.runId}` : undefined;
}

/**
 * Throws when `identities` does not cover `oracle` exactly once each — a
 * gap (an oracle identity missing entirely) or a duplicate (any identity
 * appearing more than once) both throw. This is the assertion the
 * deliberate off-by-one below must both trip (negative) and pass through
 * cleanly (positive) for the scenario to be honest.
 */
function assertUnionExactlyOnce(identities: readonly string[], oracle: ReadonlySet<string>): void {
  const counts = new Map<string, number>();
  for (const identity of identities) {
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  for (const expected of oracle) {
    const count = counts.get(expected) ?? 0;
    if (count === 0) {
      throw new Error(`restart conformance: durable event "${expected}" is missing (a gap)`);
    }
    if (count > 1) {
      throw new Error(
        `restart conformance: durable event "${expected}" appeared ${count} times (a duplicate)`,
      );
    }
  }
  for (const identity of counts.keys()) {
    if (!oracle.has(identity)) {
      throw new Error(`restart conformance: unexpected durable event "${identity}"`);
    }
  }
}

/** Reads real SSE/WebSocket frames, bounded by `signal`, until one satisfies `isMatch` — never a sleep, never a fixed attempt count standing in for a real bound. */
async function readTailUntil(
  next: (signal?: AbortSignal) => Promise<ServerFrame | undefined>,
  isMatch: (frame: ServerFrame) => boolean,
  signal: AbortSignal,
): Promise<ServerFrame[]> {
  const seen: ServerFrame[] = [];
  for (;;) {
    const frame = await next(signal);
    if (!frame) return seen;
    seen.push(frame);
    if (isMatch(frame)) return seen;
  }
}

describe('Gateway restart and durable-history replay conformance (AB-275)', () => {
  it('[nightly] real SIGKILL, fresh process over the same SQLite backend: paging-to-tailing is gap-free and duplicate-free over SSE and WebSocket, honesty-checked by a deliberate one-event-late page', async () => {
    const runtime = createManualRuntimeServices();

    let gen1Port: number | undefined;
    let gen2Port: number | undefined;
    let runId: string | undefined;
    let cursorObservedByFirstClient: string | undefined;

    let sseTail: Awaited<ReturnType<FixtureGatewayClient['openEventStream']>> | undefined;
    let wsTail: Awaited<ReturnType<FixtureGatewayClient['openWebSocket']>> | undefined;
    let pageBeforeCancel: DurableEventPage | undefined;
    let sseFramesSeen: ServerFrame[] = [];
    let wsFramesSeen: ServerFrame[] = [];
    let pageAfterCancel: DurableEventPage | undefined;

    const report = await runCrashScenario({
      killAtMarker: 'checkpoint-committed',
      runtime,
      gateway: true,
      onMarker: async ({ generation, marker, detail }) => {
        if (generation === 1 && marker === 'ready') {
          const port = detail?.['gatewayPort'];
          if (typeof port === 'number') gen1Port = port;
          return;
        }

        if (generation === 1 && marker === 'run-started') {
          const observedRunId = detail?.['runId'];
          if (typeof observedRunId !== 'string') {
            throw new Error('restart conformance: run-started carried no string runId');
          }
          runId = observedRunId;
          if (gen1Port === undefined) {
            throw new Error('restart conformance: run-started observed before gen-1 ready');
          }
          // "The last cursor the first client observed": a real client
          // against the FIRST process's real gateway, before anything
          // durable exists for this run yet (`nextCursor` is `undefined`
          // on an empty page — the honest "nothing seen yet" cursor).
          const page = await connectFixtureGateway(gen1Port).page(runId);
          expect(page.events).toEqual([]);
          cursorObservedByFirstClient = page.nextCursor;
          return;
        }

        if (generation === 2 && marker === 'ready') {
          const port = detail?.['gatewayPort'];
          if (typeof port === 'number') gen2Port = port;
          return;
        }

        if (generation === 2 && marker === 'signal-parked') {
          if (gen2Port === undefined || runId === undefined) {
            throw new Error('restart conformance: signal-parked observed before gen-2 setup');
          }
          const client = connectFixtureGateway(gen2Port);

          // Page from the last cursor the first client observed, BEFORE
          // answering the park — nothing durable can commit until this
          // scenario's own `cancel` answer resolves it, so this page and
          // the tails opened right after it never race anything.
          pageBeforeCancel = await client.page(runId, cursorObservedByFirstClient);

          // Fresh subscriptions with `since` set to "reconnect from the
          // beginning" on this brand-new process's EMPTY in-memory
          // buffer (`live-events.ts`'s own `bufferCoversSince` — nothing
          // survives a real process boundary) — triggers the durable
          // fallback (AB-312): replay-then-tail, delivered as
          // `'durable-event'` frames, race-free by construction (see
          // `LiveFrameBroker.subscribe`'s own doc comment).
          sseTail = await client.openEventStream(
            `/api/v1/events?runId=${runId}&since=${encodeURIComponent(`${runId}:0`)}`,
          );
          wsTail = await client.openWebSocket('/ws?token=' + CRASH_FIXTURE_GATEWAY_AUTH_TOKEN);
          wsTail.send({ type: 'subscribe', runId, since: 0 });
          return;
        }

        if (generation === 2 && marker === 'cancellation-recorded') {
          if (!sseTail || !wsTail || !runId) {
            throw new Error('restart conformance: cancellation-recorded before tails opened');
          }
          const bound = AbortSignal.timeout(TAIL_READ_BOUND_MS);

          sseFramesSeen = await readTailUntil(
            (signal) => sseTail?.next(signal) ?? Promise.resolve(undefined),
            (frame) => frame.type === 'durable-event',
            bound,
          );
          wsFramesSeen = await readTailUntil(
            (signal) => wsTail?.next(signal) ?? Promise.resolve(undefined),
            (frame) => frame.type === 'durable-event',
            bound,
          );

          // Closed BEFORE this hook returns (and therefore before the
          // fixture's own gateway `stop()` runs) — this fixture's
          // `ManualRuntimeServices` is never advanced by anything in
          // this real process, so AB-235's drain timer would never fire
          // on its own; an open tail at shutdown would hang forever
          // rather than drain.
          await sseTail.close();
          wsTail.close();
          await wsTail.waitForClose(bound);

          // The negative half, written first per this issue's own
          // testing plan: re-page from the SAME cursor NOW, after the
          // tails already delivered `run.aborted` — the paging boundary
          // shifted one event too late.
          const client = connectFixtureGateway(gen2Port as number);
          pageAfterCancel = await client.page(runId, cursorObservedByFirstClient);
          expect(pageAfterCancel.events.length).toBeGreaterThan(0);
        }
      },
    });

    if (!runId || !pageBeforeCancel || !pageAfterCancel) {
      throw new Error('restart conformance: scenario did not reach every expected marker');
    }

    const oracle = new Set(pageAfterCancel.events.map(identityOfEnvelope));
    expect(oracle).toEqual(new Set([`run.aborted:run:${runId}`]));

    const sseDurableIdentities = sseFramesSeen
      .map(identityOfDurableFrame)
      .filter((identity): identity is string => identity !== undefined);
    const wsDurableIdentities = wsFramesSeen
      .map(identityOfDurableFrame)
      .filter((identity): identity is string => identity !== undefined);

    // Transport parity: SSE and WebSocket observe the identical durable
    // event set for this run.
    expect(new Set(sseDurableIdentities)).toEqual(new Set(wsDurableIdentities));

    const pageBeforeIdentities = pageBeforeCancel.events.map(identityOfEnvelope);
    const pageAfterIdentities = pageAfterCancel.events.map(identityOfEnvelope);

    // Positive: page (taken before the terminal event could exist) union
    // the live tail covers `run.aborted` exactly once, over both
    // transports — no gap, no duplicate.
    expect(() =>
      assertUnionExactlyOnce([...pageBeforeIdentities, ...sseDurableIdentities], oracle),
    ).not.toThrow();
    expect(() =>
      assertUnionExactlyOnce([...pageBeforeIdentities, ...wsDurableIdentities], oracle),
    ).not.toThrow();

    // Negative: the SAME assertion over the one-event-late page DOES
    // throw — `run.aborted` is now double-counted (paged AND tailed) —
    // proving the identity check above is load-bearing, not vacuous.
    expect(() =>
      assertUnionExactlyOnce([...pageAfterIdentities, ...sseDurableIdentities], oracle),
    ).toThrow(/duplicate/);
    expect(() =>
      assertUnionExactlyOnce([...pageAfterIdentities, ...wsDurableIdentities], oracle),
    ).toThrow(/duplicate/);

    // Neither tail ever saw an ordinary LIVE 'event' copy of the same
    // terminal fact — the broadcast-suppression path (AB-312) owns
    // exactly-once delivery for a subscriber in durable-fallback mode.
    expect(
      sseFramesSeen.some((frame) => frame.type === 'event' && frame.event === 'run.aborted'),
    ).toBe(false);
    expect(
      wsFramesSeen.some((frame) => frame.type === 'event' && frame.event === 'run.aborted'),
    ).toBe(false);

    // The production shutdown boundary: both processes exited cleanly
    // (never killed by anything other than this scenario's own
    // deliberate SIGKILL of the FIRST process), the SIGKILLed process
    // shows its signal, no descendant of either process's pid survives,
    // and the recovered process's own bureau/gateway teardown reports
    // are both clean.
    expect(report.first.signalCode).toBe('SIGKILL');
    expect(report.second.exitCode).toBe(0);
    expect(report.second.signalCode).toBeNull();
    expect(report.noOrphanedProcesses).toBe(true);

    const quiescentObservation = report.second.observations.find(
      (observation) => observation.label === 'quiescent',
    );
    expect(quiescentObservation?.value).toBe(true);

    const gatewayShutdownObservation = report.second.observations.find(
      (observation) => observation.label === 'gateway-shutdown-report',
    );
    expect(gatewayShutdownObservation?.value).toEqual({ drained: true, forcedConnections: 0 });

    // The recovered process's own port is released: a fresh connection
    // attempt against it is refused, not merely slow.
    if (gen2Port !== undefined) {
      let refused = false;
      try {
        await fetch(`http://127.0.0.1:${gen2Port}/health`);
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    }

    const markerSequence = (markers: readonly { readonly marker: CrashMarker }[]): CrashMarker[] =>
      markers.map((entry) => entry.marker);
    expect(markerSequence(report.first.markers)).toEqual([
      'ready',
      'run-started',
      'child-registered',
      'effect-attempted',
      'checkpoint-committed',
    ]);
    // `'checkpoint-committed'` fires BEFORE `'ready'` on this generation:
    // Weft's own boot recovery replays the still-in-flight run's
    // unwritten step as a side effect of `createBureauTestHarness`'s
    // construction — before `main()` gets to starting the gateway and
    // reporting `'ready'` at all (see `fixture.ts`'s own top comment on
    // recovery re-invoking `generate`/tool callbacks). Confirmed
    // empirically against this exact scenario; not something this
    // issue's gateway wiring changes.
    expect(markerSequence(report.second.markers)).toEqual([
      'checkpoint-committed',
      'ready',
      'signal-parked',
      'cancellation-recorded',
      'cleanup-completed',
    ]);
  }, 30_000);
});
