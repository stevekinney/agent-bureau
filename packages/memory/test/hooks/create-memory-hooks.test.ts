import { beforeEach, describe, expect, it } from 'bun:test';

import { createMemory } from '../../src/create-memory';
import { createMemoryHooks } from '../../src/hooks/create-memory-hooks';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../../src/test/index';
import type { Memory } from '../../src/types';

const DIMENSION = 64;

function createTestMemory() {
  const storage = createInMemoryMemoryRecordStorage();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({ embedder, storage, dimension: DIMENSION });
  return { memory, storage, embedder };
}

/**
 * Minimal mock conversation that satisfies the hooks' ConversationLike interface.
 */
function createMockConversation(messages: Array<{ role: string; content: string }>) {
  const internalMessages = [...messages];

  return {
    getMessages() {
      return internalMessages;
    },
    appendSystemMessage(content: string, _metadata?: Record<string, unknown>) {
      internalMessages.push({ role: 'system', content });
    },
  };
}

describe('createMemoryHooks', () => {
  let memory: Memory;

  beforeEach(async () => {
    const test = createTestMemory();
    memory = test.memory;
    await memory.init();
  });

  describe('prepareStep (auto-recall)', () => {
    it('injects relevant memories as a system message', async () => {
      await memory.remember('The project uses TypeScript');
      await memory.remember('The database is PostgreSQL');

      const hooks = createMemoryHooks({ memory });
      const conversation = createMockConversation([
        { role: 'user', content: 'What language does the project use?' },
      ]);

      await hooks.prepareStep({ conversation, step: 1 });

      const messages = conversation.getMessages();
      const systemMessages = messages.filter((message) => message.role === 'system');
      expect(systemMessages.length).toBe(1);
      expect(systemMessages[0]!.content).toContain('Relevant memories:');
    });

    it('does not inject when no memories match', async () => {
      const hooks = createMemoryHooks({ memory });
      const conversation = createMockConversation([{ role: 'user', content: 'Hello there' }]);

      await hooks.prepareStep({ conversation, step: 1 });

      const messages = conversation.getMessages();
      const systemMessages = messages.filter((message) => message.role === 'system');
      expect(systemMessages.length).toBe(0);
    });

    it('does nothing when autoRecall is disabled', async () => {
      await memory.remember('Some stored memory');

      const hooks = createMemoryHooks({ memory, autoRecall: false });
      const conversation = createMockConversation([
        { role: 'user', content: 'Some stored memory' },
      ]);

      await hooks.prepareStep({ conversation, step: 1 });

      const messages = conversation.getMessages();
      const systemMessages = messages.filter((message) => message.role === 'system');
      expect(systemMessages.length).toBe(0);
    });

    it('does nothing when there is no user message', async () => {
      await memory.remember('A memory');

      const hooks = createMemoryHooks({ memory });
      const conversation = createMockConversation([{ role: 'assistant', content: 'Hello!' }]);

      await hooks.prepareStep({ conversation, step: 1 });

      const messages = conversation.getMessages();
      const systemMessages = messages.filter((message) => message.role === 'system');
      expect(systemMessages.length).toBe(0);
    });

    it('respects the recallLimit option', async () => {
      for (let i = 0; i < 10; i++) {
        await memory.remember(`Memory entry number ${i}`);
      }

      const hooks = createMemoryHooks({ memory, recallLimit: 3 });
      const conversation = createMockConversation([{ role: 'user', content: 'Memory entry' }]);

      await hooks.prepareStep({ conversation, step: 1 });

      const messages = conversation.getMessages();
      const systemMessages = messages.filter((message) => message.role === 'system');
      expect(systemMessages.length).toBe(1);

      // Count the bullet points in the system message
      const bulletCount = (systemMessages[0]!.content.match(/^- /gm) || []).length;
      expect(bulletCount).toBeLessThanOrEqual(3);
    });

    it('uses the provided namespace for recall', async () => {
      await memory.remember('Default namespace memory');
      await memory.remember('Project namespace memory', { namespace: 'project' });

      const hooks = createMemoryHooks({ memory, namespace: 'project' });
      const conversation = createMockConversation([
        { role: 'user', content: 'What about the project?' },
      ]);

      await hooks.prepareStep({ conversation, step: 1 });

      const messages = conversation.getMessages();
      const systemMessages = messages.filter((message) => message.role === 'system');
      expect(systemMessages.length).toBe(1);
      expect(systemMessages[0]!.content).toContain('Project namespace memory');
    });
  });

  describe('afterToolExecution (auto-capture)', () => {
    it('stores content when trigger keyword is detected', async () => {
      const hooks = createMemoryHooks({ memory });
      const conversation = createMockConversation([
        { role: 'user', content: 'Remember that the API key is stored in env vars' },
      ]);

      await hooks.afterToolExecution({ conversation, step: 1, results: [] });

      const count = await memory.count();
      expect(count).toBe(1);
    });

    it('detects various trigger phrases', async () => {
      const triggers = [
        "Don't forget the meeting is at 3pm",
        'Keep in mind that we use ESM modules',
        'Note that the build takes 5 minutes',
        'Save this: the password policy requires 12 characters',
        'Store this configuration for later',
      ];

      for (const trigger of triggers) {
        const freshTest = createTestMemory();
        await freshTest.memory.init();

        const hooks = createMemoryHooks({ memory: freshTest.memory });
        const conversation = createMockConversation([{ role: 'user', content: trigger }]);

        await hooks.afterToolExecution({ conversation, step: 1, results: [] });

        const count = await freshTest.memory.count();
        expect(count).toBe(1);
      }
    });

    it('does not capture when no trigger keyword is present', async () => {
      const hooks = createMemoryHooks({ memory });
      const conversation = createMockConversation([
        { role: 'user', content: 'What is the weather today?' },
      ]);

      await hooks.afterToolExecution({ conversation, step: 1, results: [] });

      const count = await memory.count();
      expect(count).toBe(0);
    });

    it('does nothing when autoCapture is disabled', async () => {
      const hooks = createMemoryHooks({ memory, autoCapture: false });
      const conversation = createMockConversation([
        { role: 'user', content: 'Remember that the sky is blue' },
      ]);

      await hooks.afterToolExecution({ conversation, step: 1, results: [] });

      const count = await memory.count();
      expect(count).toBe(0);
    });

    it('sets source to auto-capture on stored memories', async () => {
      const hooks = createMemoryHooks({ memory });
      const conversation = createMockConversation([
        { role: 'user', content: 'Remember that TypeScript is great' },
      ]);

      await hooks.afterToolExecution({ conversation, step: 1, results: [] });

      const results = await memory.recall('TypeScript is great');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.metadata.source).toBe('auto-capture');
    });

    it('uses the provided namespace for auto-capture', async () => {
      const hooks = createMemoryHooks({ memory, namespace: 'notes' });
      const conversation = createMockConversation([
        { role: 'user', content: 'Remember that the server runs on port 3000' },
      ]);

      await hooks.afterToolExecution({ conversation, step: 1, results: [] });

      const defaultCount = await memory.count('default');
      const notesCount = await memory.count('notes');
      expect(defaultCount).toBe(0);
      expect(notesCount).toBe(1);
    });
  });

  describe('both hooks disabled', () => {
    it('returns no-op functions when both are disabled', async () => {
      await memory.remember('Existing memory');

      const hooks = createMemoryHooks({
        memory,
        autoRecall: false,
        autoCapture: false,
      });
      const conversation = createMockConversation([
        { role: 'user', content: 'Remember this existing memory' },
      ]);

      await hooks.prepareStep({ conversation, step: 1 });
      await hooks.afterToolExecution({ conversation, step: 1, results: [] });

      const messages = conversation.getMessages();
      const systemMessages = messages.filter((message) => message.role === 'system');
      expect(systemMessages.length).toBe(0);

      // Only the original memory should exist, no new auto-capture
      const count = await memory.count();
      expect(count).toBe(1);
    });
  });
});
