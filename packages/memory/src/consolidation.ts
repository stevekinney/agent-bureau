import type { Memory, MemoryMetadata, MemorySearchResult } from './types';

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

      // Fetch a batch of entries. We request more than chunkSize to account
      // for entries we've already processed, then filter down to unprocessed ones.
      const fetchLimit = alreadyProcessed.size + chunkSize;
      const allResults = await memory.recall('*', {
        limit: fetchLimit,
        threshold: 0.0,
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

      // ── Stage 1: Distill ────────────────────────────────────────
      const mergedIds = new Set<string>();

      for (let i = 0; i < entriesToProcess.length && !signal.aborted; i++) {
        for (let j = i + 1; j < entriesToProcess.length && !signal.aborted; j++) {
          const entryA = entriesToProcess[i]!;
          const entryB = entriesToProcess[j]!;

          if (mergedIds.has(entryA.id) || mergedIds.has(entryB.id)) continue;

          // Check pairwise similarity
          const similarity = await computeSimilarity(
            memory,
            entryA.content,
            entryB.content,
            entryCount,
          );

          if (similarity >= mergeThreshold && similarity < deduplicationThreshold) {
            const mergedContent = await merge(entryA.content, entryB.content);

            // Determine confidence boosting for experiential entries
            const metadata: Partial<MemoryMetadata> = {
              ...(namespace && { namespace }),
            };

            if (boostConfidenceOnMerge && isExperiential(entryA) && isExperiential(entryB)) {
              const confA = getConfidence(entryA);
              const confB = getConfidence(entryB);
              metadata['confidence'] = Math.min(1.0, Math.max(confA, confB) + 0.1);
            }

            await memory.remember(mergedContent, metadata);
            await memory.forget(entryA.id);
            await memory.forget(entryB.id);

            mergedIds.add(entryA.id);
            mergedIds.add(entryB.id);
            distilled++;
          }
        }
      }

      // ── Stage 2: Deduplicate ────────────────────────────────────
      const deduplicatedIds = new Set<string>();

      for (let i = 0; i < entriesToProcess.length && !signal.aborted; i++) {
        for (let j = i + 1; j < entriesToProcess.length && !signal.aborted; j++) {
          const entryA = entriesToProcess[i]!;
          const entryB = entriesToProcess[j]!;

          if (
            mergedIds.has(entryA.id) ||
            mergedIds.has(entryB.id) ||
            deduplicatedIds.has(entryA.id) ||
            deduplicatedIds.has(entryB.id)
          ) {
            continue;
          }

          const similarity = await computeSimilarity(
            memory,
            entryA.content,
            entryB.content,
            entryCount,
          );

          if (similarity >= deduplicationThreshold) {
            // Keep the most recent, remove the older one
            const older = entryA.createdAt <= entryB.createdAt ? entryA : entryB;
            await memory.forget(older.id);
            deduplicatedIds.add(older.id);
            deduplicated++;
          }
        }
      }

      // ── Stage 3: Update ─────────────────────────────────────────
      const resolvedIds = new Set<string>();

      if (resolveConflict) {
        const [conflictMin, conflictMax] = conflictRange;

        for (let i = 0; i < entriesToProcess.length && !signal.aborted; i++) {
          for (let j = i + 1; j < entriesToProcess.length && !signal.aborted; j++) {
            const entryA = entriesToProcess[i]!;
            const entryB = entriesToProcess[j]!;

            if (
              mergedIds.has(entryA.id) ||
              mergedIds.has(entryB.id) ||
              deduplicatedIds.has(entryA.id) ||
              deduplicatedIds.has(entryB.id) ||
              resolvedIds.has(entryA.id) ||
              resolvedIds.has(entryB.id)
            ) {
              continue;
            }

            const similarity = await computeSimilarity(
              memory,
              entryA.content,
              entryB.content,
              entryCount,
            );

            if (similarity >= conflictMin && similarity < conflictMax) {
              const reconciled = await resolveConflict(entryA.content, entryB.content);

              if (reconciled !== null) {
                await memory.remember(reconciled, { ...(namespace && { namespace }) });
                await memory.forget(entryA.id);
                await memory.forget(entryB.id);
                resolvedIds.add(entryA.id);
                resolvedIds.add(entryB.id);
                conflictsResolved++;
              }
            }
          }
        }
      }

      // ── Stage 4: Filter ─────────────────────────────────────────
      if (evaluateImportance) {
        for (const entry of entriesToProcess) {
          if (signal.aborted) break;
          if (
            mergedIds.has(entry.id) ||
            deduplicatedIds.has(entry.id) ||
            resolvedIds.has(entry.id)
          ) {
            continue;
          }

          const importance = await evaluateImportance(entry.content, entry.metadata);
          const confidence = getConfidence(entry);
          const isExp = isExperiential(entry);

          // Experiential entries with low confidence are pruned more aggressively
          const effectiveThreshold =
            isExp && confidence < 0.5 ? pruneThreshold * 1.5 : pruneThreshold;

          if (importance < effectiveThreshold) {
            await memory.forget(entry.id);
            pruned++;
          }
        }
      }

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

// ── Helpers ───────────────────────────────────────────────────────

function isExperiential(entry: MemorySearchResult): boolean {
  return entry.metadata.source === 'experiential';
}

function getConfidence(entry: MemorySearchResult): number {
  const conf = entry.metadata['confidence'];
  return typeof conf === 'number' ? conf : 0.5;
}

/**
 * Compute similarity between two content strings by recalling one
 * and checking the score of the other in the results.
 *
 * @param entryCount - Total number of entries in memory, used as the recall
 *   limit to ensure the target entry is always found regardless of memory size.
 */
async function computeSimilarity(
  memory: Memory,
  contentA: string,
  contentB: string,
  entryCount: number,
): Promise<number> {
  const results = await memory.recall(contentA, { limit: entryCount, threshold: 0.0 });
  const match = results.find((r) => r.content === contentB);
  return match?.score ?? 0;
}
