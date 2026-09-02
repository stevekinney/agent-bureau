import { getMessageText } from '@lostgradient/chat';
import { describe, expect, it, mock } from 'bun:test';

import type { RunSummary } from '../../types';
import type { GatewayClientEnvironment } from '../client-environment';
import { createChatStore, type CreateChatStoreOptions } from './use-chat.svelte.ts';

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    status: 'running',
    steps: 0,
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: undefined,
    error: undefined,
    actionCount: 0,
    agentName: 'bureau',
    principal: undefined,
    startedAt: 0,
    ...overrides,
  };
}

/**
 * Builds a {@link GatewayClientEnvironment} test double with a controllable
 * `fetch`. `use-chat.svelte.ts` never touches `WebSocket`, `EventSource`, or
 * `timers`, so those fields throw if a bug ever causes them to be invoked.
 */
function createEnvironment(fetchImplementation: typeof fetch): GatewayClientEnvironment {
  return {
    fetch: fetchImplementation,
    WebSocket: class {
      constructor() {
        throw new Error('use-chat does not construct a WebSocket');
      }
    } as unknown as typeof WebSocket,
    EventSource: class {
      constructor() {
        throw new Error('use-chat does not construct an EventSource');
      }
    } as unknown as typeof EventSource,
    timers: {
      setTimeout: () => {
        throw new Error('use-chat does not use timers.setTimeout');
      },
      clearTimeout: () => {
        throw new Error('use-chat does not use timers.clearTimeout');
      },
      setInterval: () => {
        throw new Error('use-chat does not use timers.setInterval');
      },
      clearInterval: () => {
        throw new Error('use-chat does not use timers.clearInterval');
      },
      now: () => {
        throw new Error('use-chat does not use timers.now');
      },
    },
  };
}

// Bun's `typeof fetch` also requires a static `preconnect` method that this
// stub has no use for; the cast documents that this is a deliberate
// call-should-never-happen sentinel, not a real fetch implementation.
const unusedFetch = (() =>
  Promise.reject(new Error('fetch should not be called in this test'))) as unknown as typeof fetch;

function makeStore(
  overrides: Partial<Omit<CreateChatStoreOptions, 'environment'>> = {},
  fetchImplementation: typeof fetch = unusedFetch,
) {
  const subscribe = mock((_runId: string) => {});
  const unsubscribe = mock((_runId: string) => {});
  const onRunCreated = mock((_run: RunSummary) => {});
  const store = createChatStore({
    subscribe,
    unsubscribe,
    onRunCreated,
    environment: createEnvironment(fetchImplementation),
    ...overrides,
  });
  return { store, subscribe, unsubscribe, onRunCreated };
}

function messageTexts(store: ReturnType<typeof makeStore>['store']): string[] {
  return store.conversation.ids.map((id) => getMessageText(store.conversation.messages[id]!));
}

describe('createChatStore', () => {
  it('starts with an empty conversation', () => {
    const { store } = makeStore();
    expect(store.conversation.ids).toHaveLength(0);
    expect(store.sending).toBe(false);
    expect(store.runId).toBeUndefined();
  });

  it('appends the user message, subscribes to the run, and reports it', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-7', sessionId: 'sess-7' })))),
    );

    const { store, subscribe, onRunCreated } = makeStore({}, fetchMock as unknown as typeof fetch);
    await store.send('hello there');

    expect(messageTexts(store)).toEqual(['hello there']);
    expect(store.runId).toBe('run-7');
    expect(store.sessionId).toBe('sess-7');
    expect(store.sending).toBe(false);
    expect(subscribe).toHaveBeenCalledWith('run-7');
    expect(onRunCreated).toHaveBeenCalledTimes(1);
  });

  it('threads the session id and unsubscribes the prior run on a second send', async () => {
    const responses = [
      makeRun({ id: 'run-1', sessionId: 'sess-1' }),
      makeRun({ id: 'run-2', sessionId: 'sess-1' }),
    ];
    let call = 0;
    const requestInits: (RequestInit | undefined)[] = [];
    const fetchMock = mock((_input: unknown, init?: RequestInit) => {
      requestInits.push(init);
      return Promise.resolve(new Response(JSON.stringify(responses[call++])));
    });

    const { store, subscribe, unsubscribe } = makeStore({}, fetchMock as unknown as typeof fetch);
    await store.send('first');
    await store.send('second');

    expect(unsubscribe).toHaveBeenCalledWith('run-1');
    expect(subscribe).toHaveBeenLastCalledWith('run-2');
    expect(store.sessionId).toBe('sess-1');

    const secondInit = requestInits[1];
    const sentBody = JSON.parse(secondInit?.body as string) as { sessionId?: string };
    expect(sentBody.sessionId).toBe('sess-1');
  });

  it('records a non-ok response body as the error', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('rate limited', { status: 429 })));

    const { store, subscribe } = makeStore({}, fetchMock as unknown as typeof fetch);
    await store.send('hi');

    expect(store.error).toBe('rate limited');
    expect(subscribe).not.toHaveBeenCalled();
    expect(store.sending).toBe(false);
  });

  it('records a thrown network error', async () => {
    const fetchMock = mock(() => Promise.reject(new Error('offline')));

    const { store } = makeStore({}, fetchMock as unknown as typeof fetch);
    await store.send('hi');

    expect(store.error).toBe('offline');
    expect(store.sending).toBe(false);
  });

  it('ignores frames for a run other than the active one', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify(makeRun()))));

    const { store } = makeStore({}, fetchMock as unknown as typeof fetch);
    await store.send('hi');

    store.handleMessage({
      type: 'stream:text-delta',
      runSeq: 1,
      runId: 'someone-else',
      content: 'x',
      accumulated: 'x',
    });
    expect(store.streamingAssistantContent).toBe('');
  });

  it('commits the streamed assistant content on run.completed', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );

    const { store } = makeStore({}, fetchMock as unknown as typeof fetch);
    await store.send('question');

    store.handleMessage({
      type: 'stream:text-delta',
      runSeq: 1,
      runId: 'run-1',
      content: 'answer',
      accumulated: 'answer',
    });
    expect(store.streamingAssistantContent).toBe('answer');

    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'run.completed',
      detail: {},
      sequence: 1,
      runSeq: 1,
      timestamp: 1,
    });

    expect(messageTexts(store)).toEqual(['question', 'answer']);
    expect(store.streamingAssistantContent).toBe('');
  });

  it('falls back to the completion detail content when nothing streamed', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );

    const { store } = makeStore({}, fetchMock as unknown as typeof fetch);
    await store.send('question');

    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'run.completed',
      detail: { content: 'from-detail' },
      sequence: 1,
      runSeq: 1,
      timestamp: 1,
    });

    expect(messageTexts(store)).toEqual(['question', 'from-detail']);
  });

  it('sets an error on run.error and clears streaming', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );

    const { store } = makeStore({}, fetchMock as unknown as typeof fetch);
    await store.send('question');

    store.handleMessage({
      type: 'stream:text-delta',
      runSeq: 1,
      runId: 'run-1',
      content: 'partial',
      accumulated: 'partial',
    });
    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'run.error',
      detail: { error: 'kaboom' },
      sequence: 1,
      runSeq: 1,
      timestamp: 1,
    });

    expect(store.error).toBe('kaboom');
    expect(store.streamingAssistantContent).toBe('');
  });

  it('sets an error on run.aborted and clears streaming', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );

    const { store } = makeStore({}, fetchMock as unknown as typeof fetch);
    await store.send('question');

    store.handleMessage({
      type: 'stream:text-delta',
      runSeq: 1,
      runId: 'run-1',
      content: 'partial',
      accumulated: 'partial',
    });
    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'run.aborted',
      detail: { error: '{"kind":"abort","code":"ABORTED","message":"cancelled"}' },
      sequence: 1,
      runSeq: 1,
      timestamp: 1,
    });

    expect(store.error).toBe('{"kind":"abort","code":"ABORTED","message":"cancelled"}');
    expect(store.streamingAssistantContent).toBe('');
  });

  it('summarizes completed tool calls in the tool-activity log', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );

    const { store } = makeStore({}, fetchMock as unknown as typeof fetch);
    await store.send('question');

    store.handleMessage({
      type: 'stream:tool-call-start',
      runSeq: 1,
      runId: 'run-1',
      toolName: 'search',
      blockId: 'block-a',
    });
    store.handleMessage({
      type: 'stream:tool-call-complete',
      runSeq: 1,
      runId: 'run-1',
      toolName: 'search',
      blockId: 'block-a',
      arguments: { q: 'agent' },
    });

    expect(store.toolActivity).toEqual(['search completed {"q":"agent"}']);
  });

  it('calls onHumanInputRequested on step.completed for the active run', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );
    const onHumanInputRequested = mock(() => {});

    const { store } = makeStore({ onHumanInputRequested }, fetchMock as unknown as typeof fetch);
    await store.send('question');

    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'step.completed',
      detail: {},
      sequence: 1,
      runSeq: 1,
      timestamp: 1,
    });

    expect(onHumanInputRequested).toHaveBeenCalledTimes(1);
  });

  it('calls onHumanInputRequested on multiagent.human-wait.parked for the active run', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );
    const onHumanInputRequested = mock(() => {});

    const { store } = makeStore({ onHumanInputRequested }, fetchMock as unknown as typeof fetch);
    await store.send('question');

    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'multiagent.human-wait.parked',
      detail: {},
      sequence: 1,
      runSeq: 1,
      timestamp: 1,
    });

    expect(onHumanInputRequested).toHaveBeenCalledTimes(1);
  });

  it('does not call onHumanInputRequested for an unrelated run', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );
    const onHumanInputRequested = mock(() => {});

    const { store } = makeStore({ onHumanInputRequested }, fetchMock as unknown as typeof fetch);
    await store.send('question');

    store.handleMessage({
      type: 'event',
      runId: 'someone-else',
      event: 'step.completed',
      detail: {},
      sequence: 1,
      runSeq: 1,
      timestamp: 1,
    });

    expect(onHumanInputRequested).not.toHaveBeenCalled();
  });

  it('does not call onHumanInputRequested for unrelated event types', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );
    const onHumanInputRequested = mock(() => {});

    const { store } = makeStore({ onHumanInputRequested }, fetchMock as unknown as typeof fetch);
    await store.send('question');

    store.handleMessage({
      type: 'stream:text-delta',
      runId: 'run-1',
      content: 'x',
      accumulated: 'x',
      runSeq: 1,
    });

    expect(onHumanInputRequested).not.toHaveBeenCalled();
  });

  it('resets streaming and tool activity at the start of each send', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );

    const { store } = makeStore({}, fetchMock as unknown as typeof fetch);
    await store.send('first');
    store.handleMessage({
      type: 'stream:tool-call-start',
      runSeq: 1,
      runId: 'run-1',
      toolName: 'search',
      blockId: 'block-a',
    });
    expect(store.toolActivity).toHaveLength(1);

    await store.send('second');
    expect(store.toolActivity).toHaveLength(0);
    expect(store.streamingAssistantContent).toBe('');
  });
});
