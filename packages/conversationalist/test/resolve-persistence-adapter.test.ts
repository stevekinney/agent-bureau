import { afterEach, describe, expect, it } from 'bun:test';

import {
  type ResolvedPersistenceAdapter,
  resolvePersistenceAdapter,
} from '../src/persistence/resolve-persistence-adapter';
import type { SQLitePersistenceAdapter } from '../src/persistence/sqlite-adapter';

describe('resolvePersistenceAdapter', () => {
  let resolved: ResolvedPersistenceAdapter | undefined;

  afterEach(() => {
    // Clean up SQLite adapters that hold open database handles.
    if (resolved?.name === 'sqlite') {
      (resolved.adapter as SQLitePersistenceAdapter).close();
    }
    resolved = undefined;
  });

  it('returns SQLite adapter when sqlite options are provided (Bun environment)', async () => {
    resolved = await resolvePersistenceAdapter({
      sqlite: { path: ':memory:' },
    });

    expect(resolved.name).toBe('sqlite');
    expect(resolved.adapter).toBeDefined();
    expect(typeof resolved.adapter.save).toBe('function');
    expect(typeof resolved.adapter.load).toBe('function');
  });

  it('falls back to in-memory adapter when no options are provided', async () => {
    resolved = await resolvePersistenceAdapter();

    expect(resolved.name).toBe('memory');
    expect(resolved.adapter).toBeDefined();
  });

  it('falls back to in-memory adapter when an empty options object is provided', async () => {
    resolved = await resolvePersistenceAdapter({});

    expect(resolved.name).toBe('memory');
  });

  it('skips an adapter when its options are not provided even if available', async () => {
    // SQLite and JSONL are available in Bun, but we only provide memory options.
    resolved = await resolvePersistenceAdapter({
      memory: {},
    });

    expect(resolved.name).toBe('memory');
  });

  it('respects a custom preference order', async () => {
    resolved = await resolvePersistenceAdapter({
      sqlite: { path: ':memory:' },
      memory: {},
      preference: ['memory', 'sqlite'],
    });

    expect(resolved.name).toBe('memory');
  });

  it('resolves JSONL adapter when jsonl options are provided', async () => {
    const temporaryDirectory = `${import.meta.dir}/.tmp-resolve-test-${Date.now()}`;

    resolved = await resolvePersistenceAdapter({
      jsonl: { directory: temporaryDirectory },
      preference: ['jsonl'],
    });

    expect(resolved.name).toBe('jsonl');
    expect(resolved.adapter).toBeDefined();
  });

  it('falls back to memory when custom preference excludes all available adapters with options', async () => {
    resolved = await resolvePersistenceAdapter({
      preference: ['sqlite', 'jsonl'],
      // No sqlite or jsonl options provided.
    });

    expect(resolved.name).toBe('memory');
  });
});
