import { describe, expect, it } from 'bun:test';

import type { MemoryLike } from '../src/skill-memory';
import { createSkillMemory } from '../src/skill-memory';

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

describe('createSkillMemory', () => {
  it('forces the skill:{name} namespace on remember', async () => {
    const mock = createMockMemory();
    const skillMemory = createSkillMemory(mock, 'code-review');

    await skillMemory.remember('Always check for null returns');

    expect(mock.entries).toHaveLength(1);
    expect(mock.entries[0]?.metadata).toEqual({ namespace: 'skill:code-review' });
  });

  it('forces the skill:{name} namespace on recall', async () => {
    const mock = createMockMemory();
    const skillMemory = createSkillMemory(mock, 'code-review');

    await skillMemory.recall('null checking patterns');

    expect(mock.recalls).toHaveLength(1);
    expect(mock.recalls[0]?.options).toEqual({ namespace: 'skill:code-review' });
  });

  it('uses different namespaces for different skills', async () => {
    const mock = createMockMemory();
    const reviewMemory = createSkillMemory(mock, 'code-review');
    const deployMemory = createSkillMemory(mock, 'deploy');

    await reviewMemory.remember('Review tip');
    await deployMemory.remember('Deploy tip');

    expect(mock.entries[0]?.metadata).toEqual({ namespace: 'skill:code-review' });
    expect(mock.entries[1]?.metadata).toEqual({ namespace: 'skill:deploy' });
  });

  it('preserves original metadata alongside the namespace', async () => {
    const mock = createMockMemory();
    const skillMemory = createSkillMemory(mock, 'code-review');

    await skillMemory.remember('Check for null', {
      source: 'experiential',
      tags: ['best-practice'],
    });

    expect(mock.entries[0]?.metadata).toEqual({
      source: 'experiential',
      tags: ['best-practice'],
      namespace: 'skill:code-review',
    });
  });

  it('merges recall options with the forced namespace', async () => {
    const mock = createMockMemory();
    const skillMemory = createSkillMemory(mock, 'testing');

    await skillMemory.recall('assertion patterns', { limit: 3 });

    expect(mock.recalls[0]?.options).toEqual({
      limit: 3,
      namespace: 'skill:testing',
    });
  });

  it('overrides any caller-provided namespace with the skill namespace', async () => {
    const mock = createMockMemory();
    const skillMemory = createSkillMemory(mock, 'testing');

    await skillMemory.remember('Something', { namespace: 'sneaky' });
    await skillMemory.recall('query', { namespace: 'sneaky' });

    expect(mock.entries[0]?.metadata?.['namespace']).toBe('skill:testing');
    expect(mock.recalls[0]?.options?.['namespace']).toBe('skill:testing');
  });
});
