/**
 * Tests for the uniform inheritance mechanism — per-axis combine functions.
 *
 * Each describe block covers one axis:
 *   - combineTools   (tools = ∪)
 *   - combineProvider (provider = override)
 *   - combineHooks   (hooks = bureau-first, additive-only)
 *   - combineMemory  (memory = merged-read / private-write)
 *   - combineIdentity (identity = layered, bureau-first)
 */

import { createMockTool, createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import type { MemoryLike } from '../src/create-memory-bridge';
import {
  combineHooks,
  combineIdentity,
  combineMemory,
  combineProvider,
  combineTools,
} from '../src/inheritance';
import type { GenerateFunction, PrepareStepHook, StepContext } from '../src/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockMemory(
  storedResults: Array<{ content: string; score: number }> = [],
  namespace?: string,
): MemoryLike & {
  rememberCalls: Array<[string, Record<string, unknown> | undefined]>;
  recallCalls: Array<[string, Record<string, unknown> | undefined]>;
  namespace?: string;
} {
  const rememberCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  const recallCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    namespace,
    rememberCalls,
    recallCalls,
    async remember(content, metadata) {
      rememberCalls.push([content, metadata]);
      return { id: 'mock-id' };
    },
    async recall(query, options) {
      recallCalls.push([query, options as Record<string, unknown>]);
      return storedResults;
    },
  };
}

function createStepContext(conversation: Conversation, step = 0): StepContext {
  return { conversation, step };
}

// ---------------------------------------------------------------------------
// combineTools
// ---------------------------------------------------------------------------

describe('combineTools — tools = ∪', () => {
  it('returns undefined when both sides are undefined', () => {
    expect(combineTools(undefined, undefined)).toBeUndefined();
  });

  it('returns the bureau toolbox when the agent has no tools', () => {
    const bureauToolbox = createTestToolbox([]);
    expect(combineTools(bureauToolbox, undefined)).toBe(bureauToolbox);
  });

  it('returns the agent toolbox when the bureau has no tools', () => {
    const agentToolbox = createTestToolbox([]);
    expect(combineTools(undefined, agentToolbox)).toBe(agentToolbox);
  });

  it('merges bureau and agent toolboxes — both tool sets are present', () => {
    // Use named tools to verify presence by serialization
    const bureauToolbox = createTestToolbox([createMockTool({ name: 'search' })]);
    const agentToolbox = createTestToolbox([createMockTool({ name: 'scratchpad' })]);

    const combined = combineTools(bureauToolbox, agentToolbox);
    expect(combined).toBeDefined();

    const serialized = combined!.toJSON();
    const names = serialized.map((t: { name: string }) => t.name);
    expect(names).toContain('search');
    expect(names).toContain('scratchpad');
  });

  it('agent tool wins on name conflict (last-writer-wins)', () => {
    const bureauToolbox = createTestToolbox([
      createMockTool({ name: 'search', impl: async () => 'bureau' }),
    ]);
    const agentToolbox = createTestToolbox([
      createMockTool({ name: 'search', impl: async () => 'agent' }),
    ]);

    const combined = combineTools(bureauToolbox, agentToolbox);
    expect(combined).toBeDefined();
    // The serialized list should have exactly one 'search' entry.
    const names = combined!.toJSON().map((t: { name: string }) => t.name);
    expect(names.filter((n: string) => n === 'search')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// combineProvider
// ---------------------------------------------------------------------------

describe('combineProvider — provider = override', () => {
  it('returns undefined when both sides are undefined', () => {
    expect(combineProvider(undefined, undefined)).toBeUndefined();
  });

  it('returns the bureau provider when the agent has no provider', () => {
    const bureauGenerate: GenerateFunction = async () => ({ content: 'bureau', toolCalls: [] });
    expect(combineProvider(bureauGenerate, undefined)).toBe(bureauGenerate);
  });

  it('returns the agent provider when the bureau has no provider', () => {
    const agentGenerate: GenerateFunction = async () => ({ content: 'agent', toolCalls: [] });
    expect(combineProvider(undefined, agentGenerate)).toBe(agentGenerate);
  });

  it('agent provider overrides bureau provider when both are present', () => {
    const bureauGenerate: GenerateFunction = async () => ({ content: 'bureau', toolCalls: [] });
    const agentGenerate: GenerateFunction = async () => ({ content: 'agent', toolCalls: [] });

    const effective = combineProvider(bureauGenerate, agentGenerate);
    expect(effective).toBe(agentGenerate);
    expect(effective).not.toBe(bureauGenerate);
  });
});

// ---------------------------------------------------------------------------
// combineHooks
// ---------------------------------------------------------------------------

describe('combineHooks — bureau-first, additive-only', () => {
  it('returns undefined when both sides are undefined', () => {
    expect(combineHooks(undefined, undefined)).toBeUndefined();
  });

  it('normalizes a single bureau hook to an array', () => {
    const bureauHook = async () => {};
    const result = combineHooks(bureauHook, undefined);
    expect(result).toEqual([bureauHook]);
  });

  it('normalizes a single agent hook to an array', () => {
    const agentHook = async () => {};
    const result = combineHooks(undefined, agentHook);
    expect(result).toEqual([agentHook]);
  });

  it('places bureau hooks before agent hooks', () => {
    const bureauHook1 = async () => {};
    const bureauHook2 = async () => {};
    const agentHook1 = async () => {};
    const agentHook2 = async () => {};

    const result = combineHooks([bureauHook1, bureauHook2], [agentHook1, agentHook2]);
    expect(result).toEqual([bureauHook1, bureauHook2, agentHook1, agentHook2]);
  });

  it('agent hooks cannot suppress bureau hooks — all bureau hooks survive', () => {
    const order: string[] = [];
    const bureauHook: PrepareStepHook = async () => {
      order.push('bureau');
    };
    const agentHook: PrepareStepHook = async () => {
      order.push('agent');
    };

    const combined = combineHooks(bureauHook, agentHook);
    expect(combined).toHaveLength(2);
    // Bureau hook must be at index 0
    expect(combined![0]).toBe(bureauHook);
    expect(combined![1]).toBe(agentHook);
  });

  it('bureau hook array + single agent hook flattens correctly', () => {
    const b1 = async () => {};
    const b2 = async () => {};
    const a1 = async () => {};

    const result = combineHooks([b1, b2], a1);
    expect(result).toEqual([b1, b2, a1]);
  });

  it('single bureau hook + agent hook array flattens correctly', () => {
    const b1 = async () => {};
    const a1 = async () => {};
    const a2 = async () => {};

    const result = combineHooks(b1, [a1, a2]);
    expect(result).toEqual([b1, a1, a2]);
  });

  it('returns undefined for empty arrays on both sides', () => {
    expect(combineHooks([], [])).toBeUndefined();
  });

  it('empty bureau + agent hooks returns only agent hooks', () => {
    const agentHook = async () => {};
    expect(combineHooks([], [agentHook])).toEqual([agentHook]);
  });
});

// ---------------------------------------------------------------------------
// combineMemory
// ---------------------------------------------------------------------------

describe('combineMemory — merged-read / private-write', () => {
  it('returns undefined when both sides are undefined', () => {
    expect(combineMemory(undefined, undefined)).toBeUndefined();
  });

  it('returns bureau memory when agent side is undefined', () => {
    const bureauMemory = createMockMemory();
    const result = combineMemory({ memory: bureauMemory }, undefined);
    expect(result).toBe(bureauMemory);
  });

  it('returns agent memory when bureau side is undefined', () => {
    const agentMemory = createMockMemory();
    const result = combineMemory(undefined, { memory: agentMemory });
    expect(result).toBe(agentMemory);
  });

  describe('merged recall — reads from both namespaces', () => {
    it('queries both bureau and agent memories', async () => {
      const bureauMemory = createMockMemory([{ content: 'bureau fact', score: 0.7 }]);
      const agentMemory = createMockMemory([{ content: 'agent fact', score: 0.9 }]);

      const merged = combineMemory(
        { memory: bureauMemory, namespace: 'bureau-global' },
        { memory: agentMemory, namespace: 'researcher' },
      );

      const results = await merged!.recall('query');

      // Both memories were queried
      expect(bureauMemory.recallCalls).toHaveLength(1);
      expect(agentMemory.recallCalls).toHaveLength(1);

      // Both results appear in the output
      const contents = results.map((r) => r.content);
      expect(contents).toContain('bureau fact');
      expect(contents).toContain('agent fact');
    });

    it('sorts merged results by score descending', async () => {
      const bureauMemory = createMockMemory([
        { content: 'bureau low', score: 0.5 },
        { content: 'bureau high', score: 0.9 },
      ]);
      const agentMemory = createMockMemory([{ content: 'agent mid', score: 0.7 }]);

      const merged = combineMemory({ memory: bureauMemory }, { memory: agentMemory });

      const results = await merged!.recall('query');
      const scores = results.map((r) => r.score);

      // Results must be sorted descending
      for (let index = 1; index < scores.length; index++) {
        expect(scores[index - 1]!).toBeGreaterThanOrEqual(scores[index]!);
      }
    });

    it('deduplicates identical content across both memories', async () => {
      const shared = { content: 'shared fact', score: 0.8 };
      const bureauMemory = createMockMemory([shared]);
      const agentMemory = createMockMemory([shared, { content: 'agent only', score: 0.6 }]);

      const merged = combineMemory({ memory: bureauMemory }, { memory: agentMemory });
      const results = await merged!.recall('query');

      const contents = results.map((r) => r.content);
      // 'shared fact' must appear exactly once
      expect(contents.filter((c) => c === 'shared fact')).toHaveLength(1);
    });

    it('respects the limit option', async () => {
      const bureauMemory = createMockMemory([
        { content: 'b1', score: 0.9 },
        { content: 'b2', score: 0.8 },
        { content: 'b3', score: 0.7 },
      ]);
      const agentMemory = createMockMemory([
        { content: 'a1', score: 0.6 },
        { content: 'a2', score: 0.5 },
      ]);

      const merged = combineMemory({ memory: bureauMemory }, { memory: agentMemory });
      const results = await merged!.recall('query', { limit: 3 });

      expect(results).toHaveLength(3);
    });

    it('passes the namespace to each side during recall', async () => {
      const bureauMemory = createMockMemory([]);
      const agentMemory = createMockMemory([]);

      const merged = combineMemory(
        { memory: bureauMemory, namespace: 'bureau-global' },
        { memory: agentMemory, namespace: 'researcher' },
      );

      await merged!.recall('query');

      // Bureau recalled with bureau namespace
      expect(bureauMemory.recallCalls[0]?.[1]).toMatchObject({ namespace: 'bureau-global' });
      // Agent recalled with agent namespace
      expect(agentMemory.recallCalls[0]?.[1]).toMatchObject({ namespace: 'researcher' });
    });
  });

  describe('private write — remember goes to agent namespace only', () => {
    it('writes to agent memory, not bureau memory', async () => {
      const bureauMemory = createMockMemory();
      const agentMemory = createMockMemory();

      const merged = combineMemory(
        { memory: bureauMemory, namespace: 'bureau-global' },
        { memory: agentMemory, namespace: 'researcher' },
      );

      await merged!.remember('new insight', { tag: 'important' });

      // Only agent memory received the write
      expect(agentMemory.rememberCalls).toHaveLength(1);
      expect(bureauMemory.rememberCalls).toHaveLength(0);

      const [content, metadata] = agentMemory.rememberCalls[0]!;
      expect(content).toBe('new insight');
      expect(metadata).toEqual({ tag: 'important' });
    });
  });
});

// ---------------------------------------------------------------------------
// combineIdentity
// ---------------------------------------------------------------------------

describe('combineIdentity — layered, bureau-first', () => {
  it('returns undefined when both sides are undefined', () => {
    expect(combineIdentity(undefined, undefined)).toBeUndefined();
  });

  it('returns a hook when only bureau identity is provided', () => {
    const hook = combineIdentity({ resolve: async () => 'bureau persona' }, undefined);
    expect(hook).toBeTypeOf('function');
  });

  it('returns a hook when only agent identity is provided', () => {
    const hook = combineIdentity(undefined, { resolve: async () => 'agent persona' });
    expect(hook).toBeTypeOf('function');
  });

  it('injects only bureau persona when only bureau identity is provided', async () => {
    const conversation = new Conversation();
    const hook = combineIdentity({ resolve: async () => 'You are a bureau agent' }, undefined);

    await hook!(createStepContext(conversation, 0));

    const messages = conversation.getMessages();
    const systemMessages = messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]!.content).toBe('You are a bureau agent');
  });

  it('injects only agent persona when only agent identity is provided', async () => {
    const conversation = new Conversation();
    const hook = combineIdentity(undefined, { resolve: async () => 'You are the researcher' });

    await hook!(createStepContext(conversation, 0));

    const messages = conversation.getMessages();
    const systemMessages = messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]!.content).toBe('You are the researcher');
  });

  it('injects bureau persona BEFORE agent persona', async () => {
    const conversation = new Conversation();
    const hook = combineIdentity(
      { resolve: async () => 'Bureau: you are a Lost Gradient agent' },
      { resolve: async () => 'Agent: you are the researcher' },
    );

    await hook!(createStepContext(conversation, 0));

    const messages = conversation.getMessages();
    const systemMessages = messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(2);
    // Bureau persona comes first
    expect(systemMessages[0]!.content).toBe('Bureau: you are a Lost Gradient agent');
    // Agent persona comes second
    expect(systemMessages[1]!.content).toBe('Agent: you are the researcher');
  });

  it('does NOT inject on steps other than step 0', async () => {
    const conversation = new Conversation();
    const hook = combineIdentity(
      { resolve: async () => 'bureau persona' },
      { resolve: async () => 'agent persona' },
    );

    // Step 1 — should NOT inject
    await hook!(createStepContext(conversation, 1));
    const messages = conversation.getMessages();
    const systemMessages = messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(0);
  });

  it('is idempotent — does not inject twice on repeated step-0 calls', async () => {
    const conversation = new Conversation();
    const hook = combineIdentity(
      { resolve: async () => 'bureau persona' },
      { resolve: async () => 'agent persona' },
    );

    await hook!(createStepContext(conversation, 0));
    await hook!(createStepContext(conversation, 0));

    const systemMessages = conversation.getMessages().filter((m) => m.role === 'system');
    // Should still be exactly 2 (bureau + agent), not 4
    expect(systemMessages).toHaveLength(2);
  });

  it('degrades gracefully when bureau resolve throws — still injects agent identity', async () => {
    const warnings: string[] = [];
    const conversation = new Conversation();
    const hook = combineIdentity(
      {
        resolve: async () => {
          throw new Error('bureau resolve failed');
        },
      },
      { resolve: async () => 'Agent persona' },
      { warn: (msg) => warnings.push(msg) },
    );

    await hook!(createStepContext(conversation, 0));

    // Agent identity was injected despite bureau failure
    const systemMessages = conversation.getMessages().filter((m) => m.role === 'system');
    expect(systemMessages.some((m) => m.content === 'Agent persona')).toBe(true);

    // Warning was logged
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('bureau resolve failed');
  });

  it('degrades gracefully when agent resolve throws — bureau identity still injected', async () => {
    const warnings: string[] = [];
    const conversation = new Conversation();
    const hook = combineIdentity(
      { resolve: async () => 'Bureau persona' },
      {
        resolve: async () => {
          throw new Error('agent resolve failed');
        },
      },
      { warn: (msg) => warnings.push(msg) },
    );

    await hook!(createStepContext(conversation, 0));

    // Bureau identity was injected despite agent failure
    const systemMessages = conversation.getMessages().filter((m) => m.role === 'system');
    expect(systemMessages.some((m) => m.content === 'Bureau persona')).toBe(true);

    // Warning was logged
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('agent resolve failed');
  });

  it('skips injection for empty identity strings', async () => {
    const conversation = new Conversation();
    const hook = combineIdentity(
      { resolve: async () => '' },
      { resolve: async () => 'Agent persona' },
    );

    await hook!(createStepContext(conversation, 0));

    // Only the non-empty agent persona is injected
    const systemMessages = conversation.getMessages().filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]!.content).toBe('Agent persona');
  });
});
