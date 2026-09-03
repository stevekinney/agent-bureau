import { describe, expect, it } from 'bun:test';

import { Conversation } from '../src/history';
import { appendUserMessage, createConversationHistory, defineMessagePlugin } from '../src/index';
import type { MessagePluginIdentity } from '../src/types';

describe('Conversation lifecycle and observation', () => {
  it('exposes a cached framework-neutral snapshot and stable subscriptions', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'store' }));
    const first = conversation.getSnapshot();
    const notifications: number[] = [];

    const unsubscribe = conversation.subscribe(() => {
      notifications.push(conversation.getSnapshot().revision);
    });

    expect(conversation.getSnapshot()).toBe(first);
    expect(first).toMatchObject({ revision: 0, lifecycle: 'open' });
    expect(first.conversation).toBe(conversation.current);

    conversation.appendUserMessage('hello');
    expect(notifications).toEqual([1]);
    expect(conversation.getSnapshot()).not.toBe(first);
    expect(conversation.getSnapshot()).toBe(conversation.getSnapshot());

    unsubscribe();
    unsubscribe();
    conversation.appendAssistantMessage('world');
    expect(notifications).toEqual([1]);
  });

  it('supports setup-cleanup-setup and serializable server hydration snapshots', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'strict-mode' }));
    let notifications = 0;
    const firstUnsubscribe = conversation.subscribe(() => notifications++);
    firstUnsubscribe();
    const secondUnsubscribe = conversation.subscribe(() => notifications++);

    conversation.appendUserMessage('one transition');
    expect(notifications).toBe(1);
    expect(structuredClone(conversation.getServerSnapshot())).toEqual(conversation.getSnapshot());

    secondUnsubscribe();
  });

  it('treats duplicate callback subscriptions as independent registrations', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'duplicates' }));
    let notifications = 0;
    const listener = () => notifications++;
    const unsubscribeFirst = conversation.subscribe(listener);
    const unsubscribeSecond = conversation.subscribe(listener);

    unsubscribeFirst();
    conversation.appendUserMessage('one remains');
    expect(notifications).toBe(1);
    unsubscribeSecond();
    conversation.appendUserMessage('none remain');
    expect(notifications).toBe(1);
  });

  it('closes idempotently, publishes the terminal snapshot, and rejects later writes', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'closed' }));
    const lifecycleEvents: string[] = [];
    conversation.addEventListener('controller.closed', (event) => lifecycleEvents.push(event.type));

    conversation.complete();
    conversation.complete();

    expect(conversation.lifecycle).toBe('closed');
    expect(conversation.completed).toBe(true);
    expect(conversation.getSnapshot().lifecycle).toBe('closed');
    expect(lifecycleEvents).toEqual(['controller.closed']);
    expect(() => conversation.appendUserMessage('too late')).toThrow(
      expect.objectContaining({ code: 'error:conversation-closed' }),
    );
    expect(conversation.current.ids).toEqual([]);
  });

  it('aborts and awaits in-flight compaction before disposal becomes quiescent', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'dispose' }));
    for (let index = 0; index < 8; index++) conversation.appendUserMessage(`message ${index}`);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compaction = conversation.compact(async (_messages, options) => {
      expect(options?.signal?.aborted).toBe(false);
      await waiting;
      expect(options?.signal?.aborted).toBe(true);
      return 'summary';
    });

    const disposal = conversation.dispose();
    release();

    await expect(compaction).rejects.toMatchObject({ code: 'error:operation-cancelled' });
    await disposal;
    expect(conversation.lifecycle).toBe('disposed');
    expect(conversation.inFlightOperationCount).toBe(0);
    expect(conversation.current.ids).toHaveLength(8);
    expect(() => conversation.subscribe(() => {})).toThrow(
      expect.objectContaining({ code: 'error:conversation-disposed' }),
    );
  });

  it('publishes disposal after an earlier close', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'close-dispose' }));
    const lifecycles: string[] = [];
    conversation.subscribe(() => lifecycles.push(conversation.getSnapshot().lifecycle));

    conversation.close();
    await conversation.dispose();

    expect(lifecycles).toEqual(['closed', 'disposed']);
    expect(conversation.getSnapshot().lifecycle).toBe('disposed');

    const asynchronouslyDisposable = new Conversation(
      createConversationHistory({ id: 'async-dispose' }),
    );
    await asynchronouslyDisposable[Symbol.asyncDispose]();
    expect(asynchronouslyDisposable.lifecycle).toBe('disposed');
  });

  it('adds monotonic event identity and stream sequence metadata', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'events' }));
    const events: Array<{ revision: number; sequence: number; streamSequence?: number }> = [];
    conversation.addEventListener('stream.updated', (event) => events.push(event));
    const messageId = conversation.appendStreamingMessage('assistant');
    conversation.updateStreamingMessage(messageId, 'a');
    conversation.updateStreamingMessage(messageId, 'ab');

    expect(events.map(({ revision }) => revision)).toEqual([2, 3]);
    expect(events[1]!.sequence).toBeGreaterThan(events[0]!.sequence);
    expect(events.map(({ streamSequence }) => streamSequence)).toEqual([1, 2]);
  });

  it('accepts expected revisions and reports rejected and stale external mutations', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'commands' }));
    const rejected: Array<{ outcome: string; reason?: string }> = [];
    conversation.addEventListener('mutation.rejected', (event) => rejected.push(event));

    expect(
      conversation.applyMutation(
        { expectedRevision: 0, correlationId: 'request-1', actor: 'client' },
        (state) => appendUserMessage(state, 'accepted'),
      ),
    ).toEqual({ accepted: true, revision: 1 });
    expect(
      conversation.applyMutation({ expectedRevision: 0 }, (state) =>
        appendUserMessage(state, 'rejected'),
      ),
    ).toEqual({ accepted: false, revision: 1, reason: 'revision-conflict' });
    expect(
      conversation.reconcileExternalSnapshot({
        conversation: conversation.current,
        revision: 1,
        lifecycle: 'open',
      }),
    ).toEqual({ accepted: false, revision: 1, reason: 'stale-external-event' });
    expect(conversation.current.ids).toHaveLength(1);
    expect(rejected.map(({ outcome, reason }) => [outcome, reason])).toEqual([
      ['rejected', 'revision-conflict'],
      ['discarded', 'stale-external-event'],
    ]);
    expect(
      conversation.reconcileExternalSnapshot({
        conversation: createConversationHistory({ id: 'wrong-controller' }),
        revision: 2,
        lifecycle: 'open',
      }),
    ).toEqual({ accepted: false, revision: 1, reason: 'invalid-external-snapshot' });
  });

  it('discards compaction results computed from a stale revision', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'stale' }));
    for (let index = 0; index < 8; index++) conversation.appendUserMessage(`message ${index}`);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const staleEvents: string[] = [];
    conversation.addEventListener('compaction.stale-discarded', (event) =>
      staleEvents.push(event.type),
    );
    const compaction = conversation.compact(async () => {
      await waiting;
      return 'summary';
    });
    conversation.appendAssistantMessage('newer state');
    release();

    await expect(compaction).rejects.toMatchObject({ code: 'error:revision-conflict' });
    expect(conversation.current.ids).toHaveLength(9);
    expect(staleEvents).toEqual(['compaction.stale-discarded']);
  });

  it('revision-fences asynchronous tool-result streams', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'tool-race' }));
    conversation.appendToolCall({ id: 'call-1', name: 'lookup', arguments: {} });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = conversation.appendToolResultAsync({
      callId: 'call-1',
      outcome: 'success',
      content: [],
      stream: {
        async *[Symbol.asyncIterator]() {
          await waiting;
          yield { value: 'late' };
        },
      },
    });
    conversation.appendUserMessage('newer revision');
    release();

    await expect(append).rejects.toMatchObject({ code: 'error:revision-conflict' });
    expect(conversation.getPendingToolCalls()).toHaveLength(1);
  });

  it('actively closes owned tool-result iterators during disposal', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'tool-abort' }));
    let iteratorClosed = false;
    let nextCalled = false;
    const append = conversation.appendToolResultAsync({
      callId: 'call-1',
      outcome: 'success',
      content: [],
      stream: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextCalled = true;
              return new Promise<IteratorResult<unknown>>(() => {});
            },
            async return() {
              iteratorClosed = true;
              return { done: true, value: undefined };
            },
          };
        },
      },
    });
    await Promise.resolve();
    expect(nextCalled).toBe(true);

    await conversation.dispose();

    await expect(append).rejects.toMatchObject({ code: 'error:operation-cancelled' });
    expect(iteratorClosed).toBe(true);
  });

  it('gives plugins stable identity, fixed authority, and activation and failure events', () => {
    const failing = defineMessagePlugin({ id: 'policy', revision: 3 }, () => {
      throw new Error('blocked');
    });
    const conversation = new Conversation(createConversationHistory({ id: 'plugins' }), {
      plugins: [failing],
    });
    const events: Array<{ type: string; plugin?: MessagePluginIdentity }> = [];
    conversation.addEventListener('plugin.activated', (event) => events.push(event));
    conversation.addEventListener('plugin.failed', (event) => events.push(event));

    expect(conversation.plugins).toEqual([
      { id: 'policy', revision: 3, authority: 'transcript-transform' },
    ]);
    expect(() => conversation.appendUserMessage('secret')).toThrow('blocked');
    expect(events.map(({ type }) => type)).toEqual(['plugin.activated', 'plugin.failed']);
    expect(events[1]?.plugin).toEqual({
      id: 'policy',
      revision: 3,
      authority: 'transcript-transform',
    });
    expect(
      () => new Conversation(createConversationHistory(), { plugins: [failing, failing] }),
    ).toThrow('Duplicate message plugin identity: policy');
    expect(() => defineMessagePlugin({ id: '', revision: 1 }, (input) => input)).toThrow(
      'Message plugin identity requires a non-empty id and a positive integer revision',
    );
    expect(() => defineMessagePlugin({ id: 'invalid', revision: 0 }, (input) => input)).toThrow(
      'Message plugin identity requires a non-empty id and a positive integer revision',
    );
    expect(
      () => new Conversation(createConversationHistory(), { plugins: [(input) => input] }),
    ).toThrow('requires an explicit id and revision');
    expect(
      () =>
        new Conversation(createConversationHistory(), {
          plugins: [Object.assign((input) => input, { id: 'invalid', revision: 0 })],
        }),
    ).toThrow('requires an explicit id and revision');
  });

  it('makes the committed snapshot visible inside transition event callbacks', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'event-snapshot' }));
    const snapshots: Array<{ revision: number; eventRevision: number; sameState: boolean }> = [];
    conversation.getSnapshot();
    conversation.addEventListener('change', (event) => {
      const snapshot = conversation.getSnapshot();
      snapshots.push({
        revision: snapshot.revision,
        eventRevision: event.revision,
        sameState: snapshot.conversation === event.conversation,
      });
    });

    conversation.appendUserMessage('current during dispatch');

    expect(snapshots).toEqual([{ revision: 1, eventRevision: 1, sameState: true }]);
  });

  it('delivers disposed after closed through the lifecycle event channel', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'lifecycle-events' }));
    const events: string[] = [];
    conversation.addEventListener('controller.closed', (event) => events.push(event.type));
    conversation.addEventListener('controller.disposed', (event) => events.push(event.type));

    conversation.close();
    await conversation.dispose();

    expect(events).toEqual(['controller.closed', 'controller.disposed']);
  });

  it('keeps plugin lifecycle events isolated to a fork', () => {
    const plugin = defineMessagePlugin({ id: 'fork-policy', revision: 1 }, (input) => input);
    const parent = new Conversation(createConversationHistory({ id: 'plugin-parent' }), {
      plugins: [plugin],
    });
    const child = parent.fork();
    const parentEvents: string[] = [];
    const childEvents: string[] = [];
    parent.addEventListener('plugin.activated', (event) => parentEvents.push(event.type));
    child.addEventListener('plugin.activated', (event) => childEvents.push(event.type));

    child.appendUserMessage('child only');
    child.appendUserMessage('activation remains one-time');

    expect(parentEvents).toEqual([]);
    expect(childEvents).toEqual(['plugin.activated']);
  });

  it('uses distinct sequences and one correlation for paired transitions', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'paired-events' }));
    conversation.appendUserMessage('undo target');
    const events: Array<{ type: string; sequence: number; correlationId: string }> = [];
    conversation.addEventListener('change', (event) => events.push(event));
    conversation.addEventListener('undo', (event) => events.push(event));

    conversation.undo();

    expect(events.map(({ type }) => type)).toEqual(['change', 'undo']);
    expect(events[0]!.sequence).not.toBe(events[1]!.sequence);
    expect(events[0]!.correlationId).toBe(events[1]!.correlationId);

    const forkEvents: Array<{ sequence: number; correlationId: string }> = [];
    conversation.addEventListener('session.forked', (event) => forkEvents.push(event));
    conversation.addEventListener('change', (event) => forkEvents.push(event));
    conversation.fork();
    expect(forkEvents[0]!.sequence).not.toBe(forkEvents[1]!.sequence);
    expect(forkEvents[0]!.correlationId).toBe(forkEvents[1]!.correlationId);
  });

  it('preserves stream sequence counters across history navigation', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'stream-revival' }));
    const sequences: number[] = [];
    conversation.addEventListener('stream.updated', (event) =>
      sequences.push(event.streamSequence!),
    );
    const messageId = conversation.appendStreamingMessage('assistant');
    conversation.updateStreamingMessage(messageId, 'first');
    conversation.finalizeStreamingMessage(messageId);
    conversation.undo();
    conversation.updateStreamingMessage(messageId, 'second');

    expect(sequences).toEqual([1, 2]);
  });

  it('honors caller cancellation when an async tool-result stream is blocked', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'caller-abort' }));
    const controller = new AbortController();
    let iteratorClosed = false;
    const append = conversation.appendToolResultAsync(
      {
        callId: 'call-1',
        outcome: 'success',
        content: [],
        stream: {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>(() => {}),
              async return() {
                iteratorClosed = true;
                return { done: true, value: undefined };
              },
            };
          },
        },
      },
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort('caller stopped');

    await expect(append).rejects.toMatchObject({ name: 'AbortError' });
    expect(iteratorClosed).toBe(true);
  });

  it('rejects malformed external histories without throwing', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'external-shape' }));
    const malformed = {
      ...conversation.current,
      ids: ['missing-message'],
    };

    expect(
      conversation.reconcileExternalSnapshot({
        conversation: malformed,
        revision: 1,
        lifecycle: 'open',
      }),
    ).toEqual({ accepted: false, revision: 0, reason: 'invalid-external-snapshot' });
  });

  it('reports truthful compaction outcomes and honors caller cancellation after summary', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'compact-outcomes' }));
    for (let index = 0; index < 8; index++) conversation.appendUserMessage(`message ${index}`);
    const outcomes: Array<[string, string]> = [];
    conversation.addEventListener('compaction.started', (event) =>
      outcomes.push([event.type, event.outcome]),
    );
    conversation.addEventListener('compaction.cancelled', (event) =>
      outcomes.push([event.type, event.outcome]),
    );
    const controller = new AbortController();

    const compacting = conversation.compact(
      async () => {
        controller.abort('caller stopped');
        return 'summary despite cancellation';
      },
      { signal: controller.signal },
    );

    await expect(compacting).rejects.toMatchObject({ code: 'error:operation-cancelled' });
    expect(outcomes).toEqual([
      ['compaction.started', 'started'],
      ['compaction.cancelled', 'cancelled'],
    ]);
  });

  it('delivers snapshot.restored after callers can subscribe', async () => {
    const source = new Conversation(createConversationHistory({ id: 'restored-event' }));
    source.appendUserMessage('persisted');
    const restored = Conversation.from(source.snapshot());
    const events: string[] = [];
    restored.addEventListener('snapshot.restored', (event) => events.push(event.type));

    await Promise.resolve();

    expect(events).toEqual(['snapshot.restored']);
  });

  it('announces plugin activation only after the owning mutation commits', () => {
    const plugin = defineMessagePlugin({ id: 'reentrant-plugin', revision: 1 }, (input) => input);
    const conversation = new Conversation(createConversationHistory({ id: 'plugin-order' }), {
      plugins: [plugin],
    });
    conversation.addEventListener('plugin.activated', () => {
      conversation.appendAssistantMessage('listener write');
    });

    conversation.appendUserMessage('outer write');

    expect(conversation.current.ids.map((id) => conversation.current.messages[id]!.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('registers compaction as owned work before announcing it', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'compact-order' }));
    for (let index = 0; index < 8; index++) conversation.appendUserMessage(`message ${index}`);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let disposal!: Promise<void>;
    conversation.addEventListener('compaction.started', () => {
      disposal = conversation.dispose();
    });
    const compacting = conversation.compact(async () => {
      await waiting;
      return 'late summary';
    });

    expect(conversation.inFlightOperationCount).toBe(1);
    release();
    await expect(compacting).rejects.toMatchObject({ code: 'error:operation-cancelled' });
    await disposal;
    expect(conversation.inFlightOperationCount).toBe(0);
  });

  it('rejects a mutation result when its callback writes reentrantly', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'mutation-reentrant' }));

    const result = conversation.applyMutation({ expectedRevision: 0 }, (state) => {
      conversation.appendAssistantMessage('reentrant write');
      return appendUserMessage(state, 'stale callback result');
    });

    expect(result).toEqual({ accepted: false, revision: 1, reason: 'revision-conflict' });
    expect(conversation.current.ids.map((id) => conversation.current.messages[id]!.role)).toEqual([
      'assistant',
    ]);
  });
});
