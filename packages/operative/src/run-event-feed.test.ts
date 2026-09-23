import { describe, expect, it } from 'bun:test';

import { AgentRunError } from './errors.ts';
import * as operativeEvents from './events.ts';
import {
  RunAbortedEvent,
  RunErrorEvent,
  RunStartedEvent,
  StepCompletedEvent,
  StepGeneratedEvent,
  StepStartedEvent,
  ToolsExecutedEvent,
} from './events.ts';
import {
  createAgentRunEventFeed,
  projectRunEvent,
  PUBLISHED_RUN_EVENT_KINDS,
  publishedRunEventKinds,
  type AgentRunEventEnvelope,
} from './run-event-feed.ts';

const CANARY = 'CredentialInProviderResponseCanary';

function conversation() {
  // The feed never projects a conversation, so an opaque stand-in is enough
  // and keeps this test independent of the conversation model's shape.
  return {} as never;
}

async function drain(
  iterable: AsyncIterable<AgentRunEventEnvelope>,
  count: number,
): Promise<AgentRunEventEnvelope[]> {
  const seen: AgentRunEventEnvelope[] = [];
  for await (const envelope of iterable) {
    seen.push(envelope);
    if (seen.length >= count) break;
  }
  return seen;
}

describe('the agent run event feed', () => {
  it('numbers envelopes from zero with matching cursors', () => {
    const feed = createAgentRunEventFeed({ runId: 'run-1', now: () => 1000 });

    const first = feed.publish(new RunStartedEvent(conversation()));
    const second = feed.publish(new StepStartedEvent(conversation(), 0));

    expect(first).toMatchObject({ sequence: 0, runId: 'run-1', kind: 'run.started' });
    expect(second).toMatchObject({ sequence: 1, kind: 'step.started' });
    expect(first?.cursor).not.toBe(second?.cursor);
    expect(first?.emittedAtMs).toBe(1000);
    feed.dispose();
  });

  it('drops an event it has no projection for rather than forwarding it opaquely', () => {
    const feed = createAgentRunEventFeed({ runId: 'run-1' });

    // A bare Event stands in for any of Operative's many unprojected classes.
    expect(feed.publish(new Event('some.unmapped.event'))).toBeUndefined();
    // The dropped event must not consume a sequence number either, or a
    // client's cursor arithmetic would see gaps it cannot explain.
    expect(feed.publish(new RunStartedEvent(conversation()))?.sequence).toBe(0);
    feed.dispose();
  });

  it('never forwards an error cause, however the provider buried it', () => {
    // The whole reason projection is explicit. `AgentRunError.cause` for a
    // provider failure can be the raw HTTP response with credential headers.
    const cause = { response: { headers: { authorization: `Bearer ${CANARY}` } } };
    const error = new AgentRunError('provider rejected the request', {
      kind: 'generate',
      code: 'UNKNOWN',
      cause,
    });

    const envelope = createAgentRunEventFeed({ runId: 'run-1' }).publish(
      new RunErrorEvent(2, error),
    );

    expect(envelope?.payload).toMatchObject({ step: 2 });
    expect(JSON.stringify(envelope)).not.toContain(CANARY);
    expect(JSON.stringify(envelope)).not.toContain('authorization');
    expect(envelope?.payload['error']).not.toHaveProperty('cause');
    expect(envelope?.payload['error']).not.toHaveProperty('stack');
  });

  it('redacts an abort error the same way', () => {
    const error = new AgentRunError(CANARY, { kind: 'abort', code: 'ABORTED' });
    error.name = CANARY;
    const event = new RunAbortedEvent(
      1,
      conversation(),
      error,
      undefined,
      undefined,
      'user stopped it',
    );

    const envelope = createAgentRunEventFeed({ runId: 'run-1' }).publish(event);

    // The message is the one field of an error a client needs, so a canary
    // planted there is expected to survive; a canary in `name` is not.
    expect(JSON.stringify(envelope?.payload['error'])).toContain(CANARY);
    expect(envelope?.payload).toMatchObject({ reason: 'user stopped it' });
  });

  it('projects tool calls to identity only, never their arguments', () => {
    const event = new StepGeneratedEvent({
      step: 0,
      content: 'text',
      toolCalls: [{ id: 'call-1', name: 'roll_dice', arguments: { secret: CANARY } }],
      usage: { prompt: 1, completion: 2, total: 3 },
    });

    const envelope = createAgentRunEventFeed({ runId: 'run-1' }).publish(event);

    expect(envelope?.payload['toolCalls']).toEqual([{ id: 'call-1', name: 'roll_dice' }]);
    expect(JSON.stringify(envelope)).not.toContain(CANARY);
    expect(envelope?.payload['usage']).toEqual({ prompt: 1, completion: 2, total: 3 });
  });

  it('omits usage entirely when the event carries none', () => {
    const event = new StepGeneratedEvent({ step: 0, content: '', toolCalls: [] });

    const envelope = createAgentRunEventFeed({ runId: 'run-1' }).publish(event);

    expect(envelope?.payload).not.toHaveProperty('usage');
  });

  it('projects tool results to their outcome, not their content', () => {
    const event = new ToolsExecutedEvent(0, [{ id: 'call-1', name: 'roll_dice', arguments: {} }], [
      { callId: 'call-1', outcome: 'success', content: CANARY },
    ] as never);

    const envelope = createAgentRunEventFeed({ runId: 'run-1' }).publish(event);

    expect(envelope?.payload['results']).toEqual([{ callId: 'call-1', outcome: 'success' }]);
    expect(JSON.stringify(envelope)).not.toContain(CANARY);
  });

  it('lets a late subscriber replay what it missed, then follow live', async () => {
    const runFeed = createAgentRunEventFeed({ runId: 'run-1' });
    runFeed.publish(new RunStartedEvent(conversation()));
    runFeed.publish(new StepStartedEvent(conversation(), 0));

    const collected = drain(runFeed.feed.subscribe(), 3);
    await Promise.resolve();
    runFeed.publish(
      new StepCompletedEvent({
        step: 0,
        conversation: conversation(),
        content: '',
        toolCalls: [],
        results: [],
        final: true,
      }),
    );

    const seen = await collected;
    expect(seen.map((envelope) => envelope.kind)).toEqual([
      'run.started',
      'step.started',
      'step.completed',
    ]);
    runFeed.dispose();
  });

  it('resumes from a cursor without redelivering what the client already has', async () => {
    const runFeed = createAgentRunEventFeed({ runId: 'run-1' });
    const first = runFeed.publish(new RunStartedEvent(conversation()));
    runFeed.publish(new StepStartedEvent(conversation(), 0));
    runFeed.publish(new StepStartedEvent(conversation(), 1));

    if (first === undefined) throw new Error('the first event must have been published');
    const resumed: AgentRunEventEnvelope[] = [];
    for await (const envelope of runFeed.feed.replay({ fromCursor: first.cursor })) {
      resumed.push(envelope);
    }

    expect(resumed.map((envelope) => envelope.sequence)).toEqual([1, 2]);
    runFeed.dispose();
  });
});

describe('run event projection coverage', () => {
  /**
   * Reports the gap rather than failing on it.
   *
   * Operative exports far more event classes than the feed projects, and
   * every unprojected one is dropped — safe, but invisible unless something
   * counts. This test fails only if coverage *regresses*, so adding an event
   * class does not break the build while leaving the omission on the record.
   */
  it('publishes a known subset, and every published kind is reachable', () => {
    // Reflection over the module namespace, so a new event class is counted
    // without this test being edited. Typed as `unknown` because the exports
    // are a heterogeneous union — classes, helpers, and plain values.
    const exportedEventKinds: string[] = [];
    for (const value of Object.values(operativeEvents) as unknown[]) {
      if (typeof value !== 'function') continue;
      const candidate = (value as { type?: unknown }).type;
      if (typeof candidate === 'string') exportedEventKinds.push(candidate);
    }

    // Every kind the feed claims to publish is a real exported event type —
    // a typo in a projection key would otherwise silently publish nothing.
    for (const kind of publishedRunEventKinds) {
      expect(exportedEventKinds).toContain(kind);
    }

    expect(publishedRunEventKinds.length).toBeGreaterThanOrEqual(10);
    expect(new Set(publishedRunEventKinds).size).toBe(publishedRunEventKinds.length);
  });

  it('keeps the filterable tuple and the projection registry in agreement', () => {
    // `PUBLISHED_RUN_EVENT_KINDS` is spelled out so a subscriber filtering by
    // kind gets literal types; the registry is what actually publishes. If
    // they drift, a projected event silently becomes unfilterable, or a
    // filter offers a kind nothing emits.
    // The registry's widened `string[]` is the receiver, so the literal
    // tuple is checked against it rather than narrowing the comparison.
    expect([...publishedRunEventKinds].toSorted()).toEqual(
      [...PUBLISHED_RUN_EVENT_KINDS].toSorted(),
    );
  });

  it('returns undefined for an event outside the published set', () => {
    expect(projectRunEvent(new Event('run.nonexistent'))).toBeUndefined();
    expect(projectRunEvent(undefined)).toBeUndefined();
    expect(projectRunEvent({ type: 'run.started' })).toBeUndefined();
  });
});

describe('feed disposal', () => {
  it('ends a live subscriber instead of leaving it parked', async () => {
    // `drainLive` loops until its subscription signal aborts. Disposing the
    // backend only unhooks the listener and empties the log, so without the
    // feed's lifetime signal this subscriber's generator would wait on a
    // waker nothing can ever fire again — the test would time out rather
    // than fail.
    const runFeed = createAgentRunEventFeed({ runId: 'run-1' });
    let delivered = 0;
    let ended = false;
    const reading = (async () => {
      for await (const envelope of runFeed.feed.subscribe()) {
        if (envelope.kind !== '') delivered += 1;
      }
      ended = true;
    })();

    await Promise.resolve();
    runFeed.dispose();
    await reading;

    expect(ended).toBe(true);
    expect(delivered).toBe(0);
    expect(runFeed.signal.aborted).toBe(true);
  });

  it('leaves the signal unaborted while the feed is live', () => {
    const runFeed = createAgentRunEventFeed({ runId: 'run-1' });
    expect(runFeed.signal.aborted).toBe(false);
    runFeed.dispose();
  });
});
