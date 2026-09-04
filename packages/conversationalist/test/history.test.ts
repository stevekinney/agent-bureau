import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import type { TruncateOptions } from '../src/context';
import { estimateConversationTokens, truncateToTokenLimit } from '../src/context';
import { ConversationChangeEvent } from '../src/events';
import { Conversation as ConversationHistory } from '../src/history';
import {
  appendUserMessage,
  createConversationHistory as createConversation,
  getStatistics,
} from '../src/index';
import {
  conversationFromMarkdown as conversationHistoryFromMarkdown,
  conversationToMarkdown as conversationHistoryToMarkdown,
} from '../src/markdown';
import type {
  ConversationHistory as ConversationState,
  Message,
  TokenEstimator,
} from '../src/types';

const getOrderedMessages = (conversation: ConversationState): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('Conversation', () => {
  it('should have event methods without extending EventTarget', () => {
    const history = new ConversationHistory(createConversation());
    expect(typeof history.addEventListener).toBe('function');
    expect(typeof history.removeEventListener).toBe('function');
    expect(typeof history.dispatchEvent).toBe('function');
    expect(typeof history.on).toBe('function');
    expect(typeof history.once).toBe('function');
    expect(typeof history.subscribe).toBe('function');
  });

  it('should initialize with a conversation', () => {
    const conversation = createConversation({ title: 'Test' });
    const history = new ConversationHistory(conversation);
    expect(history.current).toEqual(conversation);
    expect(history.current).not.toBe(conversation);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('should initialize with an empty conversation by default', () => {
    const history = new ConversationHistory();
    expect(history.current.ids).toHaveLength(0);
    expect(history.current.status).toBe('active');
    expect(history.canUndo).toBe(false);
  });

  it('mints the default conversation through a supplied runtime, not the real globals (AB-321)', () => {
    const runtime = createManualRuntimeServices({ origin: '2030-03-01T00:00:00.000Z' });

    // No `initial` argument at all — the exact shape every operative call
    // site (`new Conversation()`) uses. Before AB-321 the constructor's
    // default parameter minted the initial history with a bare, unseeded
    // environment, so a caller-supplied `environment` was silently ignored
    // for the id and timestamps.
    const history = new ConversationHistory(undefined, { runtime });

    expect(history.current.id).toBe(`${runtime.identifierPrefix}-conversation-1`);
    expect(history.current.createdAt).toBe('2030-03-01T00:00:00.000Z');
  });

  it('produces byte-identical default conversation ids from two independently constructed runtimes with the same seeds (AB-321)', () => {
    const runtimeA = createManualRuntimeServices({
      origin: '2030-03-01T00:00:00.000Z',
      identifierSeed: 'shared-seed',
    });
    const runtimeB = createManualRuntimeServices({
      origin: '2030-03-01T00:00:00.000Z',
      identifierSeed: 'shared-seed',
    });

    const historyA = new ConversationHistory(undefined, { runtime: runtimeA });
    const historyB = new ConversationHistory(undefined, { runtime: runtimeB });

    expect(historyA.current.id).toBe(historyB.current.id);
    expect(historyA.current.createdAt).toBe(historyB.current.createdAt);
  });

  it('should support undo and redo', () => {
    const v1 = createConversation({ title: 'V1' });
    const history = new ConversationHistory(v1);

    const v2 = appendUserMessage(v1, 'Hello');
    history.push(v2);

    expect(history.current).toEqual(v2);
    expect(history.canUndo).toBe(true);

    const undone = history.undo();
    expect(undone).toEqual(v1);
    expect(history.current).toEqual(v1);
    expect(history.canRedo).toBe(true);

    const redone = history.redo();
    expect(redone).toEqual(v2);
    expect(history.current).toEqual(v2);
  });

  it('should support branching and switching between branches', () => {
    const v1 = createConversation({ title: 'V1' });
    const history = new ConversationHistory(v1);

    const v2 = appendUserMessage(v1, 'Message 2');
    history.push(v2);

    history.undo(); // back to v1

    const v3 = appendUserMessage(v1, 'Message 3');
    history.push(v3); // Creates a second branch from v1

    expect(history.current).toEqual(v3);
    expect(history.branchCount).toBe(2);
    expect(history.branchIndex).toBe(1);

    history.switchToBranch(0);
    expect(history.current).toEqual(v2);
    expect(history.branchIndex).toBe(0);

    history.undo();
    expect(history.current).toEqual(v1);
    expect(history.redo(1)).toEqual(v3);
  });

  it('should return path to current state', () => {
    const v1 = createConversation({ title: 'V1' });
    const history = new ConversationHistory(v1);
    const v2 = appendUserMessage(v1, 'V2');
    history.push(v2);
    const v3 = appendUserMessage(v2, 'V3');
    history.push(v3);

    const path = history.getPath();
    expect(path).toEqual([v1, v2, v3]);
  });

  it('should add a new branch instead of truncating history', () => {
    const history = new ConversationHistory(createConversation({ title: 'V1' }));
    const v1 = history.current;
    const v2 = appendUserMessage(v1, 'V2');
    history.push(v2);
    history.undo();

    const v3 = appendUserMessage(v1, 'V3');
    history.push(v3);

    expect(history.current).toEqual(v3);
    expect(history.branchCount).toBe(2);

    history.undo();
    expect(history.canRedo).toBe(true);
    expect(history.redo(0)).toEqual(v2);
  });

  it('should bind functions and automatically push updates', () => {
    const history = new ConversationHistory(createConversation());
    const boundAppend = history.bind(appendUserMessage);

    boundAppend('Hello');
    const afterFirst = getOrderedMessages(history.current);
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0].content).toBe('Hello');

    boundAppend('World');
    expect(history.current.ids.length).toBe(2);
    expect(history.canUndo).toBe(true);

    history.undo();
    expect(history.current.ids.length).toBe(1);
  });

  it('should bind functions that do not return a conversation without pushing', () => {
    const history = new ConversationHistory(createConversation());
    const boundStats = history.bind(getStatistics);

    const stats = boundStats();
    expect(stats.total).toBe(0);
    expect(history.current.ids.length).toBe(0); // Should not have pushed
  });

  it('should not push non-conformant objects to history', () => {
    const original = createConversation({ id: 'original' });
    const history = new ConversationHistory(original);
    const boundIncomplete = history.bind(
      () =>
        ({
          id: 'incomplete',
          messages: [],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          // missing status, metadata
        }) as any,
    );

    boundIncomplete();
    expect(history.current.id).toBe('original'); // Should NOT have pushed the incomplete object
  });

  it('should not push objects with null metadata to history', () => {
    const original = createConversation({ id: 'original' });
    const history = new ConversationHistory(original);
    const boundWithNullMetadata = history.bind(
      () =>
        ({
          id: 'null-metadata',
          status: 'active',
          metadata: null,
          messages: [],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        }) as any,
    );

    boundWithNullMetadata();
    expect(history.current.id).toBe('original'); // Should NOT have pushed the object with null metadata
  });

  it('should use custom token estimator from environment when bound', () => {
    const customEstimator = () => 100; // Every message is 100 tokens
    const history = new ConversationHistory(createConversation(), {
      estimateTokens: customEstimator,
    });

    // Explicit type arguments select the sync overload of `truncateToTokenLimit`:
    // `bind`'s generic inference from an overloaded function value only considers
    // the last overload signature, which would otherwise require the async options.
    const boundTruncate = history.bind<
      [number, (TruncateOptions | TokenEstimator)?],
      ConversationState
    >(truncateToTokenLimit);

    history.push(appendUserMessage(history.current, 'Hello'));
    history.push(appendUserMessage(history.current, 'World'));

    // 2 messages + initial = 3 * 100 = 300 tokens
    // Truncate to 150 should leave 1 message + initial (if initial is empty/0 tokens, but we said every message is 100)
    // Wait, createConversation creates 0 messages.
    // So 2 messages * 100 = 200 tokens.
    // Truncate to 150 should leave 1 message.

    boundTruncate(150);
    expect(history.current.ids.length).toBe(1);
  });

  it('should use custom token estimator from environment for estimateConversationTokens when bound', () => {
    const customEstimator = () => 100;
    const history = new ConversationHistory(createConversation(), {
      estimateTokens: customEstimator,
    });

    // Explicit type arguments select the sync overload; see the comment above
    // `boundTruncate` for why inference alone picks the wrong overload here.
    const boundEstimate = history.bind<[TokenEstimator?], number>(estimateConversationTokens);

    history.push(appendUserMessage(history.current, 'Hello'));
    history.push(appendUserMessage(history.current, 'World'));

    expect(boundEstimate()).toBe(200);
  });

  it('should return 0 for redoCount on a leaf node', () => {
    const history = new ConversationHistory(createConversation());
    expect(history.redoCount).toBe(0);
  });

  it('should return undefined when undo is not possible', () => {
    const history = new ConversationHistory(createConversation());
    expect(history.undo()).toBeUndefined();
  });

  it('should return undefined when redo is not possible', () => {
    const history = new ConversationHistory(createConversation());
    expect(history.redo()).toBeUndefined();
  });

  it('should return undefined when switching to non-existent branch', () => {
    const history = new ConversationHistory(createConversation());
    expect(history.switchToBranch(1)).toBeUndefined();
  });

  it('should return 1 for branchCount and 0 for branchIndex on root node', () => {
    const history = new ConversationHistory(createConversation());
    expect(history.branchCount).toBe(1);
    expect(history.branchIndex).toBe(0);
  });

  describe('encapsulated utility methods', () => {
    it('should support query methods', () => {
      let conv = createConversation({ title: 'Query' });
      conv = appendUserMessage(conv, 'Hello');
      const history = new ConversationHistory(conv);

      expect(history.getMessages()).toHaveLength(1);
      expect(history.getMessageAtPosition(0)?.content).toBe('Hello');
      expect(history.getStatistics().total).toBe(1);
      expect(history.current.title).toBe('Query');
      expect(history.toChatMessages()).toHaveLength(1);
      expect(conversationHistoryToMarkdown(history)).toContain('### User');
      expect(conversationHistoryToMarkdown(history, { includeMetadata: true })).toContain('---');

      const restored = conversationHistoryFromMarkdown(
        conversationHistoryToMarkdown(history, { includeMetadata: true }),
      );
      const restoredMessages = getOrderedMessages(restored.current);
      expect(restoredMessages).toHaveLength(1);
      expect(restoredMessages[0].content).toBe('Hello');
      expect(history.estimateTokens()).toBeGreaterThan(0);
      expect(history.getRecentMessages(1)).toHaveLength(1);
      expect(history.hasSystemMessage()).toBe(false);
      expect(history.getFirstSystemMessage()).toBeUndefined();
      expect(history.getSystemMessages()).toHaveLength(0);
      expect(history.searchMessages((m) => m.role === 'user')).toHaveLength(1);
      const convMessages = getOrderedMessages(conv);
      expect(history.getMessageById(convMessages[0].id)).toBeDefined();
      expect(history.get(convMessages[0].id)).toBeDefined();
      expect([...history.getMessageIds()]).toEqual([...conv.ids]);
      expect([...history.ids]).toEqual([...conv.ids]);
    });

    it('should support mutation methods', () => {
      const history = new ConversationHistory(createConversation());

      history.appendMessages({ role: 'user', content: 'First' });
      expect(history.current.ids.length).toBe(1);

      history.appendUserMessage('User msg');
      expect(history.current.ids.length).toBe(2);
      expect(history.canUndo).toBe(true);

      history.appendAssistantMessage('Assistant msg');
      expect(history.current.ids.length).toBe(3);

      history.appendSystemMessage('System msg');
      expect(history.current.ids.length).toBe(4);

      history.prependSystemMessage('First system');
      expect(getOrderedMessages(history.current)[0].content).toBe('First system');

      history.replaceSystemMessage('New system');
      expect(history.getFirstSystemMessage()?.content).toBe('New system');

      history.collapseSystemMessages();
      expect(history.getSystemMessages()).toHaveLength(1);

      history.redactMessageAtPosition(1, '[REDACTED]');
      expect(history.getMessageAtPosition(1)?.content).toBe('[REDACTED]');

      history.truncateFromPosition(1);
      expect(history.current.ids.length).toBe(4); // system + messages from pos 1

      history.truncateToTokenLimit(10);
      expect(history.current.ids.length).toBeLessThan(4);
    });

    it('should support streaming mutation methods', () => {
      const history = new ConversationHistory(createConversation());

      const messageId = history.appendStreamingMessage('assistant');
      expect(history.getStreamingMessage()?.id).toBe(messageId);

      history.updateStreamingMessage(messageId, 'Partial...');
      expect(getOrderedMessages(history.current)[0].content).toBe('Partial...');

      history.finalizeStreamingMessage(messageId, {
        tokenUsage: { prompt: 1, completion: 1, total: 2 },
      });
      expect(history.getStreamingMessage()).toBeUndefined();
      expect(getOrderedMessages(history.current)[0].tokenUsage?.total).toBe(2);

      const nextId = history.appendStreamingMessage('user');
      history.cancelStreamingMessage(nextId);
      expect(history.current.ids.length).toBe(1);
    });

    it('should not emit any event when a late token is rejected', () => {
      const history = new ConversationHistory(createConversation());
      const messageId = history.appendStreamingMessage('assistant');
      history.updateStreamingMessage(messageId, 'Frozen');
      history.finalizeStreamingMessage(messageId);

      const observed: string[] = [];
      for (const type of ['change', 'push', 'messages.updated', 'stream.updated'] as const) {
        history.addEventListener(type, () => observed.push(type));
      }

      history.updateStreamingMessage(messageId, 'Frozen and then some');
      history.updateStreamingMessage('no-such-message', 'Never existed');

      expect(observed).toEqual([]);
      expect(getOrderedMessages(history.current)[0].content).toBe('Frozen');
    });

    it('should not add an undo entry when a late token is rejected', () => {
      const countUndoSteps = (subject: ConversationHistory): number => {
        let steps = 0;
        while (subject.canUndo) {
          subject.undo();
          steps += 1;
        }
        return steps;
      };

      const build = (): ConversationHistory => {
        const subject = new ConversationHistory(createConversation());
        const messageId = subject.appendStreamingMessage('assistant');
        subject.updateStreamingMessage(messageId, 'Frozen');
        subject.finalizeStreamingMessage(messageId);
        return subject;
      };

      const baseline = build();
      const flooded = build();
      const finalizedState = flooded.current;
      const messageId = finalizedState.ids[0]!;
      for (let index = 0; index < 5; index += 1) {
        flooded.updateStreamingMessage(messageId, `late token ${index}`);
      }

      // The flood left the state and the undo chain exactly as finalize did.
      expect(flooded.current).toBe(finalizedState);
      expect(countUndoSteps(flooded)).toBe(countUndoSteps(baseline));
    });

    it('should support serialization and deserialization of the full history tree', () => {
      const history = new ConversationHistory(createConversation({ title: 'Root' }));
      history.appendUserMessage('V1');
      history.undo();
      history.appendUserMessage('V2');
      history.appendAssistantMessage('V2-A');

      const json = history.snapshot();
      const restored = ConversationHistory.from(json);

      expect(restored.current.title).toBe('Root');
      const restoredMessages = getOrderedMessages(restored.current);
      expect(restoredMessages).toHaveLength(2);
      expect(restoredMessages[0].content).toBe('V2');
      expect(restoredMessages[1].content).toBe('V2-A');

      restored.undo();
      restored.undo();
      expect(restored.current.ids).toHaveLength(0);

      // Check the other branch
      restored.redo(0);
      const branchMessages = getOrderedMessages(restored.current);
      expect(branchMessages).toHaveLength(1);
      expect(branchMessages[0].content).toBe('V1');
    });

    it('should support event listeners and dispatch events on mutations', () => {
      const history = new ConversationHistory(createConversation());
      let changeCount = 0;
      let lastType = '';
      const actionEvents: Array<{ type: string; detailType: string }> = [];

      const changeHandler = (e: any) => {
        changeCount++;
        expect(e.type).toBe('change');
        lastType = e.action;
      };
      const pushHandler = (e: any) => {
        actionEvents.push({ type: e.type, detailType: e.action });
      };
      const undoHandler = (e: any) => {
        actionEvents.push({ type: e.type, detailType: e.action });
      };
      const redoHandler = (e: any) => {
        actionEvents.push({ type: e.type, detailType: e.action });
      };
      const switchHandler = (e: any) => {
        actionEvents.push({ type: e.type, detailType: e.action });
      };
      history.addEventListener('change', changeHandler);
      history.addEventListener('push', pushHandler);
      history.addEventListener('undo', undoHandler);
      history.addEventListener('redo', redoHandler);
      history.addEventListener('switch', switchHandler);

      history.appendUserMessage('test');
      expect(changeCount).toBe(1);
      expect(lastType).toBe('messages.appended');

      history.undo();
      expect(changeCount).toBe(2);
      expect(lastType).toBe('undo');

      history.redo();
      expect(changeCount).toBe(3);
      expect(lastType).toBe('redo');

      history.undo();
      history.appendUserMessage('branch');
      history.switchToBranch(0);
      expect(changeCount).toBe(6); // push, undo, redo, undo, push, switch
      expect(lastType).toBe('switch');

      history.removeEventListener('change', changeHandler);
      history.removeEventListener('push', pushHandler);
      history.removeEventListener('undo', undoHandler);
      history.removeEventListener('redo', redoHandler);
      history.removeEventListener('switch', switchHandler);
      history.appendUserMessage('after unsubscribe');
      expect(changeCount).toBe(6); // no increase

      expect(actionEvents.map((event) => event.type)).toEqual([
        'push',
        'undo',
        'redo',
        'undo',
        'push',
        'switch',
      ]);
      expect(actionEvents.map((event) => event.detailType)).toEqual([
        'push',
        'undo',
        'redo',
        'undo',
        'push',
        'switch',
      ]);
    });

    it('should support AbortSignal in addEventListener', () => {
      const history = new ConversationHistory(createConversation());
      let count = 0;
      const controller = new AbortController();

      history.addEventListener('change', () => count++, { signal: controller.signal });

      history.appendUserMessage('msg');
      expect(count).toBe(1);

      controller.abort();
      history.appendUserMessage('msg 2');
      expect(count).toBe(1);
    });

    it('should support cleanup via Symbol.dispose', () => {
      const history = new ConversationHistory(createConversation());
      history.appendUserMessage('msg');

      // Explicit cleanup
      history[Symbol.dispose]();

      // Node references should be cleared (verified via no crash on repeated dispose)
      expect(() => history[Symbol.dispose]()).not.toThrow();
    });

    it('should support watch for state observation', () => {
      const history = new ConversationHistory(createConversation({ id: 'test' }));
      let current: ConversationState | undefined;
      const unsubscribe = history.watch((v) => {
        current = v;
      });

      expect(current?.id).toBe('test');

      history.appendUserMessage('new message');
      expect(current?.ids.length).toBe(1);

      unsubscribe();
      history.appendUserMessage('another one');
      expect(current?.ids.length).toBe(1);
    });

    it('should support getSnapshot for React useSyncExternalStore', () => {
      const conversation = createConversation();
      const history = new ConversationHistory(conversation);
      expect(history.getSnapshot()).toEqual({
        conversation,
        revision: 0,
        lifecycle: 'open',
      });
      expect(history.getSnapshot()).not.toBe(conversation);
      expect(history.getSnapshot()).toBe(history.getSnapshot());
    });

    it('should expose the environment via env getter', () => {
      const customEnv = { randomId: () => 'custom-id' };
      const history = new ConversationHistory(createConversation(), customEnv);
      expect(history.env.randomId()).toBe('custom-id');
    });

    it('removes event listeners with options', () => {
      const history = new ConversationHistory(createConversation());
      // ConversationChangeEvent imported at top of file
      let calls = 0;
      const handler = () => {
        calls += 1;
      };

      history.addEventListener('change', handler, { capture: true });
      history.removeEventListener('change', handler, { capture: true });

      history.dispatchEvent(
        new ConversationChangeEvent({
          action: 'push',
          conversation: history.current,
          previousConversation: history.current,
          revision: 0,
          sequence: 0,
          correlationId: 'test-correlation-id',
          durability: 'ephemeral',
          outcome: 'accepted',
        }),
      );

      expect(calls).toBe(0);
    });

    it('dispatches events through the internal target', () => {
      const history = new ConversationHistory(createConversation());
      let seen = false;
      history.addEventListener('change', (event: any) => {
        if (event.action === 'push') {
          seen = true;
        }
      });

      // ConversationChangeEvent imported at top of file
      history.dispatchEvent(
        new ConversationChangeEvent({
          action: 'push',
          conversation: history.current,
          previousConversation: history.current,
          revision: 0,
          sequence: 0,
          correlationId: 'test-correlation-id',
          durability: 'ephemeral',
          outcome: 'accepted',
        }),
      );

      expect(seen).toBe(true);
    });

    it('supports boolean listener options overloads', () => {
      const history = new ConversationHistory(createConversation());
      // ConversationChangeEvent imported at top of file
      let calls = 0;
      const handler = () => {
        calls += 1;
      };

      history.addEventListener('change', handler, false);
      history.dispatchEvent(
        new ConversationChangeEvent({
          action: 'push',
          conversation: history.current,
          previousConversation: history.current,
          revision: 0,
          sequence: 0,
          correlationId: 'test-correlation-id',
          durability: 'ephemeral',
          outcome: 'accepted',
        }),
      );
      expect(calls).toBe(1);

      history.removeEventListener('change', handler, false);
      history.dispatchEvent(
        new ConversationChangeEvent({
          action: 'push',
          conversation: history.current,
          previousConversation: history.current,
          revision: 0,
          sequence: 0,
          correlationId: 'test-correlation-id',
          durability: 'ephemeral',
          outcome: 'accepted',
        }),
      );
      expect(calls).toBe(1);
    });

    it('watch returns an unsubscribe function that removes the listener', () => {
      const history = new ConversationHistory(createConversation());
      let calls = 0;
      const unsubscribe = history.watch(() => {
        calls++;
      });

      expect(typeof unsubscribe).toBe('function');
      expect(calls).toBe(1); // initial call

      history.appendUserMessage('msg');
      expect(calls).toBe(2);

      unsubscribe();
      history.appendUserMessage('msg2');
      expect(calls).toBe(2); // no further calls
    });

    it('supports dispatchEvent() for typed event emission', () => {
      const history = new ConversationHistory(createConversation());
      let received = false;
      history.addEventListener('change', () => {
        received = true;
      });

      // ConversationChangeEvent imported at top of file
      history.dispatchEvent(
        new ConversationChangeEvent({
          action: 'push',
          conversation: history.current,
          previousConversation: history.current,
          revision: 0,
          sequence: 0,
          correlationId: 'test-correlation-id',
          durability: 'ephemeral',
          outcome: 'accepted',
        }),
      );

      expect(received).toBe(true);
    });

    describe('compaction', () => {
      it('compacts conversation replacing old messages with summary', async () => {
        const history = new ConversationHistory(createConversation());
        for (let i = 0; i < 10; i++) {
          history.appendUserMessage(`Message ${i}`);
          history.appendAssistantMessage(`Reply ${i}`);
        }
        const before = history.current.ids.length;

        const result = await history.compact(async (messages) => {
          return `Summary of ${messages.length} messages`;
        });

        expect(result.compacted).toBe(true);
        expect(result.messagesRemoved).toBeGreaterThan(0);
        expect(history.current.ids.length).toBeLessThan(before);
      });

      it('emits compaction events', async () => {
        const history = new ConversationHistory(createConversation());
        for (let i = 0; i < 8; i++) {
          history.appendUserMessage(`Msg ${i}`);
        }

        const events: string[] = [];
        history.addEventListener('compaction.started', () => events.push('started'));
        history.addEventListener('compaction.completed', () => events.push('completed'));

        await history.compact(async () => 'summary');

        expect(events).toContain('started');
        expect(events).toContain('completed');
      });

      it('returns compacted false when nothing to compact', async () => {
        const history = new ConversationHistory(createConversation());
        history.appendUserMessage('one');
        history.appendAssistantMessage('two');

        const result = await history.compact(async () => 'summary');
        expect(result.compacted).toBe(false);
      });
    });

    it('supports observable event helpers and tool interaction wrappers', async () => {
      let identifierIndex = 0;
      const history = new ConversationHistory(createConversation(), {
        randomId: () => `tool-call-${++identifierIndex}`,
      });

      const typedEvents: string[] = [];
      const allEvents: string[] = [];
      const onEvents: string[] = [];
      let onceCount = 0;

      const onSubscription = history
        .on('tool-calls.appended')
        .subscribe((event) => onEvents.push(event.type));
      const typedSubscription = history.subscribe('tool-results.appended', (event) => {
        typedEvents.push(event.type);
      });
      const allSubscription = history.toObservable().subscribe((event) => {
        allEvents.push(event.type);
      });
      history.once('tool-calls.appended', () => {
        onceCount += 1;
      });

      history.appendToolCall({
        name: 'lookup-weather',
        arguments: { city: 'Denver' },
      });
      history.appendToolCalls([]);

      const [firstPendingToolCall] = history.getPendingToolCalls();
      expect(firstPendingToolCall?.id).toBe('tool-call-1');
      expect(firstPendingToolCall?.arguments).toEqual({ city: 'Denver' });

      const nextToolResultEvent = history.events('tool-results.appended').next();

      history.appendToolResult({
        callId: 'tool-call-1',
        outcome: 'success',
        content: { forecast: 'sunny' },
      });

      const emittedToolResultEvent = await nextToolResultEvent;
      expect(emittedToolResultEvent.done).toBe(false);
      expect(emittedToolResultEvent.value?.type).toBe('tool-results.appended');

      history.appendToolCalls([
        {
          id: 'tool-call-2',
          name: 'lookup-weather',
          arguments: { city: 'Boulder' },
        },
      ]);
      history.appendToolResults([]);

      await history.appendToolResultAsync({
        callId: 'tool-call-2',
        outcome: 'success',
        content: [],
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { forecast: 'snow' };
          },
        },
      });

      history.appendToolCalls([
        {
          id: 'tool-call-3',
          name: 'lookup-weather',
          arguments: { city: 'Fort Collins' },
        },
        {
          id: 'tool-call-4',
          name: 'lookup-weather',
          arguments: { city: 'Colorado Springs' },
        },
      ]);

      await history.appendToolResultsAsync([
        {
          callId: 'tool-call-3',
          outcome: 'success',
          content: [],
          result: {
            async *[Symbol.asyncIterator]() {
              yield 'warm';
              yield 'dry';
            },
          },
        },
        {
          callId: 'tool-call-4',
          outcome: 'action_required',
          content: { prompt: 'Approve request' },
          action: {
            type: 'approval',
            message: 'Need approval',
          },
        },
      ]);

      expect(history.getPendingToolCalls()).toHaveLength(0);
      expect(history.getToolInteractions()).toHaveLength(4);
      expect(onEvents).toContain('tool-calls.appended');
      expect(typedEvents).toContain('tool-results.appended');
      expect(allEvents).toContain('tool-calls.appended');
      expect(allEvents).toContain('tool-results.appended');
      expect(onceCount).toBe(1);

      onSubscription.unsubscribe();
      typedSubscription.unsubscribe();
      allSubscription.unsubscribe();

      history.complete();
      expect(history.completed).toBe(true);
    });

    it('resolves a pending tool-result by callId, keeping exactly one tool-result message', () => {
      let messageIndex = 0;
      const history = new ConversationHistory(createConversation(), {
        randomId: () => `msg-${++messageIndex}`,
      });

      history.appendToolCall({
        id: 'call-1',
        name: 'deploy',
        arguments: { environment: 'production' },
      });
      history.appendToolResult({
        callId: 'call-1',
        outcome: 'action_required',
        content: null,
        action: { type: 'approval', message: 'Approve deploy to production?' },
      });

      history.resolveToolResult('call-1', {
        callId: 'call-1',
        outcome: 'success',
        content: { deployed: true },
      });

      const toolResultMessages = getOrderedMessages(history.current).filter(
        (message) => message.role === 'tool-result' && message.toolResult?.callId === 'call-1',
      );
      expect(toolResultMessages).toHaveLength(1);
      expect(toolResultMessages[0]?.toolResult?.outcome).toBe('success');
    });

    it('resolveToolResultAsync collects a streaming toolResult before replacing the pending result', async () => {
      let messageIndex = 0;
      const history = new ConversationHistory(createConversation(), {
        randomId: () => `msg-${++messageIndex}`,
      });

      history.appendToolCall({ id: 'call-1', name: 'deploy', arguments: {} });
      history.appendToolResult({
        callId: 'call-1',
        outcome: 'action_required',
        content: null,
        action: { type: 'approval', message: 'Approve deploy?' },
      });

      await history.resolveToolResultAsync('call-1', {
        callId: 'call-1',
        outcome: 'success',
        content: [],
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { chunk: 'a' };
          },
        },
      });

      const toolResultMessages = getOrderedMessages(history.current).filter(
        (message) => message.role === 'tool-result' && message.toolResult?.callId === 'call-1',
      );
      expect(toolResultMessages).toHaveLength(1);
      expect(toolResultMessages[0]?.toolResult?.content).toEqual([{ chunk: 'a' }]);
    });
  });

  describe('maxHistoryDepth', () => {
    it('prunes oldest ancestors when depth exceeded', () => {
      const history = new ConversationHistory(createConversation(), {
        maxHistoryDepth: 5,
      });

      for (let i = 0; i < 10; i++) {
        history.appendUserMessage(`Message ${i}`);
      }

      const path = history.getPath();
      expect(path.length).toBeLessThanOrEqual(5);
    });

    it('limits undo to maxHistoryDepth', () => {
      const history = new ConversationHistory(createConversation(), {
        maxHistoryDepth: 5,
      });

      for (let i = 0; i < 10; i++) {
        history.appendUserMessage(`Message ${i}`);
      }

      let undoCount = 0;
      while (history.canUndo) {
        history.undo();
        undoCount++;
      }

      expect(undoCount).toBeLessThanOrEqual(4); // max depth 5 means at most 4 undos
    });

    it('does not limit when maxHistoryDepth is undefined', () => {
      const history = new ConversationHistory(createConversation());

      for (let i = 0; i < 10; i++) {
        history.appendUserMessage(`Message ${i}`);
      }

      const path = history.getPath();
      // 1 initial + 10 mutations = 11
      expect(path.length).toBe(11);
    });
  });

  describe('compaction event emission', () => {
    it('emits compaction.completed exactly once when compaction occurs', async () => {
      const history = new ConversationHistory(createConversation());
      for (let i = 0; i < 10; i++) {
        history.appendUserMessage(`Message ${i}`);
        history.appendAssistantMessage(`Reply ${i}`);
      }

      let completedCount = 0;
      history.addEventListener('compaction.completed', () => {
        completedCount++;
      });

      const summarizer = async (messages: Message[]) => `Summary of ${messages.length} messages`;

      await history.compact(summarizer, { preserveRecentCount: 2 });

      expect(completedCount).toBe(1);
    });

    it('emits compaction.completed exactly once when no compaction needed', async () => {
      const history = new ConversationHistory(createConversation());
      history.appendUserMessage('only one');

      let completedCount = 0;
      history.addEventListener('compaction.completed', () => {
        completedCount++;
      });

      const summarizer = async (messages: Message[]) => `Summary of ${messages.length} messages`;

      await history.compact(summarizer, { preserveRecentCount: 10 });

      expect(completedCount).toBe(1);
    });
  });
});

describe('Conversation rewind methods', () => {
  const seedFourMessages = (): ConversationHistory => {
    const history = new ConversationHistory(createConversation());
    history.appendUserMessage('Message 0');
    history.appendAssistantMessage('Message 1');
    history.appendUserMessage('Message 2');
    history.appendAssistantMessage('Message 3');
    return history;
  };

  it('rewindBeforePosition drops the boundary message and everything after it', () => {
    const history = seedFourMessages();

    history.rewindBeforePosition(2);

    expect(getOrderedMessages(history.current).map((message) => message.content)).toEqual([
      'Message 0',
      'Message 1',
    ]);
  });

  it('rewindBeforeMessage drops the named message and everything after it', () => {
    const history = seedFourMessages();
    const target = getOrderedMessages(history.current)[1];

    history.rewindBeforeMessage(target.id);

    expect(getOrderedMessages(history.current).map((message) => message.content)).toEqual([
      'Message 0',
    ]);
  });

  it('records a rewind as an undoable step', () => {
    const history = seedFourMessages();

    history.rewindBeforePosition(1);
    expect(history.current.ids).toHaveLength(1);

    history.undo();
    expect(history.current.ids).toHaveLength(4);
  });

  it('adds no history entry when the rewind changes nothing', () => {
    const history = seedFourMessages();
    const before = history.current;

    history.rewindBeforePosition(4);
    history.rewindBeforeMessage('not-a-real-id');

    expect(history.current).toBe(before);
  });
});
