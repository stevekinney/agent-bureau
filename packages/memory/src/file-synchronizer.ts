import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

import {
  CompletableEventTarget,
  createDefaultRuntimeServices,
  type EventMap,
  type ObservableLike,
  type Observer,
  type RuntimeServices,
  type RuntimeTimeoutHandle,
  type Subscription,
} from 'lifecycle';

import type { ChunkingOptions } from './chunking';
import { sha256Hex } from './hash';
import { ingest } from './ingest';
import type { Memory, MemoryMetadata } from './types';

/**
 * Aliases of `RuntimeServices`'s timer seam (AB-252, AB-324/AB-326), kept
 * under their pre-existing exported names so no consumer's import breaks.
 * `setIntervalFunction`/`clearIntervalFunction` default to the resolved
 * `runtime.timers.setInterval`/`clearInterval` rather than to
 * `globalThis.setInterval`/`clearInterval` directly.
 */
export type IntervalHandle = RuntimeTimeoutHandle;
export type ScheduleInterval = RuntimeServices['timers']['setInterval'];
export type ClearScheduledInterval = RuntimeServices['timers']['clearInterval'];

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
  /**
   * Injectable interval function. Defaults to the resolved `runtime`'s
   * `timers.setInterval`; still overridable directly for a caller that wants
   * an interval seam independent of `runtime`.
   */
  setIntervalFunction?: ScheduleInterval;
  /**
   * Injectable interval cleanup function. Defaults to the resolved
   * `runtime`'s `timers.clearInterval`.
   */
  clearIntervalFunction?: ClearScheduledInterval;
  /**
   * Runtime services `setIntervalFunction`/`clearIntervalFunction` default
   * to. Defaults to the real implementation
   * (`createDefaultRuntimeServices()`). A test composes its own via
   * `createManualRuntimeServices()` from `lifecycle`.
   */
  runtime?: RuntimeServices;
}

export interface SynchronizeResult {
  added: number;
  updated: number;
  removed: number;
}

/**
 * Dispatched when a poll-triggered `synchronize()` pass settles (AB-341),
 * whether it succeeded or threw. `result` is set on success; `error` is set
 * on failure (the polling loop swallows the error — see the `start()` poll
 * callback — but still reports it here so an observer, such as a test, can
 * tell the two outcomes apart). Exactly one of `result`/`error` is set.
 * This is the event-driven completion signal the coordinator ruling on
 * AB-341 calls for, replacing a bounded yield-count wait: a listener sees
 * this only after the synchronizing lock has already been released, so
 * scheduling another poll tick immediately after observing it is safe.
 */
export class PollCycleCompletedEvent extends Event {
  static readonly type = 'poll-cycle.completed' as const;
  readonly result?: SynchronizeResult;
  readonly error?: unknown;
  constructor(data: { result: SynchronizeResult } | { error: unknown }) {
    super(PollCycleCompletedEvent.type);
    if ('result' in data) {
      this.result = data.result;
    } else {
      this.error = data.error;
    }
  }
}

export interface FileSynchronizerEventMap extends EventMap {
  [PollCycleCompletedEvent.type]: PollCycleCompletedEvent;
}

export type FileSynchronizerEventType = keyof FileSynchronizerEventMap;

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
  addEventListener<K extends FileSynchronizerEventType>(
    type: K,
    listener: (event: FileSynchronizerEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends FileSynchronizerEventType>(
    type: K,
    listener: (event: FileSynchronizerEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  /** One-shot listener for a poll-cycle completion event. */
  once<K extends FileSynchronizerEventType>(
    type: K,
    listener: (event: FileSynchronizerEventMap[K]) => void,
  ): void;
  on<K extends FileSynchronizerEventType>(type: K): ObservableLike<FileSynchronizerEventMap[K]>;
  subscribe<K extends FileSynchronizerEventType>(
    type: K,
    observerOrNext?:
      Observer<FileSynchronizerEventMap[K]> | ((value: FileSynchronizerEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription;
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
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const {
    memory,
    directory,
    extensions = ['.md'],
    chunking,
    metadata,
    pollingInterval = 5000,
    setIntervalFunction = runtime.timers.setInterval,
    clearIntervalFunction = runtime.timers.clearInterval,
  } = options;

  // Tracks known files: relative path → content hash.
  const knownFiles = new Map<string, string>();
  // Tracks which source identifiers belong to which file.
  const sourceByPath = new Map<string, string>();
  // Tracks the memory entry IDs for each source identifier so we can
  // delete them directly without relying on recall() (which applies
  // semantic search and source-document deduplication).
  const entryIdsBySource = new Map<string, string[]>();

  const events = new CompletableEventTarget<FileSynchronizerEventMap>();

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
            // The lock is released and the completion event dispatched from
            // the same synchronous continuation (async/await, rather than a
            // separate `.catch().finally()` chain) so a listener never
            // observes the event before `synchronizing` has already been
            // reset — a listener that immediately schedules another poll
            // tick on hearing this event is safe (AB-341).
            void (async () => {
              try {
                const result = await trackedSynchronize();
                synchronizing = false;
                events.dispatch(new PollCycleCompletedEvent({ result }));
              } catch (error) {
                // Swallow errors during polling — will retry next interval.
                synchronizing = false;
                events.dispatch(new PollCycleCompletedEvent({ error }));
              }
            })();
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

    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    // `CompletableEventTarget`'s generic methods bind to a callable whose
    // `K` is constrained to `string`, one step looser than
    // `FileSynchronizerEventType` (`keyof FileSynchronizerEventMap`, a
    // single-member string-literal union here) — the two are equivalent in
    // practice since `FileSynchronizerEventMap` has no non-string keys, but
    // TypeScript does not narrow a bound generic method's parameter that
    // way, so the assignment needs an explicit cast (same pattern as
    // `Scratchpad`'s `on`/`once`/`subscribe` in operative).
    once: events.once.bind(events) as FileSynchronizer['once'],
    on: events.on.bind(events) as FileSynchronizer['on'],
    subscribe: events.subscribe.bind(events) as FileSynchronizer['subscribe'],
  };
}
