import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

import type { ChunkingOptions } from './chunking';
import { ingest, SOURCE_DOCUMENT_KEY } from './ingest';
import type { Memory, MemoryMetadata } from './types';

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
}

export interface SynchronizeResult {
  added: number;
  updated: number;
  removed: number;
}

export interface FileSynchronizer {
  /** Start watching for changes on a polling interval. */
  start(): Promise<void>;
  /** Stop watching. */
  stop(): void;
  /** Synchronize all files once (no watching). */
  synchronize(): Promise<SynchronizeResult>;
}

async function sha256Hex(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
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
  } = options;

  // Tracks known files: relative path → content hash.
  const knownFiles = new Map<string, string>();
  // Tracks which source identifiers belong to which file.
  const sourceByPath = new Map<string, string>();

  let intervalId: ReturnType<typeof setInterval> | null = null;

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

      await ingest(memory, content, {
        ...chunking,
        sourceIdentifier,
        metadata: { ...metadata, __filePath: relativePath },
      });

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

  async function forgetBySource(sourceIdentifier: string): Promise<void> {
    // Recall all entries with this source document to get their IDs.
    // Use a high limit to get all chunks.
    const results = await memory.recall(sourceIdentifier, { limit: 1000 });
    for (const result of results) {
      if (result.metadata[SOURCE_DOCUMENT_KEY] === sourceIdentifier) {
        await memory.forget(result.id);
      }
    }
  }

  return {
    async start(): Promise<void> {
      if (intervalId) return;
      await synchronize();
      intervalId = setInterval(() => {
        synchronize().catch(() => {
          // Swallow errors during polling — will retry next interval.
        });
      }, pollingInterval);
    },

    stop(): void {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },

    synchronize,
  };
}
