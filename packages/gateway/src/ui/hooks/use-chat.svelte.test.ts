import { getMessageText } from '@lostgradient/cinder/chat';
import { afterEach, describe, expect, it, mock } from 'bun:test';

import type { RunSummary } from '../../types';
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

function makeStore(overrides: Partial<CreateChatStoreOptions> = {}) {
  const subscribe = mock((_runId: string) => {});
  const unsubscribe = mock((_runId: string) => {});
  const onRunCreated = mock((_run: RunSummary) => {});
  const store = createChatStore({ subscribe, unsubscribe, onRunCreated, ...overrides });
  return { store, subscribe, unsubscribe, onRunCreated };
}

function messageTexts(store: ReturnType<typeof makeStore>['store']): string[] {
  return store.conversation.ids.map((id) => getMessageText(store.conversation.messages[id]!));
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { store, subscribe, onRunCreated } = makeStore();
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
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { store, subscribe, unsubscribe } = makeStore();
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
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { store, subscribe } = makeStore();
    await store.send('hi');

    expect(store.error).toBe('rate limited');
    expect(subscribe).not.toHaveBeenCalled();
    expect(store.sending).toBe(false);
  });

  it('records a thrown network error', async () => {
    const fetchMock = mock(() => Promise.reject(new Error('offline')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { store } = makeStore();
    await store.send('hi');

    expect(store.error).toBe('offline');
    expect(store.sending).toBe(false);
  });

  it('ignores frames for a run other than the active one', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify(makeRun()))));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { store } = makeStore();
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
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { store } = makeStore();
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
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { store } = makeStore();
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
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { store } = makeStore();
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

  it('summarizes completed tool calls in the tool-activity log', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { store } = makeStore();
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
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const onHumanInputRequested = mock(() => {});

    const { store } = makeStore({ onHumanInputRequested });
    await store.send('question');

    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'step.completed',
      detail: {},
      sequence: 1,
      timestamp: 1,
    });

    expect(onHumanInputRequested).toHaveBeenCalledTimes(1);
  });

  it('calls onHumanInputRequested on multiagent.human-wait.parked for the active run', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const onHumanInputRequested = mock(() => {});

    const { store } = makeStore({ onHumanInputRequested });
    await store.send('question');

    store.handleMessage({
      type: 'event',
      runId: 'run-1',
      event: 'multiagent.human-wait.parked',
      detail: {},
      sequence: 1,
      timestamp: 1,
    });

    expect(onHumanInputRequested).toHaveBeenCalledTimes(1);
  });

  it('does not call onHumanInputRequested for an unrelated run', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const onHumanInputRequested = mock(() => {});

    const { store } = makeStore({ onHumanInputRequested });
    await store.send('question');

    store.handleMessage({
      type: 'event',
      runId: 'someone-else',
      event: 'step.completed',
      detail: {},
      sequence: 1,
      timestamp: 1,
    });

    expect(onHumanInputRequested).not.toHaveBeenCalled();
  });

  it('does not call onHumanInputRequested for unrelated event types', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const onHumanInputRequested = mock(() => {});

    const { store } = makeStore({ onHumanInputRequested });
    await store.send('question');

    store.handleMessage({
      type: 'stream:text-delta',
      runId: 'run-1',
      content: 'x',
      accumulated: 'x',
    });

    expect(onHumanInputRequested).not.toHaveBeenCalled();
  });

  it('resets streaming and tool activity at the start of each send', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(makeRun({ id: 'run-1' })))),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { store } = makeStore();
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
