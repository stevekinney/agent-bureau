import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import { createMemory } from '../src/create-memory';
import type {
  FileSynchronizer,
  IntervalHandle,
  PollCycleCompletedEvent,
} from '../src/file-synchronizer';
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
 * Awaits the synchronizer's next poll-cycle completion event (AB-341) — the
 * event-driven signal the coordinator ruling calls for, in place of a
 * bounded yield-count poll of a side effect. Register this before
 * triggering the poll (calling the injected `poll` callback, or advancing
 * a manual runtime's clock) so the listener is in place before the event
 * can fire; the returned promise resolves only once the pass has actually
 * settled, filesystem I/O included, with the synchronizing lock already
 * released.
 */
function waitForPollCycle(synchronizer: FileSynchronizer): Promise<PollCycleCompletedEvent> {
  return new Promise((resolve) => {
    synchronizer.once('poll-cycle.completed', resolve);
  });
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
    Object.assign(memory, {
      rememberOnce: async (...args: Parameters<Memory['rememberOnce']>) => {
        if (failing) {
          throw new Error('poll failure');
        }
        return originalRememberOnce(...args);
      },
    });

    // Change the file so the next poll re-ingests it, register the
    // poll-cycle completion listener, then fire the poll. Awaiting the
    // event (rather than polling a side effect like rememberOnce's call
    // count) is the event-driven observation the coordinator ruling on
    // AB-341 calls for: the synchronizer performs real filesystem I/O on
    // macrotasks, and the event fires only once that pass has fully
    // settled and the synchronizing lock has already been released — no
    // separate microtask drain is needed afterward.
    await writeFile(filePath, 'Updated once.');
    const firstCycle = waitForPollCycle(synchronizer);
    poll?.();
    const firstEvent = await firstCycle;
    expect(firstEvent.error).toBeDefined();
    expect(firstEvent.result).toBeUndefined();

    // The failing tick must not leave the synchronizing lock stuck: a follow-up
    // poll, now succeeding, should still ingest content.
    failing = false;
    await writeFile(filePath, 'Updated twice.');
    const secondCycle = waitForPollCycle(synchronizer);
    poll?.();
    const secondEvent = await secondCycle;
    expect(secondEvent.error).toBeUndefined();
    expect(secondEvent.result).toBeDefined();

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
    // trigger a poll. Only advancing the injected runtime does. `advance()`
    // itself only awaits the microtask queue between fired timer callbacks
    // (see `ManualRuntimeServices.advance`'s own doc comment) — it settles
    // before the poll's synchronize() has finished its real filesystem I/O,
    // which happens on macrotasks. Awaiting the poll-cycle completion event
    // (AB-341) observes that completion directly and event-drivenly,
    // rather than polling memory.count() for a side effect to appear.
    const pollCycle = waitForPollCycle(synchronizer);
    await writeFile(join(tempDir, 'polled.md'), 'Polled content.');
    await runtime.advance(1000);
    const event = await pollCycle;
    expect(event.error).toBeUndefined();
    expect(event.result).toBeDefined();

    expect(await memory.count()).toBeGreaterThan(countAfterStart);

    await synchronizer.stop();
  });
});
