import { describe, expect, it } from 'bun:test';

import { RunStartedEvent, StepStartedEvent } from './events.ts';
import { createAgentRunEventFeed, type AgentRunEventEnvelope } from './run-event-feed.ts';
import {
  createAgentRunEventRegistry,
  runEventEnvelopeSchema,
  runEventsSubscriptionOperation,
  type RunEventsOperationEngine,
} from './run-events-operation.ts';

function conversation() {
  return {} as never;
}

/**
 * Invokes the operation the way the WebSocket session does: with the registry
 * as the `engine` value. Everything else in the pipeline — validation,
 * authorization, transport — is Weft's and is tested there.
 */
async function invoke(
  input: { runId: string; fromCursor?: string; kinds?: string | string[] },
  engine: RunEventsOperationEngine,
) {
  const definition = runEventsSubscriptionOperation as unknown as {
    invoke: (args: { input: typeof input; engine: unknown }) => Promise<{
      envelope: { subscriptionId: string; cursor: string };
      iterable: AsyncIterable<AgentRunEventEnvelope> & { close(): Promise<void> };
      close(): Promise<void>;
    }>;
  };
  return definition.invoke({ input, engine });
}

describe('the operative.runs.events subscription', () => {
  it('declares itself on the WebSocket transport only', () => {
    // A run feed is long-lived and resumable, which a single HTTP response
    // cannot express.
    const declaration = runEventsSubscriptionOperation as unknown as {
      name: string;
      kind: string;
      transports: Record<string, boolean>;
    };
    expect(declaration.name).toBe('operative.runs.events');
    expect(declaration.kind).toBe('subscription');
    expect(declaration.transports).toMatchObject({
      http: false,
      jsonRpcHttp: false,
      jsonRpcWebSocket: true,
      jsonRpcStdio: false,
    });
  });

  it('refuses a run the registry does not know', async () => {
    const registry = createAgentRunEventRegistry();

    // A run may have completed and been reaped between listing and
    // subscribing, so this is a caller error rather than a transport failure.
    await expect(invoke({ runId: 'missing' }, { runFeeds: registry })).rejects.toThrow(
      /Unknown run "missing"/,
    );
  });

  it('replays what already happened, then follows live', async () => {
    const registry = createAgentRunEventRegistry();
    const runFeed = createAgentRunEventFeed({ runId: 'run-1' });
    registry.set('run-1', runFeed);
    runFeed.publish(new RunStartedEvent(conversation()));

    const subscription = await invoke({ runId: 'run-1' }, { runFeeds: registry });
    const seen: AgentRunEventEnvelope[] = [];
    const reading = (async () => {
      for await (const envelope of subscription.iterable) {
        seen.push(envelope);
        if (seen.length >= 2) break;
      }
    })();
    await Promise.resolve();
    runFeed.publish(new StepStartedEvent(conversation(), 0));
    await reading;

    expect(seen.map((envelope) => envelope.kind)).toEqual(['run.started', 'step.started']);
    expect(subscription.envelope.subscriptionId).toMatch(/^sub_/);
    await subscription.close();
    runFeed.dispose();
  });

  it('reports the caller’s cursor back in the start envelope', async () => {
    const registry = createAgentRunEventRegistry();
    const runFeed = createAgentRunEventFeed({ runId: 'run-1' });
    registry.set('run-1', runFeed);
    const first = runFeed.publish(new RunStartedEvent(conversation()));
    if (first === undefined) throw new Error('the first event must have been published');

    const subscription = await invoke(
      { runId: 'run-1', fromCursor: first.cursor },
      { runFeeds: registry },
    );

    expect(subscription.envelope.cursor).toBe(first.cursor);
    await subscription.close();
    runFeed.dispose();
  });

  it('stops delivering once closed', async () => {
    const registry = createAgentRunEventRegistry();
    const runFeed = createAgentRunEventFeed({ runId: 'run-1' });
    registry.set('run-1', runFeed);

    const subscription = await invoke({ runId: 'run-1' }, { runFeeds: registry });
    await subscription.close();
    // Publishing after close must not throw into the producer; the socket is
    // already gone and the run does not care.
    expect(() => runFeed.publish(new RunStartedEvent(conversation()))).not.toThrow();
    runFeed.dispose();
  });

  it('validates the envelopes it publishes against its own event schema', () => {
    const runFeed = createAgentRunEventFeed({ runId: 'run-1' });
    const envelope = runFeed.publish(new StepStartedEvent(conversation(), 3));

    // The declared `eventSchema` is what a client validates against, so a
    // projection that drifted from it would ship frames the client rejects.
    expect(runEventEnvelopeSchema.safeParse(envelope).success).toBe(true);
    runFeed.dispose();
  });

  it('delivers only the kinds a subscriber asked for', async () => {
    const registry = createAgentRunEventRegistry();
    const runFeed = createAgentRunEventFeed({ runId: 'run-1' });
    registry.set('run-1', runFeed);
    runFeed.publish(new RunStartedEvent(conversation()));
    runFeed.publish(new StepStartedEvent(conversation(), 0));
    runFeed.publish(new StepStartedEvent(conversation(), 1));

    const subscription = await invoke(
      { runId: 'run-1', kinds: ['step.started'] },
      { runFeeds: registry },
    );
    const seen: AgentRunEventEnvelope[] = [];
    for await (const envelope of subscription.iterable) {
      seen.push(envelope);
      if (seen.length >= 2) break;
    }

    // `run.started` is filtered out; the two `step.started` envelopes arrive
    // with their original sequence numbers, because the cursor is over the
    // unfiltered stream.
    expect(seen.map((envelope) => envelope.kind)).toEqual(['step.started', 'step.started']);
    expect(seen.map((envelope) => envelope.sequence)).toEqual([1, 2]);
    await subscription.close();
    runFeed.dispose();
  });

  it('accepts a bare kind as well as a list', async () => {
    const registry = createAgentRunEventRegistry();
    const runFeed = createAgentRunEventFeed({ runId: 'run-1' });
    registry.set('run-1', runFeed);
    runFeed.publish(new RunStartedEvent(conversation()));
    runFeed.publish(new StepStartedEvent(conversation(), 0));

    const subscription = await invoke(
      { runId: 'run-1', kinds: 'run.started' },
      { runFeeds: registry },
    );
    const seen: AgentRunEventEnvelope[] = [];
    for await (const envelope of subscription.iterable) {
      seen.push(envelope);
      break;
    }

    expect(seen.map((envelope) => envelope.kind)).toEqual(['run.started']);
    await subscription.close();
    runFeed.dispose();
  });

  it('removes a run from the registry on delete', () => {
    const registry = createAgentRunEventRegistry();
    const runFeed = createAgentRunEventFeed({ runId: 'run-1' });
    registry.set('run-1', runFeed);
    expect(registry.get('run-1')).toBeDefined();

    registry.delete('run-1');

    expect(registry.get('run-1')).toBeUndefined();
    runFeed.dispose();
  });
});
