import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { createCheckpointStore } from './checkpoint-store';
import type { RunCursor, StepRecord } from './types';

/** In-memory text-value store for tests, backed by Weft's MemoryStorage. */
const createStore = () => textValueStore(new MemoryStorage());

/** A full {@link RunCursor} at `step` with zeroed run-level accumulators. */
const cursor = (step: number): RunCursor => ({
  step,
  totalUsage: { prompt: 0, completion: 0, total: 0 },
  lastContent: '',
  schemaAttempts: 0,
});

describe('createCheckpointStore', () => {
  describe('cursor', () => {
    it('round-trips a cursor', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveCursor('run-1', cursor(3));
      expect(await store.loadCursor('run-1')).toEqual(cursor(3));
    });

    it('returns null for a run with no cursor', async () => {
      const store = createCheckpointStore(createStore());
      expect(await store.loadCursor('missing')).toBeNull();
    });

    it('overwrites the cursor on re-save', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveCursor('run-1', cursor(1));
      await store.saveCursor('run-1', cursor(5));
      expect(await store.loadCursor('run-1')).toEqual(cursor(5));
    });
  });

  describe('conversation snapshot', () => {
    it('round-trips a conversation snapshot through Conversation.from with deep-equal history', async () => {
      const store = createCheckpointStore(createStore());

      const conversation = new Conversation(createConversationHistory({ id: 'conv-1' }));
      conversation.appendUserMessage('Hello');
      conversation.appendAssistantMessage('Hi there');
      const original = conversation.snapshot();

      await store.saveConversation('run-1', original);
      const loaded = await store.loadConversation('run-1');

      expect(loaded).not.toBeNull();
      // Rehydrate and re-snapshot: the round-trip must be structurally identical.
      const rehydrated = Conversation.from(loaded!);
      expect(rehydrated.snapshot()).toEqual(original);
      expect(rehydrated.getMessages()).toEqual(conversation.getMessages());
    });

    it('returns null when no conversation has been persisted', async () => {
      const store = createCheckpointStore(createStore());
      expect(await store.loadConversation('missing')).toBeNull();
    });
  });

  describe('step records', () => {
    const makeStep = (step: number, final = false): StepRecord => ({
      step,
      content: `step ${step}`,
      toolCalls: [],
      results: [],
      usage: { prompt: 10, completion: 5, total: 15 },
      final,
    });

    it('round-trips a single step record', async () => {
      const store = createCheckpointStore(createStore());
      const record = makeStep(0, true);
      await store.saveStep('run-1', record);
      expect(await store.loadSteps('run-1')).toEqual([record]);
    });

    it('returns step records in step order regardless of write order', async () => {
      const store = createCheckpointStore(createStore());
      // Write out of order; zero-padded keys must still list in numeric order.
      await store.saveStep('run-1', makeStep(2));
      await store.saveStep('run-1', makeStep(0));
      await store.saveStep('run-1', makeStep(1));

      const steps = await store.loadSteps('run-1');
      expect(steps.map((s) => s.step)).toEqual([0, 1, 2]);
    });

    it('keeps double-digit steps in numeric order (zero-padding guard)', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveStep('run-1', makeStep(10));
      await store.saveStep('run-1', makeStep(2));
      const steps = await store.loadSteps('run-1');
      expect(steps.map((s) => s.step)).toEqual([2, 10]);
    });

    it('returns an empty array for a run with no steps', async () => {
      const store = createCheckpointStore(createStore());
      expect(await store.loadSteps('missing')).toEqual([]);
    });
  });

  describe('loadCheckpoint', () => {
    it('assembles cursor, conversation, and steps into one checkpoint', async () => {
      const store = createCheckpointStore(createStore());
      const conversation = new Conversation(createConversationHistory({ id: 'conv-1' }));
      conversation.appendUserMessage('Hi');

      await store.saveCursor('run-1', cursor(2));
      await store.saveConversation('run-1', conversation.snapshot());
      await store.saveStep('run-1', {
        step: 0,
        content: 'first',
        toolCalls: [],
        results: [],
        final: false,
      });

      const checkpoint = await store.loadCheckpoint('run-1');
      expect(checkpoint.runId).toBe('run-1');
      expect(checkpoint.cursor).toEqual(cursor(2));
      expect(checkpoint.conversation).not.toBeNull();
      expect(checkpoint.steps).toHaveLength(1);
      expect(checkpoint.steps[0]!.content).toBe('first');
    });

    it('defaults the cursor to step 0 when none is persisted', async () => {
      const store = createCheckpointStore(createStore());
      const checkpoint = await store.loadCheckpoint('fresh');
      expect(checkpoint.cursor).toEqual(cursor(0));
      expect(checkpoint.conversation).toBeNull();
      expect(checkpoint.steps).toEqual([]);
    });
  });

  describe('clear', () => {
    it('removes every key for a run and returns the count', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveCursor('run-1', cursor(1));
      await store.saveConversation(
        'run-1',
        new Conversation(createConversationHistory()).snapshot(),
      );
      await store.saveStep('run-1', {
        step: 0,
        content: 'x',
        toolCalls: [],
        results: [],
        final: true,
      });

      const deleted = await store.clear('run-1');
      expect(deleted).toBe(3);
      expect(await store.loadCursor('run-1')).toBeNull();
      expect(await store.loadSteps('run-1')).toEqual([]);
    });

    it('does not touch other runs', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveCursor('run-1', cursor(1));
      await store.saveCursor('run-2', cursor(9));

      await store.clear('run-1');
      expect(await store.loadCursor('run-2')).toEqual(cursor(9));
    });
  });
});
