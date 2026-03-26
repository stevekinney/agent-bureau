import { describe, expect, it } from 'bun:test';

import type {
  ConversationLike,
  MemoryLike,
  StepContextLike,
  StepResultLike,
} from '../src/create-skill-memory';
import { createSkillMemoryHooks } from '../src/create-skill-memory-hooks';

function createMockMemory() {
  const entries: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
  const recalls: Array<{ query: string; options?: Record<string, unknown> }> = [];

  return {
    entries,
    recalls,
    async remember(content: string, metadata?: Record<string, unknown>) {
      entries.push({ content, metadata });
      return { id: `entry-${entries.length}` };
    },
    async recall(query: string, options?: { limit?: number; namespace?: string }) {
      recalls.push({ query, options });
      return entries
        .filter(
          (entry) => !options?.namespace || entry.metadata?.['namespace'] === options.namespace,
        )
        .map((entry) => ({ content: entry.content, score: 0.9 }));
    },
  } satisfies MemoryLike & {
    entries: Array<{ content: string; metadata?: Record<string, unknown> }>;
    recalls: Array<{ query: string; options?: Record<string, unknown> }>;
  };
}

function createMockConversation(
  messages: Array<{ role: string; content: string }>,
): ConversationLike {
  return {
    getMessages() {
      return messages;
    },
  };
}

function createStepContext(overrides: Partial<StepContextLike> = {}): StepContextLike {
  return {
    conversation: createMockConversation([{ role: 'user', content: 'How do I write tests?' }]),
    step: 0,
    ...overrides,
  };
}

function createStepResult(overrides: Partial<StepResultLike> = {}): StepResultLike {
  return {
    step: 3,
    conversation: createMockConversation([
      { role: 'user', content: 'How do I write tests?' },
      { role: 'assistant', content: 'Use describe and it blocks.' },
    ]),
    content: 'Use describe and it blocks.',
    final: true,
    ...overrides,
  };
}

describe('createSkillMemoryHooks', () => {
  describe('prepareStep', () => {
    it('recalls from skill memory on step 0', async () => {
      const mock = createMockMemory();
      const { prepareStep } = createSkillMemoryHooks({ memory: mock });
      const context = createStepContext({ step: 0 });

      await prepareStep(context);

      expect(mock.recalls).toHaveLength(1);
      expect(mock.recalls[0]?.query).toBe('How do I write tests?');
    });

    it('does not recall on step > 0', async () => {
      const mock = createMockMemory();
      const { prepareStep } = createSkillMemoryHooks({ memory: mock });

      await prepareStep(createStepContext({ step: 1 }));
      await prepareStep(createStepContext({ step: 5 }));

      expect(mock.recalls).toHaveLength(0);
    });

    it('uses custom recallQuery string when provided', async () => {
      const mock = createMockMemory();
      const { prepareStep } = createSkillMemoryHooks({
        memory: mock,
        recallQuery: 'testing best practices',
      });

      await prepareStep(createStepContext({ step: 0 }));

      expect(mock.recalls[0]?.query).toBe('testing best practices');
    });

    it('uses custom recallQuery function when provided', async () => {
      const mock = createMockMemory();
      const { prepareStep } = createSkillMemoryHooks({
        memory: mock,
        recallQuery: (conversation) => {
          const messages = conversation.getMessages();
          return `skill context: ${messages[0]?.content}`;
        },
      });

      await prepareStep(createStepContext({ step: 0 }));

      expect(mock.recalls[0]?.query).toBe('skill context: How do I write tests?');
    });

    it('respects recallLimit', async () => {
      const mock = createMockMemory();
      const { prepareStep } = createSkillMemoryHooks({
        memory: mock,
        recallLimit: 10,
      });

      await prepareStep(createStepContext({ step: 0 }));

      expect(mock.recalls[0]?.options?.['limit']).toBe(10);
    });

    it('uses default recallLimit of 5', async () => {
      const mock = createMockMemory();
      const { prepareStep } = createSkillMemoryHooks({ memory: mock });

      await prepareStep(createStepContext({ step: 0 }));

      expect(mock.recalls[0]?.options?.['limit']).toBe(5);
    });

    it('degrades gracefully when recall throws', async () => {
      const failingMemory: MemoryLike = {
        async remember() {
          return {};
        },
        async recall() {
          throw new Error('Memory service unavailable');
        },
      };

      const { prepareStep } = createSkillMemoryHooks({ memory: failingMemory });

      // Should not throw
      await expect(prepareStep(createStepContext({ step: 0 }))).resolves.toBeUndefined();
    });

    it('does not recall when conversation has no user messages', async () => {
      const mock = createMockMemory();
      const { prepareStep } = createSkillMemoryHooks({ memory: mock });

      const context = createStepContext({
        step: 0,
        conversation: createMockConversation([{ role: 'assistant', content: 'Hello' }]),
      });

      await prepareStep(context);

      expect(mock.recalls).toHaveLength(0);
    });
  });

  describe('onStep', () => {
    it('stores to skill memory on final step', async () => {
      const mock = createMockMemory();
      const { onStep } = createSkillMemoryHooks({ memory: mock });

      await onStep(createStepResult({ final: true }));

      expect(mock.entries).toHaveLength(1);
      expect(mock.entries[0]?.content).toBe('Use describe and it blocks.');
      expect(mock.entries[0]?.metadata?.['source']).toBe('experiential');
      expect(mock.entries[0]?.metadata?.['tags']).toEqual(['skill-learning']);
    });

    it('does not store on non-final steps', async () => {
      const mock = createMockMemory();
      const { onStep } = createSkillMemoryHooks({ memory: mock });

      await onStep(createStepResult({ final: false }));

      expect(mock.entries).toHaveLength(0);
    });

    it('degrades gracefully when remember throws', async () => {
      const failingMemory: MemoryLike = {
        async remember() {
          throw new Error('Memory service unavailable');
        },
        async recall() {
          return [];
        },
      };

      const { onStep } = createSkillMemoryHooks({ memory: failingMemory });

      // Should not throw
      await expect(onStep(createStepResult({ final: true }))).resolves.toBeUndefined();
    });

    it('does not store when content is empty', async () => {
      const mock = createMockMemory();
      const { onStep } = createSkillMemoryHooks({ memory: mock });

      await onStep(createStepResult({ final: true, content: '' }));

      expect(mock.entries).toHaveLength(0);
    });
  });
});
