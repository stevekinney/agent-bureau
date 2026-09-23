/**
 * A bureau owns its operatives' events as well as their lifecycles.
 *
 * `createAgentRunEventFeed` and `createBureauEventFeed` are host-pumped by
 * design. Before this, nothing was the host: both feeds existed, so did the
 * `operative.runs.events` and `bureau.events` operations, and no bureau ever
 * created or filled either one. These tests pin the wiring that closed that,
 * and the orderings a client depends on.
 *
 * SCOPE. Run feeds follow the store-registered `createRun` surface, which is
 * what bureau manages — `getRun`, `abortRun`, `deleteRun`, recovery. A
 * direct catalog dispatch through `bureau.run` never reaches `store.register`
 * and has no bureau-managed run id for a subscriber to name, so it gets no
 * feed; a caller holding that handle already has the `AgentRun` itself.
 */
import { type GenerateFunction } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import type { BureauEventEnvelope } from './bureau-event-feed.ts';
import { createBureau } from './create-bureau';
import { waitForCondition, waitForRunState } from './test';

const CANARY = 'ModelOutputCanary';

function createMockGenerate(content = 'Done.'): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

async function buildBureau(content?: string) {
  return createBureau({
    agents: {},
    generate: content === undefined ? createMockGenerate() : createMockGenerate(content),
  });
}

describe('a bureau’s own event feed', () => {
  it('records the events it dispatches, without being pumped by a host', async () => {
    const bureau = await buildBureau();
    try {
      await bureau.createRun({ message: 'hello' });

      const seen: BureauEventEnvelope[] = [];
      for await (const envelope of bureau.eventFeed.feed.replay()) seen.push(envelope);

      expect(seen.length).toBeGreaterThan(0);
      expect(seen.map((envelope) => envelope.kind)).toContain('run.registered');
      // Every envelope carries this bureau's identity — the `bureauId` a
      // `bureau.events` subscriber names to reach this feed.
      expect(new Set(seen.map((envelope) => envelope.bureauId))).toEqual(new Set([bureau.id]));
      // Sequences are dense and start at zero, so a cursor means something.
      expect(seen.map((envelope) => envelope.sequence)).toEqual(seen.map((_, index) => index));
    } finally {
      await bureau.dispose();
    }
  });

  it('takes its identity from options when one is supplied', async () => {
    const bureau = await createBureau({
      id: 'bureau-under-test',
      agents: {},
      generate: createMockGenerate(),
    });
    try {
      expect(bureau.id).toBe('bureau-under-test');
    } finally {
      await bureau.dispose();
    }
  });

  it('ends a watcher on shutdown rather than leaving it hanging', async () => {
    // The path a gateway takes on every restart.
    //
    // WHAT IS AND IS NOT PROMISED. The subscription ends — that is the
    // guarantee, and before the feed's lifetime signal it did not hold at
    // all. It does NOT promise a final `bureau.disposed` envelope: shutdown
    // dispatches that event and disposes the feed in the same synchronous
    // stretch, and `drainLive` returns on an aborted signal before flushing
    // whatever is still buffered. Letting the loop turn in between would
    // make the last envelope arrive for a prompt reader and not a slow one,
    // and a guarantee that holds only sometimes is worse than none. A client
    // that needs to know why a stream ended asks; it does not infer.
    const bureau = await buildBureau();
    const seen: string[] = [];
    let ended = false;
    const reading = (async () => {
      for await (const envelope of bureau.eventFeed.feed.subscribe()) seen.push(envelope.kind);
      ended = true;
    })();
    // Wait for the subscription to finish replay and reach the live phase —
    // `subscribe` awaits a tail snapshot and drains replay first, so a bare
    // microtask yield would test a different thing.
    const summary = await bureau.createRun({ message: 'hello' });
    await waitForRunState(bureau, summary.id);
    await waitForCondition(() => seen.length > 0, 'the watcher never received an event');

    await bureau.dispose();
    await reading;

    expect(ended).toBe(true);
  });

  it('gives two bureaus distinct generated identities', async () => {
    const first = await buildBureau();
    const second = await buildBureau();
    try {
      expect(first.id).not.toBe(second.id);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});

describe('the run feeds a bureau owns', () => {
  it('registers a feed for a run it creates and fills it from the run', async () => {
    const bureau = await buildBureau();
    try {
      const summary = await bureau.createRun({ message: 'hello' });
      await waitForRunState(bureau, summary.id);

      const runFeed = bureau.runEventFeeds.get(summary.id);
      expect(runFeed).toBeDefined();

      const seen: string[] = [];
      for await (const envelope of runFeed!.feed.replay()) seen.push(envelope.kind);

      // The run ran to completion, so its whole lifecycle is on the feed.
      expect(seen[0]).toBe('run.started');
      expect(seen).toContain('run.completed');
    } finally {
      await bureau.dispose();
    }
  });

  it('has the feed registered before `run.registered` reaches a watcher', async () => {
    // The race this rules out: a client sees `run.registered` on
    // `bureau.events`, immediately subscribes to `operative.runs.events` for
    // that run, and is told the run is unknown because the registry entry had
    // not been made yet. The feed is attached before `store.register`, which
    // is what drives this event, so by the time anyone can observe it the
    // lookup already succeeds.
    const bureau = await buildBureau();
    const observed: Array<{ runId: string; feedPresent: boolean }> = [];
    try {
      bureau.addEventListener('run.registered', (event) => {
        const { runId } = event;
        observed.push({ runId, feedPresent: bureau.runEventFeeds.get(runId) !== undefined });
      });

      await bureau.createRun({ message: 'hello' });

      expect(observed.length).toBeGreaterThan(0);
      for (const entry of observed) {
        expect(entry.feedPresent).toBe(true);
      }
    } finally {
      await bureau.dispose();
    }
  });

  it('keeps the whole history readable after the run finishes', async () => {
    // A client that subscribes on hearing `run.completed` must still get
    // everything that came before it. The feed is reaped by removal, not by
    // completion, so a terminal run's log is intact and replayable.
    const bureau = await buildBureau();
    try {
      const summary = await bureau.createRun({ message: 'hello' });
      await waitForRunState(bureau, summary.id);

      const runFeed = bureau.runEventFeeds.get(summary.id);
      expect(runFeed).toBeDefined();

      const replayed = await collect(runFeed!.feed.replay());
      const kinds = replayed.map((envelope) => envelope.kind);
      expect(kinds.at(0)).toBe('run.started');
      expect(kinds.at(-1)).toBe('run.completed');
      // Dense from zero: a cursor handed out mid-run still resolves.
      expect(replayed.map((envelope) => envelope.sequence)).toEqual(
        replayed.map((_, index) => index),
      );
    } finally {
      await bureau.dispose();
    }
  });

  it('reaps the feed when the run is deleted, ending a live reader', async () => {
    const bureau = await buildBureau();
    try {
      const summary = await bureau.createRun({ message: 'hello' });
      await waitForRunState(bureau, summary.id);
      const runFeed = bureau.runEventFeeds.get(summary.id);
      expect(runFeed).toBeDefined();

      let ended = false;
      const reading = (async () => {
        for await (const envelope of runFeed!.feed.subscribe()) {
          expect(typeof envelope.kind).toBe('string');
        }
        ended = true;
      })();
      await Promise.resolve();

      await bureau.deleteRun(summary.id);

      // Without the feed's lifetime signal this never returns and the test
      // times out instead of failing.
      await reading;
      expect(ended).toBe(true);
      expect(bureau.runEventFeeds.get(summary.id)).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });

  it('does not put the model’s output on the run feed', async () => {
    // The redaction discipline has to survive the bureau path, not just a
    // standalone feed: these projections are named-field, so assistant text
    // reaches the transcript frames and never an `events:read` subscriber.
    const bureau = await buildBureau(CANARY);
    try {
      const summary = await bureau.createRun({ message: 'hello' });
      await waitForRunState(bureau, summary.id);
      const runFeed = bureau.runEventFeeds.get(summary.id);

      const envelopes = [];
      for await (const envelope of runFeed!.feed.replay()) envelopes.push(envelope);

      expect(envelopes.length).toBeGreaterThan(0);
      expect(JSON.stringify(envelopes)).not.toContain(CANARY);
      expect(JSON.stringify([...(await collect(bureau.eventFeed.feed.replay()))])).not.toContain(
        CANARY,
      );
    } finally {
      await bureau.dispose();
    }
  });
});

describe('the event-feed pump’s isolation', () => {
  it('does not let a throwing feed break the run that dispatched the event', async () => {
    // Same hazard `emitLiveFrame` guards against (AB-96): `dispatchEvent`
    // walks its all-events listeners unguarded, and several bureau
    // dispatches happen synchronously inside run setup — a throw there
    // leaves a run launched but never registered. Recording an event must
    // not be able to break the thing it records.
    const diagnostics: Array<{ scope: string; message: string }> = [];
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      onDiagnostic: (diagnostic) => {
        diagnostics.push({ scope: diagnostic.scope, message: diagnostic.message });
      },
    });
    try {
      // The pump reads `publish` off this object on every dispatch, so
      // replacing it here is enough — no need to reach inside `createBureau`.
      (bureau.eventFeed as unknown as { publish: () => never }).publish = () => {
        throw new Error('feed exploded');
      };

      const summary = await bureau.createRun({ message: 'hello' });
      await waitForRunState(bureau, summary.id);

      // The run still ran, and the failure was reported rather than swallowed.
      expect(bureau.store.getRun(summary.id)?.status).not.toBe('running');
      expect(diagnostics.some((entry) => entry.scope === 'event-feed')).toBe(true);
    } finally {
      await bureau.dispose();
    }
  });

  it('does not let a throwing run feed wedge the run it is recording', async () => {
    // The run-feed listener sits on the run's OWN emitter, so an escaping
    // throw would surface inside whichever dispatch the run was making —
    // including its terminal one, leaving the run stuck at `running` until
    // some caller's bounded wait gives up. This asserts the guard holds: a
    // feed that throws on every event costs the events, not the run.
    const diagnostics: string[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate(),
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic.scope);
      },
    });
    try {
      // Poisoned on `run.registered` — the earliest point the feed is in the
      // registry, and before the run has emitted anything. Waiting until
      // `createRun` returns is too late: the run has already finished by
      // then, and the feed would never be asked to record anything.
      let poisoned = false;
      bureau.addEventListener('run.registered', (event) => {
        const feed = bureau.runEventFeeds.get(event.runId);
        if (feed === undefined) return;
        // The listener reads `publish` off this object on every event.
        (feed as unknown as { publish: () => never }).publish = () => {
          throw new Error('projection exploded');
        };
        poisoned = true;
      });

      const summary = await bureau.createRun({ message: 'hello' });
      expect(poisoned).toBe(true);

      // Settles rather than hanging — the whole point.
      const settled = await waitForRunState(bureau, summary.id);
      expect(settled.status).not.toBe('running');
      expect(diagnostics).toContain('event-feed');
    } finally {
      await bureau.dispose();
    }
  });
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}
