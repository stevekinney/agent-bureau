import { describe, expect, it } from 'bun:test';

import {
  createBureauEventFeed,
  projectBureauEvent,
  PUBLISHED_BUREAU_EVENT_KINDS,
  publishedBureauEventKinds,
  type BureauEventEnvelope,
} from './bureau-event-feed.ts';
import {
  ActionEvent,
  BureauDisposedEvent,
  RecoveryRejectedEvent,
  ReviewApprovedEvent,
  RunRegisteredEvent,
} from './events.ts';

const CANARY = 'CallerSuppliedDetailCanary';

describe('the bureau event feed', () => {
  it('numbers envelopes from zero and stamps the bureau', () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1', now: () => 500 });

    const first = feed.publish(new RunRegisteredEvent('run-1'));
    const second = feed.publish(new RunRegisteredEvent('run-2'));

    expect(first).toMatchObject({
      sequence: 0,
      bureauId: 'bureau-1',
      kind: 'run.registered',
      emittedAtMs: 500,
    });
    expect(first?.payload).toEqual({ runId: 'run-1' });
    expect(second?.sequence).toBe(1);
    feed.dispose();
  });

  it('drops an event it has no projection for', () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1' });

    expect(feed.publish(new Event('task.routed'))).toBeUndefined();
    // A dropped event consumes no sequence number.
    expect(feed.publish(new BureauDisposedEvent())?.sequence).toBe(0);
    feed.dispose();
  });

  it('carries an action log entry’s shape but never its detail', () => {
    // `Action.detail` is `unknown` and caller-supplied — exactly the field a
    // generic projection would ship without anyone deciding to.
    const event = new ActionEvent({
      sequence: 7,
      runId: 'run-1',
      type: 'tool.invoked',
      detail: { secret: CANARY },
      timestamp: 1234,
    });

    const envelope = createBureauEventFeed({ bureauId: 'bureau-1' }).publish(event);

    expect(envelope?.payload).toEqual({
      sequence: 7,
      runId: 'run-1',
      actionType: 'tool.invoked',
      timestamp: 1234,
    });
    expect(JSON.stringify(envelope)).not.toContain(CANARY);
  });

  it('renames a review’s own kind so it cannot be confused with the envelope’s', () => {
    const event = new ReviewApprovedEvent(
      'review-1',
      'run-1',
      'user@example.test',
      'tool-approval',
    );

    const envelope = createBureauEventFeed({ bureauId: 'bureau-1' }).publish(event);

    // `envelope.kind` is the event type; `payload.reviewKind` is which sort
    // of review settled. Two meanings under one name would be misread.
    expect(envelope?.kind).toBe('review.approved');
    expect(envelope?.payload).toEqual({
      reviewId: 'review-1',
      runId: 'run-1',
      principal: 'user@example.test',
      reviewKind: 'tool-approval',
    });
  });

  it('projects a recovery rejection with its reason', () => {
    const event = new RecoveryRejectedEvent('run-1', 'session-absent');

    const envelope = createBureauEventFeed({ bureauId: 'bureau-1' }).publish(event);

    expect(envelope?.payload).toEqual({ runId: 'run-1', reason: 'session-absent' });
  });

  it('lets a late subscriber replay, then follow live', async () => {
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    bureauFeed.publish(new RunRegisteredEvent('run-1'));

    const seen: BureauEventEnvelope[] = [];
    const reading = (async () => {
      for await (const envelope of bureauFeed.feed.subscribe()) {
        seen.push(envelope);
        if (seen.length >= 2) break;
      }
    })();
    await Promise.resolve();
    bureauFeed.publish(new BureauDisposedEvent());
    await reading;

    expect(seen.map((envelope) => envelope.kind)).toEqual(['run.registered', 'bureau.disposed']);
    bureauFeed.dispose();
  });
});

describe('bureau event projection coverage', () => {
  it('keeps the filterable tuple and the projection registry in agreement', () => {
    expect([...publishedBureauEventKinds].toSorted()).toEqual(
      [...PUBLISHED_BUREAU_EVENT_KINDS].toSorted(),
    );
  });

  it('does not publish the supervisor task and synthesis events', () => {
    // They carry the task text, a whole `RunResult`, a raw error, and the
    // synthesized output. Omitting them is a decision, and this records it.
    for (const kind of ['task.routed', 'task.completed', 'task.failed', 'synthesis.completed']) {
      expect(publishedBureauEventKinds).not.toContain(kind);
    }
  });

  it('returns undefined for an event outside the published set', () => {
    expect(projectBureauEvent(new Event('bureau.nonexistent'))).toBeUndefined();
    expect(projectBureauEvent(undefined)).toBeUndefined();
    expect(projectBureauEvent({ type: 'run.registered' })).toBeUndefined();
  });
});

describe('bureau feed disposal', () => {
  it('ends a live subscriber instead of leaving it parked', async () => {
    // Same hazard as the run feed: disposal unhooks a subscriber without
    // waking it, so the lifetime signal is what lets the generator finish.
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    let ended = false;
    const reading = (async () => {
      for await (const envelope of bureauFeed.feed.subscribe()) {
        expect(envelope.bureauId).toBe('bureau-1');
      }
      ended = true;
    })();

    await Promise.resolve();
    bureauFeed.dispose();
    await reading;

    expect(ended).toBe(true);
    expect(bureauFeed.signal.aborted).toBe(true);
  });
});
