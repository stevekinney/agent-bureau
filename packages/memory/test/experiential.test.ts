import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { createMemory } from '../src/create-memory';
import type { StepResultLike } from '../src/experiential';
import { createRunCaptureHook, summarizeRun } from '../src/experiential';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';
import type { Memory } from '../src/types';

const DIMENSION = 64;

function createTestMemory() {
  const storage = createInMemoryMemoryRecordStorage();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({
    embedder,
    storage,
    dimension: DIMENSION,
  });
  return { memory, storage, embedder };
}

function createMockConversation(messages: Array<{ role: string; content: string }>) {
  return {
    getMessages() {
      return messages;
    },
  };
}

function createStepResult(overrides?: Partial<StepResultLike>): StepResultLike {
  return {
    step: 2,
    conversation: createMockConversation([
      { role: 'user', content: 'What is TypeScript?' },
      { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript.' },
      { role: 'user', content: 'Tell me more about its type system.' },
      { role: 'assistant', content: 'TypeScript has structural typing with generics.' },
    ]),
    content: 'TypeScript has structural typing with generics.',
    final: true,
    metadata: {},
    ...overrides,
  };
}

describe('summarizeRun', () => {
  it('produces a well-formed summary with all sections', () => {
    const result = createStepResult();
    const summary = summarizeRun(result);

    expect(summary).toContain('## Run Summary');
    expect(summary).toContain('Initial query: What is TypeScript?');
    expect(summary).toContain('Approach:');
    expect(summary).toContain('Outcome:');
    expect(summary).toContain('Steps: 3');
  });

  it('extracts the first user message as initial query', () => {
    const result = createStepResult({
      conversation: createMockConversation([
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'First real question' },
        { role: 'assistant', content: 'Answer.' },
      ]),
    });

    const summary = summarizeRun(result);
    expect(summary).toContain('Initial query: First real question');
  });

  it('shows (unknown) when there are no user messages', () => {
    const result = createStepResult({
      conversation: createMockConversation([
        { role: 'system', content: 'System only conversation' },
      ]),
    });

    const summary = summarizeRun(result);
    expect(summary).toContain('Initial query: (unknown)');
  });

  it('truncates long outcome content', () => {
    const longContent = 'x'.repeat(300);
    const result = createStepResult({ content: longContent });

    const summary = summarizeRun(result);
    expect(summary).toContain('...');
    expect(summary.length).toBeLessThan(longContent.length + 200);
  });

  it('includes step count (1-based)', () => {
    const result = createStepResult({ step: 0 });
    const summary = summarizeRun(result);
    expect(summary).toContain('Steps: 1');
  });
});

describe('createRunCaptureHook', () => {
  let memory: Memory;

  beforeEach(async () => {
    const test = createTestMemory();
    memory = test.memory;
    await memory.init();
  });

  it('fires only on the final step', async () => {
    const { onStep } = createRunCaptureHook({ memory });

    // Non-final step — should not store anything
    await onStep(createStepResult({ final: false }));
    expect(await memory.count('experiential')).toBe(0);

    // Final step — should store
    await onStep(createStepResult({ final: true }));
    expect(await memory.count('experiential')).toBe(1);
  });

  it('stores the entry with correct metadata', async () => {
    const { onStep } = createRunCaptureHook({ memory });

    await onStep(
      createStepResult({
        final: true,
        metadata: { finishReason: 'stop-condition', agentId: 'test-agent' },
      }),
    );

    const results = await memory.recall('TypeScript', { namespace: 'experiential' });
    expect(results.length).toBe(1);

    const entry = results[0]!;
    expect(entry.metadata.source).toBe('experiential');
    expect(entry.metadata.namespace).toBe('experiential');
    expect(entry.metadata.tags).toEqual(['case']);
    expect(entry.metadata['finishReason']).toBe('stop-condition');
    expect(entry.metadata['agentId']).toBe('test-agent');
  });

  it('uses a custom namespace when provided', async () => {
    const { onStep } = createRunCaptureHook({
      memory,
      namespace: 'custom-experiential',
    });

    await onStep(createStepResult());

    expect(await memory.count('custom-experiential')).toBe(1);
    expect(await memory.count('experiential')).toBe(0);
  });

  it('uses a custom summarize function when provided', async () => {
    const customSummarize = mock((_result: StepResultLike) => 'Custom summary output');
    const { onStep } = createRunCaptureHook({
      memory,
      summarize: customSummarize,
    });

    await onStep(createStepResult());

    expect(customSummarize).toHaveBeenCalledTimes(1);

    const results = await memory.recall('Custom summary', { namespace: 'experiential' });
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe('Custom summary output');
  });
});
