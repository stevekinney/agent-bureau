import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { createMemory } from '../src/create-memory';
import type { StepResultLike } from '../src/experiential';
import { createReflectionHook } from '../src/reflection';
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
    step: 1,
    conversation: createMockConversation([
      { role: 'user', content: 'Help me refactor the auth module' },
      { role: 'assistant', content: 'I will break the refactor into three steps.' },
      { role: 'user', content: 'Sounds good, proceed.' },
      { role: 'assistant', content: 'Refactoring complete. All tests pass.' },
    ]),
    content: 'Refactoring complete. All tests pass.',
    final: true,
    metadata: {},
    ...overrides,
  };
}

describe('createReflectionHook', () => {
  let memory: Memory;

  beforeEach(async () => {
    const test = createTestMemory();
    memory = test.memory;
    await memory.init();
  });

  it('calls reflect with the run summary', async () => {
    const reflect = mock(async (summary: string) => `Insight: ${summary.slice(0, 30)}`);
    const { onStep } = createReflectionHook({ memory, reflect });

    await onStep(createStepResult());

    expect(reflect).toHaveBeenCalledTimes(1);
    const calledWith = reflect.mock.calls[0]![0];
    expect(calledWith).toContain('## Run Summary');
    expect(calledWith).toContain('Initial query:');
  });

  it('stores the extracted insight with correct metadata', async () => {
    const reflect = mock(async () => 'When refactoring auth, always run integration tests first.');
    const { onStep } = createReflectionHook({
      memory,
      reflect,
      namespace: 'experiential',
    });

    await onStep(
      createStepResult({
        metadata: { finishReason: 'stop-condition', agentId: 'refactor-agent' },
      }),
    );

    const results = await memory.recall('refactoring auth', { namespace: 'experiential' });
    expect(results.length).toBe(1);

    const entry = results[0]!;
    expect(entry.content).toBe('When refactoring auth, always run integration tests first.');
    expect(entry.metadata.source).toBe('experiential');
    expect(entry.metadata.tags).toEqual(['strategy']);
    expect(entry.metadata['finishReason']).toBe('stop-condition');
    expect(entry.metadata['agentId']).toBe('refactor-agent');
  });

  it('is a no-op on non-final steps', async () => {
    const reflect = mock(async () => 'insight');
    const { onStep } = createReflectionHook({ memory, reflect });

    await onStep(createStepResult({ final: false }));

    expect(reflect).not.toHaveBeenCalled();
    expect(await memory.count('experiential')).toBe(0);
  });

  it('respects shouldReflect predicate', async () => {
    const reflect = mock(async () => 'insight');
    const shouldReflect = mock((_result: StepResultLike) => false);

    const { onStep } = createReflectionHook({ memory, reflect, shouldReflect });

    await onStep(createStepResult());

    expect(shouldReflect).toHaveBeenCalledTimes(1);
    expect(reflect).not.toHaveBeenCalled();
    expect(await memory.count('experiential')).toBe(0);
  });

  it('reflects when shouldReflect returns true', async () => {
    const reflect = mock(async () => 'good insight');
    const shouldReflect = mock(() => true);

    const { onStep } = createReflectionHook({ memory, reflect, shouldReflect });

    await onStep(createStepResult());

    expect(reflect).toHaveBeenCalledTimes(1);
    expect(await memory.count('experiential')).toBe(1);
  });

  it('uses a custom namespace', async () => {
    const reflect = mock(async () => 'custom namespace insight');
    const { onStep } = createReflectionHook({
      memory,
      reflect,
      namespace: 'strategies',
    });

    await onStep(createStepResult());

    expect(await memory.count('strategies')).toBe(1);
    expect(await memory.count('experiential')).toBe(0);
  });
});
