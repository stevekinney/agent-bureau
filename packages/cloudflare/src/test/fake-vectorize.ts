import { cosineSimilarity } from 'interoperability';

import type {
  VectorizeIndex,
  VectorizeMatch,
  VectorizeMetadataValue,
  VectorizeQueryOptions,
  VectorizeQueryResult,
  VectorizeUpsertVector,
} from '../vectorize';

/**
 * A poison hit the {@link FakeVectorize} can be told to splice into a query
 * result so rehydration can be PROVEN to drop it. Each shape models a way a real
 * secondary index can lag or diverge from the canonical SQLite store:
 *
 * - cross-tenant / wrong-namespace: the index returned an id whose metadata
 *   filter "passed" but whose canonical row belongs to a different scope;
 * - stale-version: the index holds an old vector whose advertised version no
 *   longer matches the canonical row;
 * - deleted: the index still holds an id whose canonical row was tombstoned;
 * - absent: the index holds an id with no canonical row at all.
 *
 * `metadata` is whatever the adversary wants the backend to read back; the
 * backend must NOT trust it.
 */
export interface PoisonHit {
  id: string;
  score: number;
  metadata?: Record<string, VectorizeMetadataValue>;
}

/**
 * A recorded {@link VectorizeIndex.query} invocation, captured so tests can
 * assert the backend sent a server-owned tenant + namespace filter.
 */
export interface RecordedQuery {
  vector: number[];
  options: VectorizeQueryOptions;
}

/**
 * The recording, adversarial fake {@link VectorizeIndex}.
 *
 * By default `query()` scores stored vectors with the SAME `cosineSimilarity`
 * the local backends use (so the deterministic exact-search fixture — including
 * the zero-vector edge case — matches), filters by the query's metadata filter,
 * returns ALL candidates up to `topK` in descending score (NO threshold; the
 * backend applies that after rehydration), and echoes each vector's upserted
 * metadata back when `returnMetadata` is set.
 *
 * It also records every `upsert`/`query`/`deleteByIds` call AND can be told to
 * splice {@link PoisonHit}s into the NEXT query result — cross-tenant,
 * wrong-namespace, stale-version, deleted, or absent ids — so rehydration is
 * proven to drop every one.
 */
export interface FakeVectorize extends VectorizeIndex {
  /** Every upsert call's vectors, in order. */
  readonly upsertCalls: VectorizeUpsertVector[][];
  /** Every query call's vector + options, in order. */
  readonly queryCalls: RecordedQuery[];
  /** Every deleteByIds call's id list, in order. */
  readonly deleteCalls: string[][];
  /**
   * A flat, ordered log of mutating call kinds, so tests can assert ordering
   * (e.g. the SQLite tombstone is written before the Vectorize delete by
   * interleaving this with the SQL double — here it records this index's own
   * upsert/delete order).
   */
  readonly callLog: ReadonlyArray<'upsert' | 'query' | 'delete'>;
  /**
   * Splice these poison hits into the FRONT of the NEXT `query()` result, before
   * the genuine scored candidates. Cleared after that one query.
   */
  injectPoison(hits: PoisonHit[]): void;
}

/** A vector currently stored in the fake index. */
interface StoredVector {
  values: number[];
  metadata: Record<string, VectorizeMetadataValue>;
}

/**
 * Read a string metadata field, or `undefined` if absent / not a string. Used so
 * the fake's own metadata filter never throws on a non-string value.
 */
function metadataString(
  metadata: Record<string, VectorizeMetadataValue>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Creates a recording, adversarial {@link FakeVectorize}.
 */
export function createFakeVectorize(): FakeVectorize {
  const vectors = new Map<string, StoredVector>();
  const upsertCalls: VectorizeUpsertVector[][] = [];
  const queryCalls: RecordedQuery[] = [];
  const deleteCalls: string[][] = [];
  const callLog: Array<'upsert' | 'query' | 'delete'> = [];
  let pendingPoison: PoisonHit[] = [];

  return {
    upsertCalls,
    queryCalls,
    deleteCalls,
    callLog,

    injectPoison(hits: PoisonHit[]): void {
      pendingPoison = [...pendingPoison, ...hits];
    },

    upsert(toUpsert: VectorizeUpsertVector[]): Promise<void> {
      upsertCalls.push(toUpsert.map((vector) => ({ ...vector })));
      callLog.push('upsert');
      for (const vector of toUpsert) {
        vectors.set(vector.id, {
          values: [...vector.values],
          metadata: { ...vector.metadata },
        });
      }
      return Promise.resolve();
    },

    query(vector: number[], options: VectorizeQueryOptions): Promise<VectorizeQueryResult> {
      queryCalls.push({
        vector: [...vector],
        options: { ...options, filter: { ...options.filter } },
      });
      callLog.push('query');

      const filterTenant = metadataString(options.filter, 'tenant_id');
      const filterNamespace = metadataString(options.filter, 'namespace');

      // Genuine candidates: every stored vector whose metadata matches the
      // server-owned filter, scored by the same cosineSimilarity the local
      // backends use, descending. NO threshold here — the backend applies that.
      const genuine: VectorizeMatch[] = [];
      for (const [id, stored] of vectors) {
        if (
          filterTenant !== undefined &&
          metadataString(stored.metadata, 'tenant_id') !== filterTenant
        ) {
          continue;
        }
        if (
          filterNamespace !== undefined &&
          metadataString(stored.metadata, 'namespace') !== filterNamespace
        ) {
          continue;
        }
        genuine.push({
          id,
          score: cosineSimilarity(vector, stored.values),
          ...(options.returnMetadata ? { metadata: { ...stored.metadata } } : {}),
        });
      }
      genuine.sort((a, b) => b.score - a.score);

      // Adversarial poison goes in FRONT so it would surface first if the
      // backend trusted the index — proving rehydration is what drops it.
      const poison: VectorizeMatch[] = pendingPoison.map((hit) => ({
        id: hit.id,
        score: hit.score,
        ...(options.returnMetadata && hit.metadata !== undefined
          ? { metadata: { ...hit.metadata } }
          : {}),
      }));
      pendingPoison = [];

      const matches = [...poison, ...genuine].slice(0, options.topK);
      return Promise.resolve({ matches });
    },

    deleteByIds(ids: string[]): Promise<void> {
      deleteCalls.push([...ids]);
      callLog.push('delete');
      for (const id of ids) vectors.delete(id);
      return Promise.resolve();
    },
  };
}
