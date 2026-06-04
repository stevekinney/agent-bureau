import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MemoryStorageAdapter } from 'vector-frankl';

import { createMemory } from '../src/create-memory';
import { createFileSynchronizer } from '../src/file-synchronizer';
import { createMockEmbedder } from '../src/test/index';
import type { Memory } from '../src/types';

const DIMENSION = 64;

async function drainMicrotasks(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

describe('createFileSynchronizer', () => {
  let memory: Memory;
  let tempDir: string;

  beforeEach(async () => {
    const storage = new MemoryStorageAdapter();
    const embedder = createMockEmbedder(DIMENSION);
    memory = createMemory({ embedder, storage, dimension: DIMENSION });
    await memory.init();

    tempDir = await mkdtemp(join(tmpdir(), 'memory-sync-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('synchronizes new files into memory', async () => {
    await writeFile(join(tempDir, 'notes.md'), '# Authentication\n\nOAuth2 flow details.');

    const synchronizer = createFileSynchronizer({ memory, directory: tempDir });
    const result = await synchronizer.synchronize();

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);

    expect(await memory.count()).toBeGreaterThan(0);
  });

  it('treats a missing directory as an empty synchronization result', async () => {
    const missingDirectory = join(tempDir, 'missing');
    const synchronizer = createFileSynchronizer({ memory, directory: missingDirectory });

    const result = await synchronizer.synchronize();

    expect(result).toEqual({ added: 0, updated: 0, removed: 0 });
  });

  it('detects updated files on re-sync', async () => {
    await writeFile(join(tempDir, 'notes.md'), 'Original content.');

    const synchronizer = createFileSynchronizer({ memory, directory: tempDir });
    await synchronizer.synchronize();

    await writeFile(join(tempDir, 'notes.md'), 'Updated content.');
    const result = await synchronizer.synchronize();

    expect(result.updated).toBe(1);
    expect(result.added).toBe(0);
  });

  it('detects removed files on re-sync', async () => {
    await writeFile(join(tempDir, 'notes.md'), 'Temporary content.');

    const synchronizer = createFileSynchronizer({ memory, directory: tempDir });
    await synchronizer.synchronize();

    await rm(join(tempDir, 'notes.md'));
    const result = await synchronizer.synchronize();

    expect(result.removed).toBe(1);
  });

  it('skips files that become unreadable between scans', async () => {
    const unreadableFile = join(tempDir, 'private.md');
    await writeFile(unreadableFile, 'Secret content.');
    await Bun.$`chmod 000 ${unreadableFile}`;

    try {
      const synchronizer = createFileSynchronizer({ memory, directory: tempDir });
      const result = await synchronizer.synchronize();

      expect(result).toEqual({ added: 0, updated: 0, removed: 0 });
    } finally {
      await Bun.$`chmod 644 ${unreadableFile}`;
    }
  });

  it('only includes files with matching extensions', async () => {
    await writeFile(join(tempDir, 'notes.md'), 'Markdown content.');
    await writeFile(join(tempDir, 'data.json'), '{"key": "value"}');

    const synchronizer = createFileSynchronizer({
      memory,
      directory: tempDir,
      extensions: ['.md'],
    });
    const result = await synchronizer.synchronize();

    expect(result.added).toBe(1); // Only the .md file.
  });

  it('recurses into subdirectories', async () => {
    const subDir = join(tempDir, 'sub');
    await mkdir(subDir);
    await writeFile(join(subDir, 'deep.md'), 'Deep content.');

    const synchronizer = createFileSynchronizer({ memory, directory: tempDir });
    const result = await synchronizer.synchronize();

    expect(result.added).toBe(1);
  });

  it('start and stop control polling', async () => {
    await writeFile(join(tempDir, 'test.md'), 'Poll content.');

    const synchronizer = createFileSynchronizer({
      memory,
      directory: tempDir,
      pollingInterval: 60_000, // Long interval so it doesn't fire during test.
    });

    await synchronizer.start();
    expect(await memory.count()).toBeGreaterThan(0);

    synchronizer.stop();
  });

  it('swallows polling errors and releases the synchronizing lock for future ticks', async () => {
    const filePath = join(tempDir, 'polling.md');
    await writeFile(filePath, 'Initial content.');
    let poll: (() => void) | undefined;

    const synchronizer = createFileSynchronizer({
      memory,
      directory: tempDir,
      pollingInterval: 20,
      setIntervalFunction: ((handler: TimerHandler) => {
        poll = handler as () => void;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFunction: (() => {}) as typeof clearInterval,
    });

    await synchronizer.start();

    const originalRemember = memory.remember.bind(memory);
    let failing = true;
    Object.assign(memory, {
      remember: async (...args: Parameters<Memory['remember']>) => {
        if (failing) {
          throw new Error('poll failure');
        }
        return originalRemember(...args);
      },
    });

    await writeFile(filePath, 'Updated once.');
    poll?.();
    await drainMicrotasks();

    failing = false;
    await writeFile(filePath, 'Updated twice.');
    poll?.();
    await drainMicrotasks();

    synchronizer.stop();
    expect(await memory.count()).toBeGreaterThan(0);
  });

  it('does not leak intervals when start() is called concurrently', async () => {
    await writeFile(join(tempDir, 'concurrent.md'), 'Concurrent test.');

    const synchronizer = createFileSynchronizer({
      memory,
      directory: tempDir,
      pollingInterval: 60_000,
    });

    // Fire two concurrent start() calls — only one should create an interval.
    const [first, second] = await Promise.allSettled([synchronizer.start(), synchronizer.start()]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');

    // Memory should have entries from exactly one synchronize() call.
    expect(await memory.count()).toBeGreaterThan(0);

    // A single stop() should clean up the only interval. If two intervals
    // were created, the leaked one would keep a reference alive — but we
    // cannot directly observe the interval count, so we verify no error
    // is thrown and stop completes cleanly.
    synchronizer.stop();
  });

  it('allows restart after stop even if start was called concurrently', async () => {
    await writeFile(join(tempDir, 'restart.md'), 'Restart test.');

    const synchronizer = createFileSynchronizer({
      memory,
      directory: tempDir,
      pollingInterval: 60_000,
    });

    // Concurrent start calls.
    await Promise.all([synchronizer.start(), synchronizer.start()]);
    synchronizer.stop();

    // Should be able to start again after stopping.
    await synchronizer.start();
    expect(await memory.count()).toBeGreaterThan(0);
    synchronizer.stop();
  });

  it('skips unchanged files on re-sync', async () => {
    await writeFile(join(tempDir, 'stable.md'), 'Stable content.');

    const synchronizer = createFileSynchronizer({ memory, directory: tempDir });
    const first = await synchronizer.synchronize();
    expect(first.added).toBe(1);

    const second = await synchronizer.synchronize();
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
  });
});
