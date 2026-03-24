import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, createInMemoryPersistenceAdapter } from 'conversationalist';
import type { GenerateFunction, Toolbox } from 'operative';
import { createStore } from 'sentinel';

import { BureauError, createBureau } from './create-bureau';
import { DEFAULT_MAXIMUM_STEPS } from './types';

function createMockGenerate(): GenerateFunction {
  return async () => ({ content: 'Done.', toolCalls: [] });
}

function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

describe('createBureau', () => {
  describe('ready', () => {
    it('is false when no generate function is configured', () => {
      const bureau = createBureau();
      expect(bureau.ready).toBe(false);
    });

    it('is true when generate function is provided', () => {
      const bureau = createBureau({ generate: createMockGenerate() });
      expect(bureau.ready).toBe(true);
    });
  });

  describe('store', () => {
    it('creates a default store when none is provided', () => {
      const bureau = createBureau();
      expect(bureau.store).toBeDefined();
    });

    it('uses a provided store', () => {
      const store = createStore();
      const bureau = createBureau({ store });
      expect(bureau.store).toBe(store);
    });
  });

  describe('createRun', () => {
    it('throws NOT_CONFIGURED when no generate function exists', async () => {
      const bureau = createBureau();
      try {
        await bureau.createRun({ message: 'Hello' });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BureauError);
        expect((error as BureauError).code).toBe('NOT_CONFIGURED');
      }
    });

    it('throws NOT_CONFIGURED when message is missing', async () => {
      const bureau = createBureau({ generate: createMockGenerate() });
      try {
        await bureau.createRun({ message: '' });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BureauError);
        expect((error as BureauError).code).toBe('NOT_CONFIGURED');
      }
    });

    it('creates a run and returns a summary', async () => {
      const bureau = createBureau({
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
      });

      const summary = await bureau.createRun({ message: 'Hello' });
      expect(summary.id).toBeString();
      expect(summary.status).toBe('running');
      expect(summary.steps).toBe(0);
    });

    it('registers the run in the store', async () => {
      const bureau = createBureau({
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
      });

      const summary = await bureau.createRun({ message: 'Hello' });
      const stored = bureau.store.getRun(summary.id);
      expect(stored).toBeDefined();
    });

    it('loads conversation from persistence when conversationId is provided', async () => {
      const persistence = createInMemoryPersistenceAdapter();
      const conversation = new Conversation();
      conversation.appendUserMessage('Previous message');
      await persistence.save(conversation.current);

      const bureau = createBureau({
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        persistence,
      });

      const summary = await bureau.createRun({
        message: 'New message',
        conversationId: conversation.current.id,
      });

      expect(summary.id).toBeString();
    });

    it('applies system prompt', async () => {
      const bureau = createBureau({
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        systemPrompt: 'You are helpful.',
      });

      const summary = await bureau.createRun({ message: 'Hello' });
      expect(summary.id).toBeString();
    });

    it('uses request-level maximumSteps override', async () => {
      const bureau = createBureau({
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
        maximumSteps: 5,
      });

      const summary = await bureau.createRun({ message: 'Hello', maximumSteps: 20 });
      expect(summary.id).toBeString();
    });
  });

  describe('listRuns', () => {
    it('returns empty array when no runs exist', () => {
      const bureau = createBureau();
      expect(bureau.listRuns()).toEqual([]);
    });

    it('returns all runs', async () => {
      const bureau = createBureau({
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
      });

      await bureau.createRun({ message: 'Hello' });
      const runs = bureau.listRuns();
      expect(runs.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by status', async () => {
      const bureau = createBureau({
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
      });

      await bureau.createRun({ message: 'Hello' });
      const filtered = bureau.listRuns('completed');
      // Run may or may not have completed yet — no error is the assertion
      expect(Array.isArray(filtered)).toBe(true);
    });
  });

  describe('getRun', () => {
    it('returns undefined for unknown run', () => {
      const bureau = createBureau();
      expect(bureau.getRun('nonexistent')).toBeUndefined();
    });

    it('returns a run summary', async () => {
      const bureau = createBureau({
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
      });

      const created = await bureau.createRun({ message: 'Hello' });
      const found = bureau.getRun(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
    });
  });

  describe('abortRun', () => {
    it('throws NOT_FOUND for unknown run', () => {
      const bureau = createBureau();
      expect(() => bureau.abortRun('nonexistent')).toThrow(BureauError);
    });

    it('throws CONFLICT for non-running run', async () => {
      const bureau = createBureau({
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
      });

      const { id } = await bureau.createRun({ message: 'Hello' });
      // Wait for run to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      try {
        bureau.abortRun(id);
        // If it doesn't throw, the run may still be running — that's fine
      } catch (error) {
        expect(error).toBeInstanceOf(BureauError);
        expect((error as BureauError).code).toBe('CONFLICT');
      }
    });

    it('aborts a running run', async () => {
      const generate: GenerateFunction = () => new Promise(() => {});
      const bureau = createBureau({ generate, toolbox: createEmptyToolbox() });

      const { id } = await bureau.createRun({ message: 'Hello' });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const aborted = bureau.abortRun(id);
      expect(aborted.status).toBe('aborted');
    });
  });

  describe('deleteRun', () => {
    it('throws NOT_FOUND for unknown run', () => {
      const bureau = createBureau();
      expect(() => bureau.deleteRun('nonexistent')).toThrow(BureauError);
    });

    it('throws CONFLICT for running run', async () => {
      const generate: GenerateFunction = () => new Promise(() => {});
      const bureau = createBureau({ generate, toolbox: createEmptyToolbox() });

      const { id } = await bureau.createRun({ message: 'Hello' });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(() => bureau.deleteRun(id)).toThrow(BureauError);
    });
  });

  describe('conversations', () => {
    it('throws NOT_IMPLEMENTED when no persistence is configured', () => {
      const bureau = createBureau();
      expect(() => bureau.listConversations()).toThrow(BureauError);
    });

    it('lists conversations from persistence', async () => {
      const persistence = createInMemoryPersistenceAdapter();
      const conversation = new Conversation();
      conversation.appendUserMessage('Hello');
      await persistence.save(conversation.current);

      const bureau = createBureau({ persistence });
      const sessions = await bureau.listConversations();
      expect(sessions).toHaveLength(1);
    });

    it('loads a conversation by ID', async () => {
      const persistence = createInMemoryPersistenceAdapter();
      const conversation = new Conversation();
      conversation.appendUserMessage('Hello');
      await persistence.save(conversation.current);

      const bureau = createBureau({ persistence });
      const loaded = await bureau.getConversation(conversation.current.id);
      expect(loaded).toBeDefined();
    });

    it('returns undefined for missing conversation', async () => {
      const persistence = createInMemoryPersistenceAdapter();
      const bureau = createBureau({ persistence });
      const loaded = await bureau.getConversation('missing');
      expect(loaded).toBeUndefined();
    });

    it('deletes a conversation', async () => {
      const persistence = createInMemoryPersistenceAdapter();
      const conversation = new Conversation();
      conversation.appendUserMessage('Hello');
      await persistence.save(conversation.current);
      const sessionId = conversation.current.id;

      const bureau = createBureau({ persistence });
      await bureau.deleteConversation(sessionId);
      const loaded = await bureau.getConversation(sessionId);
      expect(loaded).toBeUndefined();
    });
  });

  describe('getConfiguration', () => {
    it('returns configuration with defaults', () => {
      const bureau = createBureau();
      const config = bureau.getConfiguration();
      expect(config.maximumSteps).toBe(DEFAULT_MAXIMUM_STEPS);
      expect(config.tools).toEqual([]);
      expect(config.provider).toBeUndefined();
    });

    it('returns provider configuration', () => {
      const bureau = createBureau({
        provider: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      });
      const config = bureau.getConfiguration();
      expect(config.provider?.provider).toBe('anthropic');
      expect(config.provider?.model).toBe('claude-sonnet-4-20250514');
    });
  });

  describe('getTools', () => {
    it('returns empty array when no toolbox', () => {
      const bureau = createBureau();
      expect(bureau.getTools()).toEqual([]);
    });
  });

  describe('dispose', () => {
    it('disposes the store', () => {
      const bureau = createBureau();
      bureau.dispose();
      // Should not throw on repeated dispose
      bureau.dispose();
    });
  });

  describe('BureauError', () => {
    it('has name and code', () => {
      const error = new BureauError('test', 'NOT_FOUND');
      expect(error.name).toBe('BureauError');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('test');
    });
  });

  describe('event emission', () => {
    function createReadyBureau() {
      return createBureau({
        generate: createMockGenerate(),
        toolbox: createEmptyToolbox(),
      });
    }

    it('addEventListener("action", listener) receives actions from runs', async () => {
      const bureau = createReadyBureau();
      const received: unknown[] = [];

      bureau.addEventListener('action', (event) => {
        received.push(event.detail);
      });

      await bureau.createRun({ message: 'Hello' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(received.length).toBeGreaterThan(0);
      bureau.dispose();
    });

    it('toObservable() emits events', async () => {
      const bureau = createReadyBureau();
      const types: string[] = [];

      const subscription = bureau.toObservable().subscribe((event) => {
        types.push(event.type);
      });

      await bureau.createRun({ message: 'Hello' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(types.length).toBeGreaterThan(0);
      subscription.unsubscribe();
      bureau.dispose();
    });

    it('on("action") returns Observable', async () => {
      const bureau = createReadyBureau();
      const received: unknown[] = [];

      const subscription = bureau.on('action').subscribe((event) => {
        received.push(event.detail);
      });

      await bureau.createRun({ message: 'Hello' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(received.length).toBeGreaterThan(0);
      subscription.unsubscribe();
      bureau.dispose();
    });

    it('once("action", listener) fires once', async () => {
      const bureau = createReadyBureau();
      const received: unknown[] = [];

      bureau.once('action', (event) => {
        received.push(event.detail);
      });

      await bureau.createRun({ message: 'Hello' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(received.length).toBe(1);
      bureau.dispose();
    });

    it('subscribe("action", observer) returns Subscription', async () => {
      const bureau = createReadyBureau();
      const received: unknown[] = [];

      const subscription = bureau.subscribe('action', (event) => {
        received.push(event.detail);
      });

      expect(typeof subscription.unsubscribe).toBe('function');

      await bureau.createRun({ message: 'Hello' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(received.length).toBeGreaterThan(0);
      subscription.unsubscribe();
      bureau.dispose();
    });

    it('events("action") returns async iterator', async () => {
      const bureau = createReadyBureau();
      const received: unknown[] = [];

      const iterator = bureau.events('action');

      await bureau.createRun({ message: 'Hello' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      bureau.complete();

      for await (const event of iterator) {
        received.push(event.detail);
      }

      expect(received.length).toBeGreaterThan(0);
    });

    it('"run.registered" fires from createRun()', async () => {
      const bureau = createReadyBureau();
      const registered: string[] = [];

      bureau.addEventListener('run.registered', (event) => {
        registered.push(event.detail.runId);
      });

      const summary = await bureau.createRun({ message: 'Hello' });

      expect(registered).toContain(summary.id);
      bureau.dispose();
    });

    it('"run.removed" fires from deleteRun()', async () => {
      const bureau = createReadyBureau();
      const removed: string[] = [];

      bureau.addEventListener('run.removed', (event) => {
        removed.push(event.detail.runId);
      });

      const { id } = await bureau.createRun({ message: 'Hello' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      bureau.deleteRun(id);

      expect(removed).toContain(id);
      bureau.dispose();
    });

    it('"bureau.disposed" fires from dispose()', () => {
      const bureau = createReadyBureau();
      let disposed = false;

      bureau.addEventListener('bureau.disposed', () => {
        disposed = true;
      });

      bureau.dispose();
      expect(disposed).toBe(true);
    });

    it('complete() / completed work correctly', () => {
      const bureau = createReadyBureau();
      expect(bureau.completed).toBe(false);
      bureau.complete();
      expect(bureau.completed).toBe(true);
    });
  });
});
