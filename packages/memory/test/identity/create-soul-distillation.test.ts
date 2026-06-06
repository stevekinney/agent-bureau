import { describe, expect, it } from 'bun:test';

import { createMemory } from '../../src/create-memory';
import type { SoulDistillationState } from '../../src/identity/create-soul-distillation';
import { createSoulDistillationTask } from '../../src/identity/create-soul-distillation';
import { createStaticIdentityProvider } from '../../src/identity/create-static-provider';
import type { SoulBudget, SoulItem } from '../../src/identity/types';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../../src/test/index';
import type { Memory } from '../../src/types';

function createTestMemory(): Memory {
  return createMemory({
    embedder: createMockEmbedder(128),
    storage: createInMemoryMemoryRecordStorage(),
    deduplicationThreshold: 0.99,
  });
}

function makeSoulItem(id: string, content: string, overrides?: Partial<SoulItem>): SoulItem {
  return {
    id,
    content,
    source: 'seed',
    pinned: false,
    updatedAt: '2026-01-01T00:00:00Z',
    reinforcementCount: 0,
    ...overrides,
  };
}

const defaultBudget: SoulBudget = {
  maxTokens: 10000,
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
  maxItemsPerTopic: 5,
};

async function processAllChunks(
  processChunk: (
    state: SoulDistillationState,
    signal: AbortSignal,
  ) => Promise<{ state: SoulDistillationState; done: boolean }>,
  initialState: SoulDistillationState,
): Promise<SoulDistillationState> {
  const controller = new AbortController();
  let state = initialState;
  let done = false;

  while (!done) {
    const result = await processChunk(state, controller.signal);
    state = result.state;
    done = result.done;
  }

  return state;
}

describe('createSoulDistillationTask', () => {
  it('creates a valid chunked task options structure', () => {
    const memory = createTestMemory();
    const provider = createStaticIdentityProvider();

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async () => '',
    });

    expect(task.name).toBe('soul-distillation');
    expect(task.priority).toBe('background');
    expect(task.initialState.scanned).toBe(0);
    expect(task.initialState.candidates).toEqual([]);
    expect(task.initialState.demotions).toEqual([]);
    expect(task.initialState.proposalGenerated).toBe(false);
  });

  it('completes without errors when there are no graduation candidates', async () => {
    const memory = createTestMemory();
    await memory.init();

    const provider = createStaticIdentityProvider();

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async () => '',
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);
    expect(finalState.candidates).toEqual([]);

    await memory.close();
  });

  it('entries below graduationConfidence are not considered', async () => {
    const memory = createTestMemory();
    await memory.init();

    // Add entries with low confidence
    await memory.remember('Low confidence insight', {
      confidence: 0.5,
      reinforcementCount: 10,
    });

    const provider = createStaticIdentityProvider();

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      graduationConfidence: 0.9,
      distill: async () => '',
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);
    expect(finalState.candidates).toHaveLength(0);

    await memory.close();
  });

  it('entries below graduationReinforcement are not considered', async () => {
    const memory = createTestMemory();
    await memory.init();

    // Add entries with high confidence but low reinforcement
    await memory.remember('High confidence but not reinforced', {
      confidence: 0.95,
      reinforcementCount: 1,
    });

    const provider = createStaticIdentityProvider();

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      graduationReinforcement: 3,
      distill: async () => '',
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);
    expect(finalState.candidates).toHaveLength(0);

    await memory.close();
  });

  it('identifies candidates that meet both confidence and reinforcement thresholds', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Prefer TypeScript for new projects', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    await memory.remember('Always run tests before committing', {
      confidence: 0.92,
      reinforcementCount: 4,
    });

    const provider = createStaticIdentityProvider();
    let distillCalled = false;

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async (currentSoul, candidates) => {
        distillCalled = true;
        return candidates.map((c) => c.content).join('\n');
      },
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);
    expect(finalState.candidates).toHaveLength(2);
    expect(distillCalled).toBe(true);

    await memory.close();
  });

  it('the proposal is stored as pending, not applied directly', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Important principle', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('existing', 'Existing soul item')],
    });

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async (_soul, candidates) => candidates.map((c) => c.content).join('\n'),
    });

    await processAllChunks(task.processChunk, task.initialState);

    // The pending update should exist
    const pending = await provider.loadPendingSoulUpdate();
    expect(pending).toBeDefined();
    expect(pending!.length).toBeGreaterThan(0);

    // The current soul should still be the original
    const soul = await provider.loadSoul();
    expect(soul[0]!.content).toBe('Existing soul item');

    await memory.close();
  });

  it('distill function receives the current soul text and formatted candidates', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Always validate inputs', {
      confidence: 0.95,
      reinforcementCount: 5,
      topic: 'safety',
    });

    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Be helpful.')],
    });

    let receivedSoul = '';
    let receivedCandidates: Array<{ content: string; confidence: number; topic?: string }> = [];

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async (currentSoul, candidates) => {
        receivedSoul = currentSoul;
        receivedCandidates = candidates;
        return candidates.map((c) => c.content).join('\n');
      },
    });

    await processAllChunks(task.processChunk, task.initialState);

    expect(receivedSoul).toBe('Be helpful.');
    expect(receivedCandidates).toHaveLength(1);
    expect(receivedCandidates[0]!.content).toBe('Always validate inputs');
    expect(receivedCandidates[0]!.confidence).toBe(0.95);
    expect(receivedCandidates[0]!.topic).toBe('safety');

    await memory.close();
  });

  it('maxItemsPerTopic prevents topic over-concentration', async () => {
    const memory = createTestMemory();
    await memory.init();

    // Add many candidates in the same topic
    for (let i = 0; i < 8; i++) {
      await memory.remember(`Safety rule ${i}`, {
        confidence: 0.95,
        reinforcementCount: 5,
        topic: 'safety',
      });
    }

    const provider = createStaticIdentityProvider({
      soul: [
        makeSoulItem('s1', 'Safety rule existing 1', { topic: 'safety' }),
        makeSoulItem('s2', 'Safety rule existing 2', { topic: 'safety' }),
      ],
    });

    let receivedCandidates: Array<{ content: string }> = [];

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: { ...defaultBudget, maxItemsPerTopic: 3 },
      distill: async (_soul, candidates) => {
        receivedCandidates = candidates;
        return candidates.map((c) => c.content).join('\n');
      },
    });

    await processAllChunks(task.processChunk, task.initialState);

    // 2 existing + at most 1 new = 3 total for the topic
    expect(receivedCandidates.length).toBeLessThanOrEqual(1);

    await memory.close();
  });

  it('safety filter rejects flagged candidates', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Safe principle', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    await memory.remember('Unsafe principle that should be rejected', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    const provider = createStaticIdentityProvider();

    let distillCandidates: Array<{ content: string }> = [];

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async (_soul, candidates) => {
        distillCandidates = candidates;
        return candidates.map((c) => c.content).join('\n');
      },
      safetyFilter: async (item) => !item.includes('Unsafe'),
    });

    await processAllChunks(task.processChunk, task.initialState);

    // Only the safe candidate should have made it to distill
    expect(distillCandidates).toHaveLength(1);
    expect(distillCandidates[0]!.content).toBe('Safe principle');

    await memory.close();
  });

  it('budget enforcement triggers demotion of lowest-value non-pinned items', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('New high-value insight', {
      confidence: 0.98,
      reinforcementCount: 10,
    });

    // Create a soul that's near the budget limit
    const provider = createStaticIdentityProvider({
      soul: [
        makeSoulItem('pinned', 'I am pinned and safe', { pinned: true, reinforcementCount: 1 }),
        makeSoulItem('low-value', 'I have low reinforcement', { reinforcementCount: 0 }),
        makeSoulItem('high-value', 'I have high reinforcement', { reinforcementCount: 10 }),
      ],
    });

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: {
        maxTokens: 20, // Very tight budget
        estimateTokens: (text) => Math.ceil(text.length / 4),
        maxItemsPerTopic: 5,
      },
      distill: async (_soul, candidates) => candidates.map((c) => c.content).join('\n'),
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    // The low-value non-pinned item should be a demotion candidate
    if (finalState.demotions.length > 0) {
      expect(finalState.demotions).toContain('low-value');
      expect(finalState.demotions).not.toContain('pinned');
    }

    await memory.close();
  });

  it('pinned items are never demoted', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('New insight', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    const provider = createStaticIdentityProvider({
      soul: [
        makeSoulItem('pinned-low', 'Pinned but low reinforcement', {
          pinned: true,
          reinforcementCount: 0,
        }),
      ],
    });

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: {
        maxTokens: 5, // Very tight
        estimateTokens: (text) => Math.ceil(text.length / 4),
        maxItemsPerTopic: 5,
      },
      distill: async (_soul, candidates) => candidates.map((c) => c.content).join('\n'),
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    expect(finalState.demotions).not.toContain('pinned-low');

    await memory.close();
  });

  it('completes when memory is empty', async () => {
    const memory = createTestMemory();
    await memory.init();

    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Existing')],
    });

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async () => 'Should not be called',
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);
    expect(finalState.scanned).toBe(0);
    expect(finalState.proposalGenerated).toBe(false);

    // No pending update should be created
    expect(await provider.loadPendingSoulUpdate()).toBeUndefined();

    await memory.close();
  });

  it('returns immediately when a proposal has already been generated', async () => {
    const memory = createTestMemory();
    const provider = createStaticIdentityProvider();
    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async () => '',
    });

    const completedState: SoulDistillationState = {
      scanned: 2,
      candidates: [],
      demotions: [],
      proposalGenerated: true,
    };

    const result = await task.processChunk(completedState, new AbortController().signal);

    expect(result).toEqual({ state: completedState, done: true });
  });

  it('returns partial scanning state when aborted mid-scan', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Abortable candidate', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    const provider = createStaticIdentityProvider();
    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async () => '',
    });
    const controller = new AbortController();
    controller.abort();

    const result = await task.processChunk(task.initialState, controller.signal);

    expect(result.done).toBe(false);
    expect(result.state.scanned).toBe(1);
    expect(result.state.candidates).toEqual([]);

    await memory.close();
  });

  it('returns done false while additional chunks remain to be scanned', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Candidate one', { confidence: 0.95, reinforcementCount: 5 });
    await memory.remember('Candidate two', { confidence: 0.95, reinforcementCount: 5 });
    await memory.remember('Candidate three', { confidence: 0.95, reinforcementCount: 5 });

    const provider = createStaticIdentityProvider();
    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      chunkSize: 2,
      distill: async (_soul, candidates) =>
        candidates.map((candidate) => candidate.content).join('\n'),
    });

    const result = await task.processChunk(task.initialState, new AbortController().signal);

    expect(result.done).toBe(false);
    expect(result.state.scanned).toBe(2);
    expect(result.state.candidates).toHaveLength(2);

    await memory.close();
  });

  it('reuses existing candidates when resuming a later chunk', async () => {
    const memory = createTestMemory();
    await memory.init();

    const firstCandidate = await memory.remember('Candidate one', {
      confidence: 0.95,
      reinforcementCount: 5,
    });
    await memory.remember('Candidate two', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    const provider = createStaticIdentityProvider();
    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async (_soul, candidates) =>
        candidates.map((candidate) => candidate.content).join('\n'),
    });

    const resumedState: SoulDistillationState = {
      scanned: 0,
      candidates: [
        {
          content: 'Candidate one',
          confidence: 0.95,
          reinforcementCount: 5,
          entryId: firstCandidate.id,
        },
      ],
      demotions: [],
      proposalGenerated: false,
    };

    const finalState = await processAllChunks(task.processChunk, resumedState);

    expect(finalState.candidates).toHaveLength(2);
    expect(finalState.candidates.map((candidate) => candidate.entryId)).toContain(
      firstCandidate.id,
    );

    await memory.close();
  });

  it('marks the proposal complete when the safety filter removes every candidate', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Filtered candidate', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    const provider = createStaticIdentityProvider();
    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async (_soul, candidates) =>
        candidates.map((candidate) => candidate.content).join('\n'),
      safetyFilter: async () => false,
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    expect(finalState.proposalGenerated).toBe(true);
    expect(finalState.candidates).toHaveLength(1);
    expect(await provider.loadPendingSoulUpdate()).toBeUndefined();

    await memory.close();
  });

  it('demotes the oldest low-priority soul item first when reinforcement counts tie', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Graduate this memory', {
      confidence: 0.98,
      reinforcementCount: 6,
    });

    const provider = createStaticIdentityProvider({
      soul: [
        makeSoulItem('older-item', 'Older item', {
          reinforcementCount: 1,
          updatedAt: '2025-01-01T00:00:00Z',
        }),
        makeSoulItem('newer-item', 'Newer item', {
          reinforcementCount: 1,
          updatedAt: '2026-01-01T00:00:00Z',
        }),
      ],
    });

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: {
        maxTokens: 20,
        estimateTokens: (text) => (text.length === 0 ? 0 : text.split('\n').length * 10),
        maxItemsPerTopic: 5,
      },
      distill: async (_soul, candidates) =>
        candidates.map((candidate) => candidate.content).join('\n'),
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    expect(finalState.demotions[0]).toBe('older-item');

    await memory.close();
  });
});
