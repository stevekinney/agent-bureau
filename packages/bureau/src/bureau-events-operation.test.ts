import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';

import { type BureauEventEnvelope, createBureauEventFeed } from './bureau-event-feed.ts';
import {
  bureauEventEnvelopeSchema,
  type BureauEventsOperationEngine,
  bureauEventsSubscriptionOperation,
  createBureauEventRegistry,
} from './bureau-events-operation.ts';
import { BureauDisposedEvent, RunRegisteredEvent, RunRemovedEvent } from './events.ts';
import { throwingRejectionOf } from './testing/promise-outcome.test-support.ts';

function invoke(
  input: { bureauId: string; fromCursor?: string; kinds?: string | string[] },
  engine: BureauEventsOperationEngine,
) {
  const definition = bureauEventsSubscriptionOperation as unknown as {
    invoke: (args: { input: typeof input; engine: unknown }) => Promise<{
      envelope: { subscriptionId: string; cursor: string };
      iterable: AsyncIterable<BureauEventEnvelope> & { close(): Promise<void> };
      close(): Promise<void>;
    }>;
  };
  return definition.invoke({ input, engine });
}

describe('the bureau.events subscription', () => {
  it('declares itself on the WebSocket transport only', () => {
    const declaration = bureauEventsSubscriptionOperation as unknown as {
      name: string;
      kind: string;
      transports: Record<string, boolean>;
    };
    expect(declaration.name).toBe('bureau.events');
    expect(declaration.kind).toBe('subscription');
    expect(declaration.transports).toMatchObject({ jsonRpcWebSocket: true, http: false });
  });

  it('refuses a bureau the registry does not know', async () => {
    expect(
      await throwingRejectionOf(
        invoke({ bureauId: 'missing' }, { bureauFeeds: createBureauEventRegistry() }),
      ),
    ).toThrow(/Unknown bureau "missing"/);
  });

  it('delivers only the kinds a subscriber asked for', async () => {
    const registry = createBureauEventRegistry();
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    registry.set('bureau-1', bureauFeed);
    bureauFeed.publish(new RunRegisteredEvent('run-1'));
    bureauFeed.publish(new RunRemovedEvent('run-1'));
    bureauFeed.publish(new BureauDisposedEvent());

    const subscription = await invoke(
      { bureauId: 'bureau-1', kinds: ['run.removed', 'bureau.disposed'] },
      { bureauFeeds: registry },
    );
    const seen: BureauEventEnvelope[] = [];
    for await (const envelope of subscription.iterable) {
      seen.push(envelope);
      if (seen.length >= 2) break;
    }

    expect(seen.map((envelope) => envelope.kind)).toEqual(['run.removed', 'bureau.disposed']);
    // Sequences are over the unfiltered stream, so the skipped event's number
    // is absent rather than renumbered.
    expect(seen.map((envelope) => envelope.sequence)).toEqual([1, 2]);
    await subscription.close();
    bureauFeed.dispose();
  });

  it('accepts a bare kind as well as a list', async () => {
    const registry = createBureauEventRegistry();
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    registry.set('bureau-1', bureauFeed);
    bureauFeed.publish(new RunRegisteredEvent('run-1'));
    bureauFeed.publish(new RunRemovedEvent('run-1'));

    const subscription = await invoke(
      { bureauId: 'bureau-1', kinds: 'run.removed' },
      { bureauFeeds: registry },
    );
    const seen: BureauEventEnvelope[] = [];
    for await (const envelope of subscription.iterable) {
      seen.push(envelope);
      break;
    }

    expect(seen.map((envelope) => envelope.kind)).toEqual(['run.removed']);
    await subscription.close();
    bureauFeed.dispose();
  });

  it('resumes from a cursor', async () => {
    const registry = createBureauEventRegistry();
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    registry.set('bureau-1', bureauFeed);
    const first = bureauFeed.publish(new RunRegisteredEvent('run-1'));
    bureauFeed.publish(new RunRemovedEvent('run-1'));
    if (first === undefined) throw new Error('the first event must have been published');

    const resumed: BureauEventEnvelope[] = [];
    for await (const envelope of bureauFeed.feed.replay({ fromCursor: first.cursor })) {
      resumed.push(envelope);
    }

    expect(resumed.map((envelope) => envelope.sequence)).toEqual([1]);
    bureauFeed.dispose();
  });

  it('validates published envelopes against its declared event schema', () => {
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    const envelope = bureauFeed.publish(new RunRegisteredEvent('run-1'));

    expect(bureauEventEnvelopeSchema.safeParse(envelope).success).toBe(true);
    bureauFeed.dispose();
  });

  it('mints the subscription id through the injected runtime', async () => {
    const registry = createBureauEventRegistry();
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    registry.set('bureau-1', bureauFeed);
    const runtime = createManualRuntimeServices({ identifierSeed: 'bureau-events-operation' });
    const reference = createManualRuntimeServices({ identifierSeed: 'bureau-events-operation' });

    const first = await invoke({ bureauId: 'bureau-1' }, { bureauFeeds: registry, runtime });
    const second = await invoke({ bureauId: 'bureau-1' }, { bureauFeeds: registry, runtime });

    expect(first.envelope.subscriptionId).toBe(
      `sub_${reference.identifiers.next('bureau-subscription')}`,
    );
    expect(second.envelope.subscriptionId).toBe(
      `sub_${reference.identifiers.next('bureau-subscription')}`,
    );
    expect(second.envelope.subscriptionId).not.toBe(first.envelope.subscriptionId);
    await first.close();
    await second.close();
    bureauFeed.dispose();
  });

  it('falls back to a default runtime when none is supplied', async () => {
    const registry = createBureauEventRegistry();
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    registry.set('bureau-1', bureauFeed);

    const first = await invoke({ bureauId: 'bureau-1' }, { bureauFeeds: registry });
    const second = await invoke({ bureauId: 'bureau-1' }, { bureauFeeds: registry });

    // A fresh default runtime is created per invocation, so its per-kind
    // counter is always at 1; the trailing UUID is what keeps the ids unique.
    const defaultRuntimeIdentifier =
      /^sub_bureau-subscription-1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(first.envelope.subscriptionId).toMatch(defaultRuntimeIdentifier);
    expect(second.envelope.subscriptionId).toMatch(defaultRuntimeIdentifier);
    expect(second.envelope.subscriptionId).not.toBe(first.envelope.subscriptionId);
    await first.close();
    await second.close();
    bureauFeed.dispose();
  });
});
