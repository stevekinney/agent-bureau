import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';

import { createMemoryLifecycleMethods } from './memory-lifecycle';
import { createRecall } from './memory-recall';
import type { MemoryRecord, MemoryRecordScope } from './memory-record-storage';
import { stampSupersession } from './temporal-validity';
import type { CreateMemoryOptions, Memory, MemoryEntry, MemoryMetadata } from './types';

const DEFAULT_DEDUPLICATION_THRESHOLD = 0.95;
const DEFAULT_NAMESPACE = 'default';

function createScope(namespace: string): MemoryRecordScope {
  if (namespace.length === 0) throw new Error('namespace must be a non-empty string.');
  return { namespace };
}

function memorySource(value: unknown): MemoryMetadata['source'] {
  return value === 'manual' ||
    value === 'tool' ||
    value === 'experiential' ||
    value === 'auto-capture'
    ? value
    : 'manual';
}

function generateId(runtime: RuntimeServices): string {
  return runtime.identifiers.next('memory');
}

/**
 * Builds the public {@link MemoryMetadata} view of a stored record. The
 * authoritative `namespace` is sourced from the record itself; arbitrary
 * extension keys on the stored metadata are preserved.
 */
function toMemoryMetadata(record: MemoryRecord): MemoryMetadata {
  const raw = record.metadata;
  const metadata: MemoryMetadata = {
    ...raw,
    namespace: record.namespace,
    source: memorySource(raw['source']),
  };
  const conversationId = raw['conversationId'];
  const agentId = raw['agentId'];
  const importance = raw['importance'];
  const evergreen = raw['evergreen'];
  const tags = raw['tags'];
  if (typeof conversationId === 'string') metadata.conversationId = conversationId;
  if (typeof agentId === 'string') metadata.agentId = agentId;
  if (typeof importance === 'number') metadata.importance = importance;
  if (typeof evergreen === 'boolean') metadata.evergreen = evergreen;
  if (Array.isArray(tags) && tags.every((tag): tag is string => typeof tag === 'string')) {
    metadata.tags = tags;
  }
  return metadata;
}

/**
 * Strips the framework-managed fields from caller-supplied metadata so only
 * extension data is persisted on the record. `namespace` lives on the record's
 * own field, never in the metadata blob.
 */
function buildStoredMetadata(metadata: Partial<MemoryMetadata>): Record<string, unknown> {
  // `namespace` lives on the record's own field; `supersedes` is a write-only
  // directive consumed by remember() and never persisted.
  const { namespace: _namespace, supersedes: _supersedes, ...rest } = metadata;
  return { source: 'manual', ...rest };
}

function toMemoryEntry(record: MemoryRecord, vector?: number[]): MemoryEntry {
  return {
    id: record.id,
    content: record.content,
    vector: vector ?? Array.from(record.vector),
    metadata: toMemoryMetadata(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Creates a Memory instance backed by a {@link CreateMemoryOptions.storage}
 * {@link import('./types').MemoryRecordStorage}.
 *
 * The returned object satisfies the Memory interface and provides:
 * - remember() with automatic deduplication
 * - recall() with hybrid (vector + BM25) search, temporal decay, and MMR diversity
 * - forget(), forgetAll(), count() for lifecycle management
 */
export function createMemory(options: CreateMemoryOptions): Memory {
  const {
    embedder,
    storage,
    namespace: defaultNamespace = DEFAULT_NAMESPACE,
    defaultSearchOptions,
    deduplicationThreshold = DEFAULT_DEDUPLICATION_THRESHOLD,
    textSearchProvider,
    requireNamespace = false,
    conflictThreshold,
    onConflict,
    temporalValidity = false,
  } = options;
  const runtime = options.runtime ?? createDefaultRuntimeServices();

  if (conflictThreshold !== undefined && conflictThreshold >= deduplicationThreshold) {
    throw new Error(
      `conflictThreshold (${conflictThreshold}) must be less than deduplicationThreshold (${deduplicationThreshold}).`,
    );
  }

  const scopeFor = createScope;

  async function embed(text: string): Promise<number[]> {
    const vectors = await embedder([text]);
    return vectors[0]!;
  }

  interface DuplicateCheckResult {
    duplicate: MemoryRecord | undefined;
    conflict: { record: MemoryRecord; similarity: number } | undefined;
  }

  async function checkDuplicatesAndConflicts(
    vector: number[],
    namespace: string,
  ): Promise<DuplicateCheckResult> {
    // The lowest similarity worth retrieving is whichever floor is active:
    // conflict detection (when enabled) reaches further down than dedup.
    const threshold = conflictThreshold ?? deduplicationThreshold;
    const hits = await storage.searchByVector(vector, scopeFor(namespace), {
      limit: 1,
      threshold,
    });

    const top = hits[0];
    if (!top) return { duplicate: undefined, conflict: undefined };

    if (top.score >= deduplicationThreshold) {
      return { duplicate: top.record, conflict: undefined };
    }

    // Past the dedup check, `conflictThreshold` is necessarily set: if it were
    // undefined the search floor would equal `deduplicationThreshold`, so any
    // returned hit would have scored at or above it and been handled as a
    // duplicate above. The storage contract guarantees `top.score >= threshold`
    // (= `conflictThreshold`), so the top hit — the highest-similarity match
    // below the dedup threshold — is exactly the conflict to surface.
    return { duplicate: undefined, conflict: { record: top.record, similarity: top.score } };
  }

  function validateRememberMetadata(metadata: Partial<MemoryMetadata> | undefined): void {
    if (requireNamespace && !metadata?.namespace && defaultNamespace === DEFAULT_NAMESPACE) {
      throw new Error(
        'Namespace is required: provide a namespace in metadata or configure a default namespace.',
      );
    }
    if (metadata?.supersedes !== undefined && !temporalValidity) {
      throw new Error('metadata.supersedes requires temporalValidity to be enabled.');
    }
  }

  async function replaceExisting(
    existing: MemoryRecord,
    content: string,
    metadata: Partial<MemoryMetadata> | undefined,
    namespace: string,
    scope: MemoryRecordScope,
    vector: number[],
  ): Promise<MemoryEntry> {
    const updated = await storage.update(existing.id, scope, {
      content,
      vector: new Float32Array(vector),
      metadata: buildStoredMetadata({ source: 'manual', ...metadata }),
    });
    const record = updated ?? existing;
    if (textSearchProvider) await textSearchProvider.index(record.id, content, namespace);
    return toMemoryEntry(record, vector);
  }

  async function resolveConflict(
    conflict: NonNullable<DuplicateCheckResult['conflict']>,
    content: string,
    metadata: Partial<MemoryMetadata> | undefined,
    namespace: string,
    scope: MemoryRecordScope,
    vector: number[],
  ): Promise<MemoryEntry | undefined> {
    const existingMeta = toMemoryMetadata(conflict.record);
    const resolution = onConflict
      ? await onConflict(
          { content, metadata: metadata ?? {} },
          {
            id: conflict.record.id,
            content: conflict.record.content,
            metadata: existingMeta,
            similarity: conflict.similarity,
          },
        )
      : 'keep-both';
    if (resolution === 'replace')
      return replaceExisting(conflict.record, content, metadata, namespace, scope, vector);
    if (resolution !== 'skip') return undefined;
    return {
      id: conflict.record.id,
      content: conflict.record.content,
      vector: Array.from(conflict.record.vector),
      metadata: existingMeta,
      createdAt: conflict.record.createdAt,
      updatedAt: conflict.record.updatedAt,
    };
  }

  async function insertRecord(
    content: string,
    metadata: Partial<MemoryMetadata> | undefined,
    namespace: string,
    scope: MemoryRecordScope,
    vector: number[],
  ): Promise<MemoryEntry> {
    const id = generateId(runtime);
    const now = runtime.clock.now();
    const record: MemoryRecord = {
      id,
      namespace,
      content,
      vector: new Float32Array(vector),
      metadata: buildStoredMetadata({ source: 'manual', ...metadata }),
      createdAt: now,
      updatedAt: now,
      version: 1,
      status: 'active',
    };
    await storage.put(record);
    if (textSearchProvider) await textSearchProvider.index(id, content, namespace);
    if (temporalValidity && metadata?.supersedes !== undefined) {
      const superseded = await storage.get(metadata.supersedes, scope);
      if (!superseded)
        throw new Error(
          `Cannot supersede unknown record "${metadata.supersedes}" in namespace "${namespace}".`,
        );
      await storage.update(superseded.id, scope, {
        metadata: stampSupersession(superseded.metadata, id, now),
      });
    }
    return toMemoryEntry(record, vector);
  }

  async function rememberOnceEntry(
    content: string,
    metadata: Partial<MemoryMetadata> & { dedupeKey: string },
  ): Promise<MemoryEntry> {
    const namespace = metadata.namespace ?? defaultNamespace;
    const scope = scopeFor(namespace);
    const existing = await storage.getByDedupeKey?.(scope, metadata.dedupeKey);
    if (existing !== undefined) {
      if (textSearchProvider)
        await textSearchProvider.index(existing.id, existing.content, namespace);
      return toMemoryEntry(existing);
    }
    if (storage.putOnce === undefined)
      throw new Error('rememberOnce requires storage.putOnce support.');
    const vector = await embed(content);
    const now = runtime.clock.now();
    const record: MemoryRecord = {
      id: generateId(runtime),
      namespace,
      content,
      vector: new Float32Array(vector),
      metadata: buildStoredMetadata({ source: 'manual', ...metadata }),
      createdAt: now,
      updatedAt: now,
      version: 1,
      status: 'active',
    };
    const result = await storage.putOnce(record);
    if (textSearchProvider)
      await textSearchProvider.index(result.record.id, result.record.content, namespace);
    return toMemoryEntry(result.record, result.inserted ? vector : undefined);
  }

  const memory: Memory = {
    async remember(content: string, metadata?: Partial<MemoryMetadata>): Promise<MemoryEntry> {
      validateRememberMetadata(metadata);

      const namespace = metadata?.namespace ?? defaultNamespace;
      const scope = scopeFor(namespace);
      const vector = await embed(content);
      const { duplicate, conflict } = await checkDuplicatesAndConflicts(vector, namespace);

      // Deduplication: near-identical entries are updated in place.
      if (duplicate) {
        return replaceExisting(duplicate, content, metadata, namespace, scope, vector);
      }

      // Conflict detection: topically similar but potentially contradictory.
      if (conflict) {
        const resolved = await resolveConflict(
          conflict,
          content,
          metadata,
          namespace,
          scope,
          vector,
        );
        if (resolved) return resolved;
      }
      return insertRecord(content, metadata, namespace, scope, vector);
    },

    async rememberOnce(
      content: string,
      metadata: Partial<MemoryMetadata> & { dedupeKey: string },
    ): Promise<MemoryEntry> {
      if (typeof metadata.dedupeKey !== 'string' || metadata.dedupeKey.length === 0) {
        throw new Error('dedupeKey must be a non-empty string.');
      }

      if (requireNamespace && !metadata.namespace && defaultNamespace === DEFAULT_NAMESPACE) {
        throw new Error(
          'Namespace is required: provide a namespace in metadata or configure a default namespace.',
        );
      }

      return rememberOnceEntry(content, metadata);
    },

    recall: createRecall({
      storage,
      defaultNamespace,
      defaultSearchOptions,
      textSearchProvider,
      temporalValidity,
      runtime,
      embed,
      scopeFor,
      toMemoryMetadata,
    }),
    ...createMemoryLifecycleMethods({
      storage,
      defaultNamespace,
      textSearchProvider,
      embedder,
      scopeFor,
      toMemoryMetadata,
    }),
  };

  return memory;
}
