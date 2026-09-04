import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import { createMemory } from '../src/create-memory';
import type { IntervalHandle } from '../src/file-synchronizer';
import { createFileSynchronizer } from '../src/file-synchronizer';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';
import type { Memory } from '../src/types';

const DIMENSION = 64;

async function drainMicrotasks(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

/**
 * Polls `condition` up to `maximumAttempts` times, yielding one real macrotask turn
 * (`yieldToPortableEventLoop`, a zero-delay `MessageChannel` post — not a wall-clock timer)
 * between tries. The synchronizer under test performs real filesystem I/O on macrotasks, so a
 * microtask-only drain never observes its completion; this still needs a real event-loop turn,
 * never a fixed-duration sleep. Bounded, never an unbounded spin.
 */
async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  failureMessage: string,
  maximumAttempts = 200,
): Promise<void> {
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    if (await condition()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error(failureMessage);
}

describe('createFileSynchronizer', () => {
  let memory: Memory;
  let tempDir: string;

  beforeEach(async () => {
    const storage = createInMemoryMemoryRecordStorage();
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

    await synchronizer.stop();
  });

  it('stop() awaits an in-flight synchronize() call before resolving', async () => {
    await writeFile(join(tempDir, 'note.md'), 'Content.');

    const synchronizer = createFileSynchronizer({ memory, directory: tempDir });

    let releaseRememberOnce: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRememberOnce = resolve;
    });
    const originalRememberOnce = memory.rememberOnce.bind(memory);
    Object.assign(memory, {
      rememberOnce: async (...args: Parameters<Memory['rememberOnce']>) => {
        await gate;
        return originalRememberOnce(...args);
      },
    });

    const synchronizePromise = synchronizer.synchronize();

    let stopResolved = false;
    const stopPromise = synchronizer.stop().then(() => {
      stopResolved = true;
    });

    // Give the in-flight synchronize() a chance to run and stop() a chance
    // to (incorrectly) resolve early — it must not, since rememberOnce is
    // still gated.
    await drainMicrotasks();
    expect(stopResolved).toBe(false);

    releaseRememberOnce?.();
    await synchronizePromise;
    await stopPromise;
    expect(stopResolved).toBe(true);
  });

  it('stop() resolves (not rejects) even when the in-flight synchronize() rejects', async () => {
    await writeFile(join(tempDir, 'note.md'), 'Content.');

    const synchronizer = createFileSynchronizer({ memory, directory: tempDir });

    const failure = new Error('rememberOnce failed');
    Object.assign(memory, {
      rememberOnce: async () => {
        throw failure;
      },
    });

    const synchronizePromise = synchronizer.synchronize();
    // stop() must settle even though the in-flight synchronize() it is
    // draining rejects — the rejection is the caller of synchronize()'s
    // concern (asserted below), not stop()'s.
    const stopPromise = synchronizer.stop();

    let synchronizeError: unknown;
    try {
      await synchronizePromise;
    } catch (error) {
      synchronizeError = error;
    }
    expect(synchronizeError).toBe(failure);

    await stopPromise;
  });

  it('stop() resolves promptly when no synchronize() call is in flight', async () => {
    const synchronizer = createFileSynchronizer({ memory, directory: tempDir });

    let resolved = false;
    void synchronizer.stop().then(() => {
      resolved = true;
    });

    // No in-flight synchronize() and no polling interval — stop() has
    // nothing to wait on, so it settles within a couple of microtask
    // turns. An artificial wait (a real timer, an unresolved gate) would
    // not settle by this point, unlike the wall-clock bound this replaces.
    await drainMicrotasks();
    expect(resolved).toBe(true);
  });

  it('swallows polling errors and releases the synchronizing lock for future ticks', async () => {
    const filePath = join(tempDir, 'polling.md');
    await writeFile(filePath, 'Initial content.');
    let poll: (() => void) | undefined;

    const synchronizer = createFileSynchronizer({
      memory,
      directory: tempDir,
      pollingInterval: 20,
      setIntervalFunction: (callback: () => void): IntervalHandle => {
        poll = callback;
        return 1;
      },
      clearIntervalFunction: (): void => {},
    });

    await synchronizer.start();

    const originalRememberOnce = memory.rememberOnce.bind(memory);
    let failing = true;
    let rememberCalls = 0;
    Object.assign(memory, {
      rememberOnce: async (...args: Parameters<Memory['rememberOnce']>) => {
        rememberCalls += 1;
        if (failing) {
          throw new Error('poll failure');
        }
        return originalRememberOnce(...args);
      },
    });

    // Change the file so the next poll re-ingests it, then fire the poll. The
    // synchronize() running inside the interval performs real filesystem I/O on
    // macrotasks, so we must wait until rememberOnce() has actually been invoked
    // (and thrown) before proceeding — otherwise flipping `failing` below could
    // race ahead of the in-flight sync and let it succeed, never exercising the
    // polling error-swallow path.
    await writeFile(filePath, 'Updated once.');
    poll?.();
    await waitForCondition(
      () => rememberCalls > 0,
      'expected rememberOnce to be invoked after the first poll',
    );
    // Flush the ingest → synchronize rejection through the interval's .catch
    // (swallow) and .finally (lock release).
    await drainMicrotasks();

    // The failing tick must not leave the synchronizing lock stuck: a follow-up
    // poll, now succeeding, should still ingest content.
    failing = false;
    const callsBeforeRecovery = rememberCalls;
    await writeFile(filePath, 'Updated twice.');
    poll?.();
    await waitForCondition(
      () => rememberCalls > callsBeforeRecovery,
      'expected rememberOnce to be invoked again after the recovery poll',
    );
    await drainMicrotasks();

    await synchronizer.stop();
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
    await synchronizer.stop();
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
    await synchronizer.stop();

    // Should be able to start again after stopping.
    await synchronizer.start();
    expect(await memory.count()).toBeGreaterThan(0);
    await synchronizer.stop();
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

  it('polls on an injected manual runtime clock rather than a real timer, when no explicit interval functions are given', async () => {
    const runtime = createManualRuntimeServices();
    await writeFile(join(tempDir, 'initial.md'), 'Initial content.');

    const synchronizer = createFileSynchronizer({
      memory,
      directory: tempDir,
      pollingInterval: 1000,
      runtime,
    });

    await synchronizer.start();
    const countAfterStart = await memory.count();
    expect(countAfterStart).toBeGreaterThan(0);

    // No real timer is running — advancing real wall-clock time (nothing to
    // advance here, since only the manual runtime's clock moves) does not
    // trigger a poll. Only advancing the injected runtime does. The poll's
    // synchronize() does real filesystem I/O on macrotasks (same as the
    // "swallows polling errors" test above), so poll bounded for the count
    // to change rather than assuming microtask draining alone is enough.
    await writeFile(join(tempDir, 'polled.md'), 'Polled content.');
    await runtime.advance(1000);
    await waitForCondition(
      async () => (await memory.count()) > countAfterStart,
      'expected memory.count() to increase after the polled sync',
    );

    expect(await memory.count()).toBeGreaterThan(countAfterStart);

    await synchronizer.stop();
  });
});
