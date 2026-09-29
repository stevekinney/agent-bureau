import {
  encodeStorageKeyComponent,
  formatSortableStorageTimestamp,
  type Storage,
  storageConditionalBatch,
  storageDeletePrefix,
} from '@lostgradient/weft';
import { z } from 'zod';

import { validateMemoryKeyPrefix } from '../create-weft-memory-record-storage-helpers';
import type { MemoryRecordScope } from '../memory-record-storage';
import {
  MEMORY_DELETION_TARGETS,
  type MemoryDeletionReceipt,
  type MemoryExportManifest,
  type MemoryGovernanceEvent,
  type MemoryLineageLink,
  type MemoryPendingDerivation,
} from './ledger-types';
import { MEMORY_CLASSES } from './policy';
import {
  DERIVED_RECORD_KINDS,
  type MemoryAttribution,
  memoryAttributionSchema,
  type MemoryRecordSourceReference,
  memorySourceReferenceSchema,
} from './record-governance';

/**
 * Default key prefix for governance ledger entries. Disjoint from every Weft
 * reserved prefix and from the memory record prefix, so the ledger can share one
 * {@link Storage} with a Weft engine and with governed memory records.
 */
export const DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX = 'app:agent-bureau:memory-governance:v1:';

/**
 * The durable governance record: events, deletion receipts, export manifests,
 * source-to-derived lineage, derivations not yet confirmed against their
 * sources, the scopes governed memory has written to, and active-context
 * evictions. It is the authoritative history of revocation,
 * deletion, retention, and projection invalidation, and it survives a process
 * restart because it lives in the same durable {@link Storage} as the records.
 */
export interface MemoryGovernanceLedger {
  appendEvent(event: MemoryGovernanceEvent): Promise<void>;
  listEvents(filter: {
    tenantId: string;
    type?: string;
    recordId?: string;
  }): Promise<MemoryGovernanceEvent[]>;
  /** Removes events older than `before`; returns how many were removed. */
  pruneEvents(tenantId: string, before: number): Promise<number>;
  putReceipt(receipt: MemoryDeletionReceipt): Promise<void>;
  getReceipt(deletionId: string): Promise<MemoryDeletionReceipt | undefined>;
  listReceipts(filter: { tenantId?: string; open?: boolean }): Promise<MemoryDeletionReceipt[]>;
  deleteReceipt(deletionId: string): Promise<void>;
  /**
   * Stores a new export manifest. An existing manifest changes only through
   * {@link MemoryGovernanceLedger.revokeExport} and
   * {@link MemoryGovernanceLedger.scrubExport}, which merge onto what is stored.
   */
  putExport(manifest: MemoryExportManifest): Promise<void>;
  getExport(tenantId: string, exportId: string): Promise<MemoryExportManifest | undefined>;
  /**
   * Marks an export revoked, merged onto the manifest as it is stored now, so
   * a scrub landing alongside keeps its removals. Returns the manifest this
   * call revoked, or `undefined` when the export is missing or already revoked.
   */
  revokeExport(
    tenantId: string,
    exportId: string,
    revocation: { readonly revokedAt: number; readonly revokedBy: MemoryAttribution },
  ): Promise<MemoryExportManifest | undefined>;
  /**
   * Moves deleted records from an export's `recordIds` to its
   * `removedRecordIds`, merged onto the manifest as it is stored now. It never
   * touches the revocation, so a revocation landing alongside survives it.
   */
  scrubExport(tenantId: string, exportId: string, recordIds: readonly string[]): Promise<void>;
  listExports(filter: { tenantId: string; recordId?: string }): Promise<MemoryExportManifest[]>;
  putLineage(link: MemoryLineageLink): Promise<void>;
  listLineage(tenantId: string, source: MemoryRecordSourceReference): Promise<MemoryLineageLink[]>;
  deleteLineage(tenantId: string, source: MemoryRecordSourceReference): Promise<void>;
  putPendingDerivation(entry: MemoryPendingDerivation): Promise<void>;
  listPendingDerivations(filter: { tenantId?: string }): Promise<MemoryPendingDerivation[]>;
  deletePendingDerivation(tenantId: string, record: MemoryRecordSourceReference): Promise<void>;
  registerScope(scope: Required<MemoryRecordScope>): Promise<void>;
  listScopes(tenantId: string): Promise<Required<MemoryRecordScope>[]>;
  putEviction(tenantId: string, contextId: string, recordId: string): Promise<void>;
  listEvictions(tenantId: string, contextId: string): Promise<string[]>;
}

export interface CreateMemoryGovernanceLedgerOptions {
  /** Defaults to {@link DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX}. */
  keyPrefix?: string;
}

const nonEmpty = z.string().min(1);
const detailValue = z.union([z.string(), z.number(), z.boolean()]);

const eventSchema = z.object({
  id: nonEmpty,
  at: z.number(),
  tenantId: nonEmpty,
  type: nonEmpty,
  outcome: nonEmpty,
  attribution: memoryAttributionSchema.optional(),
  recordIds: z.array(z.string()),
  details: z.record(z.string(), detailValue).optional(),
  reason: z.string().optional(),
  diagnostic: z
    .object({
      detector: z.string(),
      category: z.string(),
      confidence: z.number(),
      contentDigest: z.string(),
    })
    .optional(),
});

const receiptSchema = z.object({
  version: z.literal(1),
  deletionId: nonEmpty,
  tenantId: nonEmpty,
  scope: z.enum(['source', 'projection']),
  trigger: z.enum(['request', 'retention-expiry', 'hold-release']),
  record: z.object({
    id: nonEmpty,
    namespace: nonEmpty,
    ownerId: nonEmpty,
    collection: nonEmpty,
    memoryClass: z.enum(MEMORY_CLASSES),
    contentDigest: nonEmpty,
  }),
  plan: z.object({
    projections: z.array(memorySourceReferenceSchema),
    identityViews: z.array(memorySourceReferenceSchema),
    managedAssetRecords: z.array(memorySourceReferenceSchema),
    summaries: z.array(memorySourceReferenceSchema),
  }),
  contentDigests: z.array(nonEmpty),
  requestedBy: memoryAttributionSchema,
  requestedAt: z.number(),
  boundMilliseconds: z.number().positive(),
  awaitingHoldRelease: z.boolean(),
  targets: z.array(
    z.object({
      target: z.enum(MEMORY_DELETION_TARGETS),
      lane: z.enum(['synchronous', 'bounded-async']),
      status: z.enum(['completed', 'pending', 'exempt', 'failed', 'unknown']),
      deadline: z.number().optional(),
      settledAt: z.number().optional(),
      detail: z.string().optional(),
    }),
  ),
  open: z.boolean(),
  updatedAt: z.number(),
});

const exportSchema = z.object({
  version: z.literal(1),
  exportId: nonEmpty,
  tenantId: nonEmpty,
  ownerId: nonEmpty,
  exportedBy: memoryAttributionSchema,
  recordIds: z.array(z.string()),
  removedRecordIds: z.array(z.string()),
  createdAt: z.number(),
  revoked: z.boolean(),
  revokedAt: z.number().optional(),
  revokedBy: memoryAttributionSchema.optional(),
});

const lineageSchema = z.object({
  tenantId: nonEmpty,
  source: memorySourceReferenceSchema,
  derived: memorySourceReferenceSchema.extend({ kind: z.enum(DERIVED_RECORD_KINDS) }),
});

const pendingDerivationSchema = z.object({
  tenantId: nonEmpty,
  record: memorySourceReferenceSchema,
  startedAt: z.number(),
});

const scopeSchema = z.object({ tenantId: nonEmpty, namespace: nonEmpty });

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function decode<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  return schema.parse(JSON.parse(decoder.decode(bytes)));
}

const component = encodeStorageKeyComponent;

/**
 * How many times a manifest change re-reads the manifest and retries after
 * another writer changed it first.
 */
const EXPORT_WRITE_ATTEMPTS = 8;

/**
 * Creates the governance ledger over a Weft {@link Storage}. Every persisted
 * entry is decoded through a schema, so a corrupt receipt fails loudly at the
 * read boundary rather than reading as "nothing to propagate". Export manifest
 * changes are compare-and-swap writes, so the storage must support
 * `conditionalBatch`.
 */
export function createMemoryGovernanceLedger(
  storage: Storage,
  options: CreateMemoryGovernanceLedgerOptions = {},
): MemoryGovernanceLedger {
  const prefix = options.keyPrefix ?? DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX;
  validateMemoryKeyPrefix(prefix);

  const eventPrefix = (tenantId: string) => `${prefix}event:${component(tenantId)}:`;
  const receiptKey = (deletionId: string) => `${prefix}receipt:${component(deletionId)}`;
  const exportPrefix = (tenantId: string) => `${prefix}export:${component(tenantId)}:`;
  const exportKey = (tenantId: string, exportId: string) =>
    `${exportPrefix(tenantId)}${component(exportId)}`;
  const lineagePrefix = (tenantId: string, source: MemoryRecordSourceReference) =>
    `${prefix}lineage:${component(tenantId)}:${component(source.namespace)}:${component(source.id)}:`;
  const derivationPrefix = (tenantId?: string) =>
    tenantId === undefined ? `${prefix}derivation:` : `${prefix}derivation:${component(tenantId)}:`;
  const derivationKey = (tenantId: string, record: MemoryRecordSourceReference) =>
    `${derivationPrefix(tenantId)}${component(record.namespace)}:${component(record.id)}`;
  const scopePrefix = (tenantId: string) => `${prefix}scope:${component(tenantId)}:`;
  const evictionPrefix = (tenantId: string, contextId: string) =>
    `${prefix}evict:${component(tenantId)}:${component(contextId)}:`;

  async function scanValues<T>(scanPrefix: string, schema: z.ZodType<T>): Promise<T[]> {
    const values: T[] = [];
    for await (const [, bytes] of storage.scan(scanPrefix)) values.push(decode(schema, bytes));
    return values;
  }

  /**
   * Applies `change` to a manifest as it is stored now: the write is a
   * compare-and-swap against the bytes read, retried when another writer lands
   * first. Returns the manifest written, or `undefined` when the export is
   * missing or `change` leaves it alone.
   */
  async function updateExport(
    tenantId: string,
    exportId: string,
    change: (current: MemoryExportManifest) => MemoryExportManifest | undefined,
  ): Promise<MemoryExportManifest | undefined> {
    const key = exportKey(tenantId, exportId);
    for (let attempt = 1; ; attempt++) {
      const bytes = await storage.get(key);
      if (bytes === null) return undefined;
      const next = change(decode(exportSchema, bytes) as MemoryExportManifest);
      if (next === undefined) return undefined;
      const swapped = await storageConditionalBatch(
        storage,
        [{ key, expectedValue: bytes }],
        [{ type: 'put', key, value: encode(next) }],
      );
      if (swapped) return next;
      if (attempt >= EXPORT_WRITE_ATTEMPTS) {
        throw new Error(
          `Export manifest "${exportId}" kept changing; gave up after ${EXPORT_WRITE_ATTEMPTS} attempts.`,
        );
      }
    }
  }

  return {
    async appendEvent(event) {
      const key = `${eventPrefix(event.tenantId)}${formatSortableStorageTimestamp(event.at)}:${component(event.id)}`;
      await storage.put(key, encode(event));
    },

    async listEvents(filter) {
      const events = await scanValues(eventPrefix(filter.tenantId), eventSchema);
      return events.filter(
        (event) =>
          (filter.type === undefined || event.type === filter.type) &&
          (filter.recordId === undefined || event.recordIds.includes(filter.recordId)),
      ) as MemoryGovernanceEvent[];
    },

    async pruneEvents(tenantId, before) {
      let removed = 0;
      const stale: string[] = [];
      for await (const [key, bytes] of storage.scan(eventPrefix(tenantId))) {
        if (decode(eventSchema, bytes).at < before) stale.push(key);
      }
      for (const key of stale) {
        await storage.delete(key);
        removed++;
      }
      return removed;
    },

    async putReceipt(receipt) {
      await storage.put(receiptKey(receipt.deletionId), encode(receipt));
    },

    async getReceipt(deletionId) {
      const bytes = await storage.get(receiptKey(deletionId));
      return bytes === null ? undefined : (decode(receiptSchema, bytes) as MemoryDeletionReceipt);
    },

    async listReceipts(filter) {
      const receipts = await scanValues(`${prefix}receipt:`, receiptSchema);
      return receipts.filter(
        (receipt) =>
          (filter.tenantId === undefined || receipt.tenantId === filter.tenantId) &&
          (filter.open === undefined || receipt.open === filter.open),
      ) as MemoryDeletionReceipt[];
    },

    async deleteReceipt(deletionId) {
      await storage.delete(receiptKey(deletionId));
    },

    async putExport(manifest) {
      await storage.put(exportKey(manifest.tenantId, manifest.exportId), encode(manifest));
    },

    async getExport(tenantId, exportId) {
      const bytes = await storage.get(exportKey(tenantId, exportId));
      return bytes === null ? undefined : (decode(exportSchema, bytes) as MemoryExportManifest);
    },

    revokeExport(tenantId, exportId, revocation) {
      return updateExport(tenantId, exportId, (current) =>
        current.revoked ? undefined : { ...current, revoked: true, ...revocation },
      );
    },

    async scrubExport(tenantId, exportId, recordIds) {
      const deleted = new Set(recordIds);
      await updateExport(tenantId, exportId, (current) => {
        const removed = current.recordIds.filter((id) => deleted.has(id));
        if (removed.length === 0) return undefined;
        return {
          ...current,
          recordIds: current.recordIds.filter((id) => !deleted.has(id)),
          removedRecordIds: [...new Set([...current.removedRecordIds, ...removed])],
        };
      });
    },

    async listExports(filter) {
      const manifests = await scanValues(exportPrefix(filter.tenantId), exportSchema);
      return manifests.filter(
        (manifest) => filter.recordId === undefined || manifest.recordIds.includes(filter.recordId),
      ) as MemoryExportManifest[];
    },

    async putLineage(link) {
      const key = `${lineagePrefix(link.tenantId, link.source)}${component(link.derived.namespace)}:${component(link.derived.id)}`;
      await storage.put(key, encode(link));
    },

    async listLineage(tenantId, source) {
      return scanValues(lineagePrefix(tenantId, source), lineageSchema);
    },

    async deleteLineage(tenantId, source) {
      await storageDeletePrefix(storage, lineagePrefix(tenantId, source));
    },

    async putPendingDerivation(entry) {
      await storage.put(derivationKey(entry.tenantId, entry.record), encode(entry));
    },

    async listPendingDerivations(filter) {
      return scanValues(derivationPrefix(filter.tenantId), pendingDerivationSchema);
    },

    async deletePendingDerivation(tenantId, record) {
      await storage.delete(derivationKey(tenantId, record));
    },

    async registerScope(scope) {
      await storage.put(
        `${scopePrefix(scope.tenantId)}${component(scope.namespace)}`,
        encode(scope),
      );
    },

    async listScopes(tenantId) {
      return scanValues(scopePrefix(tenantId), scopeSchema);
    },

    async putEviction(tenantId, contextId, recordId) {
      await storage.put(
        `${evictionPrefix(tenantId, contextId)}${component(recordId)}`,
        encode(recordId),
      );
    },

    async listEvictions(tenantId, contextId) {
      return scanValues(evictionPrefix(tenantId, contextId), nonEmpty);
    },
  };
}
