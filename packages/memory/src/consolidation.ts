import {
  deduplicateEntries,
  distillEntries,
  pruneEntries,
  resolveConflicts,
} from './consolidation-stages';
import type { Memory, MemoryMetadata } from './types';

/**
 * Options for creating a memory consolidation task.
 */
export interface CreateConsolidationOptions {
  /** The memory instance to consolidate. */
  memory: Memory;
  /** Namespace to consolidate. If not set, consolidates the default namespace. */
  namespace?: string;
  /** Number of entries to process per chunk. Default: 20. */
  chunkSize?: number;

  // ── Stage 1: Distill ──────────────────────────────────────────
  /** Similarity threshold for identifying entries worth merging. Default: 0.75. */
  mergeThreshold?: number;
  /** Function that merges two related entries into one. Consumer provides the LLM call. */
  merge: (entryA: string, entryB: string) => Promise<string>;

  // ── Stage 2: Deduplicate ──────────────────────────────────────
  /** Similarity threshold for near-duplicate removal. Default: 0.95. */
  deduplicationThreshold?: number;

  // ── Stage 3: Update ───────────────────────────────────────────
  /** Function that resolves conflicts between entries.
   *  Returns the reconciled content, or null to keep both.
   *  Optional — if not provided, conflicts are left as-is. */
  resolveConflict?: (entryA: string, entryB: string) => Promise<string | null>;
  /** Similarity range for conflict detection. Default: [0.6, 0.9]. */
  conflictRange?: [number, number];

  // ── Stage 4: Filter ───────────────────────────────────────────
  /** Function that evaluates whether an entry is still valuable.
   *  Returns a score from 0 (worthless) to 1 (essential).
   *  Optional — if not provided, no filtering occurs. */
  evaluateImportance?: (entry: string, metadata: MemoryMetadata) => Promise<number>;
  /** Importance score below which entries are candidates for pruning. Default: 0.2. */
  pruneThreshold?: number;

  // ── Experiential ──────────────────────────────────────────────
  /** When consolidation finds multiple experiential entries with the same insight,
   *  boost the confidence score of the surviving entry. Default: true. */
  boostConfidenceOnMerge?: boolean;
}

/**
 * State tracked across consolidation chunks. processedIds is the checkpoint
 * boundary — if a chunk is preempted mid-stage, the entire chunk reruns
 * from stage 1 (safe because each stage is idempotent).
 */
export interface ConsolidationState {
  /** IDs of entries already processed or removed in prior chunks. */
  processedIds: string[];
  /** Number of entries distilled (merged) across all chunks. */
  distilled: number;
  /** Number of near-duplicate entries removed across all chunks. */
  deduplicated: number;
  /** Number of conflicts resolved across all chunks. */
  conflictsResolved: number;
  /** Number of entries pruned by the filter stage across all chunks. */
  pruned: number;
  /** Total number of entries scanned. */
  scanned: number;
}

/**
 * Structurally compatible with operative's CreateChunkedTaskOptions<ConsolidationState>.
 * The consumer wires this into createChunkedTask without memory importing from operative.
 */
export interface ConsolidationChunkedTaskOptions {
  name: string;
  priority: 'background';
  initialState: ConsolidationState;
  processChunk: (
    state: ConsolidationState,
    signal: AbortSignal,
  ) => Promise<{ state: ConsolidationState; done: boolean }>;
  onComplete?: (finalState: ConsolidationState) => void | Promise<void>;
  onError?: (error: unknown, state: ConsolidationState) => void | Promise<void>;
}

/**
 * Creates a consolidation task that runs memory maintenance as background work.
 * Returns options structurally compatible with operative's createChunkedTask.
 *
 * The four stages per chunk are:
 * 1. **Distill:** Merge similar entries above mergeThreshold
 * 2. **Deduplicate:** Remove near-duplicate entries above deduplicationThreshold
 * 3. **Update:** Resolve conflicts in the conflictRange
 * 4. **Filter:** Prune low-importance entries below pruneThreshold
 */
export function createConsolidationTask(
  options: CreateConsolidationOptions,
): ConsolidationChunkedTaskOptions {
  const {
    memory,
    namespace,
    chunkSize = 20,
    mergeThreshold = 0.75,
    merge,
    deduplicationThreshold = 0.95,
    resolveConflict,
    conflictRange = [0.6, 0.9],
    evaluateImportance,
    pruneThreshold = 0.2,
    boostConfidenceOnMerge = true,
  } = options;

  return {
    name: 'memory-consolidation',
    priority: 'background',
    initialState: {
      processedIds: [],
      distilled: 0,
      deduplicated: 0,
      conflictsResolved: 0,
      pruned: 0,
      scanned: 0,
    },

    async processChunk(
      state: ConsolidationState,
      signal: AbortSignal,
    ): Promise<{ state: ConsolidationState; done: boolean }> {
      const alreadyProcessed = new Set(state.processedIds);

      // List entries without semantic search — avoids the recall('*') problem
      // where '*' is treated as a literal query string rather than a wildcard.
      const fetchLimit = alreadyProcessed.size + chunkSize;
      const allResults = await memory.list({
        limit: fetchLimit,
        ...(namespace && { namespace }),
      });

      // Filter to only entries we haven't processed yet
      const chunkEntries = allResults.filter((entry) => !alreadyProcessed.has(entry.id));

      // Take at most chunkSize entries
      const entriesToProcess = chunkEntries.slice(0, chunkSize);

      if (entriesToProcess.length === 0) {
        // No more unprocessed entries — consolidation is complete
        return { state, done: true };
      }

      if (signal.aborted) {
        return { state, done: false };
      }

      // Get total entry count once per chunk for similarity queries.
      // This ensures computeSimilarity always searches the full memory.
      const entryCount = await memory.count(namespace);

      let { distilled, deduplicated, conflictsResolved, pruned, scanned } = state;

      const mergedIds = await distillEntries(
        entriesToProcess,
        memory,
        signal,
        entryCount,
        namespace,
        mergeThreshold,
        deduplicationThreshold,
        merge,
        boostConfidenceOnMerge,
      );
      distilled += mergedIds.count;

      // ── Stage 2: Deduplicate ────────────────────────────────────
      const deduplicatedIds = await deduplicateEntries(
        entriesToProcess,
        memory,
        signal,
        entryCount,
        namespace,
        deduplicationThreshold,
        mergedIds.ids,
      );
      deduplicated += deduplicatedIds.count;

      // ── Stage 3: Update ─────────────────────────────────────────
      const resolvedIds = await resolveConflicts(
        entriesToProcess,
        memory,
        signal,
        entryCount,
        namespace,
        conflictRange,
        resolveConflict,
        mergedIds.ids,
        deduplicatedIds.ids,
      );
      conflictsResolved += resolvedIds.count;

      // ── Stage 4: Filter ─────────────────────────────────────────
      pruned += await pruneEntries(
        entriesToProcess,
        memory,
        signal,
        namespace,
        evaluateImportance,
        pruneThreshold,
        mergedIds.ids,
        deduplicatedIds.ids,
        resolvedIds.ids,
      );

      // If aborted mid-stage, preserve the updated stats counters (because
      // memory mutations like forget/remember are already committed) but do
      // NOT add entries to processedIds — the chunk will rerun from stage 1
      // on the next attempt (each stage is idempotent, so this is safe).
      if (signal.aborted) {
        return {
          state: {
            processedIds: state.processedIds,
            distilled,
            deduplicated,
            conflictsResolved,
            pruned,
            scanned: state.scanned,
          },
          done: false,
        };
      }

      const newProcessedIds = [...state.processedIds, ...entriesToProcess.map((entry) => entry.id)];

      scanned += entriesToProcess.length;

      const nextState: ConsolidationState = {
        processedIds: newProcessedIds,
        distilled,
        deduplicated,
        conflictsResolved,
        pruned,
        scanned,
      };

      // Done when this chunk returned fewer entries than chunkSize
      const done = entriesToProcess.length < chunkSize;

      return { state: nextState, done };
    },
  };
}
