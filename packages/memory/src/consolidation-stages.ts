import type { Memory, MemoryMetadata, MemorySearchResult } from './types';

// ── Helpers ───────────────────────────────────────────────────────

function isExperiential(entry: MemorySearchResult): boolean {
  return entry.metadata.source === 'experiential';
}

function getConfidence(entry: MemorySearchResult): number {
  const conf = entry.metadata['confidence'];
  return typeof conf === 'number' ? conf : 0.5;
}

function pairIsUnavailable(
  entryA: MemorySearchResult,
  entryB: MemorySearchResult,
  ...sets: Set<string>[]
): boolean {
  return sets.some((set) => set.has(entryA.id) || set.has(entryB.id));
}

function mergeMetadata(
  entryA: MemorySearchResult,
  entryB: MemorySearchResult,
  namespace: string | undefined,
  boostConfidence: boolean,
): Partial<MemoryMetadata> {
  const metadata: Partial<MemoryMetadata> = { ...(namespace && { namespace }) };
  if (boostConfidence && isExperiential(entryA) && isExperiential(entryB)) {
    metadata['confidence'] = Math.min(
      1,
      Math.max(getConfidence(entryA), getConfidence(entryB)) + 0.1,
    );
  }
  return metadata;
}

function isOutsideConflictRange(similarity: number, range: [number, number]): boolean {
  return similarity < range[0] || similarity >= range[1];
}

type IdentifierResult = { ids: Set<string>; count: number };

export async function distillEntries(
  entries: MemorySearchResult[],
  memory: Memory,
  signal: AbortSignal,
  entryCount: number,
  namespace: string | undefined,
  mergeThreshold: number,
  deduplicationThreshold: number,
  merge: (entryA: string, entryB: string) => Promise<string>,
  boostConfidenceOnMerge: boolean,
): Promise<IdentifierResult> {
  const ids = new Set<string>();
  let count = 0;
  for (let i = 0; i < entries.length && !signal.aborted; i++) {
    for (let j = i + 1; j < entries.length && !signal.aborted; j++) {
      const entryA = entries[i]!;
      const entryB = entries[j]!;
      if (pairIsUnavailable(entryA, entryB, ids)) continue;
      const similarity = await computeSimilarity(
        memory,
        entryA.content,
        entryB.content,
        entryCount,
        namespace,
      );
      if (similarity < mergeThreshold || similarity >= deduplicationThreshold) continue;
      const metadata = mergeMetadata(entryA, entryB, namespace, boostConfidenceOnMerge);
      await memory.remember(await merge(entryA.content, entryB.content), metadata);
      await memory.forget(entryA.id, namespace);
      await memory.forget(entryB.id, namespace);
      ids.add(entryA.id);
      ids.add(entryB.id);
      count++;
    }
  }
  return { ids, count };
}

export async function deduplicateEntries(
  entries: MemorySearchResult[],
  memory: Memory,
  signal: AbortSignal,
  entryCount: number,
  namespace: string | undefined,
  threshold: number,
  mergedIds: Set<string>,
): Promise<IdentifierResult> {
  const ids = new Set<string>();
  let count = 0;
  for (let i = 0; i < entries.length && !signal.aborted; i++) {
    for (let j = i + 1; j < entries.length && !signal.aborted; j++) {
      const entryA = entries[i]!;
      const entryB = entries[j]!;
      if (pairIsUnavailable(entryA, entryB, mergedIds, ids)) continue;
      const similarity = await computeSimilarity(
        memory,
        entryA.content,
        entryB.content,
        entryCount,
        namespace,
      );
      if (similarity < threshold) continue;
      const older = entryA.createdAt <= entryB.createdAt ? entryA : entryB;
      await memory.forget(older.id, namespace);
      ids.add(older.id);
      count++;
    }
  }
  return { ids, count };
}

export async function resolveConflicts(
  entries: MemorySearchResult[],
  memory: Memory,
  signal: AbortSignal,
  entryCount: number,
  namespace: string | undefined,
  range: [number, number],
  resolveConflict: ((entryA: string, entryB: string) => Promise<string | null>) | undefined,
  mergedIds: Set<string>,
  deduplicatedIds: Set<string>,
): Promise<IdentifierResult> {
  const ids = new Set<string>();
  if (!resolveConflict) return { ids, count: 0 };
  let count = 0;
  for (let i = 0; i < entries.length && !signal.aborted; i++) {
    for (let j = i + 1; j < entries.length && !signal.aborted; j++) {
      const entryA = entries[i]!;
      const entryB = entries[j]!;
      if (pairIsUnavailable(entryA, entryB, mergedIds, deduplicatedIds, ids)) continue;
      const similarity = await computeSimilarity(
        memory,
        entryA.content,
        entryB.content,
        entryCount,
        namespace,
      );
      if (isOutsideConflictRange(similarity, range)) continue;
      const reconciled = await resolveConflict(entryA.content, entryB.content);
      if (reconciled === null) continue;
      await memory.remember(reconciled, { ...(namespace && { namespace }) });
      await memory.forget(entryA.id, namespace);
      await memory.forget(entryB.id, namespace);
      ids.add(entryA.id);
      ids.add(entryB.id);
      count++;
    }
  }
  return { ids, count };
}

export async function pruneEntries(
  entries: MemorySearchResult[],
  memory: Memory,
  signal: AbortSignal,
  namespace: string | undefined,
  evaluateImportance: ((entry: string, metadata: MemoryMetadata) => Promise<number>) | undefined,
  threshold: number,
  mergedIds: Set<string>,
  deduplicatedIds: Set<string>,
  resolvedIds: Set<string>,
): Promise<number> {
  if (!evaluateImportance) return 0;
  let count = 0;
  for (const entry of entries) {
    if (signal.aborted) break;
    if (mergedIds.has(entry.id) || deduplicatedIds.has(entry.id) || resolvedIds.has(entry.id))
      continue;
    const importance = await evaluateImportance(entry.content, entry.metadata);
    const effectiveThreshold =
      isExperiential(entry) && getConfidence(entry) < 0.5 ? threshold * 1.5 : threshold;
    if (importance < effectiveThreshold) {
      await memory.forget(entry.id, namespace);
      count++;
    }
  }
  return count;
}

/**
 * Compute pure cosine similarity between two content strings.
 *
 * Uses `vectorOnly: true` to get cosine similarity scores without BM25 blending,
 * ensuring thresholds (e.g., deduplicationThreshold: 0.95) behave as expected.
 *
 * @param entryCount - Total number of entries in memory, used as the recall
 *   limit to ensure the target entry is always found regardless of memory size.
 * @param namespace - Namespace to search within, matching the consolidation scope.
 */
async function computeSimilarity(
  memory: Memory,
  contentA: string,
  contentB: string,
  entryCount: number,
  namespace?: string,
): Promise<number> {
  const results = await memory.recall(contentA, {
    limit: entryCount,
    threshold: 0.0,
    vectorOnly: true,
    ...(namespace && { namespace }),
  });
  const match = results.find((r) => r.content === contentB);
  return match?.score ?? 0;
}
