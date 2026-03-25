import { beforeEach, describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import type { MemoryLike } from '../src/create-memory-bridge';
import { createMemoryBridge } from '../src/create-memory-bridge';
import { createScratchpad, type Scratchpad } from '../src/create-scratchpad';
import type { StepContext, StepResult } from '../src/types';

function createMockMemory(
  storedResults: Array<{ content: string; score: number }> = [],
): MemoryLike & { rememberCalls: Array<[string, Record<string, unknown> | undefined]> } {
  const rememberCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    rememberCalls,
    async remember(content: string, metadata?: Record<string, unknown>) {
      rememberCalls.push([content, metadata]);
      return { id: 'mock-id' };
    },
    async recall(_query: string, _options?: { limit?: number; namespace?: string }) {
      return storedResults;
    },
  };
}

function createStepContext(conversation: Conversation, step: number = 0): StepContext {
  return { conversation, step };
}

function createStepResult(conversation: Conversation, overrides?: Partial<StepResult>): StepResult {
  return {
    step: 0,
    conversation,
    content: 'Final response.',
    toolCalls: [],
    results: [],
    final: true,
    ...overrides,
  };
}

describe('createMemoryBridge', () => {
  let scratchpad: Scratchpad;

  beforeEach(() => {
    scratchpad = createScratchpad();
  });

  describe('prepareStep', () => {
    it('populates the scratchpad with recalled memories on step 0', async () => {
      const memory = createMockMemory([
        { content: 'Previous insight about TypeScript', score: 0.9 },
        { content: 'Another memory', score: 0.8 },
      ]);

      const { prepareStep } = createMemoryBridge({ memory, scratchpad });

      const conversation = new Conversation();
      conversation.appendUserMessage('Tell me about TypeScript');

      await prepareStep(createStepContext(conversation, 0));

      expect(scratchpad.has('memories')).toBe(true);
      const memories = scratchpad.get('memories') as string[];
      expect(memories).toEqual(['Previous insight about TypeScript', 'Another memory']);
    });

    it('does nothing on steps other than 0', async () => {
      const memory = createMockMemory([{ content: 'Some memory', score: 0.9 }]);

      const { prepareStep } = createMemoryBridge({ memory, scratchpad });

      const conversation = new Conversation();
      conversation.appendUserMessage('Hello');

      await prepareStep(createStepContext(conversation, 1));

      expect(scratchpad.has('memories')).toBe(false);
    });

    it('uses recallQuery string when provided', async () => {
      let capturedQuery: string | undefined;
      const memory: MemoryLike = {
        async remember() {
          return {};
        },
        async recall(query, _options) {
          capturedQuery = query;
          return [{ content: 'result', score: 0.9 }];
        },
      };

      const { prepareStep } = createMemoryBridge({
        memory,
        scratchpad,
        recallQuery: 'custom fixed query',
      });

      const conversation = new Conversation();
      conversation.appendUserMessage('User message ignored');

      await prepareStep(createStepContext(conversation, 0));

      expect(capturedQuery).toBe('custom fixed query');
    });

    it('uses recallQuery function when provided', async () => {
      let capturedQuery: string | undefined;
      const memory: MemoryLike = {
        async remember() {
          return {};
        },
        async recall(query, _options) {
          capturedQuery = query;
          return [{ content: 'result', score: 0.9 }];
        },
      };

      const { prepareStep } = createMemoryBridge({
        memory,
        scratchpad,
        recallQuery: (conv) => {
          const messages = conv.getMessages();
          return `Derived from ${messages.length} messages`;
        },
      });

      const conversation = new Conversation();
      conversation.appendUserMessage('First');
      conversation.appendAssistantMessage('Response');

      await prepareStep(createStepContext(conversation, 0));

      expect(capturedQuery).toBe('Derived from 2 messages');
    });

    it('does not crash when memory.recall throws', async () => {
      const memory: MemoryLike = {
        async remember() {
          return {};
        },
        async recall() {
          throw new Error('Network error');
        },
      };

      const { prepareStep } = createMemoryBridge({ memory, scratchpad });

      const conversation = new Conversation();
      conversation.appendUserMessage('Hello');

      // Should not throw
      await prepareStep(createStepContext(conversation, 0));

      expect(scratchpad.has('memories')).toBe(false);
    });

    it('does not populate scratchpad when no user message exists', async () => {
      const memory = createMockMemory([{ content: 'memory', score: 0.9 }]);

      const { prepareStep } = createMemoryBridge({ memory, scratchpad });

      const conversation = new Conversation();
      // No user message added

      await prepareStep(createStepContext(conversation, 0));

      expect(scratchpad.has('memories')).toBe(false);
    });

    it('uses a custom scratchpadKey', async () => {
      const memory = createMockMemory([{ content: 'recalled', score: 0.9 }]);

      const { prepareStep } = createMemoryBridge({
        memory,
        scratchpad,
        scratchpadKey: 'context',
      });

      const conversation = new Conversation();
      conversation.appendUserMessage('Hello');

      await prepareStep(createStepContext(conversation, 0));

      expect(scratchpad.has('context')).toBe(true);
      expect(scratchpad.has('memories')).toBe(false);
    });
  });

  describe('onStep', () => {
    it('persists scratchpad entries on the final step', async () => {
      const memory = createMockMemory();

      const { onStep } = createMemoryBridge({ memory, scratchpad });

      scratchpad.set('notes', 'Important finding');
      scratchpad.set('plan', 'Next steps...');

      const conversation = new Conversation();
      await onStep(createStepResult(conversation, { final: true }));

      // Both entries should be persisted (excluding 'memories' key)
      expect(memory.rememberCalls.length).toBe(2);

      const contents = memory.rememberCalls.map(([content]) => content);
      expect(contents).toContain('Important finding');
      expect(contents).toContain('Next steps...');
    });

    it('does nothing on non-final steps', async () => {
      const memory = createMockMemory();

      const { onStep } = createMemoryBridge({ memory, scratchpad });

      scratchpad.set('data', 'some value');

      const conversation = new Conversation();
      await onStep(createStepResult(conversation, { final: false }));

      expect(memory.rememberCalls.length).toBe(0);
    });

    it('filters entries by persistKeys', async () => {
      const memory = createMockMemory();

      const { onStep } = createMemoryBridge({
        memory,
        scratchpad,
        persistKeys: ['important'],
      });

      scratchpad.set('important', 'Keep this');
      scratchpad.set('temporary', 'Discard this');

      const conversation = new Conversation();
      await onStep(createStepResult(conversation, { final: true }));

      expect(memory.rememberCalls.length).toBe(1);
      expect(memory.rememberCalls[0]![0]).toBe('Keep this');
    });

    it('does not re-persist the recalled memories key', async () => {
      const memory = createMockMemory();

      const { onStep } = createMemoryBridge({ memory, scratchpad });

      scratchpad.set('memories', ['recalled memory 1', 'recalled memory 2']);
      scratchpad.set('notes', 'New note');

      const conversation = new Conversation();
      await onStep(createStepResult(conversation, { final: true }));

      // Only 'notes' should be persisted, not 'memories'
      expect(memory.rememberCalls.length).toBe(1);
      expect(memory.rememberCalls[0]![0]).toBe('New note');
    });

    it('does not crash when memory.remember throws', async () => {
      const memory: MemoryLike = {
        async remember() {
          throw new Error('Storage failure');
        },
        async recall() {
          return [];
        },
      };

      const { onStep } = createMemoryBridge({ memory, scratchpad });

      scratchpad.set('data', 'value');

      const conversation = new Conversation();
      // Should not throw
      await onStep(createStepResult(conversation, { final: true }));
    });

    it('is a no-op when scratchpad is empty', async () => {
      const memory = createMockMemory();

      const { onStep } = createMemoryBridge({ memory, scratchpad });

      const conversation = new Conversation();
      await onStep(createStepResult(conversation, { final: true }));

      expect(memory.rememberCalls.length).toBe(0);
    });
  });
});
