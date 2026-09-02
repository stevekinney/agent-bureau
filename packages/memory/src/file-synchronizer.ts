import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

import type { ChunkingOptions } from './chunking';
import { sha256Hex } from './hash';
import { ingest } from './ingest';
import type { Memory, MemoryMetadata } from './types';

export type IntervalHandle = unknown;
export type ScheduleInterval = (callback: () => void, milliseconds?: number) => IntervalHandle;
export type ClearScheduledInterval = (handle: IntervalHandle) => void;

export interface FileSynchronizerOptions {
  memory: Memory;
  /** Root directory to watch. */
  directory: string;
  /** File extensions to include. Default: ['.md'] */
  extensions?: string[];
  /** Chunking options applied to each file. */
  chunking?: ChunkingOptions;
  /** Metadata to attach to all ingested entries. */
  metadata?: Partial<MemoryMetadata>;
  /** Polling interval in milliseconds. Default: 5000 */
  pollingInterval?: number;
  /** Injectable interval function for deterministic tests. */
  setIntervalFunction?: ScheduleInterval;
  /** Injectable interval cleanup function for deterministic tests. */
  clearIntervalFunction?: ClearScheduledInterval;
}

export interface SynchronizeResult {
  added: number;
  updated: number;
  removed: number;
}

export interface FileSynchronizer {
  /** Start watching for changes on a polling interval. */
  start(): Promise<void>;
  /**
   * Stop watching. Halts future polling immediately, then awaits any
   * `synchronize()` pass already in flight (whether started by a poll tick
   * or a direct call) before resolving, so an in-flight synchronization is
   * drained rather than abandoned.
   */
  stop(): Promise<void>;
  /** Synchronize all files once (no watching). */
  synchronize(): Promise<SynchronizeResult>;
}

async function walkDirectory(directory: string, extensions: string[]): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && extensions.includes(extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }

  await walk(directory);
  return files;
}

/**
 * Creates a file synchronizer that watches a directory and ingests
 * file contents into memory, keeping the index in sync with disk.
 */
export function createFileSynchronizer(options: FileSynchronizerOptions): FileSynchronizer {
  const {
    memory,
    directory,
    extensions = ['.md'],
    chunking,
    metadata,
    pollingInterval = 5000,
    setIntervalFunction = (callback, milliseconds) => setInterval(callback, milliseconds),
    clearIntervalFunction = (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  } = options;

  // Tracks known files: relative path → content hash.
  const knownFiles = new Map<string, string>();
  // Tracks which source identifiers belong to which file.
  const sourceByPath = new Map<string, string>();
  // Tracks the memory entry IDs for each source identifier so we can
  // delete them directly without relying on recall() (which applies
  // semantic search and source-document deduplication).
  const entryIdsBySource = new Map<string, string[]>();

  let intervalId: IntervalHandle;
  let hasInterval = false;
  let synchronizing = false;
  let starting = false;
  // Tracks the currently in-flight synchronize() call (whether triggered by
  // a poll tick or invoked directly) so stop() can await it instead of
  // abandoning it.
  let inFlightSynchronize: Promise<SynchronizeResult> | undefined;

  async function synchronize(): Promise<SynchronizeResult> {
    const result: SynchronizeResult = { added: 0, updated: 0, removed: 0 };

    const files = await walkDirectory(directory, extensions);
    const currentPaths = new Set<string>();

    for (const fullPath of files) {
      const relativePath = relative(directory, fullPath);
      currentPaths.add(relativePath);

      let content: string;
      try {
        content = await readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const hash = await sha256Hex(content);
      const previousHash = knownFiles.get(relativePath);

      if (previousHash === hash) continue; // Unchanged.

      // Use the relative path as the source identifier for deduplication.
      const sourceIdentifier = `file:${relativePath}`;

      // If we previously ingested this file, forget the old chunks first.
      const existingSource = sourceByPath.get(relativePath);
      if (existingSource) {
        await forgetBySource(existingSource);
      }

      const ingestResult = await ingest(memory, content, {
        ...chunking,
        sourceIdentifier,
        metadata: { ...metadata, __filePath: relativePath },
      });

      entryIdsBySource.set(
        sourceIdentifier,
        ingestResult.entries.map((entry) => entry.id),
      );

      knownFiles.set(relativePath, hash);
      sourceByPath.set(relativePath, sourceIdentifier);

      if (previousHash === undefined) {
        result.added++;
      } else {
        result.updated++;
      }
    }

    // Remove files that no longer exist on disk.
    for (const [relativePath, sourceIdentifier] of sourceByPath) {
      if (!currentPaths.has(relativePath)) {
        await forgetBySource(sourceIdentifier);
        knownFiles.delete(relativePath);
        sourceByPath.delete(relativePath);
        result.removed++;
      }
    }

    return result;
  }

  /**
   * Runs synchronize() while tracking it as the in-flight call so stop()
   * can await it. Used for every synchronize() call — the initial
   * start()-triggered pass, poll-triggered passes, and direct calls through
   * the public `synchronize()` method — so stop() drains whichever one is
   * running rather than abandoning it.
   */
  function trackedSynchronize(): Promise<SynchronizeResult> {
    const result = synchronize();
    inFlightSynchronize = result;
    const clearIfCurrent = () => {
      if (inFlightSynchronize === result) {
        inFlightSynchronize = undefined;
      }
    };
    result.then(clearIfCurrent).catch(clearIfCurrent);
    return result;
  }

  async function forgetBySource(sourceIdentifier: string): Promise<void> {
    const ids = entryIdsBySource.get(sourceIdentifier);
    if (!ids) return;

    // Entries are ingested under the configured metadata namespace; deletion is
    // scope-keyed and must target the same namespace.
    for (const id of ids) {
      await memory.forget(id, metadata?.namespace);
    }

    entryIdsBySource.delete(sourceIdentifier);
  }

  return {
    async start(): Promise<void> {
      if (hasInterval || starting) return;
      starting = true;
      try {
        await trackedSynchronize();
        // Only schedule the interval after a successful initial sync.
        // If synchronize() throws, no interval is created — preventing a
        // leaked timer that the caller cannot clean up.
        if (!hasInterval) {
          intervalId = setIntervalFunction(() => {
            if (synchronizing) return;
            synchronizing = true;
            void trackedSynchronize()
              .catch(() => {
                // Swallow errors during polling — will retry next interval.
              })
              .finally(() => {
                synchronizing = false;
              });
          }, pollingInterval);
          hasInterval = true;
        }
      } finally {
        starting = false;
      }
    },

    async stop(): Promise<void> {
      // Halt future polling immediately — no new synchronize() calls are
      // scheduled after this point.
      if (hasInterval) {
        clearIntervalFunction(intervalId);
        hasInterval = false;
      }
      // Drain (rather than abandon) whichever synchronize() call is
      // already in flight. Its own errors are the caller's concern (via
      // the promise returned from synchronize() or the polling catch
      // above) — stop() only needs to know when it has settled.
      if (inFlightSynchronize) {
        await inFlightSynchronize.catch(() => {});
      }
    },

    synchronize: trackedSynchronize,
  };
}
