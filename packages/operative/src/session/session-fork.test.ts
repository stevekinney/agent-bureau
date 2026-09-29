import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import type { ConversationHistory } from 'conversationalist';
import {
  createConversationHistory,
  getPendingToolCalls,
  validateConversationHistoryIntegrity,
} from 'conversationalist';
import { z } from 'zod';

import { createAgentSession, type AgentSession } from '../agent-session';
import { SessionForkEvent } from '../events';
import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { reconstructRunConversation } from './run-conversation-boundary';
import { createSessionHandle, ForkThroughRunError, type SessionHandle } from './session-handle';
import {
  collectEvents,
  createInstantGenerate,
  createSessionHandleFixture,
  createTestRunOptions,
  fixtureRuntime,
} from './session-handle-test-support';
import type { SessionStore } from './types';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

const ECHO_PROMPT = 'use the echo tool';

/**
 * A deterministic generate function that replies with the conversation's
 * length, and answers {@link ECHO_PROMPT} with one `echo` tool call followed
 * by a plain reply once the tool result lands.
 */
const scriptedGenerate: GenerateFunction = async ({ conversation }) => {
  const history = conversation.current;
  const last = history.messages[history.ids.at(-1) ?? ''];
  if (last?.role === 'user' && last.content === ECHO_PROMPT) {
    return {
      content: '',
      toolCalls: [{ name: 'echo', arguments: { message: `echo ${history.ids.length}` } }],
    };
  }
  return { content: `reply ${history.ids.length}`, toolCalls: [] };
};

const echoTool = createTool({
  name: 'echo',
  description: 'Echo the input',
  input: z.object({ message: z.string() }),
  execute: async ({ message }: { message: string }) => message,
});

function createForkSource(sessionId: string): { store: SessionStore; handle: SessionHandle } {
  const store = createSessionStore(textValueStore(new MemoryStorage()));
  const handle = createSessionHandle(sessionId, {
    store,
    agentName: 'fork-agent',
    runOptions: { generate: scriptedGenerate, toolbox: createToolbox([echoTool]), maximumSteps: 2 },
  });
  return { store, handle };
}

async function completeRun(handle: SessionHandle, input: string): Promise<void> {
  await handle.run(input).result();
  await yieldToPortableEventLoop();
}

async function loadFork(
  handle: SessionHandle,
  options?: { throughRun?: number },
): Promise<AgentSession> {
  const forked = await handle.fork(options);
  return forked.getSession();
}

async function loadSession(store: SessionStore, sessionId: string): Promise<AgentSession> {
  const session = await store.load(sessionId);
  if (!session) throw new Error(`Expected session "${sessionId}" to exist`);
  return session;
}

function boundaryOf(session: AgentSession, sequence: number): ConversationHistory {
  const boundary = reconstructRunConversation(session.runs, sequence);
  if (!boundary) throw new Error(`Expected run ${sequence} to have a persisted boundary`);
  return boundary;
}

function userContents(history: ConversationHistory): unknown[] {
  return history.ids
    .map((id) => history.messages[id])
    .filter((message) => message?.role === 'user')
    .map((message) => message?.content);
}

function toolCallIds(history: ConversationHistory): string[] {
  return history.ids.flatMap((id) => {
    const message = history.messages[id];
    const callId = message?.toolCall?.id ?? message?.toolResult?.callId;
    return callId === undefined ? [] : [callId];
  });
}

describe('session.fork()', () => {
  it('creates a new session with a different id', async () => {
    const { handle } = createSessionHandleFixture();
    await handle.getSession(); // ensure session exists

    const forked = await handle.fork();
    expect(forked.id).not.toBe(handle.id);
  });

  it('the forked session starts with an empty runs[]', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-source', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });

    await h.run('first run').result();
    await yieldToPortableEventLoop();

    const forked = await h.fork();
    const forkedSession = await forked.getSession();

    expect(forkedSession.runs).toHaveLength(0);
  });

  it('the forked session copies the conversation history', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-history-source', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(createInstantGenerate('copied')),
    });

    await h.run('something').result();
    await yieldToPortableEventLoop();

    const sourceSession = await store.load('fork-history-source');
    const forked = await h.fork();
    const forkedSession = await forked.getSession();

    // Conversation history should be the same as the source.
    expect(forkedSession.conversationHistory).toEqual(sourceSession!.conversationHistory);
  });

  it('the forked handle returns itself from getSession()', async () => {
    const { handle } = createSessionHandleFixture();
    await handle.getSession();

    const forked = await handle.fork();
    const session = await forked.getSession();
    expect(session.id).toBe(forked.id);
  });

  it('fork({ throughRun: lastIndex }) succeeds (no contamination possible)', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-guard-last', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });

    await h.run('first run').result();
    await yieldToPortableEventLoop();
    await h.run('second run').result();
    await yieldToPortableEventLoop();

    // throughRun: 1 is the last run index — no later runs exist, so the full
    // history is correct for this fork point.
    const forked = await h.fork({ throughRun: 1 });
    expect(forked.id).toBeDefined();
    const session = await forked.getSession();
    expect(session.runs).toHaveLength(0);
  });

  it('fork() with no options succeeds regardless of run count', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const h = createSessionHandle('fork-guard-default', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });

    await h.run('first run').result();
    await yieldToPortableEventLoop();
    await h.run('second run').result();
    await yieldToPortableEventLoop();

    // Default fork (no throughRun) always copies full history — no guard needed.
    const forked = await h.fork();
    expect(forked.id).toBeDefined();
  });

  it('fork() with no options keeps copying the latest stored history, not a run boundary', async () => {
    const { store, handle } = createForkSource('fork-latest-history');
    await completeRun(handle, 'first');
    await store.update('fork-latest-history', (session) =>
      session
        ? {
            ...session,
            conversationHistory: {
              ...session.conversationHistory,
              metadata: { editedAfterRun: true },
            },
          }
        : undefined,
    );

    const source = await loadSession(store, 'fork-latest-history');
    const forked = await loadFork(handle);

    expect(forked.conversationHistory).toEqual(source.conversationHistory);
    expect(boundaryOf(source, 0).metadata).not.toEqual({ editedAfterRun: true });
  });
});

describe('session.fork({ throughRun }) — historical boundaries', () => {
  it('persists each terminal run boundary once and never rewrites it', async () => {
    const { store, handle } = createForkSource('fork-boundary-persistence');

    await completeRun(handle, 'first');
    const afterFirst = await loadSession(store, 'fork-boundary-persistence');
    expect(boundaryOf(afterFirst, 0)).toEqual(afterFirst.conversationHistory);

    await completeRun(handle, 'second');
    const afterSecond = await loadSession(store, 'fork-boundary-persistence');
    expect(afterSecond.runs[0]?.conversationBoundary).toEqual(
      afterFirst.runs[0]?.conversationBoundary,
    );
    expect(boundaryOf(afterSecond, 0)).toEqual(afterFirst.conversationHistory);
    expect(boundaryOf(afterSecond, 1)).toEqual(afterSecond.conversationHistory);
    // Run 1 stores only what it added; run 0's immutable boundary supplies the rest.
    const secondBoundary = afterSecond.runs[1]?.conversationBoundary;
    const addedIds = afterSecond.conversationHistory.ids.slice(
      afterFirst.conversationHistory.ids.length,
    );
    expect(secondBoundary?.baseSequence).toBe(0);
    expect(secondBoundary?.baseIdCount).toBe(afterFirst.conversationHistory.ids.length);
    expect(secondBoundary?.ids).toEqual(addedIds);
    expect(Object.keys(secondBoundary?.messages ?? {})).toEqual(addedIds);
  });

  it('stores each message id and body in exactly one boundary across sequential runs', async () => {
    const { store, handle } = createForkSource('fork-boundary-linear-storage');
    const turns = Array.from({ length: 12 }, (_, index) => `turn ${index}`);
    for (const turn of turns) await completeRun(handle, turn);

    const session = await loadSession(store, 'fork-boundary-linear-storage');
    const history = session.conversationHistory;
    const serializedBoundaries = session.runs.map((runRef) =>
      JSON.stringify(runRef.conversationBoundary),
    );
    // Storage stays linear in the transcript: no run re-stores an id or a
    // body that an earlier run's boundary already holds.
    expect(serializedBoundaries).toHaveLength(turns.length);
    for (const id of history.ids) {
      const holders = serializedBoundaries.filter((serialized) =>
        serialized.includes(JSON.stringify(id)),
      );
      expect(holders).toHaveLength(1);
    }
    for (const turn of turns) {
      const holders = serializedBoundaries.filter((serialized) =>
        serialized.includes(JSON.stringify(turn)),
      );
      expect(holders).toHaveLength(1);
    }
    expect(boundaryOf(session, turns.length - 1)).toEqual(history);
  });

  it('forks through any completed run without copying messages from later runs', async () => {
    const { store, handle } = createForkSource('fork-through-earlier');
    await completeRun(handle, 'first');
    await completeRun(handle, 'second');
    await completeRun(handle, 'third');
    const source = await loadSession(store, 'fork-through-earlier');

    const expectedUserTurns = [['first'], ['first', 'second'], ['first', 'second', 'third']];
    for (const [throughRun, expectedUsers] of expectedUserTurns.entries()) {
      const boundary = boundaryOf(source, throughRun);
      const forked = await loadFork(handle, { throughRun });

      expect(forked.conversationHistory).toEqual(boundary);
      expect(userContents(forked.conversationHistory)).toEqual(expectedUsers);
      expect(source.conversationHistory.ids.slice(0, boundary.ids.length)).toEqual([
        ...boundary.ids,
      ]);
      const laterIds = source.conversationHistory.ids.slice(boundary.ids.length);
      expect(laterIds.length > 0).toBe(throughRun < 2);
      for (const laterId of laterIds) {
        expect(forked.conversationHistory.ids).not.toContain(laterId);
        expect(forked.conversationHistory.messages[laterId]).toBeUndefined();
      }
    }
  });

  it('keeps a later run out of an earlier boundary even when the later run commits first', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const earlierEntered = Promise.withResolvers<void>();
    const releaseEarlier = Promise.withResolvers<void>();
    const earlierHandle = createSessionHandle('fork-through-concurrent', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(async () => {
        earlierEntered.resolve();
        await releaseEarlier.promise;
        return { content: 'earlier reply', toolCalls: [] };
      }),
    });
    const laterHandle = createSessionHandle('fork-through-concurrent', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(createInstantGenerate('later reply')),
    });

    const earlierRun = earlierHandle.run('earlier');
    await earlierEntered.promise;
    await completeRun(laterHandle, 'later');
    releaseEarlier.resolve();
    await earlierRun.result();
    await yieldToPortableEventLoop();

    const source = await loadSession(store, 'fork-through-concurrent');
    expect(userContents(source.conversationHistory)).toEqual(['later', 'earlier']);
    const throughEarlier = await loadFork(earlierHandle, { throughRun: 0 });
    expect(userContents(throughEarlier.conversationHistory)).toEqual(['earlier']);
    expect(throughEarlier.conversationHistory).toEqual(boundaryOf(source, 0));
    const throughLater = await loadFork(earlierHandle, { throughRun: 1 });
    expect(userContents(throughLater.conversationHistory)).toEqual(['later']);
  });

  it('starts a historical fork with a new session id and an empty run list', async () => {
    const { store, handle } = createForkSource('fork-through-identity');
    await completeRun(handle, 'first');
    await completeRun(handle, 'second');
    const forkEvents = collectEvents(handle.emitter, SessionForkEvent.type);

    const forked = await handle.fork({ throughRun: 0 });
    const forkedSession = await forked.getSession();

    expect(forked.id).not.toBe(handle.id);
    expect(forkedSession.id).toBe(forked.id);
    expect(forkedSession.runs).toEqual([]);
    const source = await loadSession(store, 'fork-through-identity');
    expect(source.runs).toHaveLength(2);
    expect(forkEvents).toHaveLength(1);
    const [event] = forkEvents;
    if (!(event instanceof SessionForkEvent)) throw new TypeError('Expected SessionForkEvent');
    expect(event.sourceSessionId).toBe(handle.id);
    expect(event.forkedSessionId).toBe(forked.id);
    expect(event.throughRun).toBe(0);
  });

  it('forks through a run that ended in error because its transcript is terminal', async () => {
    let calls = 0;
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const handle = createSessionHandle('fork-through-error', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(async () => {
        calls += 1;
        if (calls === 2) throw new Error('provider exploded');
        return { content: `reply ${calls}`, toolCalls: [] };
      }),
    });
    await completeRun(handle, 'first');
    await completeRun(handle, 'second');
    await completeRun(handle, 'third');
    const source = await loadSession(store, 'fork-through-error');
    expect(source.runs[1]?.status).toBe('error');

    const forked = await loadFork(handle, { throughRun: 1 });

    expect(forked.conversationHistory).toEqual(boundaryOf(source, 1));
    expect(userContents(forked.conversationHistory)).toEqual(['first', 'second']);
  });

  it('keeps the forked history independent of later work on either branch', async () => {
    const { store, handle } = createForkSource('fork-through-independent');
    await completeRun(handle, 'first');
    await completeRun(handle, 'second');
    const forked = await handle.fork({ throughRun: 0 });
    const forkedAtCreation = await forked.getSession();

    await completeRun(handle, 'third on source');
    await completeRun(forked, 'second on fork');

    const source = await loadSession(store, 'fork-through-independent');
    const forkedLater = await loadSession(store, forked.id);
    expect(userContents(source.conversationHistory)).toEqual([
      'first',
      'second',
      'third on source',
    ]);
    expect(userContents(forkedLater.conversationHistory)).toEqual(['first', 'second on fork']);
    const forkedIdsAtCreation = forkedAtCreation.conversationHistory.ids;
    expect(forkedLater.conversationHistory.ids.slice(0, forkedIdsAtCreation.length)).toEqual([
      ...forkedIdsAtCreation,
    ]);
    expect(boundaryOf(source, 0).ids).toEqual(forkedAtCreation.conversationHistory.ids);
  });
});

describe('session.fork({ throughRun }) — typed fork-point errors', () => {
  async function expectForkRejection(
    store: SessionStore,
    handle: SessionHandle,
    throughRun: number,
    reason: ForkThroughRunError['reason'],
  ): Promise<void> {
    const sessionsBefore = await store.list();
    const forkEvents = collectEvents(handle.emitter, SessionForkEvent.type);
    const rejection = await handle.fork({ throughRun }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(ForkThroughRunError);
    expect(rejection).toMatchObject({
      name: 'ForkThroughRunError',
      code: 'ForkThroughRunError',
      reason,
      sessionId: handle.id,
      throughRun,
    });
    expect(forkEvents).toHaveLength(0);
    expect(await store.list()).toEqual(sessionsBefore);
  }

  it.each([
    ['a fractional', 1.5, 'invalid'],
    ['a NaN', Number.NaN, 'invalid'],
    ['an infinite', Number.POSITIVE_INFINITY, 'invalid'],
    ['a negative', -1, 'negative'],
    ['an out-of-range', 2, 'out-of-range'],
  ] as const)('rejects %s fork point with a typed error', async (_label, throughRun, reason) => {
    const { store, handle } = createForkSource(`fork-point-${reason}-${String(throughRun)}`);
    await completeRun(handle, 'first');
    await completeRun(handle, 'second');

    await expectForkRejection(store, handle, throughRun, reason);
  });

  it('rejects any explicit fork point on a session with no runs as out of range', async () => {
    const { store, handle } = createForkSource('fork-point-empty');
    await handle.getSession();

    await expectForkRejection(store, handle, 0, 'out-of-range');
  });

  it('rejects a fork point whose run is still running as non-terminal', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const generateEntered = Promise.withResolvers<void>();
    const releaseGenerate = Promise.withResolvers<void>();
    const handle = createSessionHandle('fork-point-running', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(async () => {
        generateEntered.resolve();
        await releaseGenerate.promise;
        return { content: 'late', toolCalls: [] };
      }),
    });
    const running = handle.run('still going');
    await generateEntered.promise;
    const reserved = await loadSession(store, 'fork-point-running');
    expect(reserved.runs[0]?.status).toBe('running');
    expect(reserved.runs[0]?.conversationBoundary).toBeUndefined();

    await expectForkRejection(store, handle, 0, 'non-terminal');

    releaseGenerate.resolve();
    await running.result();
  });

  it('rejects a terminal run recorded without a boundary as unavailable', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    await store.save(
      createAgentSession({
        agentName: 'fork-agent',
        conversationHistory: createConversationHistory(),
        id: 'fork-point-legacy',
        runs: [
          {
            runId: 'fork-point-legacy:0',
            sequence: 0,
            status: 'completed',
            startedAt: fixtureRuntime.clock.nowISO(),
            agentName: 'fork-agent',
            outcome: { finishReason: 'stop-condition' },
          },
        ],
      }),
    );
    const handle = createSessionHandle('fork-point-legacy', {
      store,
      agentName: 'fork-agent',
      runOptions: createTestRunOptions(),
    });

    await expectForkRejection(store, handle, 0, 'unavailable');
  });

  it('explains each rejection in its message', () => {
    const messages = (
      ['invalid', 'negative', 'out-of-range', 'non-terminal', 'unavailable'] as const
    ).map(
      (reason) =>
        new ForkThroughRunError({ sessionId: 'source', throughRun: 3, runCount: 2, reason })
          .message,
    );

    expect(messages).toEqual([
      'session.fork({ throughRun: 3 }) on session "source" requires a non-negative integer run sequence.',
      'session.fork({ throughRun: 3 }) on session "source" requires a non-negative integer run sequence.',
      'session.fork({ throughRun: 3 }) on session "source" is out of range: the session has 2 run(s).',
      'session.fork({ throughRun: 3 }) on session "source" targets a run that has not reached a terminal status.',
      'session.fork({ throughRun: 3 }) on session "source" targets a run with no recorded conversation boundary.',
    ]);
  });
});

describe('regression — historical forks never orphan or leak tool interactions', () => {
  it('keeps tool calls paired with their results and out of discarded branches', async () => {
    const { store, handle } = createForkSource('fork-tool-regression');
    await completeRun(handle, 'first');
    await completeRun(handle, ECHO_PROMPT);
    await completeRun(handle, 'third');
    const source = await loadSession(store, 'fork-tool-regression');
    const sourceToolCallIds = toolCallIds(source.conversationHistory);
    expect(sourceToolCallIds).toHaveLength(2);
    expect(new Set(sourceToolCallIds).size).toBe(1);

    const beforeTools = await loadFork(handle, { throughRun: 0 });
    expect(toolCallIds(beforeTools.conversationHistory)).toEqual([]);
    expect(validateConversationHistoryIntegrity(beforeTools.conversationHistory)).toEqual([]);

    const throughTools = await loadFork(handle, { throughRun: 1 });
    expect(toolCallIds(throughTools.conversationHistory)).toEqual(sourceToolCallIds);
    expect(validateConversationHistoryIntegrity(throughTools.conversationHistory)).toEqual([]);
    expect(getPendingToolCalls(throughTools.conversationHistory)).toEqual([]);

    const branch = createSessionHandle(beforeTools.id, {
      store,
      agentName: 'fork-agent',
      runOptions: {
        generate: scriptedGenerate,
        toolbox: createToolbox([echoTool]),
        maximumSteps: 2,
      },
    });
    await completeRun(branch, ECHO_PROMPT);

    const branchSession = await loadSession(store, branch.id);
    const branchHistory = branchSession.conversationHistory;
    const branchToolCallIds = toolCallIds(branchHistory);
    expect(branchToolCallIds).toHaveLength(2);
    expect(branchToolCallIds.some((id) => sourceToolCallIds.includes(id))).toBe(false);
    expect(validateConversationHistoryIntegrity(branchHistory)).toEqual([]);
    expect(getPendingToolCalls(branchHistory)).toEqual([]);
    const sourceAfterBranch = await loadSession(store, source.id);
    expect(toolCallIds(sourceAfterBranch.conversationHistory)).toEqual(sourceToolCallIds);
  });
});
