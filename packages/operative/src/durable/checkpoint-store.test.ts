import { MemoryStorage, textValueStore } from '@lostgradient/weft';
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
  lastAppliedConfigVersion: 0,
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

    it('defaults lastAppliedConfigVersion to 0 on loadCursor for a pre-AB-221 persisted cursor (not only through loadCheckpoint)', async () => {
      // Regression: the normalization added for `loadCheckpoint` lived only
      // in that method, so a caller using the public `loadCursor()` directly
      // (bypassing `loadCheckpoint`) still got a cursor missing this field.
      const preAb221Cursor = {
        step: 2,
        totalUsage: { prompt: 10, completion: 5, total: 15 },
        lastContent: 'partial',
        schemaAttempts: 1,
      };
      const underlying = createStore();
      await underlying.set('durable-run:run-1:cursor', JSON.stringify(preAb221Cursor));

      const store = createCheckpointStore(underlying);
      expect(await store.loadCursor('run-1')).toEqual({
        ...preAb221Cursor,
        lastAppliedConfigVersion: 0,
      });
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
      // Rehydrate and re-snapshot: the tree and lineage must survive even though
      // a new envelope gets its own creation time and integrity digest.
      const rehydrated = Conversation.from(loaded!);
      const restored = rehydrated.snapshot();
      expect(restored.nodes).toEqual(original.nodes);
      expect(restored.currentPath).toEqual(original.currentPath);
      expect(restored.controllerRevision).toBe(original.controllerRevision);
      expect(restored.lineage).toEqual(original.lineage);
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

  describe('strict reads of malformed persisted data', () => {
    const malformedStep = 'durable-run:run-1:step:0000000001';

    async function failure(read: () => Promise<unknown>): Promise<unknown> {
      try {
        await read();
      } catch (error) {
        return error;
      }
      return undefined;
    }

    it('rejects a malformed cursor in strict mode and reads it as absent otherwise', async () => {
      const underlying = createStore();
      await underlying.set('durable-run:run-1:cursor', '{not json');
      const store = createCheckpointStore(underlying);

      expect(await failure(() => store.loadCursor('run-1', { strict: true }))).toBeInstanceOf(
        Error,
      );
      expect(await failure(() => store.loadCheckpoint('run-1', { strict: true }))).toBeInstanceOf(
        Error,
      );
      expect(await store.loadCursor('run-1')).toBeNull();
      const tolerant = await store.loadCheckpoint('run-1');
      expect(tolerant.cursor.step).toBe(0);
    });

    it('rejects a malformed step record in strict mode and skips it otherwise', async () => {
      const underlying = createStore();
      await underlying.set('durable-run:run-1:step:0000000000', JSON.stringify({ step: 0 }));
      await underlying.set(malformedStep, '{not json');
      const store = createCheckpointStore(underlying);

      expect(await failure(() => store.loadSteps('run-1', { strict: true }))).toBeInstanceOf(Error);
      const tolerant = await store.loadSteps('run-1');
      expect(tolerant.map((record) => record.step)).toEqual([0]);
    });

    it('rejects a malformed transcript in strict mode and reads it as absent otherwise', async () => {
      const underlying = createStore();
      await underlying.set('durable-run:run-1:transcript', '{not json');
      const store = createCheckpointStore(underlying);

      expect(await failure(() => store.loadConversation('run-1', { strict: true }))).toBeInstanceOf(
        Error,
      );
      expect(await store.loadConversation('run-1')).toBeNull();
    });

    it('keeps a genuinely absent checkpoint a zeroed cursor in strict mode', async () => {
      const store = createCheckpointStore(createStore());
      const checkpoint = await store.loadCheckpoint('never-written', { strict: true });
      expect(checkpoint.cursor).toEqual(cursor(0));
      expect(checkpoint.conversation).toBeNull();
      expect(checkpoint.steps).toEqual([]);
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

    it('defaults lastAppliedConfigVersion to 0 for a cursor persisted before AB-221 added the field', async () => {
      // Simulate a pre-AB-221 cursor written by an older process: every field
      // `RunCursor` had at the time, minus `lastAppliedConfigVersion`. Written
      // directly through the underlying text-value store so the test does not
      // depend on `saveCursor`'s current (post-AB-221) `RunCursor` shape.
      const preAb221Cursor = {
        step: 2,
        totalUsage: { prompt: 10, completion: 5, total: 15 },
        lastContent: 'partial',
        schemaAttempts: 1,
      };
      const underlying = createStore();
      await underlying.set('durable-run:run-1:cursor', JSON.stringify(preAb221Cursor));

      const store = createCheckpointStore(underlying);
      const checkpoint = await store.loadCheckpoint('run-1');
      expect(checkpoint.cursor).toEqual({ ...preAb221Cursor, lastAppliedConfigVersion: 0 });
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

  describe('run ids that contain the key delimiter', () => {
    // A run id is caller-chosen (a child run, a goal's attempt). Keys are
    // `durable-run:<id>:<part>`, so an unencoded `:` let one run's keys land
    // inside another run's prefix.
    const victim = 'goal-x-a0';
    const intruder = 'goal-x-a0:step:q';

    it('does not surface another run cursor or transcript as a step record', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveStep(victim, {
        step: 0,
        content: 'v',
        toolCalls: [],
        results: [],
        final: true,
      });
      await store.saveCursor(intruder, cursor(4));
      await store.saveConversation(
        intruder,
        new Conversation(createConversationHistory()).snapshot(),
      );

      const steps = await store.loadSteps(victim);

      expect(steps).toHaveLength(1);
      expect(steps.map((record) => record.content)).toEqual(['v']);
      const checkpoint = await store.loadCheckpoint(victim);
      expect(checkpoint.cursor.step).toBe(0);
    });

    it('does not clear another run when a run is cleared, in either direction', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveCursor(victim, cursor(1));
      await store.saveCursor(intruder, cursor(2));

      await store.clear(victim);
      expect(await store.loadCursor(intruder)).toEqual(cursor(2));

      await store.saveCursor(victim, cursor(1));
      await store.clear(intruder);
      expect(await store.loadCursor(victim)).toEqual(cursor(1));
    });

    it('keeps ids that differ only by an encoded delimiter apart', async () => {
      const store = createCheckpointStore(createStore());
      await store.saveCursor('a:b', cursor(1));
      await store.saveCursor('a%3Ab', cursor(2));

      expect(await store.loadCursor('a:b')).toEqual(cursor(1));
      expect(await store.loadCursor('a%3Ab')).toEqual(cursor(2));
    });
  });
});
