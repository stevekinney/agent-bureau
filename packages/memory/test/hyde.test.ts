import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { MemoryStorageAdapter } from 'vector-frankl';

import { createMemory } from '../src/create-memory';
import { createHyDEGenerator, withHyDE } from '../src/hyde';
import { createMockEmbedder } from '../src/test/index';
import type { Memory } from '../src/types';

const DIMENSION = 64;

function createTestMemory() {
  const storage = new MemoryStorageAdapter();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({
    embedder,
    storage,
    dimension: DIMENSION,
  });
  return { memory, storage, embedder };
}

describe('withHyDE', () => {
  let innerMemory: Memory;

  beforeEach(async () => {
    const test = createTestMemory();
    innerMemory = test.memory;
    await innerMemory.init();
  });

  it('calls generateHypothetical with the original query', async () => {
    const generateHypothetical = mock(async (query: string) => `The answer to "${query}" is 42.`);
    const hydeMemory = withHyDE(innerMemory, { generateHypothetical });

    await innerMemory.remember('The answer to life is 42.');
    await hydeMemory.recall('What is the answer?');

    expect(generateHypothetical).toHaveBeenCalledTimes(1);
    expect(generateHypothetical).toHaveBeenCalledWith('What is the answer?');
  });

  it('uses the hypothetical text for the search when augmentTextSearch is false', async () => {
    const hypothetical = 'The project uses TypeScript for all packages.';
    const generateHypothetical = mock(async () => hypothetical);

    // Spy on the inner memory's recall to see what query is passed
    const innerRecall = innerMemory.recall.bind(innerMemory);
    let capturedQuery: string | undefined;
    innerMemory.recall = async (query, options) => {
      capturedQuery = query;
      return innerRecall(query, options);
    };

    const hydeMemory = withHyDE(innerMemory, {
      generateHypothetical,
      augmentTextSearch: false,
    });

    await hydeMemory.recall('What language does the project use?');

    expect(capturedQuery).toBe(hypothetical);
  });

  it('combines hypothetical and original query when augmentTextSearch is true (default)', async () => {
    const hypothetical = 'The project uses TypeScript for all packages.';
    const generateHypothetical = mock(async () => hypothetical);

    const innerRecall = innerMemory.recall.bind(innerMemory);
    let capturedQuery: string | undefined;
    innerMemory.recall = async (query, options) => {
      capturedQuery = query;
      return innerRecall(query, options);
    };

    const hydeMemory = withHyDE(innerMemory, { generateHypothetical });

    await hydeMemory.recall('What language does the project use?');

    expect(capturedQuery).toBe(`${hypothetical}\nWhat language does the project use?`);
  });

  it('passes through remember() to the inner memory unchanged', async () => {
    const generateHypothetical = mock(async () => 'hypothetical');
    const hydeMemory = withHyDE(innerMemory, { generateHypothetical });

    const entry = await hydeMemory.remember('Test content', {
      source: 'manual',
      tags: ['test'],
    });

    expect(entry.content).toBe('Test content');
    expect(entry.metadata.tags).toEqual(['test']);

    // Verify it was stored in the inner memory
    const count = await innerMemory.count();
    expect(count).toBe(1);

    // generateHypothetical should not have been called
    expect(generateHypothetical).not.toHaveBeenCalled();
  });

  it('passes through forget() to the inner memory unchanged', async () => {
    const generateHypothetical = mock(async () => 'hypothetical');
    const hydeMemory = withHyDE(innerMemory, { generateHypothetical });

    const entry = await hydeMemory.remember('To be forgotten');
    await hydeMemory.forget(entry.id);

    const count = await innerMemory.count();
    expect(count).toBe(0);
    expect(generateHypothetical).not.toHaveBeenCalled();
  });

  it('passes through forgetAll() to the inner memory unchanged', async () => {
    const generateHypothetical = mock(async () => 'hypothetical');
    const hydeMemory = withHyDE(innerMemory, { generateHypothetical });

    await hydeMemory.remember('Entry 1');
    await hydeMemory.remember('Entry 2');
    await hydeMemory.forgetAll();

    const count = await innerMemory.count();
    expect(count).toBe(0);
    expect(generateHypothetical).not.toHaveBeenCalled();
  });

  it('passes through count() to the inner memory unchanged', async () => {
    const generateHypothetical = mock(async () => 'hypothetical');
    const hydeMemory = withHyDE(innerMemory, { generateHypothetical });

    await innerMemory.remember('Entry 1');
    await innerMemory.remember('Entry 2');

    const count = await hydeMemory.count();
    expect(count).toBe(2);
    expect(generateHypothetical).not.toHaveBeenCalled();
  });

  it('passes through init() and close() unchanged', async () => {
    const generateHypothetical = mock(async () => 'hypothetical');
    const hydeMemory = withHyDE(innerMemory, { generateHypothetical });

    // These should not throw
    await hydeMemory.init();
    await hydeMemory.close();
    expect(generateHypothetical).not.toHaveBeenCalled();
  });

  it('forwards search options to the inner recall', async () => {
    const generateHypothetical = mock(async () => 'hypothetical answer');
    const hydeMemory = withHyDE(innerMemory, { generateHypothetical });

    await innerMemory.remember('Memory in default namespace');
    await innerMemory.remember('Memory in other namespace', { namespace: 'other' });

    const results = await hydeMemory.recall('test', { namespace: 'other', limit: 1 });

    // Should only return results from the 'other' namespace
    for (const result of results) {
      expect(result.metadata.namespace).toBe('other');
    }
  });

  it('propagates errors from generateHypothetical', async () => {
    const generateHypothetical = mock(async () => {
      throw new Error('LLM unavailable');
    });
    const hydeMemory = withHyDE(innerMemory, { generateHypothetical });

    await expect(hydeMemory.recall('test query')).rejects.toThrow('LLM unavailable');
  });
});

describe('createHyDEGenerator', () => {
  it('builds a working generator from a generateText function', async () => {
    const generateText = mock(async (_prompt: string) => {
      return 'TypeScript is a typed superset of JavaScript.';
    });

    const generator = createHyDEGenerator({ generateText });
    const result = await generator('What is TypeScript?');

    expect(result).toBe('TypeScript is a typed superset of JavaScript.');
    expect(generateText).toHaveBeenCalledTimes(1);
    // The prompt should contain the user query
    const calledWith = generateText.mock.calls[0]![0];
    expect(calledWith).toContain('What is TypeScript?');
  });

  it('uses a custom system prompt when provided', async () => {
    let capturedPrompt = '';
    const generateText = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return 'answer';
    });

    const customPrompt = 'You are a memory retrieval assistant.';
    const generator = createHyDEGenerator({ generateText, systemPrompt: customPrompt });
    await generator('test query');

    expect(capturedPrompt).toContain(customPrompt);
  });

  it('uses a default system prompt when none is provided', async () => {
    let capturedPrompt = '';
    const generateText = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return 'answer';
    });

    const generator = createHyDEGenerator({ generateText });
    await generator('test query');

    // Should contain guidance about semantic search
    expect(capturedPrompt).toContain('semantic search');
  });
});
